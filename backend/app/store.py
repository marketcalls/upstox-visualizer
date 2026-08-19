"""Read and write helpers over the SQLite tables."""

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Any

from .config import (
    IST,
    SEARCH_LIMIT_DEFAULT,
    SEARCH_LIMIT_MAX,
    SEGMENT_SEARCH_RANK,
    SYNC_RUNNING,
    TOKEN_EXPIRY_HOUR,
    TOKEN_EXPIRY_MINUTE,
    UNRANKED_SEGMENT_RANK,
)
from .db import session


def now_ist() -> datetime:
    return datetime.now(IST)


def token_expiry(issued: datetime) -> datetime:
    """Upstox tokens die at 3:30 AM IST on the trading day after they are issued."""
    cutoff = issued.replace(
        hour=TOKEN_EXPIRY_HOUR, minute=TOKEN_EXPIRY_MINUTE, second=0, microsecond=0
    )
    if issued >= cutoff:
        cutoff += timedelta(days=1)
    return cutoff


# --- credentials ------------------------------------------------------------


def get_settings() -> sqlite3.Row | None:
    with session() as conn:
        return conn.execute("SELECT * FROM app_settings WHERE id = 1").fetchone()


def save_settings(api_key: str, api_secret: str, redirect_uri: str) -> None:
    with session() as conn:
        conn.execute(
            """INSERT INTO app_settings (id, api_key, api_secret, redirect_uri, updated_at)
               VALUES (1, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   api_key = excluded.api_key,
                   api_secret = excluded.api_secret,
                   redirect_uri = excluded.redirect_uri,
                   updated_at = excluded.updated_at""",
            (api_key, api_secret, redirect_uri, now_ist().isoformat()),
        )


# --- broker session ---------------------------------------------------------


def save_session(token_payload: dict[str, Any]) -> None:
    issued = now_ist()
    with session() as conn:
        conn.execute("DELETE FROM broker_session")
        conn.execute(
            """INSERT INTO broker_session (
                   id, access_token, extended_token, user_id, user_name, email, broker,
                   exchanges, products, order_types, is_active, issued_at, expires_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                token_payload.get("access_token"),
                token_payload.get("extended_token"),
                token_payload.get("user_id"),
                token_payload.get("user_name"),
                token_payload.get("email"),
                token_payload.get("broker"),
                json.dumps(token_payload.get("exchanges") or []),
                json.dumps(token_payload.get("products") or []),
                json.dumps(token_payload.get("order_types") or []),
                1 if token_payload.get("is_active", True) else 0,
                issued.isoformat(),
                token_expiry(issued).isoformat(),
            ),
        )


def get_session_row() -> sqlite3.Row | None:
    with session() as conn:
        return conn.execute("SELECT * FROM broker_session WHERE id = 1").fetchone()


def clear_session() -> None:
    with session() as conn:
        conn.execute("DELETE FROM broker_session")


def active_token() -> str | None:
    row = get_session_row()
    if row is None:
        return None
    if datetime.fromisoformat(row["expires_at"]) <= now_ist():
        return None
    return row["access_token"]


# --- instruments ------------------------------------------------------------


def list_instruments() -> list[sqlite3.Row]:
    with session() as conn:
        return conn.execute(
            "SELECT * FROM instruments ORDER BY symbol"
        ).fetchall()


def get_instrument(symbol: str) -> sqlite3.Row | None:
    with session() as conn:
        return conn.execute(
            "SELECT * FROM instruments WHERE symbol = ?", (symbol.upper(),)
        ).fetchone()


def upsert_instrument(symbol: str, name: str, instrument_key: str, segment: str) -> None:
    with session() as conn:
        conn.execute(
            """INSERT INTO instruments (symbol, name, instrument_key, segment)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(symbol) DO UPDATE SET
                   name = excluded.name,
                   instrument_key = excluded.instrument_key,
                   segment = excluded.segment""",
            (symbol.upper(), name, instrument_key, segment),
        )


# --- instrument master ------------------------------------------------------


# executemany runs in slices rather than taking one 124k-element parameter list,
# which would hold the whole master in memory a second time for no gain.
MASTER_BATCH = 5000

# Bound by name against the dicts upstox._master_row produces, which carry exactly
# these keys. Normalising a second time here is what silently blanked every expiry:
# an ISO date fed back through an epoch-millisecond parser yields NULL, so the source
# record is projected once, in the client, and stored verbatim from there.
MASTER_COLUMNS = (
    "instrument_key",
    "trading_symbol",
    "name",
    "short_name",
    "exchange",
    "segment",
    "instrument_type",
    "isin",
    "exchange_token",
    "lot_size",
    "tick_size",
    "freeze_quantity",
    "expiry",
    "strike_price",
    "underlying_key",
    "underlying_symbol",
    "weekly",
    "security_type",
    "qty_multiplier",
    "search_key",
)

MASTER_INSERT = "INSERT OR REPLACE INTO instrument_master ({}) VALUES ({})".format(
    ", ".join(MASTER_COLUMNS),
    ", ".join(f":{column}" for column in MASTER_COLUMNS),
)

# Generated from the config map so the ranking in SQL cannot drift away from the
# ranking the rest of the app reports. The values are our own constants, never input.
SEGMENT_RANK_SQL = "CASE segment {} ELSE {} END".format(
    " ".join(f"WHEN '{seg}' THEN {rank}" for seg, rank in SEGMENT_SEARCH_RANK.items()),
    UNRANKED_SEGMENT_RANK,
)


def _like_escape(text: str) -> str:
    """Neutralise LIKE wildcards so a user typing % or _ does not match everything."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def replace_instrument_master(rows: list[dict[str, Any]]) -> int:
    """Rebuild the master wholesale in one transaction and return the stored count.

    Each row must already be projected onto MASTER_COLUMNS, which is what
    upstox.fetch_instrument_master hands back.

    A rebuild, not a merge: expired contracts drop out of the source file, so an
    upsert that never deletes would accumulate dead rows forever. Everything runs
    inside a single transaction, so a failure mid-load leaves the old rows intact.
    """
    with session() as conn:
        conn.execute("DELETE FROM instrument_master")
        for start in range(0, len(rows), MASTER_BATCH):
            # INSERT OR REPLACE, because a duplicated key inside the source file must
            # not abort the whole load.
            conn.executemany(MASTER_INSERT, rows[start : start + MASTER_BATCH])
        stored = conn.execute("SELECT COUNT(*) AS n FROM instrument_master").fetchone()
    return int(stored["n"])


def search_instruments(
    query: str,
    exchange: str | None = None,
    segment: str | None = None,
    instrument_type: str | None = None,
    limit: int = SEARCH_LIMIT_DEFAULT,
) -> list[sqlite3.Row]:
    """Ranked typeahead over trading_symbol and name, best match first."""
    text = " ".join(query.upper().split())
    if not text:
        return []
    pattern = _like_escape(text)
    params: dict[str, Any] = {
        "q": text,
        "prefix": f"{pattern}%",
        "contains": f"%{pattern}%",
        # expiry is stored as an ISO date, so a plain string compare is a date
        # compare, and today is bound rather than taken from the server clock.
        "today": now_ist().date().isoformat(),
        "limit": max(1, min(int(limit), SEARCH_LIMIT_MAX)),
    }
    filters = ""
    if exchange:
        params["exchange"] = exchange.upper()
        filters += " AND exchange = :exchange"
    if segment:
        params["segment"] = segment.upper()
        filters += " AND segment = :segment"
    if instrument_type:
        params["instrument_type"] = instrument_type.upper()
        filters += " AND instrument_type = :instrument_type"

    # Every fragment interpolated below is built here, never from the caller's text.
    with session() as conn:
        return conn.execute(
            f"""SELECT * FROM instrument_master
                WHERE search_key LIKE :contains ESCAPE '\\'{filters}
                ORDER BY
                    CASE
                        WHEN upper(trading_symbol) = :q THEN 0
                        WHEN upper(trading_symbol) LIKE :prefix ESCAPE '\\' THEN 1
                        WHEN search_key LIKE :prefix ESCAPE '\\' THEN 2
                        ELSE 3
                    END,
                    {SEGMENT_RANK_SQL},
                    /*
                      Derivatives: the front contract is what a trader wants
                      first. Without this the tiebreak below sorts the symbol
                      text, which orders by day-of-month, so "01 SEP" beats
                      "25 AUG". Cash and index rows carry no expiry and stay
                      ahead of the chain; anything already expired sinks.
                    */
                    CASE
                        WHEN expiry IS NULL OR expiry = '' THEN 0
                        WHEN expiry >= :today THEN 1
                        ELSE 2
                    END,
                    expiry,
                    strike_price,
                    length(trading_symbol),
                    trading_symbol
                LIMIT :limit""",
            params,
        ).fetchall()


def find_instrument_key(symbol: str, segment: str | None = None) -> sqlite3.Row | None:
    """Resolve one exact ticker, cash and index rows winning ties.

    BSE publishes index codes such as METAL and POWER that collide with real equity
    tickers, so a bare symbol must never resolve to the index by accident.
    """
    text = " ".join(symbol.upper().split())
    if not text:
        return None
    params: dict[str, Any] = {"symbol": text, "compact": text.replace(" ", "")}
    clause = ""
    if segment:
        params["segment"] = segment.upper()
        clause = " AND segment = :segment"

    with session() as conn:
        row = conn.execute(
            f"""SELECT * FROM instrument_master
                WHERE trading_symbol = :symbol{clause}
                ORDER BY {SEGMENT_RANK_SQL} LIMIT 1""",
            params,
        ).fetchone()
        if row is not None:
            return row
        # Only on a miss, because it cannot use an index: several index tickers keep
        # their space ("INDIA VIX"), and users type them without one.
        return conn.execute(
            f"""SELECT * FROM instrument_master
                WHERE upper(replace(trading_symbol, ' ', '')) = :compact{clause}
                ORDER BY {SEGMENT_RANK_SQL} LIMIT 1""",
            params,
        ).fetchone()


def get_master_row(instrument_key: str) -> sqlite3.Row | None:
    with session() as conn:
        return conn.execute(
            "SELECT * FROM instrument_master WHERE instrument_key = ?",
            (instrument_key,),
        ).fetchone()


def instrument_sync_status() -> sqlite3.Row | None:
    with session() as conn:
        return conn.execute("SELECT * FROM instrument_sync WHERE id = 1").fetchone()


def mark_sync(
    status: str,
    row_count: int = 0,
    message: str | None = None,
    source_url: str | None = None,
) -> None:
    stamp = now_ist().isoformat()
    running = status == SYNC_RUNNING
    with session() as conn:
        conn.execute(
            """INSERT INTO instrument_sync (
                   id, status, row_count, started_at, finished_at, source_url, message)
               VALUES (1, :status, :row_count, :started_at, :finished_at, :source_url, :message)
               ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status,
                   -- The load is atomic, so a running or failed sync leaves the
                   -- previous rows in place: keep reporting the count they have.
                   row_count = CASE WHEN :row_count > 0
                                    THEN excluded.row_count
                                    ELSE instrument_sync.row_count END,
                   started_at = CASE WHEN :running
                                     THEN excluded.started_at
                                     ELSE instrument_sync.started_at END,
                   finished_at = CASE WHEN :running THEN NULL ELSE excluded.finished_at END,
                   source_url = COALESCE(excluded.source_url, instrument_sync.source_url),
                   message = excluded.message""",
            {
                "status": status,
                "row_count": row_count,
                "started_at": stamp if running else None,
                "finished_at": None if running else stamp,
                "source_url": source_url,
                "message": message,
                "running": 1 if running else 0,
            },
        )


def master_segment_counts() -> list[sqlite3.Row]:
    with session() as conn:
        return conn.execute(
            """SELECT segment, COUNT(*) AS instrument_count
               FROM instrument_master
               GROUP BY segment
               ORDER BY instrument_count DESC, segment"""
        ).fetchall()


# --- candle cache -----------------------------------------------------------


def save_candles(
    instrument_key: str, unit: str, interval: str, candles: list[list[Any]]
) -> None:
    if not candles:
        return
    rows = [
        (
            instrument_key,
            unit,
            interval,
            c[0],
            float(c[1]),
            float(c[2]),
            float(c[3]),
            float(c[4]),
            int(c[5]),
            int(c[6]) if len(c) > 6 else 0,
        )
        for c in candles
    ]
    with session() as conn:
        conn.executemany(
            """INSERT INTO candles (instrument_key, unit, interval, ts,
                                    open, high, low, close, volume, open_interest)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(instrument_key, unit, interval, ts) DO UPDATE SET
                   open = excluded.open,
                   high = excluded.high,
                   low = excluded.low,
                   close = excluded.close,
                   volume = excluded.volume,
                   open_interest = excluded.open_interest""",
            rows,
        )
        conn.execute(
            """INSERT INTO sync_log (instrument_key, unit, interval, candle_count, synced_at)
               VALUES (?, ?, ?, ?, ?)""",
            (instrument_key, unit, interval, len(rows), now_ist().isoformat()),
        )


def load_candles(
    instrument_key: str, unit: str, interval: str, limit: int = 5000
) -> list[sqlite3.Row]:
    with session() as conn:
        rows = conn.execute(
            """SELECT ts, open, high, low, close, volume
               FROM candles
               WHERE instrument_key = ? AND unit = ? AND interval = ?
               ORDER BY ts DESC LIMIT ?""",
            (instrument_key, unit, interval, limit),
        ).fetchall()
    return list(reversed(rows))


def last_sync(instrument_key: str, unit: str, interval: str) -> str | None:
    with session() as conn:
        row = conn.execute(
            """SELECT synced_at FROM sync_log
               WHERE instrument_key = ? AND unit = ? AND interval = ?
               ORDER BY id DESC LIMIT 1""",
            (instrument_key, unit, interval),
        ).fetchone()
    return row["synced_at"] if row else None
