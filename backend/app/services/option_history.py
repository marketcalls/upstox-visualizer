"""One trading day of 1-minute bars for a contract: SQLite cache first, Upstox on a miss.

This is the only place in the backtest that talks to the network, so every rule about
Upstox candle data is enforced here once and the engine above it can stay pure:

- Upstox returns candles NEWEST FIRST. Verified twice against the live API. Everything
  that leaves this module is sorted ASCENDING, because a backwards walk would fire a
  stop on the wrong bar and still look plausible.
- An empty candles array is a normal answer, not an error. A deep-ITM strike genuinely
  has no trades. It comes back as an empty list and the caller reports the cell
  unavailable.
- A series may start late and have holes. `BANKNIFTY 54000 CE 25 AUG 26` returned bars
  from 09:28 onwards, not 09:15. So "no bar at that minute" is routine, which is why
  lookups return None rather than the nearest neighbour.
- The historical endpoint EXCLUDES the current day, so there are two endpoints, not one.
  Measured on 2026-08-19: `/v3/historical-candle/{key}/minutes/1/2026-08-19/2026-08-19`
  answered 200 with zero candles, while `/v3/historical-candle/intraday/{key}/minutes/1`
  answered 200 with all 375 bars of that same session. The intraday endpoint takes no
  dates and always means the session now in progress, so it is used only when the
  requested date IS today in IST, and the historical one covers every finished day.

Timestamps arrive as ISO 8601 with an explicit IST offset (`2026-08-18T09:15:00+05:30`)
and are stamped at the bar OPEN. They are converted to epoch seconds here so the engine
never handles a datetime, naive or otherwise.
"""

import sqlite3
import time
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

import httpx

from .. import store, upstox
from ..config import IST
from ..upstox import UpstoxError
from .straddle_engine import Bar

# The grid is defined in one-minute bars, and this pair is also the cache key in the
# candles table: (instrument_key, unit, interval, ts) is its primary key.
CANDLE_UNIT = "minutes"
CANDLE_INTERVAL = "1"

# How far back into the candle cache one lookup is allowed to see. store.load_candles
# takes the NEWEST rows, so a full result set means older rows were clipped off the
# bottom and the oldest day in it may be half a session. A single contract holds at
# most a few thousand one-minute rows (it lives weeks, and one session is under 400
# bars), so this is never reached in practice; it exists so the clipped case is
# detectable rather than silently short.
CACHE_LIMIT = 50000

# (instrument_key, date) -> ascending bars, for the life of one heatmap run.
#
# A 12 x 10 grid resolves the same ATM strike for many adjacent entry times, so without
# this the same contract would be re-read, re-parsed and possibly re-fetched dozens of
# times. Deliberately a plain dict: the run that fills it is measured in seconds.
_MEMO: dict[tuple[str, str], list[Bar]] = {}

# The memo is process-wide, so cap it rather than let a long-lived server accumulate
# every contract ever backtested. Clearing wholesale on overflow instead of evicting
# the oldest entry keeps this a dict and not a cache implementation; the SQLite cache
# underneath absorbs the cost of the next miss.
MEMO_LIMIT = 500

# How long a copy of TODAY's session may be reused from SQLite. The session is still
# growing, so stored rows stop describing it almost immediately; a minute is long enough
# that rerunning a grid does not refetch every contract again, and short enough that the
# rerun still picks up the minutes that have since printed. A finished day never changes
# and is cached with no expiry at all.
TODAY_CACHE_TTL_SECONDS = 60.0

# How far back last_session_date walks before giving up. Ten calendar days clears the
# longest run of weekend plus holiday closures the exchange calendar produces.
LAST_SESSION_LOOKBACK_DAYS = 10

# (instrument_key, date) -> monotonic clock reading at the moment that day was last
# pulled from Upstox by THIS process. Only consulted for a session still in progress.
# Deliberately process local: it records a fetch this process actually made, so it can
# never vouch for rows some earlier run left in SQLite, and a restart just refetches.
_FETCHED_AT: dict[tuple[str, str], float] = {}


def clear_memo() -> None:
    """Drop the in-process memo.

    Call at the START of a heatmap run that includes today's date: bars for a session
    still in progress are the one case where a memo from a previous run is stale.

    The fetch stamps are left alone on purpose. They are what holds today's SQLite rows
    to a one-minute life, and clearing them here would turn every rerun of today into a
    full refetch of every contract in the grid.
    """
    _MEMO.clear()


# --- internals --------------------------------------------------------------


def _check_date(date: str) -> str:
    """A date reaches the Upstox URL as a path segment, so it is validated, not trusted."""
    try:
        return datetime.strptime(date, "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        raise ValueError(f"Expected a YYYY-MM-DD date, got {date!r}.") from None


def _epoch(stamp: Any) -> int | None:
    """ISO 8601 with an IST offset to epoch seconds, or None if the row is unusable."""
    try:
        moment = datetime.fromisoformat(str(stamp))
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        # Every timestamp Upstox has returned carries +05:30. One that arrives without
        # a zone must still be read as IST: reading it as server local time would move
        # every bar by hours on a machine that is not in India.
        moment = moment.replace(tzinfo=IST)
    return int(moment.timestamp())


def _ist_date(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, IST).date().isoformat()


def _today_ist() -> str:
    """Today's IST date. The endpoint choice and the cache rule both turn on it."""
    return store.now_ist().date().isoformat()


def _is_today(date: str) -> bool:
    """Whether this date is the session the intraday endpoint would return."""
    return date == _today_ist()


def _to_bars(rows: Sequence[Sequence[Any]], date: str) -> list[Bar]:
    """Parse candle rows into ascending Bars for one IST calendar date.

    Accepts both row shapes unchanged, because their first six fields agree: the Upstox
    payload is `[ts, open, high, low, close, volume, open_interest]` and
    store.load_candles selects `ts, open, high, low, close, volume` in that order.

    Rows are keyed by timestamp before sorting, so a duplicated minute cannot produce
    two bars for the same instant, and a row that will not parse is skipped rather than
    aborting the whole contract.
    """
    by_ts: dict[int, Bar] = {}
    for row in rows:
        if row is None or len(row) < 6:
            continue
        ts = _epoch(row[0])
        # The date is checked against the parsed IST instant rather than the string
        # prefix, so a timestamp in another offset would still land on the right day.
        if ts is None or _ist_date(ts) != date:
            continue
        try:
            by_ts[ts] = Bar(
                ts=ts,
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                volume=int(row[5] or 0),
            )
        except (TypeError, ValueError):
            continue
    # The sort is the point of this module. Upstox hands back newest first.
    return [by_ts[ts] for ts in sorted(by_ts)]


def _recently_fetched(instrument_key: str, date: str) -> bool:
    """Whether an unfinished day was pulled from Upstox recently enough to reuse."""
    stamped = _FETCHED_AT.get((instrument_key, date))
    return stamped is not None and time.monotonic() - stamped < TODAY_CACHE_TTL_SECONDS


def _stamp_fetch(key: tuple[str, str]) -> None:
    """Record that this process just fetched that day. Capped like the memo."""
    if len(_FETCHED_AT) >= MEMO_LIMIT:
        _FETCHED_AT.clear()
    _FETCHED_AT[key] = time.monotonic()


def _cached_day(instrument_key: str, date: str) -> list[Bar] | None:
    """Bars for that date already in SQLite, or None when the cache cannot answer.

    None means "ask Upstox". An empty day is never a hit: the candles table cannot
    record that a contract had no trades, only that nothing was stored for it.
    """
    # Today's session is still being written, so whatever is stored for it is a partial
    # day that would otherwise read as a session ending early. A finished day is served
    # from the cache forever; an unfinished one only within TODAY_CACHE_TTL_SECONDS of
    # the fetch that wrote it, which is short enough that the missing tail is a minute
    # of bars rather than hours of them.
    if date >= _today_ist() and not _recently_fetched(instrument_key, date):
        return None

    rows: list[sqlite3.Row] = store.load_candles(
        instrument_key, CANDLE_UNIT, CANDLE_INTERVAL, limit=CACHE_LIMIT
    )
    if not rows:
        return None

    bars = _to_bars(rows, date)
    if not bars:
        return None
    # rows is ascending, so rows[0] is the oldest row that survived the clip. If the
    # requested date IS that oldest day and the limit was reached, its earlier minutes
    # may have been cut off, and a truncated morning is exactly what an entry-time grid
    # would misread. Refetch instead.
    if len(rows) >= CACHE_LIMIT and _ist_date(bars[0].ts) == date:
        return None
    return bars


async def _fetch_day(instrument_key: str, date: str) -> list[list[Any]]:
    """One V3 candle call for a single date, returned raw and unsorted.

    Which endpoint is not a preference, it is which one holds the day. A finished day
    goes to upstox.historical_candles, which builds
    `/v3/historical-candle/{key}/minutes/1/{to_date}/{from_date}`. Today goes to
    upstox.intraday_candles and `/v3/historical-candle/intraday/{key}/minutes/1`, because
    the historical endpoint answers for today with an empty array. Both URL-encode the
    key with `quote(safe="")`, which is what makes `NSE_INDEX|Nifty 50` a legal path
    segment, and both share the _unwrap error handling.

    The intraday endpoint names no date, so nothing here promises it returned the session
    that was asked for. Nothing needs to: _to_bars keeps only the rows whose IST date is
    the requested one, so a stale session would come back empty rather than misdated.
    """
    token = store.active_token()
    if not token:
        raise UpstoxError(
            "Not connected to Upstox, so option candles cannot be fetched. "
            "Connect the account and run the backtest again.",
            status=401,
        )
    try:
        if _is_today(date):
            return await upstox.intraday_candles(
                token, instrument_key, CANDLE_UNIT, CANDLE_INTERVAL
            )
        return await upstox.historical_candles(
            token, instrument_key, CANDLE_UNIT, CANDLE_INTERVAL, date, date
        )
    except httpx.HTTPError as exc:
        # A grid fetches many contracts, so a transport failure has to arrive as the
        # same UpstoxError the caller already handles per contract, not as a raw httpx
        # exception that takes the whole run down as a 500.
        raise UpstoxError(
            f"Could not reach Upstox for {instrument_key} on {date}: {exc}", status=502
        ) from exc


def _remember(key: tuple[str, str], bars: list[Bar]) -> None:
    if len(_MEMO) >= MEMO_LIMIT:
        _MEMO.clear()
    _MEMO[key] = bars


async def _day_bars(instrument_key: str, date: str) -> list[Bar]:
    """Memo, then SQLite, then Upstox. Whatever is fetched is written back."""
    day = _check_date(date)
    memo_key = (instrument_key, day)
    memoised = _MEMO.get(memo_key)
    if memoised is not None:
        return memoised

    bars = _cached_day(instrument_key, day)
    if bars is None:
        rows = await _fetch_day(instrument_key, day)
        # Stored verbatim, exactly as save_candles expects: ts stays the ISO string it
        # arrived as, so a later read parses the same text the API published.
        store.save_candles(instrument_key, CANDLE_UNIT, CANDLE_INTERVAL, rows)
        _stamp_fetch(memo_key)
        bars = _to_bars(rows, day)

    _remember(memo_key, bars)
    return bars


# --- public API -------------------------------------------------------------


async def underlying_bars(instrument_key: str, date: str) -> list[Bar]:
    """Ascending 1-minute index bars for one date, used to read spot at each entry time.

    Indices publish no volume, so every bar carries volume 0, and a full session is 375
    bars from 09:15 to 15:29. Fetched once per heatmap run. Today answers with however
    many minutes have printed so far, which is what makes a same-day backtest possible.
    """
    return await _day_bars(instrument_key, date)


async def option_bars(instrument_key: str, date: str) -> list[Bar]:
    """Ascending 1-minute option bars for one date.

    A liquid contract returns about 385 bars. An illiquid one starts late, has gaps, or
    returns nothing at all; all three come back as a short or empty list, never as an
    error, because they are facts about the contract rather than failures of the fetch.
    """
    return await _day_bars(instrument_key, date)


async def last_session_date(index_key: str) -> tuple[str, bool]:
    """The most recent date with 1-minute data for that index, and whether it is today.

    The date field on the straddle form defaults to this, so it has to be quick as well
    as right. Today is tried first and costs one intraday call, which answers on any
    trading day from 09:15 onwards. Only when that comes back empty, before the open, at
    a weekend or on an exchange holiday, does it walk backwards, and Saturdays and
    Sundays are skipped without spending a call, so the usual walk is one historical call
    and the worst case inside the window is a handful.

    Every probe goes through underlying_bars, so the memo and the SQLite cache absorb the
    cost and the day it settles on is already loaded for the backtest that follows.

    If nothing is found inside the window it returns today, which leaves the form on a
    sane default rather than blank. The flag says whether the returned date is today, not
    whether data was found, so a caller that cares must look at the date it got back.
    """
    today = _today_ist()
    if await underlying_bars(index_key, today):
        return today, True

    day = datetime.strptime(today, "%Y-%m-%d").date()
    for _ in range(LAST_SESSION_LOOKBACK_DAYS):
        day -= timedelta(days=1)
        # The exchange is shut every Saturday and Sunday, so a call for one would only
        # ever return an empty array. Skipping them locally is what keeps this fast.
        if day.weekday() >= 5:
            continue
        stamp = day.isoformat()
        if await underlying_bars(index_key, stamp):
            return stamp, False
    return today, True


def bar_at(bars: Sequence[Bar], ts: int) -> Bar | None:
    """The bar stamped exactly ts, or None.

    None is the answer for an entry minute the contract never traded, and it must stay
    None: substituting the neighbouring minute would silently price a trade that could
    not have been placed. O(log n), because a grid asks this thousands of times.
    """
    index = bisect_left(bars, ts, key=lambda bar: bar.ts)
    if index < len(bars) and bars[index].ts == ts:
        return bars[index]
    return None


def last_bar_at_or_before(bars: Sequence[Bar], ts: int) -> Bar | None:
    """The most recent bar at or before ts, or None if the series starts after it.

    This is the exit-time lookup: a series that ends early still exits at its own last
    bar, which the engine reports as a TIME exit.
    """
    index = bisect_right(bars, ts, key=lambda bar: bar.ts)
    return bars[index - 1] if index else None
