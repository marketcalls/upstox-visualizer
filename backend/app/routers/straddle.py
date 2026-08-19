"""ATM short straddle heatmap: read-only historical analytics.

Every route here resolves listed contracts, reads past candles and simulates trades in
memory. This feature must never place, modify or cancel an order, and it deliberately
imports nothing that could: no order-placement module is reachable from this file, and
none may be added to it.

The routes stay thin on purpose. Validation and the choice of status code live here;
contract resolution, candle loading and the simulation itself live in app/services.
"""

from datetime import date

from fastapi import APIRouter, HTTPException, Query

from .. import store
from ..schemas import (
    AuditRequest,
    AuditResponse,
    HeatmapRequest,
    HeatmapResponse,
    LastSessionInfo,
    UnderlyingInfo,
)
from ..services import option_history, option_resolver, straddle_heatmap
from ..services.option_resolver import ResolverError

router = APIRouter(prefix="/api/straddle", tags=["straddle"])


def _master_conflict(exc: ResolverError) -> HTTPException:
    """Every resolver failure that can reach a route is a local-data problem.

    The underlying is already closed off before the resolver is called, by the schema
    Literal on the POST bodies and by an explicit check on the GET, so what remains is
    an instrument master that is empty or missing a chain. That is a setup step the
    user clears by re-running the download, hence 409 rather than 404 or 500. The
    resolver's own message already names the fix, so it is passed through unchanged.
    """
    return HTTPException(status_code=409, detail=str(exc))


def _require_token() -> None:
    """A backtest needs candles, and candles need a live Upstox session.

    The resolver endpoints deliberately skip this: they are pure SQL over the local
    master and stay useful while the token is expired.
    """
    if store.active_token() is None:
        raise HTTPException(
            status_code=409,
            detail="Connect your Upstox account to run a straddle backtest.",
        )


def _require_underlying(underlying: str) -> str:
    """Normalise a query-string underlying, or 404 naming the ones that do work.

    The POST bodies close this off with a schema Literal and never come through here;
    this is the GET routes, where the name arrives as free text.
    """
    name = underlying.strip().upper()
    if name not in option_resolver.SUPPORTED_UNDERLYINGS:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown underlying {underlying!r}. Supported: "
                f"{', '.join(option_resolver.SUPPORTED_UNDERLYINGS)}."
            ),
        )
    return name


def _index_key(underlying: str) -> str:
    """The index instrument_key the chain hangs off, read from the local master."""
    try:
        rows = option_resolver.list_underlyings()
    except ResolverError as exc:
        raise _master_conflict(exc) from exc

    for row in rows:
        if row["underlying"] == underlying:
            return str(row["underlying_key"])
    # list_underlyings raises unless all three resolved, so this is unreachable while
    # the supported set and the resolver agree. Kept as a 409 rather than an assert so
    # a future fourth underlying fails with the same "re-download" advice as the rest.
    raise HTTPException(
        status_code=409,
        detail=(
            f"No index instrument is linked to {underlying} in instrument_master. "
            "Re-download the instrument master and retry."
        ),
    )


def _require_expiry(underlying: str, expiry: str) -> None:
    """Reject an expiry that is not listed, before a single candle is fetched.

    Expired contracts drop out of the beginning-of-day master and the expired-
    instruments API is out of scope, so "not listed" is the whole answer: no strike
    ladder means no cell can resolve. Saying it once, with the dates that do work,
    beats returning a full grid of identical unavailable cells.
    """
    try:
        live = option_resolver.list_expiries(underlying)
    except ResolverError as exc:
        raise _master_conflict(exc) from exc

    if expiry not in live:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Expiry {expiry} is not listed for {underlying}. "
                f"Live expiries: {', '.join(live) or 'none'}."
            ),
        )


def _require_session_date(backtest_date: str, expiry: str) -> None:
    """Reject the date mistakes that could only ever produce an empty grid.

    The schema enforces the YYYY-MM-DD shape; this is about meaning. Zero-padded ISO
    dates compare correctly as plain text, so the expiry test needs no parsing.
    """
    try:
        parsed = date.fromisoformat(backtest_date)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{backtest_date} is not a real calendar date.",
        ) from exc

    today = store.now_ist().date()
    if parsed > today:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Backtest date {backtest_date} is in the future. "
                f"Pick a session on or before {today.isoformat()}."
            ),
        )
    if backtest_date > expiry:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Backtest date {backtest_date} is after expiry {expiry}, "
                "when that contract was no longer trading."
            ),
        )


@router.get("/underlyings", response_model=list[UnderlyingInfo])
def underlyings() -> list[UnderlyingInfo]:
    """The three backtestable index chains, with the lot size read from the master."""
    try:
        rows = option_resolver.list_underlyings()
    except ResolverError as exc:
        raise _master_conflict(exc) from exc

    return [
        UnderlyingInfo(
            symbol=row["underlying"],
            index_instrument_key=row["underlying_key"],
            option_segment=row["segment"],
            lot_size=row["lot_size"],
        )
        for row in rows
    ]


@router.get("/expiries", response_model=list[str])
def expiries(underlying: str = Query(..., min_length=1, max_length=20)) -> list[str]:
    """Ascending expiries still present in the master, which is the backtestable set."""
    name = _require_underlying(underlying)

    try:
        return option_resolver.list_expiries(name)
    except ResolverError as exc:
        raise _master_conflict(exc) from exc


@router.get("/last-session", response_model=LastSessionInfo)
async def last_session(
    underlying: str = Query(..., min_length=1, max_length=20),
) -> LastSessionInfo:
    """The most recent date that really has 1-minute bars for this index.

    The date picker defaults to this instead of to today, because today only has bars
    once its session has started: before 09:15, and on a weekend or a holiday, the
    honest answer is the previous trading day, and offering today would hand back a
    grid that is unavailable end to end. is_today tells the UI which one it got.

    This reads candles rather than the instrument master, so unlike /underlyings and
    /expiries it needs a live Upstox session.
    """
    name = _require_underlying(underlying)
    _require_token()
    index_key = _index_key(name)

    found, is_today = await option_history.last_session_date(index_key)

    # last_session_date falls back to today when its lookback window turns up nothing,
    # so today-with-no-bars is the one answer that means "found nothing at all", and it
    # has to be told apart from today-during-a-live-session before the date is offered
    # as a default. The probe it already ran is memoised, so this re-read is free.
    if is_today and not await option_history.underlying_bars(index_key, found):
        raise HTTPException(
            status_code=409,
            detail=(
                f"No 1-minute {name} candles were found for any recent session, so "
                "there is no date to back a grid. Check the Upstox connection and retry."
            ),
        )

    return LastSessionInfo(date=found, is_today=is_today)


@router.post("/heatmap", response_model=HeatmapResponse)
async def heatmap(request: HeatmapRequest) -> HeatmapResponse:
    """Run the entry-time by stop-loss grid for one date and one expiry.

    underlying_mode rides along on the request body and is the service's decision to
    act on: what a strike is measured against is not something a route can validate,
    since a mode only fails at an individual minute where its source has no bar, and
    that is reported per cell rather than as a status code.
    """
    _require_session_date(request.date, request.expiry)
    _require_expiry(request.underlying, request.expiry)
    _require_token()

    try:
        return await straddle_heatmap.run_heatmap(request)
    except ResolverError as exc:
        raise _master_conflict(exc) from exc


@router.post("/audit", response_model=AuditResponse)
async def audit(request: AuditRequest) -> AuditResponse:
    """Re-run one cell and return every bar the engine walked, for manual checking.

    Send the same underlying_mode the grid was built with, or the audit resolves a
    different strike and explains a cell the caller is not looking at.
    """
    _require_session_date(request.date, request.expiry)
    _require_expiry(request.underlying, request.expiry)
    _require_token()

    try:
        return await straddle_heatmap.audit_cell(request)
    except ResolverError as exc:
        raise _master_conflict(exc) from exc
