"""Thin async client for the Upstox REST API."""

import gzip
import json
import zlib
from datetime import datetime
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from . import config

TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# The complete beginning-of-day instrument master, covering NSE, BSE, MCX and the
# GLOBAL rows in one file. Unlike every other Upstox call this is a public CDN asset,
# so it carries no Authorization header and can be refreshed before the user logs in.
INSTRUMENT_MASTER_URL = (
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
)

# Roughly 3.4 MB gzipped and 56 MB decompressed, so the read easily outlasts the 30 s
# that suffices for the JSON endpoints.
MASTER_TIMEOUT = httpx.Timeout(300.0, connect=15.0)


class UpstoxError(Exception):
    """An error returned by Upstox, carrying their error code when present."""

    def __init__(self, message: str, code: str = "", status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def _unwrap(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        raise UpstoxError(
            f"Upstox returned a non-JSON response (HTTP {response.status_code}).",
            status=502,
        ) from None

    if response.is_success and payload.get("status") != "error":
        return payload

    errors = payload.get("errors") or []
    if errors:
        first = errors[0]
        raise UpstoxError(
            first.get("message") or "Upstox rejected the request.",
            code=first.get("errorCode", ""),
            status=response.status_code if response.status_code >= 400 else 502,
        )
    raise UpstoxError(
        payload.get("message") or f"Upstox request failed (HTTP {response.status_code}).",
        status=response.status_code if response.status_code >= 400 else 502,
    )


def _auth_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }


def build_login_url(api_key: str, redirect_uri: str, state: str) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": api_key,
            "redirect_uri": redirect_uri,
            "state": state,
        }
    )
    return f"{config.UPSTOX_AUTH_DIALOG}?{query}"


async def exchange_code(
    code: str, api_key: str, api_secret: str, redirect_uri: str
) -> dict[str, Any]:
    """Trade the single-use authorization code for an access token."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.post(
            config.UPSTOX_TOKEN_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "code": code,
                "client_id": api_key,
                "client_secret": api_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    return _unwrap(response)


async def get_profile(token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.get(
            config.UPSTOX_PROFILE_URL, headers=_auth_headers(token)
        )
    return _unwrap(response).get("data", {})


async def logout(token: str) -> None:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await client.request(
            "DELETE", config.UPSTOX_LOGOUT_URL, headers=_auth_headers(token)
        )


async def historical_candles(
    token: str,
    instrument_key: str,
    unit: str,
    interval: str,
    to_date: str,
    from_date: str,
) -> list[list[Any]]:
    key = quote(instrument_key, safe="")
    url = f"{config.UPSTOX_HISTORICAL_V3}/{key}/{unit}/{interval}/{to_date}/{from_date}"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.get(url, headers=_auth_headers(token))
    return _unwrap(response).get("data", {}).get("candles", [])


async def intraday_candles(
    token: str, instrument_key: str, unit: str, interval: str
) -> list[list[Any]]:
    key = quote(instrument_key, safe="")
    url = f"{config.UPSTOX_INTRADAY_V3}/{key}/{unit}/{interval}"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.get(url, headers=_auth_headers(token))
    return _unwrap(response).get("data", {}).get("candles", [])


async def fetch_nse_equities() -> dict[str, dict[str, Any]]:
    """Download the NSE instrument master and index the equity rows by symbol."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=True) as client:
        response = await client.get(config.UPSTOX_NSE_INSTRUMENTS)
    if not response.is_success:
        raise UpstoxError(
            f"Could not download the NSE instrument file (HTTP {response.status_code}).",
            status=502,
        )

    records = json.loads(gzip.decompress(response.content))
    equities: dict[str, dict[str, Any]] = {}
    for record in records:
        if record.get("segment") != "NSE_EQ" or record.get("instrument_type") != "EQ":
            continue
        symbol = record.get("trading_symbol")
        if symbol:
            equities[symbol.upper()] = record
    return equities


def _as_int(value: Any) -> int | None:
    """Only seven master fields are guaranteed present, so never let junk abort a load."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _expiry_date(value: Any) -> str | None:
    """Expiry ships as epoch milliseconds, which the Upstox docs never state.

    Each value decodes to 23:59:59 IST on the expiry day, so the calendar date is only
    right when the conversion happens in IST. Doing it once here means no query-time
    code has to guess the unit again.
    """
    ms = _as_int(value)
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, config.IST).date().isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _master_row(record: dict[str, Any]) -> dict[str, Any] | None:
    """Project one raw master record onto the instrument_master column set."""
    instrument_key = record.get("instrument_key")
    trading_symbol = record.get("trading_symbol")
    # These two are the primary key and the one other NOT NULL column. Upstox has
    # published both on every row so far; drop the odd row that breaks that rather
    # than failing the whole rebuild.
    if not instrument_key or not trading_symbol:
        return None

    name = record.get("name")
    weekly = record.get("weekly")
    return {
        "instrument_key": instrument_key,
        "trading_symbol": trading_symbol,
        "name": name,
        "short_name": record.get("short_name"),
        "exchange": record.get("exchange"),
        "segment": record.get("segment"),
        "instrument_type": record.get("instrument_type"),
        "isin": record.get("isin"),
        "exchange_token": record.get("exchange_token"),
        "lot_size": _as_int(record.get("lot_size")),
        # Published in PAISE, stored exactly as published. Divide by 100 when displaying.
        "tick_size": _as_float(record.get("tick_size")),
        "freeze_quantity": _as_float(record.get("freeze_quantity")),
        "expiry": _expiry_date(record.get("expiry")),
        "strike_price": _as_float(record.get("strike_price")),
        # asset_key and asset_symbol are identical twins of the underlying_* pair, but
        # neither pair is present on every derivative row, so accept whichever arrives.
        "underlying_key": record.get("underlying_key") or record.get("asset_key"),
        "underlying_symbol": (
            record.get("underlying_symbol") or record.get("asset_symbol")
        ),
        # NULL means "not a derivative", which is a different fact from an F&O contract
        # that is explicitly not weekly, so an absent flag stays absent.
        "weekly": None if weekly is None else int(bool(weekly)),
        "security_type": record.get("security_type"),
        "qty_multiplier": _as_float(record.get("qty_multiplier")),
        # One indexed column serving both prefix and contains matching, so a user can
        # find a row by its ticker or by the company name behind it.
        "search_key": f"{trading_symbol} {name or ''}".upper().strip(),
    }


async def fetch_instrument_master() -> list[dict[str, Any]]:
    """Download the complete instrument master, normalised for the instrument_master table.

    Nothing is filtered out. Which instruments are chartable is a query-time decision:
    filtering at ingest is what leaves the app unable to chart indices today.
    """
    try:
        async with httpx.AsyncClient(
            timeout=MASTER_TIMEOUT, follow_redirects=True
        ) as client:
            response = await client.get(INSTRUMENT_MASTER_URL)
    except httpx.HTTPError as exc:
        # This runs as a background job, so a transport failure has to surface as the
        # same exception type the caller records against instrument_sync.
        raise UpstoxError(
            f"Could not reach the Upstox instrument file: {exc}", status=502
        ) from exc

    if not response.is_success:
        raise UpstoxError(
            f"Could not download the Upstox instrument file (HTTP {response.status_code}).",
            status=502,
        )

    # Served as Content-Type: application/gzip rather than Content-Encoding: gzip, so
    # httpx hands back the compressed bytes untouched and we decompress by hand.
    try:
        records = json.loads(gzip.decompress(response.content))
    except (OSError, EOFError, ValueError, zlib.error) as exc:
        raise UpstoxError(
            "The Upstox instrument file could not be decompressed or parsed.", status=502
        ) from exc

    if not isinstance(records, list):
        raise UpstoxError("The Upstox instrument file was not a JSON array.", status=502)

    # Drain the parsed list while projecting it. Holding 124k raw dicts alongside 124k
    # normalised ones doubles a 200 MB peak for nothing; popping from the tail frees
    # each raw record straight away, and row order is irrelevant to a wholesale rebuild.
    rows: list[dict[str, Any]] = []
    while records:
        row = _master_row(records.pop())
        if row is not None:
            rows.append(row)
    return rows
