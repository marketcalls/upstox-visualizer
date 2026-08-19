"""Grid arithmetic: cells, row totals, column totals and the grand total.

Only the pure parts of `straddle_heatmap` are exercised: `_row_cells` builds the
cells of one entry time from bars already in memory, and `_totals` aggregates
them. Neither touches the network, the database or the clock, so the whole grid
is assembled here from synthetic bars and a synthetic OptionPair.

The invariant under test is that the three aggregates always agree with the
cells, and that an unavailable cell contributes exactly zero rather than being
skipped in one total and counted in another.
"""

from datetime import date

import pytest

from app.services import straddle_heatmap as heatmap
from app.services.option_resolver import OptionPair
from app.services.straddle_engine import Bar

DAY = date(2026, 8, 18)
LOT_SIZE = 13  # not one of the real lot sizes, so nothing may hardcode it
LOTS = 2
QTY = LOTS * LOT_SIZE

PAIR = OptionPair(
    underlying="BANKNIFTY",
    underlying_key="NSE_INDEX|Nifty Bank",
    expiry="2026-08-25",
    strike=46_700.0,
    lot_size=LOT_SIZE,
    ce_key="NSE_FO|900001",
    pe_key="NSE_FO|900002",
    ce_symbol="BANKNIFTY 46700 CE 25 AUG 26",
    pe_symbol="BANKNIFTY 46700 PE 25 AUG 26",
)


def ts(hhmm: str) -> int:
    return heatmap._minute(DAY, hhmm)


def series(prices: list[tuple[float, float, float, float]], start: str) -> list[Bar]:
    """Bars stamped one minute apart from `start`, given as (open, high, low, close)."""
    first = ts(start)
    return [
        Bar(ts=first + i * 60, open=o, high=h, low=lo, close=c, volume=0)
        for i, (o, h, lo, c) in enumerate(prices)
    ]


# A CE that stops out at a 20% stop but not at a 50% one, so the two columns of
# the grid differ. Sold at 100: the 120 stop is pierced at 09:17, the 150 is not.
CE_BARS = series(
    [
        (100.0, 104.0, 98.0, 103.0),
        (103.0, 110.0, 102.0, 109.0),
        (109.0, 125.0, 108.0, 124.0),
        (124.0, 130.0, 120.0, 128.0),
        (128.0, 132.0, 60.0, 64.0),
    ],
    "09:16",
)

# A PE that decays quietly and never stops at either level. Sold at 80, closes 30.
PE_BARS = series(
    [
        (80.0, 82.0, 74.0, 75.0),
        (75.0, 76.0, 66.0, 68.0),
        (68.0, 69.0, 55.0, 57.0),
        (57.0, 58.0, 44.0, 46.0),
        (46.0, 47.0, 29.0, 30.0),
    ],
    "09:16",
)

BARS = {PAIR.ce_key: CE_BARS, PAIR.pe_key: PE_BARS}

ENTRY_TIMES = ["09:16", "09:17", "09:18"]
STOP_LOSSES = [20.0, 50.0]
EXIT_TS = ts("09:20")


def traded_row(entry_time: str) -> heatmap._Row:
    return heatmap._Row(
        entry_time=entry_time,
        entry_ts=ts(entry_time),
        spot=46_712.5,
        pair=PAIR,
    )


def build_grid() -> list:
    """Three entry times, the last of which cannot be priced at all."""
    rows = [traded_row("09:16"), traded_row("09:17")]
    rows.append(
        heatmap._Row(
            entry_time="09:18",
            entry_ts=ts("09:18"),
            reason="No underlying bar at 09:18",
        )
    )
    cells = []
    for row in rows:
        cells.extend(heatmap._row_cells(row, STOP_LOSSES, BARS, EXIT_TS, LOTS))
    return cells


# --- the timestamp helpers the whole grid is indexed by ----------------------


def test_minute_and_hhmm_round_trip_in_ist() -> None:
    for hhmm in ("09:15", "09:16", "12:00", "15:15", "15:29"):
        assert heatmap._hhmm(heatmap._minute(DAY, hhmm)) == hhmm
    # Consecutive minutes are exactly 60 seconds apart, which is what makes an
    # entry time an exact timestamp match rather than a range.
    assert heatmap._minute(DAY, "09:16") - heatmap._minute(DAY, "09:15") == 60


# --- one row of cells --------------------------------------------------------


def test_row_produces_one_cell_per_stop_loss_sharing_one_strike() -> None:
    cells = heatmap._row_cells(traded_row("09:16"), STOP_LOSSES, BARS, EXIT_TS, LOTS)

    assert [cell.stop_loss for cell in cells] == STOP_LOSSES
    for cell in cells:
        assert cell.status == "ok"
        assert cell.reason is None
        assert cell.entry_time == "09:16"
        assert cell.strike == PAIR.strike
        assert cell.spot_at_entry == 46_712.5
        # quantity is lots times the lot size carried by the resolved contract.
        assert cell.quantity == QTY
        assert cell.ce is not None and cell.pe is not None
        assert cell.ce.instrument_key == PAIR.ce_key
        assert cell.pe.instrument_key == PAIR.pe_key
        assert cell.gross_pnl == pytest.approx(cell.ce.pnl + cell.pe.pnl)
        # v1 charges nothing, so net and gross must not drift apart.
        assert cell.net_pnl == pytest.approx(cell.gross_pnl)


def test_only_the_stop_differs_down_a_row() -> None:
    """The same CE and PE arrays drive every column, so entries must be identical."""
    tight, wide = heatmap._row_cells(
        traded_row("09:16"), STOP_LOSSES, BARS, EXIT_TS, LOTS
    )

    assert tight.ce is not None and wide.ce is not None
    assert tight.ce.entry_price == wide.ce.entry_price == 100.0
    assert tight.ce.stop_price == pytest.approx(120.0)
    assert wide.ce.stop_price == pytest.approx(150.0)
    assert tight.ce.exit_reason == "STOP_LOSS"
    assert tight.ce.exit_time == "09:18"
    assert wide.ce.exit_reason == "TIME"
    assert wide.ce.exit_time == "09:20"
    assert wide.net_pnl is not None and tight.net_pnl is not None
    assert wide.net_pnl > tight.net_pnl

    # The untouched PE leg fills identically in both columns. Only its stop level
    # moved, and a stop that never traded cannot change the result.
    assert tight.pe is not None and wide.pe is not None
    assert tight.pe.stop_price != wide.pe.stop_price
    assert (tight.pe.entry_price, tight.pe.exit_price, tight.pe.exit_reason) == (
        wide.pe.entry_price,
        wide.pe.exit_price,
        wide.pe.exit_reason,
    )
    assert tight.pe.exit_reason == "TIME"
    assert tight.pe.pnl == wide.pe.pnl == pytest.approx(50.0 * QTY)


def test_row_with_no_bar_at_the_entry_minute_is_unavailable_and_names_the_legs() -> None:
    """An illiquid strike that starts late must fail the whole row with a reason."""
    late = {
        PAIR.ce_key: CE_BARS[2:],  # starts at 09:18
        PAIR.pe_key: PE_BARS,
    }
    cells = heatmap._row_cells(traded_row("09:16"), STOP_LOSSES, late, EXIT_TS, LOTS)

    assert len(cells) == len(STOP_LOSSES)
    for cell in cells:
        assert cell.status == "unavailable"
        assert cell.reason == f"{PAIR.ce_symbol} has no 1-minute bar at 09:16"
        # Nothing may be invented for an unavailable cell.
        assert cell.net_pnl is None
        assert cell.gross_pnl is None
        assert cell.ce is None and cell.pe is None
        assert cell.strike is None


def test_both_missing_legs_are_named_together() -> None:
    cells = heatmap._row_cells(
        traded_row("09:16"), [20.0], {PAIR.ce_key: [], PAIR.pe_key: []}, EXIT_TS, LOTS
    )
    reason = cells[0].reason
    assert reason is not None
    assert PAIR.ce_symbol in reason and PAIR.pe_symbol in reason
    assert "have no 1-minute bar at 09:16" in reason


def test_unresolved_row_is_unavailable_for_every_stop_loss() -> None:
    row = heatmap._Row("09:18", ts("09:18"), reason="No underlying bar at 09:18")
    cells = heatmap._row_cells(row, STOP_LOSSES, BARS, EXIT_TS, LOTS)

    assert len(cells) == len(STOP_LOSSES)
    assert all(cell.status == "unavailable" for cell in cells)
    assert all(cell.reason == "No underlying bar at 09:18" for cell in cells)


# --- totals ------------------------------------------------------------------


def test_totals_agree_with_the_cells_in_all_three_directions() -> None:
    cells = build_grid()
    row_totals, col_totals, grand_total, unavailable = heatmap._totals(
        cells, ENTRY_TIMES, STOP_LOSSES
    )

    ok = [cell for cell in cells if cell.status == "ok"]
    assert len(cells) == len(ENTRY_TIMES) * len(STOP_LOSSES)
    assert len(ok) == 4
    assert unavailable == 2

    for entry_time in ENTRY_TIMES:
        expected = sum(
            cell.net_pnl or 0.0 for cell in ok if cell.entry_time == entry_time
        )
        assert row_totals[entry_time] == pytest.approx(expected)

    for stop_loss in STOP_LOSSES:
        expected = sum(
            cell.net_pnl or 0.0 for cell in ok if cell.stop_loss == stop_loss
        )
        assert col_totals[str(stop_loss)] == pytest.approx(expected)

    expected_grand = sum(cell.net_pnl or 0.0 for cell in ok)
    assert grand_total == pytest.approx(expected_grand)
    assert sum(row_totals.values()) == pytest.approx(grand_total)
    assert sum(col_totals.values()) == pytest.approx(grand_total)


def test_every_row_and_column_is_present_even_when_it_holds_nothing() -> None:
    """The UI indexes by these keys, so a fully unavailable row must still be 0.0."""
    cells = build_grid()
    row_totals, col_totals, _, _ = heatmap._totals(cells, ENTRY_TIMES, STOP_LOSSES)

    assert list(row_totals) == ENTRY_TIMES
    assert list(col_totals) == [str(sl) for sl in STOP_LOSSES]
    assert row_totals["09:18"] == 0.0


def test_unavailable_cells_contribute_zero_not_a_skipped_column() -> None:
    """Dropping the unavailable row entirely must not change a single total."""
    full = build_grid()
    traded_only = [cell for cell in full if cell.entry_time != "09:18"]

    with_gap = heatmap._totals(full, ENTRY_TIMES, STOP_LOSSES)
    without = heatmap._totals(traded_only, ENTRY_TIMES[:2], STOP_LOSSES)

    assert with_gap[1] == without[1]  # column totals
    assert with_gap[2] == without[2]  # grand total
    assert with_gap[0]["09:16"] == without[0]["09:16"]
    assert with_gap[0]["09:17"] == without[0]["09:17"]
    assert with_gap[3] == 2 and without[3] == 0


def test_a_grid_where_nothing_traded_totals_to_zero() -> None:
    rows = [
        heatmap._Row(entry_time, ts(entry_time), reason="No underlying bar")
        for entry_time in ENTRY_TIMES
    ]
    cells = [
        cell
        for row in rows
        for cell in heatmap._row_cells(row, STOP_LOSSES, BARS, EXIT_TS, LOTS)
    ]

    row_totals, col_totals, grand_total, unavailable = heatmap._totals(
        cells, ENTRY_TIMES, STOP_LOSSES
    )

    assert grand_total == 0.0
    assert set(row_totals.values()) == {0.0}
    assert set(col_totals.values()) == {0.0}
    assert unavailable == len(ENTRY_TIMES) * len(STOP_LOSSES)


def test_totals_are_rounded_but_the_cells_are_not() -> None:
    """Aggregates round to the paisa; a cell must still reconcile to the candle."""
    cells = heatmap._row_cells(traded_row("09:16"), [33.0], BARS, EXIT_TS, LOTS)
    cell = cells[0]
    assert cell.ce is not None
    # No tick rounding and no 2dp rounding on a cell: the stop is the raw product,
    # which is what lets an audit reconcile against the broker's own candles.
    assert cell.ce.stop_price == 100.0 * (1 + 33.0 / 100)

    _, _, grand_total, _ = heatmap._totals(cells, ["09:16"], [33.0])
    assert grand_total == round(cell.net_pnl or 0.0, 2)
