"""SQLite storage: broker credentials, the active session token and a candle cache."""

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH, SEED_INSTRUMENTS

SCHEMA = """
CREATE TABLE IF NOT EXISTS app_settings (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    api_key      TEXT NOT NULL,
    api_secret   TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_session (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    access_token   TEXT NOT NULL,
    extended_token TEXT,
    user_id        TEXT,
    user_name      TEXT,
    email          TEXT,
    broker         TEXT,
    exchanges      TEXT,
    products       TEXT,
    order_types    TEXT,
    is_active      INTEGER DEFAULT 1,
    issued_at      TEXT NOT NULL,
    expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
    symbol         TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    instrument_key TEXT NOT NULL,
    segment        TEXT NOT NULL
);

-- The full Upstox BOD instrument master, rebuilt wholesale from complete.json.gz.
-- instrument_key is the only globally unique column: trading_symbol collides even
-- inside a single segment, and exchange_token is blank on the GLOBAL rows.
CREATE TABLE IF NOT EXISTS instrument_master (
    instrument_key    TEXT PRIMARY KEY,
    trading_symbol    TEXT NOT NULL,
    name              TEXT,
    short_name        TEXT,
    exchange          TEXT,
    segment           TEXT,
    instrument_type   TEXT,
    isin              TEXT,
    exchange_token    TEXT,
    lot_size          INTEGER,
    tick_size         REAL,
    freeze_quantity   REAL,
    -- ISO YYYY-MM-DD in IST, or NULL. The source file publishes epoch milliseconds;
    -- it is converted once at ingest so no query-time code has to guess the unit.
    expiry            TEXT,
    strike_price      REAL,
    underlying_key    TEXT,
    underlying_symbol TEXT,
    weekly            INTEGER,
    security_type     TEXT,
    qty_multiplier    REAL,
    -- upper(trading_symbol || ' ' || name), so one indexed column serves both the
    -- prefix and the contains legs of the typeahead.
    search_key        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_master_symbol   ON instrument_master(trading_symbol);
CREATE INDEX IF NOT EXISTS idx_master_search   ON instrument_master(search_key);
CREATE INDEX IF NOT EXISTS idx_master_segment  ON instrument_master(segment);
CREATE INDEX IF NOT EXISTS idx_master_exchtype ON instrument_master(exchange, instrument_type);

-- One row, tracking the state of the master download so the UI can poll it.
CREATE TABLE IF NOT EXISTS instrument_sync (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    status        TEXT NOT NULL,
    row_count     INTEGER NOT NULL DEFAULT 0,
    started_at    TEXT,
    finished_at   TEXT,
    source_url    TEXT,
    message       TEXT
);

CREATE TABLE IF NOT EXISTS candles (
    instrument_key TEXT    NOT NULL,
    unit           TEXT    NOT NULL,
    interval       TEXT    NOT NULL,
    ts             TEXT    NOT NULL,
    open           REAL    NOT NULL,
    high           REAL    NOT NULL,
    low            REAL    NOT NULL,
    close          REAL    NOT NULL,
    volume         INTEGER NOT NULL,
    open_interest  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instrument_key, unit, interval, ts)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup
    ON candles (instrument_key, unit, interval, ts DESC);

CREATE TABLE IF NOT EXISTS sync_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    instrument_key TEXT NOT NULL,
    unit           TEXT NOT NULL,
    interval       TEXT NOT NULL,
    candle_count   INTEGER NOT NULL,
    synced_at      TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with session() as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            """INSERT INTO instruments (symbol, name, instrument_key, segment)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(symbol) DO NOTHING""",
            SEED_INSTRUMENTS,
        )
