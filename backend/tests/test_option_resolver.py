"""Resolver tests against a throwaway instrument master built in a temp directory.

The resolver is pure SQL, so the only fixture it needs is a database. A synthetic
one is used rather than the real backend/upstox.db for two reasons: the real file
must never be written to by a test run, and its contents change every morning
when the master is re-downloaded, which would make these assertions rot.

The synthetic ladders are shaped like the real ones on purpose:

- NIFTY is uniform, stepping by 50.
- BANKNIFTY is NOT uniform. It steps by 100 in the middle and by 300 and 500 in
  the wings, exactly like the live chain, so `round(spot / 100) * 100` produces
  strikes that are simply not listed. That is the trap these tests exist for.
- SENSEX steps by 100 on its own BSE_FO segment.

Lot sizes are deliberately 11, 13 and 17 rather than the real 65, 30 and 20. If
any of them were hardcoded in the source instead of read from the row, these
tests would fail.
"""

import shutil
import sqlite3
import tempfile
from pathlib import Path

import pytest

from app import config, db
from app.services import option_resolver
from app.services.option_resolver import OptionPair, ResolverError

# --- the synthetic master ----------------------------------------------------

NIFTY_STRIKES = [float(s) for s in range(24_000, 24_501, 50)]

# 500, 500, 300, 100, 100, 100, 100, 300, 500, 500. The middle steps by 100 and
# the wings widen, which is what makes naive rounding produce phantom strikes.
BANKNIFTY_STRIKES = [
    45_000.0, 45_500.0, 46_000.0, 46_300.0, 46_400.0, 46_500.0,
    46_600.0, 46_700.0, 47_000.0, 47_500.0, 48_000.0,
]

SENSEX_STRIKES = [float(s) for s in range(80_000, 80_501, 100)]

CHAINS = {
    "NIFTY": {
        "index_key": "NSE_INDEX|Nifty 50",
        "index_name": "Nifty 50",
        "index_segment": "NSE_INDEX",
        "segment": "NSE_FO",
        "lot_size": 11,
        "expiries": ["2026-08-25", "2026-09-01"],
        "strikes": NIFTY_STRIKES,
    },
    "BANKNIFTY": {
        "index_key": "NSE_INDEX|Nifty Bank",
        "index_name": "Nifty Bank",
        "index_segment": "NSE_INDEX",
        "segment": "NSE_FO",
        "lot_size": 13,
        "expiries": ["2026-08-25", "2026-09-01"],
        "strikes": BANKNIFTY_STRIKES,
    },
    "SENSEX": {
        "index_key": "BSE_INDEX|SENSEX",
        "index_name": "SENSEX",
        "index_segment": "BSE_INDEX",
        "segment": "BSE_FO",
        "lot_size": 17,
        "expiries": ["2026-08-20", "2026-08-27"],
        "strikes": SENSEX_STRIKES,
    },
}

NEAR_EXPIRY = {name: chain["expiries"][0] for name, chain in CHAINS.items()}

# A CE with no matching PE. A straddle cannot be built on it, so it must never
# reach the ladder or win the ATM search even when spot sits right on it.
HALF_LISTED_STRIKE = 49_000.0

MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
          "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")

INSERT = """INSERT INTO instrument_master (
    instrument_key, trading_symbol, name, segment, instrument_type,
    lot_size, tick_size, expiry, strike_price, underlying_key,
    underlying_symbol, weekly, search_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""


def _symbol(underlying: str, strike: float, kind: str, expiry: str) -> str:
    """`NIFTY 24200 CE 25 AUG 26`, the exact shape the live master publishes."""
    year, month, day = (int(part) for part in expiry.split("-"))
    return f"{underlying} {int(strike)} {kind} {day:02d} {MONTHS[month - 1]} {year % 100:02d}"


def _rows() -> list[tuple]:
    rows: list[tuple] = []
    token = 100_000

    for underlying, chain in CHAINS.items():
        rows.append(
            (
                chain["index_key"], chain["index_name"], chain["index_name"],
                chain["index_segment"], "INDEX", None, None, None, None, None,
                None, None, chain["index_name"].upper(),
            )
        )
        for expiry in chain["expiries"]:
            listed = list(chain["strikes"])
            for strike in listed:
                for kind in ("CE", "PE"):
                    token += 1
                    symbol = _symbol(underlying, strike, kind, expiry)
                    rows.append(
                        (
                            f"{chain['segment']}|{token}", symbol, underlying,
                            chain["segment"], kind, chain["lot_size"], 5.0, expiry,
                            strike, chain["index_key"], underlying, 1,
                            symbol.upper(),
                        )
                    )

    # The half-listed strike: BANKNIFTY near expiry, CE only.
    token += 1
    half = _symbol("BANKNIFTY", HALF_LISTED_STRIKE, "CE", NEAR_EXPIRY["BANKNIFTY"])
    rows.append(
        (
            f"NSE_FO|{token}", half, "BANKNIFTY", "NSE_FO", "CE", 13, 5.0,
            NEAR_EXPIRY["BANKNIFTY"], HALF_LISTED_STRIKE, "NSE_INDEX|Nifty Bank",
            "BANKNIFTY", 1, half.upper(),
        )
    )

    # Noise the resolver must ignore: a cash row and an unsupported index chain.
    rows.append(
        (
            "NSE_EQ|INE002A01018", "RELIANCE", "Reliance Industries", "NSE_EQ",
            "EQ", 1, 5.0, None, None, None, None, None, "RELIANCE",
        )
    )
    rows.append(
        (
            "NSE_INDEX|Nifty Fin Services", "Nifty Fin Services",
            "Nifty Fin Services", "NSE_INDEX", "INDEX", None, None, None, None,
            None, None, None, "NIFTY FIN SERVICES",
        )
    )
    token += 1
    rows.append(
        (
            f"NSE_FO|{token}", "FINNIFTY 24000 CE 25 AUG 26", "FINNIFTY", "NSE_FO",
            "CE", 65, 5.0, "2026-08-25", 24_000.0, "NSE_INDEX|Nifty Fin Services",
            "FINNIFTY", 1, "FINNIFTY 24000 CE 25 AUG 26",
        )
    )
    return rows


def _build(path: Path, rows: list[tuple]) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(db.SCHEMA)
        conn.executemany(INSERT, rows)
        conn.commit()
    finally:
        conn.close()


@pytest.fixture()
def master(monkeypatch: pytest.MonkeyPatch):
    """Point `app.db` at a fresh throwaway file and delete it afterwards.

    `db.connect()` reads the module-level DB_PATH on every call, so redirecting
    that one name is enough to keep the whole resolver off the real database.
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="upstox-resolver-"))
    path = tmpdir / "throwaway-master.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    _build(path, _rows())
    # A failed redirect would silently run every assertion against the live file.
    assert db.DB_PATH != config.DB_PATH
    try:
        yield path
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@pytest.fixture()
def empty_master(monkeypatch: pytest.MonkeyPatch):
    tmpdir = Path(tempfile.mkdtemp(prefix="upstox-resolver-empty-"))
    path = tmpdir / "empty-master.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    _build(path, [])
    try:
        yield path
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# --- underlyings -------------------------------------------------------------


def test_list_underlyings_reads_keys_and_lot_sizes_from_the_database(master) -> None:
    infos = {info["underlying"]: info for info in option_resolver.list_underlyings()}

    assert list(infos) == list(option_resolver.SUPPORTED_UNDERLYINGS)
    for underlying, chain in CHAINS.items():
        info = infos[underlying]
        assert info["underlying_key"] == chain["index_key"]
        assert info["segment"] == chain["segment"]
        # 11, 13 and 17 exist nowhere in the source: this can only come from the row.
        assert info["lot_size"] == chain["lot_size"]
        assert info["nearest_expiry"] == chain["expiries"][0]


def test_unsupported_underlying_is_rejected(master) -> None:
    with pytest.raises(ResolverError, match="Unsupported underlying"):
        option_resolver.list_expiries("FINNIFTY")


def test_underlying_name_is_normalised(master) -> None:
    assert option_resolver.list_expiries("  nifty ") == CHAINS["NIFTY"]["expiries"]


def test_empty_master_says_to_download_it(empty_master) -> None:
    with pytest.raises(ResolverError, match="instrument_master is empty"):
        option_resolver.list_expiries("NIFTY")


# --- expiries ----------------------------------------------------------------


def test_expiries_are_ascending_and_per_underlying(master) -> None:
    for underlying, chain in CHAINS.items():
        expiries = option_resolver.list_expiries(underlying)
        assert expiries == chain["expiries"]
        assert expiries == sorted(expiries)


# --- the strike ladder -------------------------------------------------------


def test_ladder_is_ascending_and_matches_the_listed_strikes(master) -> None:
    for underlying, chain in CHAINS.items():
        ladder = option_resolver.strike_ladder(underlying, chain["expiries"][0])
        assert ladder == sorted(ladder)
        assert ladder == chain["strikes"]


def test_banknifty_ladder_really_is_non_uniform(master) -> None:
    """Guards the fixture itself: a uniform ladder would make the next test vacuous."""
    ladder = option_resolver.strike_ladder("BANKNIFTY", NEAR_EXPIRY["BANKNIFTY"])
    gaps = {ladder[i + 1] - ladder[i] for i in range(len(ladder) - 1)}
    assert gaps == {100.0, 300.0, 500.0}


def test_half_listed_strike_never_reaches_the_ladder(master) -> None:
    ladder = option_resolver.strike_ladder("BANKNIFTY", NEAR_EXPIRY["BANKNIFTY"])
    assert HALF_LISTED_STRIKE not in ladder


def test_ladder_of_an_unlisted_expiry_is_empty(master) -> None:
    assert option_resolver.strike_ladder("NIFTY", "2027-01-28") == []


# --- ATM selection -----------------------------------------------------------


def test_atm_on_an_exact_strike_returns_that_strike(master) -> None:
    pair = option_resolver.resolve_atm("NIFTY", NEAR_EXPIRY["NIFTY"], 24_250.0)
    assert pair.strike == 24_250.0


def test_atm_never_returns_a_strike_that_is_not_listed(master) -> None:
    """The BANKNIFTY trap. Naive rounding invents 46800; only 46700 exists.

    `round(spot / 100) * 100` gives 46800 for a spot of 46820, and there is no
    46800 contract in the wings of this ladder. The resolver must fall back to a
    real neighbour instead.
    """
    expiry = NEAR_EXPIRY["BANKNIFTY"]
    ladder = option_resolver.strike_ladder("BANKNIFTY", expiry)
    spot = 46_820.0

    naive = round(spot / 100) * 100
    assert naive == 46_800.0
    assert naive not in ladder  # the phantom strike naive rounding would trade

    pair = option_resolver.resolve_atm("BANKNIFTY", expiry, spot)
    assert pair.strike == 46_700.0
    assert pair.strike in ladder


def test_atm_stays_inside_the_ladder_across_the_whole_chain(master) -> None:
    """Sweep across and beyond the ladder; no spot may produce an unlisted strike."""
    expiry = NEAR_EXPIRY["BANKNIFTY"]
    ladder = option_resolver.strike_ladder("BANKNIFTY", expiry)
    listed = set(ladder)

    spot = 44_500.0
    while spot <= 48_500.0:
        pair = option_resolver.resolve_atm("BANKNIFTY", expiry, spot)
        assert pair.strike in listed, spot
        # Nothing listed may sit closer to spot than the strike that was chosen.
        assert abs(pair.strike - spot) == min(abs(s - spot) for s in ladder), spot
        spot += 50.0


def test_exact_midpoint_tie_goes_to_the_lower_strike(master) -> None:
    """46850 is exactly 150 from both 46700 and 47000. The lower one wins."""
    expiry = NEAR_EXPIRY["BANKNIFTY"]
    pair = option_resolver.resolve_atm("BANKNIFTY", expiry, 46_850.0)

    assert abs(46_700.0 - 46_850.0) == abs(47_000.0 - 46_850.0)
    assert pair.strike == 46_700.0


def test_exact_midpoint_tie_on_a_uniform_ladder_also_goes_lower(master) -> None:
    pair = option_resolver.resolve_atm("NIFTY", NEAR_EXPIRY["NIFTY"], 24_025.0)
    assert pair.strike == 24_000.0


def test_half_listed_strike_never_wins_the_atm_search(master) -> None:
    """Spot sits exactly on a CE-only strike; the resolver must still pick a pair."""
    expiry = NEAR_EXPIRY["BANKNIFTY"]
    pair = option_resolver.resolve_atm("BANKNIFTY", expiry, HALF_LISTED_STRIKE)

    assert pair.strike != HALF_LISTED_STRIKE
    assert pair.strike == 48_000.0  # the nearest strike that has both legs


def test_resolved_pair_carries_database_identifiers_not_assembled_ones(master) -> None:
    expiry = NEAR_EXPIRY["SENSEX"]
    pair = option_resolver.resolve_atm("SENSEX", expiry, 80_240.0)

    assert isinstance(pair, OptionPair)
    assert pair.underlying == "SENSEX"
    assert pair.underlying_key == "BSE_INDEX|SENSEX"
    assert pair.expiry == expiry
    assert pair.strike == 80_200.0
    assert pair.lot_size == 17  # from the row, not from a constant
    assert pair.ce_key != pair.pe_key
    assert pair.ce_key.startswith("BSE_FO|")
    assert pair.pe_key.startswith("BSE_FO|")
    assert pair.ce_symbol == "SENSEX 80200 CE 20 AUG 26"
    assert pair.pe_symbol == "SENSEX 80200 PE 20 AUG 26"

    # The keys must be the ones actually stored, which is what makes them fetchable.
    conn = sqlite3.connect(master)
    try:
        conn.row_factory = sqlite3.Row
        stored = {
            row["instrument_key"]: row["trading_symbol"]
            for row in conn.execute(
                "SELECT instrument_key, trading_symbol FROM instrument_master "
                "WHERE expiry = ? AND strike_price = ? AND underlying_symbol = 'SENSEX'",
                (expiry, 80_200.0),
            )
        }
    finally:
        conn.close()
    assert stored[pair.ce_key] == pair.ce_symbol
    assert stored[pair.pe_key] == pair.pe_symbol


def test_far_expiry_resolves_against_its_own_ladder(master) -> None:
    """Two expiries share strikes, so the pair must come from the one requested."""
    far = CHAINS["NIFTY"]["expiries"][1]
    near_pair = option_resolver.resolve_atm("NIFTY", NEAR_EXPIRY["NIFTY"], 24_200.0)
    far_pair = option_resolver.resolve_atm("NIFTY", far, 24_200.0)

    assert near_pair.strike == far_pair.strike == 24_200.0
    assert far_pair.expiry == far
    assert far_pair.ce_key != near_pair.ce_key
    assert far_pair.ce_symbol.endswith("01 SEP 26")


# --- rejections --------------------------------------------------------------


def test_unlisted_expiry_reports_the_live_ones(master) -> None:
    with pytest.raises(ResolverError) as excinfo:
        option_resolver.resolve_atm("NIFTY", "2027-01-28", 24_200.0)

    message = str(excinfo.value)
    assert "2027-01-28" in message
    for expiry in CHAINS["NIFTY"]["expiries"]:
        assert expiry in message


@pytest.mark.parametrize("spot", [0.0, -1.0, float("nan"), float("inf")])
def test_non_positive_or_non_finite_spot_is_rejected(master, spot: float) -> None:
    with pytest.raises(ResolverError, match="positive price"):
        option_resolver.resolve_atm("NIFTY", NEAR_EXPIRY["NIFTY"], spot)
