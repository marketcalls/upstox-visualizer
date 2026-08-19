"""Resolve tradable option contracts out of the local instrument master.

Pure SQL, no network. Every identifier handed back is read from `instrument_master`;
nothing is assembled from strings, because an assembled key that does not exist is
indistinguishable from a real one until an order or a candle request fails.

The reason this lives in its own module is the strike ladder. Ladders are not uniform:
BANKNIFTY's near expiry steps by 100 in the middle and by 300 and 500 in the wings, so
`round(spot / interval) * interval` produces strikes that are simply not listed. ATM is
therefore selected from the rows the exchange actually publishes.
"""

import sqlite3
from dataclasses import dataclass
from math import isfinite
from typing import Any

from ..config import INDEX_SEGMENTS
from ..db import session

# Fixed by the product scope: only these three index chains are backtestable.
SUPPORTED_UNDERLYINGS = ("NIFTY", "BANKNIFTY", "SENSEX")

# Interpolated into the SQL below from our own config constant, never from caller
# input, so this module cannot drift from the segment list the rest of the app uses.
INDEX_SEGMENT_SQL = ", ".join(f"'{segment}'" for segment in INDEX_SEGMENTS)


class ResolverError(Exception):
    """No tradable contract could be resolved. The message says what to fix."""


@dataclass(frozen=True)
class OptionPair:
    underlying: str            # "NIFTY"
    underlying_key: str        # "NSE_INDEX|Nifty 50"
    expiry: str                # "YYYY-MM-DD"
    strike: float
    lot_size: int
    ce_key: str                # instrument_key from the DB
    pe_key: str
    ce_symbol: str
    pe_symbol: str


# --- internals --------------------------------------------------------------


def _require_master(conn: sqlite3.Connection) -> None:
    """The master is downloaded at runtime, so an empty table means setup never ran.

    LIMIT 1 rather than COUNT(*): the only question is whether the load has happened,
    and this runs on every public call.
    """
    if conn.execute("SELECT 1 FROM instrument_master LIMIT 1").fetchone() is None:
        raise ResolverError(
            "instrument_master is empty. Download the instrument master first "
            "(POST /api/market/instruments/download), then retry."
        )


def _normalise(underlying: str) -> str:
    text = " ".join(underlying.upper().split())
    if text not in SUPPORTED_UNDERLYINGS:
        raise ResolverError(
            f"Unsupported underlying {underlying!r}. "
            f"Supported: {', '.join(SUPPORTED_UNDERLYINGS)}."
        )
    return text


def _index_row(conn: sqlite3.Connection, underlying: str) -> sqlite3.Row:
    """The index row an option chain points at, discovered through its underlying_key.

    Options carry the index instrument_key in `underlying_key`, so the link is read out
    of the data instead of being hardcoded here. Joining back onto the index row proves
    the key really is a listed index and not a dangling reference.
    """
    row = conn.execute(
        f"""SELECT idx.instrument_key, idx.trading_symbol, idx.name, idx.segment
            FROM instrument_master AS idx
            WHERE idx.segment IN ({INDEX_SEGMENT_SQL})
              AND idx.instrument_key IN (
                  SELECT DISTINCT opt.underlying_key
                  FROM instrument_master AS opt
                  WHERE opt.underlying_symbol = :underlying
                    AND opt.instrument_type IN ('CE', 'PE')
                    AND opt.underlying_key IS NOT NULL
              )
            ORDER BY idx.instrument_key
            LIMIT 1""",
        {"underlying": underlying},
    ).fetchone()
    if row is None:
        raise ResolverError(
            f"No index row links to {underlying} options in instrument_master. "
            "Re-download the instrument master; the chain cannot be resolved without it."
        )
    return row


def _front_option(conn: sqlite3.Connection, underlying_key: str) -> sqlite3.Row | None:
    """One option row from the nearest listed expiry, which is where lot_size is read."""
    return conn.execute(
        """SELECT expiry, segment, lot_size
           FROM instrument_master
           WHERE underlying_key = :key AND instrument_type IN ('CE', 'PE')
             AND expiry IS NOT NULL AND expiry <> ''
           ORDER BY expiry, strike_price
           LIMIT 1""",
        {"key": underlying_key},
    ).fetchone()


def _expiries(conn: sqlite3.Connection, underlying_key: str) -> list[str]:
    rows = conn.execute(
        """SELECT DISTINCT expiry
           FROM instrument_master
           WHERE underlying_key = :key AND instrument_type IN ('CE', 'PE')
             AND expiry IS NOT NULL AND expiry <> ''
           ORDER BY expiry""",
        {"key": underlying_key},
    ).fetchall()
    return [row["expiry"] for row in rows]


# --- public API -------------------------------------------------------------


def list_underlyings() -> list[dict[str, Any]]:
    """The three supported chains, each with its index key and lot size from the DB.

    Raises if any one of them is missing rather than silently returning a short list:
    a partial master is a broken download, and hiding it would surface later as an
    unexplained empty expiry dropdown.
    """
    out: list[dict[str, Any]] = []
    with session() as conn:
        _require_master(conn)
        for underlying in SUPPORTED_UNDERLYINGS:
            index_row = _index_row(conn, underlying)
            front = _front_option(conn, index_row["instrument_key"])
            if front is None:
                raise ResolverError(
                    f"No live {underlying} option contracts in instrument_master. "
                    "Re-download the instrument master."
                )
            if not front["lot_size"]:
                raise ResolverError(
                    f"{underlying} options carry no lot_size in instrument_master "
                    f"(expiry {front['expiry']}). Re-download the instrument master."
                )
            out.append(
                {
                    "underlying": underlying,
                    "underlying_key": index_row["instrument_key"],
                    "name": index_row["name"],
                    "segment": front["segment"],
                    "lot_size": int(front["lot_size"]),
                    "nearest_expiry": front["expiry"],
                }
            )
    return out


def list_expiries(underlying: str) -> list[str]:
    """Ascending expiries that still exist in the master.

    Expired contracts drop out of the beginning-of-day file and the expired-instruments
    API is out of scope, so the master is exactly the set of dates that can be
    backtested. Deliberately not filtered against today: a contract expiring today is a
    valid backtest target, and a clock comparison would make the answer move at 00:00.
    """
    name = _normalise(underlying)
    with session() as conn:
        _require_master(conn)
        return _expiries(conn, _index_row(conn, name)["instrument_key"])


def strike_ladder(underlying: str, expiry: str) -> list[float]:
    """Ascending strikes for that expiry that carry BOTH a CE and a PE row.

    A straddle needs both legs, so a half-listed strike is not a candidate and must
    never reach the ATM search.
    """
    name = _normalise(underlying)
    with session() as conn:
        _require_master(conn)
        rows = conn.execute(
            """SELECT strike_price
               FROM instrument_master
               WHERE underlying_key = :key AND expiry = :expiry
                 AND instrument_type IN ('CE', 'PE')
                 AND strike_price IS NOT NULL AND strike_price > 0
               GROUP BY strike_price
               HAVING COUNT(DISTINCT instrument_type) = 2
               ORDER BY strike_price""",
            {"key": _index_row(conn, name)["instrument_key"], "expiry": expiry},
        ).fetchall()
    return [float(row["strike_price"]) for row in rows]


def resolve_atm(underlying: str, expiry: str, spot: float) -> OptionPair:
    """The CE/PE pair on the listed strike closest to spot.

    The ladder comes from the database, so the strike returned is always tradable. An
    exact tie, spot sitting halfway between two listed strikes, resolves to the LOWER
    strike: that is what the ascending `strike_price` tiebreak in the ORDER BY does,
    and it is a documented rule rather than an accident of float ordering.
    """
    name = _normalise(underlying)
    if not isfinite(spot) or spot <= 0:
        raise ResolverError(f"Spot must be a positive price, got {spot!r}.")

    with session() as conn:
        _require_master(conn)
        underlying_key = _index_row(conn, name)["instrument_key"]
        # Self-join on strike, so only strikes with both legs can win. The CE row is
        # also where lot_size comes from: never a constant, it changes by contract.
        row = conn.execute(
            """SELECT ce.strike_price AS strike,
                      ce.lot_size     AS lot_size,
                      ce.instrument_key AS ce_key,
                      ce.trading_symbol AS ce_symbol,
                      pe.instrument_key AS pe_key,
                      pe.trading_symbol AS pe_symbol
               FROM instrument_master AS ce
               JOIN instrument_master AS pe
                 ON pe.underlying_key = ce.underlying_key
                AND pe.expiry = ce.expiry
                AND pe.strike_price = ce.strike_price
                AND pe.instrument_type = 'PE'
               WHERE ce.underlying_key = :key AND ce.expiry = :expiry
                 AND ce.instrument_type = 'CE'
                 AND ce.strike_price IS NOT NULL AND ce.strike_price > 0
               ORDER BY abs(ce.strike_price - :spot), ce.strike_price
               LIMIT 1""",
            {"key": underlying_key, "expiry": expiry, "spot": float(spot)},
        ).fetchone()
        if row is None:
            available = ", ".join(_expiries(conn, underlying_key)) or "none"
            raise ResolverError(
                f"No CE/PE pair listed for {name} expiry {expiry}. "
                f"Live expiries: {available}."
            )
        if not row["lot_size"]:
            raise ResolverError(
                f"{name} {expiry} strike {row['strike']} carries no lot_size in "
                "instrument_master. Re-download the instrument master."
            )

    return OptionPair(
        underlying=name,
        underlying_key=underlying_key,
        expiry=expiry,
        strike=float(row["strike"]),
        lot_size=int(row["lot_size"]),
        ce_key=row["ce_key"],
        pe_key=row["pe_key"],
        ce_symbol=row["ce_symbol"],
        pe_symbol=row["pe_symbol"],
    )
