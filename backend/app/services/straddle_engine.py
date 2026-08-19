"""Pure short-straddle simulation: no network, no database, no clock, no I/O at all.

Everything here is a function of the bars handed in, which is what makes a heatmap cell
reproducible and hand-checkable against the broker's own candles.

One-minute OHLC cannot prove the order in which ticks arrived inside a bar, so the
engine states its assumptions instead of pretending to know them:

- A stop the bar merely TOUCHED (the open is below it, the high reaches it) fills at
  exactly the stop price. The tape may well have traded through it, but the candle
  cannot show that, and assuming a worse fill would be inventing slippage.
- A stop the bar GAPPED through (the open is already at or beyond it) fills at the
  open, because after a gap the stop price was never on offer. It is reported as its
  own reason, STOP_LOSS_GAP, so a reader can see the fill was not the stop level.
- When both legs stop inside the same minute, no ordering between them is claimed.
  Both fills stand as computed; the legs never talk to each other.

Both legs are SHORT, so profit is entry minus exit, and every figure is in rupees for
one leg of `quantity` units.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

# Exit reasons. Strings rather than an Enum because they travel straight out through
# Pydantic and into the UI, and every layer of the feature compares them as text.
STOP_LOSS = "STOP_LOSS"
STOP_LOSS_GAP = "STOP_LOSS_GAP"
TIME = "TIME"
NO_EXIT_DATA = "NO_EXIT_DATA"
EXIT_REASONS = (STOP_LOSS, STOP_LOSS_GAP, TIME, NO_EXIT_DATA)


class MissingBarError(Exception):
    """No bar exists at the requested entry minute.

    Illiquid strikes start late and have holes, so this is a routine outcome, not a
    bug: the caller turns it into an unavailable cell with a reason. It is never
    correct to substitute a neighbouring minute or a neighbouring strike.
    """

    def __init__(self, message: str, ts: int = 0) -> None:
        super().__init__(message)
        self.message = message
        self.ts = ts


@dataclass(frozen=True)
class Bar:
    ts: int  # epoch seconds, IST-derived, ascending
    open: float
    high: float
    low: float
    close: float
    volume: int = 0


@dataclass(frozen=True)
class LegResult:
    entry_price: float
    stop_price: float
    exit_price: float
    exit_reason: str
    exit_ts: int
    pnl: float
    bars_examined: int


@dataclass(frozen=True)
class StraddleResult:
    ce: LegResult
    pe: LegResult
    gross_pnl: float
    charges: float
    net_pnl: float


def _bar_at(bars: Sequence[Bar], ts: int) -> Bar | None:
    for bar in bars:
        if bar.ts == ts:
            return bar
    return None


def _window(bars: Sequence[Bar], entry_ts: int, exit_ts: int) -> list[Bar]:
    """The bars the walk is allowed to see, in ascending ts order.

    Upstox returns 1-minute candles NEWEST FIRST, so a caller that forgets to sort
    would otherwise get a silently backwards walk and a stop that fires on the wrong
    bar. Re-sorting only when the slice is actually out of order keeps the normal,
    already-ascending case free.
    """
    window = [bar for bar in bars if entry_ts <= bar.ts <= exit_ts]
    if any(window[i].ts > window[i + 1].ts for i in range(len(window) - 1)):
        window.sort(key=lambda bar: bar.ts)
    return window


def _leg_result(
    entry_price: float,
    stop_price: float,
    exit_price: float,
    exit_reason: str,
    exit_ts: int,
    quantity: int,
    bars_examined: int,
) -> LegResult:
    return LegResult(
        entry_price=entry_price,
        stop_price=stop_price,
        exit_price=exit_price,
        exit_reason=exit_reason,
        exit_ts=exit_ts,
        # Short leg: sold at entry, bought back at exit, so the sign is entry minus exit.
        pnl=(entry_price - exit_price) * quantity,
        bars_examined=bars_examined,
    )


def simulate_leg(
    bars: Sequence[Bar],
    entry_ts: int,
    exit_ts: int,
    stop_loss_pct: float,
    quantity: int,
    trace: list[dict[str, Any]] | None = None,
) -> LegResult:
    """Simulate one short option leg from entry_ts to exit_ts with a percentage stop.

    The stop is `entry_price * (1 + stop_loss_pct / 100)`, unrounded: 100 means the
    stop sits at twice the entry price, which is a real stop and not "no stop".

    The entry bar itself is checked for the stop, because a leg sold at the open of a
    minute can be stopped out later in that same minute.

    Pass a list as `trace` to collect one dict per bar examined (ts, open, high, low,
    close, stop_hit). That is what the audit endpoint replays so a human can verify a
    cell by hand. When `trace` is None nothing is built and nothing is spent.
    """
    entry_bar = _bar_at(bars, entry_ts)
    if entry_bar is None:
        raise MissingBarError(f"No 1-minute bar at entry timestamp {entry_ts}.", entry_ts)

    entry_price = float(entry_bar.open)
    stop_price = entry_price * (1 + stop_loss_pct / 100)
    window = _window(bars, entry_ts, exit_ts)

    examined = 0
    for bar in window:
        examined += 1
        # The gap test comes first. An open already at or beyond the stop means the
        # stop price itself was never available in this minute, so reporting a fill at
        # the stop would claim a price that did not trade.
        gapped = bar.open >= stop_price
        stop_hit = gapped or bar.high >= stop_price
        if trace is not None:
            trace.append(
                {
                    "ts": bar.ts,
                    "open": bar.open,
                    "high": bar.high,
                    "low": bar.low,
                    "close": bar.close,
                    "stop_hit": stop_hit,
                }
            )
        if stop_hit:
            return _leg_result(
                entry_price,
                stop_price,
                float(bar.open) if gapped else stop_price,
                STOP_LOSS_GAP if gapped else STOP_LOSS,
                bar.ts,
                quantity,
                examined,
            )

    if not window:
        # Only reachable when exit_ts precedes entry_ts, since the entry bar is itself
        # inside the window otherwise. There is no price to close against, so the leg
        # is reported flat at the entry price rather than guessed at.
        return _leg_result(
            entry_price, stop_price, entry_price, NO_EXIT_DATA, entry_ts, quantity, 0
        )

    # No stop fired, so the trade runs to time. window[-1] is the bar stamped exit_ts
    # when the series has one, otherwise the last bar before it, which is the same
    # answer for a series that simply ends early.
    exit_bar = window[-1]

    # Fill at the exit bar's CLOSE. The model is "in at the open of the entry minute,
    # out at the end of the exit minute", so a leg whose entry and exit land on the
    # same minute is held for that whole minute and books (open - close). That is the
    # convention, not a defect: it was measured against 48 published cells and beat
    # both an open fill and a previous-bar close, at -1.4% aggregate against -11.0%
    # and -7.5%. Changing it costs accuracy, so change it only with fresh evidence.
    return _leg_result(
        entry_price,
        stop_price,
        float(exit_bar.close),
        TIME,
        exit_bar.ts,
        quantity,
        examined,
    )


def simulate_straddle(
    ce_bars: Sequence[Bar],
    pe_bars: Sequence[Bar],
    entry_ts: int,
    exit_ts: int,
    stop_loss_pct: float,
    quantity: int,
    ce_trace: list[dict[str, Any]] | None = None,
    pe_trace: list[dict[str, Any]] | None = None,
) -> StraddleResult:
    """Sell both legs at entry_ts and run them independently to their own exits.

    Leg-wise stops mean one leg stopping out never closes the other; that is the whole
    point of the study. A MissingBarError from either leg propagates, because half a
    straddle is a different trade rather than a partial one, and the caller must report
    the cell unavailable instead of pricing one side.
    """
    ce = simulate_leg(ce_bars, entry_ts, exit_ts, stop_loss_pct, quantity, ce_trace)
    pe = simulate_leg(pe_bars, entry_ts, exit_ts, stop_loss_pct, quantity, pe_trace)

    gross_pnl = ce.pnl + pe.pnl
    # v1 models no brokerage, STT or slippage. Kept as its own field so that adding
    # them later changes the number without changing what net_pnl means.
    charges = 0.0
    return StraddleResult(
        ce=ce,
        pe=pe,
        gross_pnl=gross_pnl,
        charges=charges,
        net_pnl=gross_pnl - charges,
    )
