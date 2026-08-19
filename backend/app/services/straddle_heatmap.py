"""Run the ATM short-straddle grid: resolve once, fetch once, then simulate in memory.

The whole feature lives or dies on this module's fetch count. A 12 x 10 grid is 120
straddles and 240 legs, but it is only ever a handful of Upstox calls: one for the index,
then one per DISTINCT option contract the entry times land on. Adjacent minutes almost
always resolve to the same ATM strike, so twelve entry times typically need two to five
strikes, and the entire grid is then arithmetic over arrays already in memory. Fetching
inside the loop instead would be 240 calls for the same numbers.

The order is therefore fixed:

1. one call for the underlying's 1-minute bars,
2. spot at each entry minute is that bar's OPEN, and ATM is resolved from the real strike
   ladder for that minute,
3. the UNION of the CE and PE keys those entry times produced is fetched, each key exactly
   once, a few at a time,
4. every (entry time x stop loss) pair runs against those arrays. Only the stop varies
   down a row, so a row reuses one CE array and one PE array for all its cells.

Missing data is reported, never patched over. An illiquid strike starts late and has
holes, so "no bar at that minute" is routine rather than exceptional: the cell says which
leg and which minute, and stays unavailable. Substituting the previous minute, the next
strike or the other leg's price would produce a number that looks like a backtest result
and is not one.

What "at the money" is measured against is the request's `underlying_mode`, and that is
the one place where this fetch budget could quietly have been lost. `spot` costs nothing:
the index day is already in hand. `future` costs one extra day fetch, shared by every
row. `synthetic` is the awkward one, because put-call parity needs a seed strike's two
legs before the traded strike is even known, so those seed pairs are resolved for ALL
entry times up front and fetched in the same deduplicated batch as the traded contracts.
By the time quote_at asks for them they are in option_history's memo, so the parity
arithmetic adds contracts to the run but never a second call for the same contract.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from .. import store
from ..config import IST
from ..schemas import (
    AuditRequest,
    AuditResponse,
    BarTrace,
    HeatmapCell,
    HeatmapRequest,
    HeatmapResponse,
    LegDetail,
)
from ..upstox import UpstoxError
from . import option_history, option_resolver, underlying_price
from .option_resolver import OptionPair, ResolverError
from .straddle_engine import Bar, LegResult, StraddleResult, simulate_straddle

# How many contracts are fetched at once. Upstox rate limits per second and a grid needs
# a couple of dozen contracts at the very worst, so a small gate keeps the wall clock
# short without ever queueing behind a 429.
FETCH_CONCURRENCY = 4

# Carried on every response because it is the one number a reader will misinterpret.
GRAND_TOTAL_NOTE = (
    "grand_total adds up independent hypothetical trades: every cell is its own straddle, "
    "entered at a different minute with a different stop. No account could have taken them "
    "all, so read it as a diagnostic sum and not as a strategy result."
)

# Warnings name a few contracts and then count the rest. A 40-row grid could otherwise
# produce a warning longer than the grid it describes.
WARNING_SAMPLE = 6


class HeatmapError(ResolverError):
    """The request cannot be run, and the message says what to change.

    Deliberately a subclass of ResolverError: to a caller both mean the same thing, a
    400-class "this combination does not exist, fix the input", so one except clause
    handles a bad expiry from the resolver and a non-trading date from here.
    """


# --- small helpers ----------------------------------------------------------


def _sample(items: list[str]) -> str:
    if len(items) <= WARNING_SAMPLE:
        return ", ".join(items)
    return f"{', '.join(items[:WARNING_SAMPLE])} and {len(items) - WARNING_SAMPLE} more"


def _capitalised(text: str) -> str:
    """Sentence-case a mid-sentence label: the first letter only, never the rest.

    Labels arrive lower case because they usually sit inside a sentence, and a contract
    name like NIFTY FUT 25 AUG 26 must keep every other letter exactly as the exchange
    publishes it.
    """
    return text[:1].upper() + text[1:]


def _parse_day(value: str, field: str) -> date:
    """The schema proves the SHAPE is YYYY-MM-DD; this proves the date exists."""
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HeatmapError(f"{field} {value!r} is not a real calendar date.") from None


def _minute(day: date, hhmm: str) -> int:
    """Epoch seconds for HH:MM on that trading day, in IST.

    Bars are stamped at their OPEN in IST, so an entry time is an exact timestamp match
    and never a range. IST is a fixed offset, which is what makes this a plain
    construction with no DST question to get wrong.
    """
    return int(
        datetime(
            day.year, day.month, day.day, int(hhmm[:2]), int(hhmm[3:5]), tzinfo=IST
        ).timestamp()
    )


def _hhmm(ts: int) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%H:%M")


def _underlying_info(underlying: str) -> dict[str, Any]:
    """The index instrument_key for a supported underlying, read from the master.

    Needed before any spot is known, so it cannot come from resolve_atm. The key is read
    out of instrument_master rather than written down here, because an index key that was
    assembled by hand is indistinguishable from a real one until a candle request fails.
    """
    for info in option_resolver.list_underlyings():
        if info["underlying"] == underlying:
            return info
    raise HeatmapError(
        f"{underlying} is not one of the supported underlyings: "
        f"{', '.join(option_resolver.SUPPORTED_UNDERLYINGS)}."
    )


# --- shared setup -----------------------------------------------------------


@dataclass(frozen=True)
class _Context:
    """Everything a grid or a single audit needs before any option is fetched."""

    underlying: str
    day: date
    date: str
    expiry: str
    default_lot_size: int
    bars: list[Bar]  # the index's 1-minute bars for that date, ascending
    warnings: list[str]
    # What the ATM strike is measured against, and the name of the series that supplies
    # it. The label is resolved once here because an unavailable row has to say WHICH
    # series was missing, and re-deriving it per row would re-query the master per row.
    mode: str = "spot"
    source: str = "the underlying"
    # Shared lookup cache for underlying_price, so a twelve-row grid does one index
    # lookup and one futures lookup rather than twelve of each.
    quotes: underlying_price.QuoteContext = field(
        default_factory=underlying_price.QuoteContext
    )


async def _prepare(
    underlying: str, day_str: str, expiry: str, exit_time: str, mode: str = "spot"
) -> _Context:
    """Validate the request against the master and fetch the index's bars ONCE.

    Everything that can be rejected cheaply is rejected here, before a single option
    candle is requested, so a typo in the expiry costs no Upstox quota. The mode joins
    that list: an unknown one, and a missing futures contract in future mode, are both
    settled here rather than discovered at the first entry time.

    The index bars are fetched whatever the mode. Spot reads them for its price, the
    synthetic seeds its parity strike from them, and even in future mode every cell
    reports the raw spot beside the futures price its strike came from.
    """
    day = _parse_day(day_str, "date")
    if mode not in underlying_price.UNDERLYING_MODES:
        # The schema Literal already closes this off for anything arriving over HTTP.
        # This is for a direct service call, and it fails here rather than at the first
        # entry time, where it would look like a data problem instead of a typo.
        raise HeatmapError(
            f"Unknown underlying mode {mode!r}. Expected one of "
            f"{', '.join(underlying_price.UNDERLYING_MODES)}."
        )

    expiry_day = _parse_day(expiry, "expiry")
    if expiry_day < day:
        raise HeatmapError(
            f"Expiry {expiry} is before the trade date {day_str}. "
            "The contract had already expired, so there is nothing to simulate."
        )

    info = _underlying_info(underlying)
    live = option_resolver.list_expiries(underlying)
    if expiry not in live:
        # Expired contracts are out of scope by design: they leave the beginning-of-day
        # master, and the expired-instruments API is never called.
        raise HeatmapError(
            f"{underlying} has no live expiry {expiry}. Only contracts still listed in "
            f"the instrument master can be backtested. Live expiries: "
            f"{', '.join(live) or 'none'}."
        )

    # Today's session is still being written, so a memo left over from an earlier run in
    # this process would serve a partial day as if it were complete.
    if day_str >= store.now_ist().date().isoformat():
        option_history.clear_memo()

    bars = await option_history.underlying_bars(info["underlying_key"], day_str)
    if not bars:
        raise HeatmapError(
            f"No 1-minute data for {underlying} on {day_str}. Choose a trading day: "
            "weekends, exchange holidays and dates before 1-minute history begins all "
            "return nothing."
        )

    # A future the master does not list is a request-level failure, not a per-minute one:
    # without the contract not a single row could be priced, so it is said once here
    # instead of repeated in every cell of the grid. Falling back to spot is not an
    # option, because the grid would then be labelled with a mode it did not use.
    contract = (
        underlying_price.current_month_future(underlying, day_str)
        if mode == "future"
        else None
    )
    if mode == "future" and contract is None:
        raise HeatmapError(
            f"{underlying} has no FUT contract expiring on or after {day_str} in "
            "instrument_master, so there is no current-month future to measure the ATM "
            "strike against. Re-download the instrument master, or run the grid in spot "
            "or synthetic mode."
        )
    source = (
        str(contract["trading_symbol"])
        if contract is not None
        else underlying_price.source_label(mode, underlying, day_str)
    )

    warnings = [GRAND_TOTAL_NOTE]
    if mode != "spot":
        measure = (
            f"the synthetic future (put-call parity K + CE - PE on the {expiry} expiry)"
            if mode == "synthetic"
            else source
        )
        warnings.append(
            f"ATM strikes were picked from {measure} and not from the index spot, so a "
            "row can sit a whole strike away from where a spot-priced run of the same "
            "grid would have put it; every priced cell still carries the raw index spot "
            "beside the price its strike came from, so the two can be compared."
        )
    if expiry == day_str:
        warnings.append(
            f"{expiry} is the expiry day for this contract. Premium decays far faster "
            "than on any other day, so these results do not generalise."
        )
    if option_history.bar_at(bars, _minute(day, exit_time)) is None:
        warnings.append(
            f"The {underlying} session on {day_str} has no bar at {exit_time} "
            f"({_hhmm(bars[0].ts)} to {_hhmm(bars[-1].ts)}). Legs that ran to time "
            "exited on the last bar at or before it."
        )

    return _Context(
        underlying=underlying,
        day=day,
        date=day_str,
        expiry=expiry,
        default_lot_size=int(info["lot_size"]),
        bars=bars,
        warnings=warnings,
        mode=mode,
        source=source,
    )


# --- step 2: one underlying quote and one ATM resolution per entry time ------


@dataclass(frozen=True)
class _Row:
    """One entry time after resolution. Either `pair` is set, or `reason` says why not."""

    entry_time: str
    entry_ts: int
    # The raw index open, in EVERY mode. It is what a reader compares the mode's own
    # measure against, so it is carried even when the strike was chosen from a future.
    spot: float | None = None
    pair: OptionPair | None = None
    reason: str | None = None
    # The price the ATM decision actually used: equal to spot in spot mode, and the
    # synthetic or futures price otherwise.
    underlying_price: float | None = None
    underlying_mode: str = "spot"
    # Which kind of problem produced `reason`. The two need different fixes, a minute
    # outside the session against a chain that is too short, so they are recorded rather
    # than inferred later from whichever fields happen to be set.
    failure: str | None = None  # "underlying" or "strike"


def _seed_pairs(ctx: _Context, entry_times: list[str]) -> dict[int, OptionPair]:
    """The parity seed pair per entry minute, so all of them can be fetched in ONE batch.

    Only the synthetic mode has seeds. This deliberately mirrors what
    underlying_price._synthetic does for itself, resolve_atm against the index open, for
    one reason: the contracts have to be known BEFORE quote_at is called so they can join
    the same deduplicated fetch as the traded strikes. If the seeding rule there ever
    changes, the wrong contracts get prewarmed and quote_at fetches what it really needs,
    so the drift costs calls and never correctness.

    Pure SQL, and a minute with no index bar or no listed chain is skipped: it has no
    seed to prefetch, and the row will report that failure for itself.
    """
    if ctx.mode != "synthetic":
        return {}

    seeds: dict[int, OptionPair] = {}
    for entry_time in entry_times:
        entry_ts = _minute(ctx.day, entry_time)
        bar = option_history.bar_at(ctx.bars, entry_ts)
        if bar is None:
            continue
        try:
            seeds[entry_ts] = option_resolver.resolve_atm(
                ctx.underlying, ctx.expiry, float(bar.open)
            )
        except ResolverError:
            continue
    return seeds


def _dead_seed(seed: OptionPair, failed: dict[str, str], entry_time: str) -> str | None:
    """The reason a parity seed cannot be read, or None.

    A seed contract whose candles failed to fetch is checked here rather than left to
    quote_at, because option_history does not memoise a failure: quote_at would ask for
    the same dead contract again, once per entry time, and one broken contract would then
    cost the run a call per row.
    """
    broken = [
        symbol
        for symbol, key in ((seed.ce_symbol, seed.ce_key), (seed.pe_symbol, seed.pe_key))
        if key in failed
    ]
    if not broken:
        return None
    return (
        f"The synthetic future has no seed at {entry_time}: candles could not be "
        f"fetched for {' and '.join(broken)}"
    )


def _missing_quote(ctx: _Context, entry_time: str, spot: float | None) -> str:
    """Why the mode's own series could not price this minute, naming that series.

    Spot keeps the wording it has always had, because in that mode a missing quote IS a
    missing index bar and nothing else. The other two modes name their series instead:
    "no underlying bar" would send a reader to the index chart to look for a hole that is
    not there.
    """
    if ctx.mode == "spot" or (ctx.mode == "synthetic" and spot is None):
        return f"No underlying bar at {entry_time}"
    return f"{ctx.source} has no 1-minute bar at {entry_time}"


async def _resolve_row(
    ctx: _Context, entry_time: str, seeds: dict[int, OptionPair], failed: dict[str, str]
) -> _Row:
    """Quote the underlying for one minute under the run's mode, then resolve ATM to it.

    In spot mode this is the original path exactly: the index bar's open, then
    resolve_atm against it. In the other two the quote comes from a different series and
    the strike follows the quote, which is the whole point of the mode.
    """
    entry_ts = _minute(ctx.day, entry_time)
    bar = option_history.bar_at(ctx.bars, entry_ts)
    # The OPEN of the entry bar: the trade is placed at the start of that minute, so its
    # close has not happened yet.
    spot = float(bar.open) if bar is not None else None

    def unresolved(reason: str, kind: str, price: float | None = None) -> _Row:
        return _Row(
            entry_time,
            entry_ts,
            spot=spot,
            reason=reason,
            underlying_price=price,
            underlying_mode=ctx.mode,
            failure=kind,
        )

    seed = seeds.get(entry_ts)
    if seed is not None:
        dead = _dead_seed(seed, failed, entry_time)
        if dead is not None:
            return unresolved(dead, "underlying")

    try:
        quote = await underlying_price.quote_at(
            ctx.mode,
            ctx.underlying,
            ctx.expiry,
            ctx.date,
            entry_ts,
            ctx.bars,
            ctx.quotes,
        )
    except UpstoxError as exc:
        # One unreachable contract or future must not sink the rest of the grid, the
        # same rule the traded legs already follow.
        return unresolved(
            f"{ctx.source} could not be priced at {entry_time}: {exc.message}",
            "underlying",
        )
    except ResolverError as exc:
        # The synthetic path resolves its own seed strike, so it can fail the same way
        # the traded strike does when the chain is short.
        return unresolved(str(exc), "strike")

    if quote is None:
        return unresolved(_missing_quote(ctx, entry_time, spot), "underlying")

    try:
        pair = option_resolver.resolve_atm(ctx.underlying, ctx.expiry, quote.price)
    except ResolverError as exc:
        return unresolved(str(exc), "strike", quote.price)

    return _Row(
        entry_time,
        entry_ts,
        spot=spot,
        pair=pair,
        underlying_price=quote.price,
        underlying_mode=ctx.mode,
    )


async def _resolve_rows(
    ctx: _Context,
    entry_times: list[str],
    seeds: dict[int, OptionPair],
    failed: dict[str, str],
) -> list[_Row]:
    """Resolve every entry time in order.

    Sequential on purpose: spot is pure SQL, and the other two modes read contracts that
    the seed batch above, or the first row to ask, has already put in option_history's
    memo, so there is nothing here for concurrency to overlap. Adjacent entry times
    usually land on the same strike; the deduplication that matters happens later, over
    the instrument keys these rows produce.
    """
    return [
        await _resolve_row(ctx, entry_time, seeds, failed) for entry_time in entry_times
    ]


# --- step 3: fetch each distinct contract exactly once -----------------------


def _collect(pair: OptionPair, symbols: dict[str, str]) -> None:
    symbols[pair.ce_key] = pair.ce_symbol
    symbols[pair.pe_key] = pair.pe_symbol


async def _fetch_series(
    symbols: dict[str, str],
    bars: dict[str, list[Bar]],
    failed: dict[str, str],
    day_str: str,
) -> None:
    """Fetch every key in `symbols` that `bars` does not already hold, one call each.

    This is the whole efficiency rule in one function. Keys are collected into a dict
    before anything is fetched, so a strike shared by nine entry times is fetched once
    and read nine times, and the seed pass that runs first leaves nothing for the traded
    pass to repeat.
    """
    gate = asyncio.Semaphore(FETCH_CONCURRENCY)

    async def load(key: str) -> None:
        async with gate:
            try:
                bars[key] = await option_history.option_bars(key, day_str)
            except UpstoxError as exc:
                # One dead contract must not sink the other rows of the grid. The cells
                # on this strike become unavailable and the reason reaches the user as a
                # warning instead of a 502 for the whole run.
                bars[key] = []
                failed[key] = exc.message

    await asyncio.gather(*(load(key) for key in symbols if key not in bars))


def _fetch_warnings(
    symbols: dict[str, str],
    bars: dict[str, list[Bar]],
    failed: dict[str, str],
    day_str: str,
) -> list[str]:
    """Report the contracts that could not be read, counted once over both passes."""
    warnings: list[str] = []
    broken = [f"{symbols[key]} ({failed[key]})" for key in sorted(failed)]
    empty = [
        symbols[key] for key in sorted(symbols) if key not in failed and not bars[key]
    ]
    if broken:
        warnings.append(f"Candle requests failed for {_sample(broken)}.")
    if empty:
        warnings.append(
            f"Upstox returned no 1-minute data at all for {_sample(empty)} on {day_str}, "
            "so every cell on those contracts is unavailable."
        )
    return warnings


async def _resolve_and_load(
    ctx: _Context, entry_times: list[str]
) -> tuple[list[_Row], dict[str, list[Bar]], list[str]]:
    """Resolve every entry time and fetch the union of contracts they touch, once each.

    Two fetch passes, one batch of contracts. The parity seeds have to be read before the
    traded strike can be chosen, so they go first; the traded pass then asks only for
    what the seed pass did not already bring back, which in synthetic mode is often
    nothing at all because the seed and the traded strike frequently coincide. In spot
    and future mode the seed pass is empty and this is the original single batch.
    """
    symbols: dict[str, str] = {}
    bars: dict[str, list[Bar]] = {}
    failed: dict[str, str] = {}

    seeds = _seed_pairs(ctx, entry_times)
    for seed in seeds.values():
        _collect(seed, symbols)
    await _fetch_series(symbols, bars, failed, ctx.date)

    rows = await _resolve_rows(ctx, entry_times, seeds, failed)
    for row in rows:
        if row.pair is not None:
            _collect(row.pair, symbols)
    await _fetch_series(symbols, bars, failed, ctx.date)

    return rows, bars, _fetch_warnings(symbols, bars, failed, ctx.date)


# --- step 4: simulate in memory ---------------------------------------------


def _leg_detail(symbol: str, instrument_key: str, leg: LegResult) -> LegDetail:
    return LegDetail(
        symbol=symbol,
        instrument_key=instrument_key,
        entry_price=leg.entry_price,
        stop_price=leg.stop_price,
        exit_price=leg.exit_price,
        exit_reason=leg.exit_reason,  # type: ignore[arg-type]
        exit_time=_hhmm(leg.exit_ts),
        pnl=leg.pnl,
    )


def _ok_cell(
    entry_time: str,
    stop_loss: float,
    result: StraddleResult,
    pair: OptionPair,
    row: "_Row",
    quantity: int,
) -> HeatmapCell:
    return HeatmapCell(
        entry_time=entry_time,
        stop_loss=stop_loss,
        status="ok",
        gross_pnl=result.gross_pnl,
        net_pnl=result.net_pnl,
        ce=_leg_detail(pair.ce_symbol, pair.ce_key, result.ce),
        pe=_leg_detail(pair.pe_symbol, pair.pe_key, result.pe),
        strike=pair.strike,
        # The raw index spot whatever the mode, beside the price the strike was actually
        # chosen from, so a reader can see how far the two diverged.
        spot_at_entry=row.spot,
        quantity=quantity,
        underlying_price=row.underlying_price,
        underlying_mode=row.underlying_mode,
    )


def _unavailable_cell(
    entry_time: str, stop_loss: float, reason: str, row: "_Row | None" = None
) -> HeatmapCell:
    """Nothing is invented here: only the mode, and the quote if there ever was one.

    The mode is a property of the run rather than of the measurement that failed, so it
    is carried even by a cell that could not be priced; underlying_price stays null
    unless the underlying was quoted and it was the legs that were missing.
    """
    return HeatmapCell(
        entry_time=entry_time,
        stop_loss=stop_loss,
        status="unavailable",
        reason=reason,
        underlying_price=row.underlying_price if row is not None else None,
        underlying_mode=row.underlying_mode if row is not None else None,
    )


def _entry_gap(pair: OptionPair, legs: dict[str, list[Bar]], row: _Row) -> str | None:
    """The reason this row cannot trade, naming the leg and the minute, or None.

    Checked once per row rather than once per cell, because it depends only on the entry
    minute and not on the stop. Both legs are named when both are missing, so a user
    reconciling by hand knows the strike was untraded rather than half-listed.
    """
    missing = [
        symbol
        for symbol, key in ((pair.ce_symbol, pair.ce_key), (pair.pe_symbol, pair.pe_key))
        if option_history.bar_at(legs.get(key, []), row.entry_ts) is None
    ]
    if not missing:
        return None
    verb = "have" if len(missing) > 1 else "has"
    return f"{' and '.join(missing)} {verb} no 1-minute bar at {row.entry_time}"


def _row_cells(
    row: _Row,
    stop_losses: list[float],
    bars: dict[str, list[Bar]],
    exit_ts: int,
    lots: int,
) -> list[HeatmapCell]:
    """Every cell of one entry time, all sharing the CE and PE arrays already in memory."""
    if row.reason is not None or row.pair is None:
        reason = row.reason or f"No contract resolved for {row.entry_time}"
        return [_unavailable_cell(row.entry_time, sl, reason, row) for sl in stop_losses]

    pair = row.pair
    gap = _entry_gap(pair, bars, row)
    if gap is not None:
        return [_unavailable_cell(row.entry_time, sl, gap, row) for sl in stop_losses]

    ce_bars = bars[pair.ce_key]
    pe_bars = bars[pair.pe_key]
    # lot_size comes from the resolved contract, never from a constant: it differs per
    # underlying and the exchange revises it.
    quantity = lots * pair.lot_size

    cells: list[HeatmapCell] = []
    for stop_loss in stop_losses:
        result = simulate_straddle(
            ce_bars, pe_bars, row.entry_ts, exit_ts, stop_loss, quantity
        )
        cells.append(_ok_cell(row.entry_time, stop_loss, result, pair, row, quantity))
    return cells


def _totals(
    cells: list[HeatmapCell], entry_times: list[str], stop_losses: list[float]
) -> tuple[dict[str, float], dict[str, float], float, int]:
    """Row, column and grand totals over the `ok` cells only.

    Every row and column is seeded, so the UI always finds its key even when the whole
    row is unavailable and contributes nothing. Only the aggregates are rounded: the
    cells themselves stay exactly as the engine computed them, so an audit still
    reconciles against the broker's own candles to the paisa.
    """
    row_totals = {entry_time: 0.0 for entry_time in entry_times}
    col_totals = {str(stop_loss): 0.0 for stop_loss in stop_losses}
    grand_total = 0.0
    unavailable = 0

    for cell in cells:
        if cell.status != "ok" or cell.net_pnl is None:
            unavailable += 1
            continue
        row_totals[cell.entry_time] += cell.net_pnl
        col_totals[str(cell.stop_loss)] += cell.net_pnl
        grand_total += cell.net_pnl

    return (
        {key: round(value, 2) for key, value in row_totals.items()},
        {key: round(value, 2) for key, value in col_totals.items()},
        round(grand_total, 2),
        unavailable,
    )


# --- public API -------------------------------------------------------------


async def run_heatmap(request: HeatmapRequest) -> HeatmapResponse:
    """Simulate the full (entry time x stop loss) grid for one date and one expiry.

    request.underlying_mode decides what the ATM strike is measured against and is echoed
    on the response and on every cell, so a saved grid still says where its strikes came
    from. It changes the strike, never the simulation: the engine below sees the same
    arrays and the same rules whichever mode chose the contracts.

    Raises HeatmapError when the request itself cannot be run, and UpstoxError when the
    underlying's candles could not be fetched at all. Anything narrower than that, a dead
    contract or an untraded minute, comes back as an unavailable cell with a reason.
    """
    ctx = await _prepare(
        request.underlying,
        request.date,
        request.expiry,
        request.exit_time,
        request.underlying_mode,
    )

    rows, bars, fetch_warnings = await _resolve_and_load(ctx, request.entry_times)
    exit_ts = _minute(ctx.day, request.exit_time)

    cells: list[HeatmapCell] = []
    for row in rows:
        cells.extend(_row_cells(row, request.stop_losses, bars, exit_ts, request.lots))

    row_totals, col_totals, grand_total, unavailable = _totals(
        cells, request.entry_times, request.stop_losses
    )

    # The response quotes one lot_size for the grid. Every cell carries its own quantity,
    # but a single expiry is a single lot size, so the first resolved contract is it.
    resolved = next((row.pair for row in rows if row.pair is not None), None)
    lot_size = resolved.lot_size if resolved is not None else ctx.default_lot_size

    warnings = ctx.warnings + fetch_warnings
    # A row can fail for two different reasons, and they need different fixes: no bar on
    # the series the mode measures means the minute is outside that session, an
    # unresolved strike means the chain is short. Reporting both as one warning would
    # send a user to the wrong one.
    no_bar = [row.entry_time for row in rows if row.failure == "underlying"]
    no_strike = [row.entry_time for row in rows if row.failure == "strike"]
    if no_bar:
        # Spot keeps the wording it has always had; the other modes name their own
        # series, which is not the index and must not be mistaken for it.
        measured = "The underlying" if ctx.mode == "spot" else _capitalised(ctx.source)
        warnings.append(
            f"{measured} has no bar at {_sample(no_bar)}; those rows could not be priced."
        )
    if no_strike:
        warnings.append(
            f"No listed CE/PE pair could be resolved for {_sample(no_strike)}."
        )
    if resolved is None:
        warnings.append(
            "No entry time resolved to a tradable strike, so the whole grid is unavailable."
        )

    return HeatmapResponse(
        underlying=ctx.underlying,
        date=ctx.date,
        expiry=ctx.expiry,
        exit_time=request.exit_time,
        lots=request.lots,
        lot_size=lot_size,
        quantity=request.lots * lot_size,
        entry_times=request.entry_times,
        stop_losses=request.stop_losses,
        cells=cells,
        row_totals=row_totals,
        col_totals=col_totals,
        grand_total=grand_total,
        unavailable_count=unavailable,
        warnings=warnings,
        underlying_mode=ctx.mode,
    )


def _traces(raw: list[dict[str, Any]], stop_price: float) -> list[BarTrace]:
    """The engine's per-bar trace, restated in the shape the audit dialog renders."""
    return [
        BarTrace(
            time=_hhmm(int(entry["ts"])),
            open=entry["open"],
            high=entry["high"],
            low=entry["low"],
            close=entry["close"],
            stop_price=stop_price,
            triggered=bool(entry["stop_hit"]),
        )
        for entry in raw
    ]


async def audit_cell(request: AuditRequest) -> AuditResponse:
    """Re-run one cell keeping every bar the engine walked, for hand reconciliation.

    Same resolution path as the grid, so an audit cannot quietly disagree with the cell
    it explains. That includes the mode: an audit sent with a different underlying_mode
    than the grid that produced the cell resolves a different strike and honestly
    explains a cell the caller is not looking at. After a heatmap run the bars are
    already cached, so this costs nothing.
    """
    ctx = await _prepare(
        request.underlying,
        request.date,
        request.expiry,
        request.exit_time,
        request.underlying_mode,
    )

    rows, bars, _ = await _resolve_and_load(ctx, [request.entry_time])
    row = rows[0]
    if row.pair is None or row.spot is None:
        # Every field of an audit describes a resolved contract, so there is no honest
        # response when nothing resolved. The reason is raised instead of invented.
        raise HeatmapError(
            f"{row.reason or 'Nothing to audit'} on {ctx.date}, so this cell cannot be "
            "reconstructed."
        )

    pair = row.pair
    spot = row.spot
    quantity = request.lots * pair.lot_size
    exit_ts = _minute(ctx.day, request.exit_time)

    gap = _entry_gap(pair, bars, row)
    if gap is not None:
        cell = _unavailable_cell(request.entry_time, request.stop_loss, gap, row)
        ce_traces: list[BarTrace] = []
        pe_traces: list[BarTrace] = []
    else:
        ce_raw: list[dict[str, Any]] = []
        pe_raw: list[dict[str, Any]] = []
        result = simulate_straddle(
            bars[pair.ce_key],
            bars[pair.pe_key],
            row.entry_ts,
            exit_ts,
            request.stop_loss,
            quantity,
            ce_raw,
            pe_raw,
        )
        cell = _ok_cell(
            request.entry_time, request.stop_loss, result, pair, row, quantity
        )
        ce_traces = _traces(ce_raw, result.ce.stop_price)
        pe_traces = _traces(pe_raw, result.pe.stop_price)

    return AuditResponse(
        underlying=ctx.underlying,
        date=ctx.date,
        expiry=ctx.expiry,
        spot_at_entry=spot,
        strike=pair.strike,
        lot_size=pair.lot_size,
        quantity=quantity,
        ce_key=pair.ce_key,
        ce_symbol=pair.ce_symbol,
        pe_key=pair.pe_key,
        pe_symbol=pair.pe_symbol,
        cell=cell,
        ce_trace=ce_traces,
        pe_trace=pe_traces,
    )
