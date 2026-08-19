"""The price the ATM strike decision is measured against.

A straddle is only "at the money" relative to something, and the three things a desk
actually uses disagree by enough to move the strike. Measured on 2026-08-19 at 09:16 on
NIFTY: the index spot opened at 24120.30 and picks strike 24100, while the synthetic
future (24143.80) and the current-month future (24147.40) both pick 24150. One whole
50-point strike apart, on the same minute of the same session. Which of them is "the"
underlying is a judgement call, so it became an input, and this module supplies the
number the caller then resolves a strike against.

- spot       the index bar's OPEN at the entry minute. The default, and what the
             backtest did before this module existed.
- synthetic  put-call parity on the SAME expiry being traded: F = K + CE - PE, read off
             the OPENs of one listed strike's two legs.
- future     the current-month FUT contract's bar OPEN at the entry minute.

The synthetic is deliberately undiscounted. Textbook parity is F = K + CE - PE adjusted
for carry to expiry, and that adjustment is simply dropped here: over an intraday horizon
on a weekly expiry it is worth well under a point, the same order as the noise the
measurement below already contains. So read the synthetic as the market's own implied
forward taken off two live quotes, not as a theoretically exact forward.

That measurement, at 09:16 on 2026-08-19 against weekly expiry 2026-08-25, is also what
fixes the algorithm. K + CE_open - PE_open by strike:

    K       24050     24100     24150     24200
    F     24143.80  24143.80  24143.10  24143.00

Under one point of spread across 150 points of strike, so the answer barely depends on
which strike is used to compute it. One refinement pass is therefore enough: seed with
the spot-ATM strike, compute F there once, and let the caller re-pick the nearest listed
strike to F. Iterating to a fixed point would move the result by a fraction of a point
and cost two more contract fetches per entry time.

Every mode returns None when its own series has no bar at the entry minute, and no mode
ever falls back to another. A cell priced off spot while the request asked for the future
would be a different backtest wearing the right label, which is worse than a cell that
says it is unavailable.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from ..config import IST
from ..db import session
from . import option_history, option_resolver
from .straddle_engine import Bar

# The three ways of measuring the underlying, in the same order as the frozen
# UnderlyingMode literal. Kept here as plain strings so this service never imports the
# schema layer.
UNDERLYING_MODES = ("spot", "synthetic", "future")


@dataclass(frozen=True)
class UnderlyingQuote:
    """One mode's answer for one minute, carrying its own provenance.

    `detail` exists because the audit panel shows it to a human who wants to check the
    strike choice by hand, so it spells the arithmetic out rather than summarising it.
    """

    mode: str  # "spot" | "synthetic" | "future"
    price: float
    source_key: str  # index key, future key, or the seed option pair behind the synthetic
    detail: str  # human readable, e.g. "24100 + CE 155.75 - PE 132.25 = 24123.50 at 09:16"


@dataclass
class QuoteContext:
    """Per-run scratch space, created once by the caller and threaded through quote_at.

    Nothing in it has to be filled in: quote_at looks up whatever is missing and caches
    the answer here, so a twelve-row grid does one index lookup and one futures lookup
    instead of twelve of each. Passing None is legal and only means the lookups are not
    shared between calls. Option and future CANDLES are not cached here; option_history
    already memoises those per (instrument_key, date) for the life of the run.
    """

    index_keys: dict[str, str | None] = field(default_factory=dict)
    futures: dict[tuple[str, str], dict[str, object] | None] = field(default_factory=dict)


# --- internals --------------------------------------------------------------


def _normalise(underlying: str) -> str:
    return " ".join(str(underlying).upper().split())


def _check_date(value: str) -> str:
    """Prove the date exists before it is compared against `expiry` in SQL.

    A malformed date would not raise: it would compare as a string and quietly match no
    contract, which reads downstream as "this underlying has no future" and sends the
    reader looking in the wrong place.
    """
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        raise ValueError(f"Expected a YYYY-MM-DD date, got {value!r}.") from None


def _hhmm(ts: int) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%H:%M")


def _price(value: float) -> str:
    return f"{value:.2f}"


def _strike(value: float) -> str:
    """24100.0 -> "24100", 24125.5 -> "24125.5". Strikes are shown the way they are quoted."""
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _index_key(underlying: str, ctx: QuoteContext) -> str | None:
    """The index instrument_key the option chain points at, read from the master.

    Taken from the derivatives' own `underlying_key` column rather than through
    option_resolver.list_underlyings, which validates all three supported chains at once
    and would fail a NIFTY quote because the SENSEX rows are missing. This value is only
    ever displayed as provenance, so the looser lookup is the right trade.
    """
    if underlying in ctx.index_keys:
        return ctx.index_keys[underlying]
    with session() as conn:
        row = conn.execute(
            """SELECT underlying_key
               FROM instrument_master
               WHERE underlying_symbol = :underlying
                 AND instrument_type IN ('CE', 'PE')
                 AND underlying_key IS NOT NULL AND underlying_key <> ''
               LIMIT 1""",
            {"underlying": underlying},
        ).fetchone()
    key = row["underlying_key"] if row is not None else None
    ctx.index_keys[underlying] = key
    return key


def _future_row(underlying: str, on_date: str, ctx: QuoteContext) -> dict[str, object] | None:
    memo_key = (underlying, on_date)
    if memo_key not in ctx.futures:
        ctx.futures[memo_key] = current_month_future(underlying, on_date)
    return ctx.futures[memo_key]


def _spot(
    underlying: str, entry_ts: int, index_bars: Sequence[Bar], ctx: QuoteContext
) -> UnderlyingQuote | None:
    bar = option_history.bar_at(index_bars, entry_ts)
    if bar is None:
        return None
    # The OPEN, not the close: the trade is placed at the start of the minute, so the
    # close of that same bar has not happened yet.
    price = float(bar.open)
    return UnderlyingQuote(
        mode="spot",
        price=price,
        source_key=_index_key(underlying, ctx) or underlying,
        detail=f"{underlying} index open {_price(price)} at {_hhmm(entry_ts)}",
    )


async def _synthetic(
    underlying: str,
    expiry: str,
    date: str,
    entry_ts: int,
    index_bars: Sequence[Bar],
    ctx: QuoteContext,
) -> UnderlyingQuote | None:
    """Put-call parity on the expiry being traded, seeded from the spot-ATM strike.

    Raises ResolverError when no CE/PE pair is listed for that expiry at all, which is
    the same failure the caller already handles when it resolves its own strike.
    """
    seed_bar = option_history.bar_at(index_bars, entry_ts)
    if seed_bar is None:
        # No spot for this minute means no seed strike, and guessing one would put the
        # parity arithmetic on a strike nobody chose.
        return None

    pair = option_resolver.resolve_atm(underlying, expiry, float(seed_bar.open))
    ce_bar = option_history.bar_at(
        await option_history.option_bars(pair.ce_key, date), entry_ts
    )
    pe_bar = option_history.bar_at(
        await option_history.option_bars(pair.pe_key, date), entry_ts
    )
    if ce_bar is None or pe_bar is None:
        # An illiquid seed strike that did not trade this minute. Sliding to the next
        # strike would silently change which contracts the number came from.
        return None

    ce = float(ce_bar.open)
    pe = float(pe_bar.open)
    # Exactly one pass, no convergence loop. The module docstring records the measurement:
    # F computed at 24050 / 24100 / 24150 / 24200 on 2026-08-19 09:16 spanned 24143.80 to
    # 24143.00, under a point across 150 points of strike, so re-seeding from this F and
    # recomputing would return the same number and cost two more contract fetches. The
    # single refinement that does matter is the caller's: it re-picks the nearest listed
    # strike to this price.
    price = round(pair.strike + ce - pe, 2)
    return UnderlyingQuote(
        mode="synthetic",
        price=price,
        source_key=f"{pair.ce_key} + {pair.pe_key}",
        detail=(
            f"{_strike(pair.strike)} + CE {_price(ce)} - PE {_price(pe)} = {_price(price)} "
            f"at {_hhmm(entry_ts)} (seed strike from spot {_price(float(seed_bar.open))}, "
            f"expiry {pair.expiry})"
        ),
    )


async def _future(
    underlying: str, date: str, entry_ts: int, ctx: QuoteContext
) -> UnderlyingQuote | None:
    contract = _future_row(underlying, date, ctx)
    if contract is None:
        return None

    # underlying_bars and option_bars are the same cached day fetch; the name says what
    # the series MEANS here, and a future standing in for the underlying is the former.
    bars = await option_history.underlying_bars(str(contract["instrument_key"]), date)
    bar = option_history.bar_at(bars, entry_ts)
    if bar is None:
        return None

    price = float(bar.open)
    return UnderlyingQuote(
        mode="future",
        price=price,
        source_key=str(contract["instrument_key"]),
        detail=(
            f"{contract['trading_symbol']} open {_price(price)} at {_hhmm(entry_ts)} "
            f"(expiry {contract['expiry']})"
        ),
    )


# --- public API -------------------------------------------------------------


def current_month_future(underlying: str, on_date: str) -> dict[str, object] | None:
    """The FUT contract with the earliest expiry on or after on_date, or None.

    "Current month" is defined by the backtest date, never by the wall clock: on
    2026-08-26 the August contract has already expired, so the September row is the
    current-month future for that day and the answer for an older backtest date does not
    move as the calendar advances.

    Pure SQL, no network. The row is handed back whole so the caller can name the exact
    contract on screen, which is what makes an unavailable cell reconcilable by hand.
    """
    with session() as conn:
        row = conn.execute(
            """SELECT instrument_key, trading_symbol, name, exchange, segment,
                      expiry, lot_size, tick_size, underlying_key, underlying_symbol
               FROM instrument_master
               WHERE underlying_symbol = :underlying
                 AND instrument_type = 'FUT'
                 AND expiry IS NOT NULL AND expiry <> ''
                 AND expiry >= :on_date
               ORDER BY expiry, instrument_key
               LIMIT 1""",
            {"underlying": _normalise(underlying), "on_date": _check_date(on_date)},
        ).fetchone()
    return dict(row) if row is not None else None


def source_label(mode: str, underlying: str, on_date: str) -> str:
    """A human name for the series a mode reads, for the unavailable reason.

    quote_at answers None rather than a reason, because the reason belongs in the cell
    the caller builds. This names the series so that reason can say WHICH one was
    missing: "NIFTY FUT 25 AUG 26 has no 1-minute bar at 09:16" rather than a bare
    "no underlying at 09:16", which sends a reader to the index chart to look for a hole
    that is not there.
    """
    name = _normalise(underlying)
    if mode == "future":
        contract = current_month_future(name, on_date)
        if contract is None:
            return f"the current-month {name} future"
        return str(contract["trading_symbol"])
    if mode == "synthetic":
        return f"the {name} synthetic future (its seed CE/PE pair)"
    return f"the {name} index"


async def quote_at(
    mode: str,
    underlying: str,
    expiry: str,
    date: str,
    entry_ts: int,
    index_bars: Sequence[Bar],
    resolver_ctx: QuoteContext | None = None,
) -> UnderlyingQuote | None:
    """The underlying price for one entry minute under one mode, or None.

    None means the mode's own series has no bar at that minute, so the caller marks the
    row unavailable and names the series with source_label. It never means "use spot
    instead".

    `index_bars` is the index's ascending 1-minute day, already fetched once per run by
    the caller. spot reads it directly, synthetic uses it only to seed the strike, and
    future ignores it entirely.

    Raises ResolverError from the synthetic path when the expiry lists no CE/PE pair at
    all, and UpstoxError when a contract's candles could not be fetched. Both are
    failures of the request rather than of the minute, and both are already handled by
    the caller that resolves strikes.
    """
    ctx = resolver_ctx if resolver_ctx is not None else QuoteContext()
    name = _normalise(underlying)

    if mode == "spot":
        return _spot(name, entry_ts, index_bars, ctx)
    if mode == "synthetic":
        return await _synthetic(name, expiry, date, entry_ts, index_bars, ctx)
    if mode == "future":
        return await _future(name, date, entry_ts, ctx)
    raise ValueError(
        f"Unknown underlying mode {mode!r}. Expected one of {', '.join(UNDERLYING_MODES)}."
    )
