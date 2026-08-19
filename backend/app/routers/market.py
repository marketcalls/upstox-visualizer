"""Candle data: fetch from Upstox, cache in SQLite, serve the last N sessions."""

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from .. import store, upstox
from ..config import (
    DEFAULT_INTERVAL,
    DEFAULT_SESSIONS,
    DEFAULT_SYMBOL,
    DEFAULT_UNIT,
    EQUITY_SEGMENTS,
    INDEX_SEGMENTS,
    IST,
    SEARCH_LIMIT_DEFAULT,
    SEARCH_LIMIT_MAX,
    SEED_INSTRUMENTS,
    SYNC_ERROR,
    SYNC_IDLE,
    SYNC_OK,
    SYNC_RUNNING,
    UPSTOX_COMPLETE_INSTRUMENTS,
)
from ..schemas import (
    Candle,
    CandleResponse,
    CandleStats,
    Instrument,
    InstrumentSearchResult,
    InstrumentSyncStatus,
    SegmentCount,
    SessionSummary,
)

router = APIRouter(prefix="/api/market", tags=["market"])

# Order the symbol fallback walks. Equities come before indices because BSE publishes
# index codes (AUTO, METAL, POWER, ENERGY) that collide with real equity tickers, and a
# bare symbol means the stock. Derivatives are only reached by the unfiltered last step.
RESOLVE_SEGMENTS: tuple[str, ...] = tuple(EQUITY_SEGMENTS) + tuple(INDEX_SEGMENTS)

# Nothing clears instrument_sync if the process dies mid-download, so a run older than
# this is treated as dead instead of blocking every later attempt with a 409 forever.
STALE_RUN_AFTER = timedelta(minutes=15)


def _to_epoch(iso_ts: str) -> int:
    return int(datetime.fromisoformat(iso_ts).timestamp())


def _session_date(iso_ts: str) -> str:
    return iso_ts[:10]


def _merge(*groups: list[list[Any]]) -> list[list[Any]]:
    """Combine candle batches, drop duplicate timestamps and sort oldest first."""
    by_ts: dict[str, list[Any]] = {}
    for group in groups:
        for candle in group:
            if candle and len(candle) >= 6:
                by_ts[candle[0]] = candle
    return [by_ts[ts] for ts in sorted(by_ts)]


def _trim_to_sessions(candles: list[list[Any]], sessions: int) -> list[list[Any]]:
    dates = sorted({_session_date(c[0]) for c in candles})
    keep = set(dates[-sessions:])
    return [c for c in candles if _session_date(c[0]) in keep]


def _summarise(candles: list[list[Any]]) -> list[SessionSummary]:
    grouped: dict[str, list[list[Any]]] = {}
    for candle in candles:
        grouped.setdefault(_session_date(candle[0]), []).append(candle)

    summaries: list[SessionSummary] = []
    previous_close: float | None = None
    for date in sorted(grouped):
        bars = grouped[date]
        close = float(bars[-1][4])
        open_ = float(bars[0][1])
        base = previous_close if previous_close is not None else open_
        summaries.append(
            SessionSummary(
                date=date,
                open=open_,
                high=max(float(b[2]) for b in bars),
                low=min(float(b[3]) for b in bars),
                close=close,
                volume=sum(int(b[5]) for b in bars),
                change_pct=round((close - base) / base * 100, 2) if base else 0.0,
                candles=len(bars),
            )
        )
        previous_close = close
    return summaries


def _stats(
    candles: list[list[Any]], sessions: list[SessionSummary]
) -> CandleStats | None:
    if not candles or not sessions:
        return None

    last = sessions[-1]
    reference = sessions[-2].close if len(sessions) > 1 else last.open
    change = last.close - reference
    return CandleStats(
        last_price=round(last.close, 2),
        change=round(change, 2),
        change_pct=round(change / reference * 100, 2) if reference else 0.0,
        day_high=round(last.high, 2),
        day_low=round(last.low, 2),
        range_high=round(max(s.high for s in sessions), 2),
        range_low=round(min(s.low for s in sessions), 2),
        total_volume=sum(s.volume for s in sessions),
        candle_count=len(candles),
        first_candle=candles[0][0],
        last_candle=candles[-1][0],
    )


def _rows_to_candles(rows: list[Any]) -> list[list[Any]]:
    return [
        [r["ts"], r["open"], r["high"], r["low"], r["close"], r["volume"], 0]
        for r in rows
    ]


# --- instrument master ------------------------------------------------------


def _running_is_stale(started_at: str | None) -> bool:
    if not started_at:
        return True
    try:
        began = datetime.fromisoformat(started_at)
    except ValueError:
        return True
    # Timestamps are written in IST; assume it for a value that arrived without a zone.
    if began.tzinfo is None:
        began = began.replace(tzinfo=IST)
    return store.now_ist() - began > STALE_RUN_AFTER


def _download_in_flight(row: Any | None) -> bool:
    return (
        row is not None
        and row["status"] == SYNC_RUNNING
        and not _running_is_stale(row["started_at"])
    )


def _master_is_stale(row: Any | None) -> bool:
    """Upstox republishes the file once a day around 06:00 IST, so one good rebuild per
    IST calendar day is enough and every later login can skip the 3.4 MB download."""
    if row is None or row["status"] != SYNC_OK or not row["row_count"]:
        return True
    finished = row["finished_at"]
    # finished_at is an IST ISO timestamp, so its date prefix is the IST calendar day.
    return not finished or finished[:10] != store.now_ist().date().isoformat()


async def _run_master_download() -> None:
    """Rebuild instrument_master from the public BOD file.

    Deliberately swallows everything: this runs after the response has been sent, so the
    instrument_sync row the UI polls is the only place a failure can be reported.
    """
    try:
        rows = await upstox.fetch_instrument_master()
        count = store.replace_instrument_master(rows)
    except upstox.UpstoxError as exc:
        store.mark_sync(
            SYNC_ERROR,
            message=exc.message,
            source_url=UPSTOX_COMPLETE_INSTRUMENTS,
        )
    except Exception as exc:
        store.mark_sync(
            SYNC_ERROR,
            message=f"{type(exc).__name__}: {exc}",
            source_url=UPSTOX_COMPLETE_INSTRUMENTS,
        )
    else:
        store.mark_sync(
            SYNC_OK,
            row_count=count,
            source_url=UPSTOX_COMPLETE_INSTRUMENTS,
        )


def schedule_master_download(
    background_tasks: BackgroundTasks, only_if_stale: bool = False
) -> bool:
    """Queue the rebuild to run once the current response has been sent.

    The sync row is marked running here rather than inside the task so that a poll or a
    second click arriving immediately after already sees the run that is about to start.
    Returns False when the download was skipped.
    """
    row = store.instrument_sync_status()
    if _download_in_flight(row):
        return False
    if only_if_stale and not _master_is_stale(row):
        return False
    store.mark_sync(SYNC_RUNNING, source_url=UPSTOX_COMPLETE_INSTRUMENTS)
    background_tasks.add_task(_run_master_download)
    return True


def _sync_status() -> InstrumentSyncStatus:
    # Read the counts positionally: SQLite names an aggregate column after whatever the
    # query aliased it to, but the pair is always (segment, count).
    segments = [
        SegmentCount(segment=row[0], count=row[1])
        for row in store.master_segment_counts()
    ]
    row = store.instrument_sync_status()
    if row is None:
        return InstrumentSyncStatus(
            status=SYNC_IDLE, source_url=UPSTOX_COMPLETE_INSTRUMENTS, segments=segments
        )

    status = row["status"]
    message = row["message"]
    if status == SYNC_RUNNING and _running_is_stale(row["started_at"]):
        # The worker died with the row still marked running; nothing else will move it.
        status = SYNC_ERROR
        message = message or "The previous download stopped before it finished."
    return InstrumentSyncStatus(
        status=status,
        row_count=row["row_count"] or 0,
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        source_url=row["source_url"] or UPSTOX_COMPLETE_INSTRUMENTS,
        message=message,
        segments=segments,
    )


# --- instrument resolution --------------------------------------------------


def _curated_instrument(row: Any) -> Instrument:
    return Instrument(
        symbol=row["symbol"],
        name=row["name"],
        instrument_key=row["instrument_key"],
        segment=row["segment"],
    )


def _master_instrument(row: Any) -> Instrument:
    return Instrument(
        symbol=row["trading_symbol"],
        # name is nullable in the master, and the ticker beats an empty chart header.
        name=row["name"] or row["trading_symbol"],
        instrument_key=row["instrument_key"],
        segment=row["segment"] or "",
    )


def _not_found(detail: str) -> HTTPException:
    row = store.instrument_sync_status()
    if row is None or row["status"] != SYNC_OK:
        detail += " The instrument master has not been downloaded yet."
    return HTTPException(status_code=404, detail=detail)


def _resolve_instrument(symbol: str) -> Instrument:
    """Curated table first, then the downloaded master.

    Keeping the curated lookup first preserves the friendly names on the seeded five;
    the master fallback is what makes the other 124k rows chartable.
    """
    row = store.get_instrument(symbol)
    if row is not None:
        return _curated_instrument(row)

    # One unfiltered lookup covers almost everything, because the store already ranks
    # cash and index rows above derivatives.
    match = store.find_instrument_key(symbol)
    if match is not None and match["segment"] in RESOLVE_SEGMENTS:
        return _master_instrument(match)

    # It landed on a contract row, so make the preference explicit rather than trusting
    # a shared ORDER BY to keep meaning the same thing.
    for segment in RESOLVE_SEGMENTS:
        preferred = store.find_instrument_key(symbol, segment)
        if preferred is not None:
            return _master_instrument(preferred)

    # Nothing in cash or index: accept a derivative contract typed out in full.
    if match is not None:
        return _master_instrument(match)

    raise _not_found(f"{symbol.upper()} was not found.")


def _resolve_key(instrument_key: str) -> Instrument:
    """Resolve an exact key, which is what the search box hands back: no ambiguity."""
    row = store.get_master_row(instrument_key)
    if row is not None:
        return _master_instrument(row)

    # The master may not be downloaded yet, but the seeded five already carry keys.
    for curated in store.list_instruments():
        if curated["instrument_key"] == instrument_key:
            return _curated_instrument(curated)

    raise _not_found(f"Unknown instrument key {instrument_key}.")


@router.get("/instruments", response_model=list[Instrument])
def instruments() -> list[Instrument]:
    return [
        Instrument(
            symbol=r["symbol"],
            name=r["name"],
            instrument_key=r["instrument_key"],
            segment=r["segment"],
        )
        for r in store.list_instruments()
    ]


@router.post("/instruments/refresh")
async def refresh_instruments() -> dict[str, Any]:
    """Re-resolve the seeded symbols against the Upstox NSE instrument master."""
    try:
        equities = await upstox.fetch_nse_equities()
    except upstox.UpstoxError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc

    updated: list[str] = []
    for symbol, fallback_name, _, _ in SEED_INSTRUMENTS:
        record = equities.get(symbol)
        if not record:
            continue
        store.upsert_instrument(
            symbol,
            record.get("name") or fallback_name,
            record["instrument_key"],
            record.get("segment", "NSE_EQ"),
        )
        updated.append(symbol)
    return {"updated": updated, "available": len(equities)}


@router.post("/instruments/download", response_model=InstrumentSyncStatus)
def download_instruments(background_tasks: BackgroundTasks) -> InstrumentSyncStatus:
    """Rebuild the full instrument master. Returns at once; the work runs afterwards."""
    if not schedule_master_download(background_tasks):
        raise HTTPException(
            status_code=409,
            detail="An instrument master download is already running.",
        )
    return _sync_status()


@router.get("/instruments/status", response_model=InstrumentSyncStatus)
def instruments_status() -> InstrumentSyncStatus:
    return _sync_status()


@router.get("/search", response_model=list[InstrumentSearchResult])
def search(
    q: str = Query(..., min_length=1, max_length=50),
    exchange: str | None = Query(None, max_length=20),
    segment: str | None = Query(None, max_length=20),
    instrument_type: str | None = Query(None, max_length=20),
    limit: int = Query(SEARCH_LIMIT_DEFAULT, ge=1, le=SEARCH_LIMIT_MAX),
) -> list[InstrumentSearchResult]:
    """Ranked typeahead over the local master: no token, no quota, no round trip."""
    rows = store.search_instruments(
        q,
        exchange=exchange,
        segment=segment,
        instrument_type=instrument_type,
        limit=limit,
    )
    return [InstrumentSearchResult(**dict(row)) for row in rows]


@router.get("/candles", response_model=CandleResponse)
async def candles(
    symbol: str = Query(DEFAULT_SYMBOL),
    instrument_key: str | None = Query(None, max_length=120),
    unit: str = Query(DEFAULT_UNIT, pattern="^(minutes|hours|days|weeks|months)$"),
    interval: str = Query(DEFAULT_INTERVAL, pattern=r"^\d{1,3}$"),
    sessions: int = Query(DEFAULT_SESSIONS, ge=1, le=30),
) -> CandleResponse:
    # An exact key wins over a symbol: it is what a search result carries, and unlike a
    # ticker it cannot mean two different rows in two segments.
    instrument = (
        _resolve_key(instrument_key) if instrument_key else _resolve_instrument(symbol)
    )
    token = store.active_token()

    source = "upstox"
    notice: str | None = None
    merged: list[list[Any]] = []

    if token:
        today = store.now_ist().date()
        # Reach back far enough that weekends and market holidays still leave
        # `sessions` trading days inside the window.
        from_date = (today - timedelta(days=max(sessions * 3, 12))).isoformat()
        try:
            historical = await upstox.historical_candles(
                token,
                instrument.instrument_key,
                unit,
                interval,
                today.isoformat(),
                from_date,
            )
        except upstox.UpstoxError as exc:
            raise HTTPException(
                status_code=exc.status,
                detail=f"{exc.message} ({exc.code})" if exc.code else exc.message,
            ) from exc

        # Today's bars are only on the intraday endpoint while the market is open.
        try:
            intraday = await upstox.intraday_candles(
                token, instrument.instrument_key, unit, interval
            )
        except upstox.UpstoxError:
            intraday = []

        merged = _merge(historical, intraday)
        store.save_candles(instrument.instrument_key, unit, interval, merged)
    else:
        notice = "Not connected to Upstox: showing the last data saved locally."

    if not merged:
        cached = store.load_candles(instrument.instrument_key, unit, interval)
        merged = _rows_to_candles(cached)
        source = "cache"
        if not merged:
            raise HTTPException(
                status_code=409 if not token else 404,
                detail=(
                    "Connect your Upstox account to load candles."
                    if not token
                    else f"Upstox returned no candles for {instrument.symbol}."
                ),
            )

    window = _trim_to_sessions(merged, sessions)
    summaries = _summarise(window)

    return CandleResponse(
        instrument=instrument,
        unit=unit,  # type: ignore[arg-type]
        interval=interval,
        sessions=summaries,
        candles=[
            Candle(
                time=_to_epoch(c[0]),
                iso=c[0],
                open=round(float(c[1]), 2),
                high=round(float(c[2]), 2),
                low=round(float(c[3]), 2),
                close=round(float(c[4]), 2),
                volume=int(c[5]),
            )
            for c in window
        ],
        stats=_stats(window, summaries),
        source=source,  # type: ignore[arg-type]
        fetched_at=store.now_ist().isoformat(),
        notice=notice,
    )
