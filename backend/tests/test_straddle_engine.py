"""Behaviour tests for the pure short-straddle engine.

Everything here is synthetic OHLC handed straight to `simulate_leg` and
`simulate_straddle`. The engine touches no network, no sqlite and no clock, so
these tests need no fixtures, no monkeypatching and no test database: if one
fails it is the arithmetic that is wrong, never the environment.

Prices are chosen so every expected number is exact in binary floating point
(halves and integers), which is why most assertions can compare directly.
`pytest.approx` is used only where a percentage multiply is involved.
"""

import pytest

from app.services.straddle_engine import (
    NO_EXIT_DATA,
    STOP_LOSS,
    STOP_LOSS_GAP,
    TIME,
    Bar,
    MissingBarError,
    simulate_leg,
    simulate_straddle,
)

# 2026-08-18 09:15 IST as epoch seconds. The engine only ever compares timestamps,
# so the absolute value is irrelevant; a real one just makes failures readable.
OPEN_TS = 1_755_490_500
MINUTE = 60

QTY = 65  # one NIFTY lot at the time of writing, used only as a multiplier


def ts(index: int) -> int:
    """Epoch seconds of the bar `index` minutes after 09:15."""
    return OPEN_TS + index * MINUTE


def bar(index: int, open_: float, high: float, low: float, close: float) -> Bar:
    return Bar(ts=ts(index), open=open_, high=high, low=low, close=close, volume=0)


def flat_series(start: float, end: float, count: int = 6) -> list[Bar]:
    """A quiet decay from `start` to `end` whose highs never exceed the first open.

    Used wherever a leg must be guaranteed NOT to stop out, so the test is about
    the time exit and nothing else.
    """
    step = (start - end) / (count - 1)
    bars = []
    for i in range(count):
        open_ = start - step * i
        close = start - step * (i + 1) if i < count - 1 else end
        bars.append(bar(i, open_, max(open_, close), min(open_, close), close))
    return bars


# --- 1. neither leg stops ----------------------------------------------------


def test_neither_leg_hits_stop_loss() -> None:
    """Both legs sold at 100, both closing at 50, is 50 points of profit each."""
    ce_bars = flat_series(100.0, 50.0)
    pe_bars = flat_series(100.0, 50.0)

    result = simulate_straddle(ce_bars, pe_bars, ts(0), ts(5), 30.0, QTY)

    for leg in (result.ce, result.pe):
        assert leg.entry_price == 100.0
        assert leg.exit_price == 50.0
        assert leg.exit_reason == TIME
        assert leg.exit_ts == ts(5)
        assert leg.pnl == 50.0 * QTY

    assert result.gross_pnl == 100.0 * QTY
    # v1 models no brokerage or slippage, so net must equal gross exactly.
    assert result.charges == 0.0
    assert result.net_pnl == result.gross_pnl


# --- 2 and 3. one leg stops, the other runs on -------------------------------


def test_ce_stops_and_pe_runs_to_time() -> None:
    """CE sold at 100 with a 20% stop fills at exactly 120; PE is untouched."""
    ce_bars = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 104.0, 125.0, 103.0, 124.0),  # high pierces the 120 stop
        bar(2, 124.0, 130.0, 120.0, 128.0),
        bar(3, 128.0, 132.0, 126.0, 130.0),
        bar(4, 130.0, 134.0, 128.0, 132.0),
        bar(5, 132.0, 136.0, 130.0, 134.0),
    ]
    pe_bars = flat_series(90.0, 40.0)

    result = simulate_straddle(ce_bars, pe_bars, ts(0), ts(5), 20.0, QTY)

    assert result.ce.stop_price == pytest.approx(120.0)
    assert result.ce.exit_price == result.ce.stop_price
    assert result.ce.exit_reason == STOP_LOSS
    assert result.ce.exit_ts == ts(1)
    assert result.ce.bars_examined == 2  # the entry bar plus the bar that stopped it
    assert result.ce.pnl == pytest.approx(-20.0 * QTY)

    # Leg independence: the CE stop did nothing whatsoever to the PE.
    assert result.pe.exit_reason == TIME
    assert result.pe.exit_ts == ts(5)
    assert result.pe.exit_price == 40.0
    assert result.pe.pnl == 50.0 * QTY
    assert result.pe.bars_examined == 6

    assert result.gross_pnl == pytest.approx(30.0 * QTY)


def test_pe_stops_and_ce_runs_to_time() -> None:
    """The mirror image: only the PE stops, and the CE is not closed with it."""
    ce_bars = flat_series(90.0, 40.0)
    pe_bars = [
        bar(0, 100.0, 104.0, 99.0, 103.0),
        bar(1, 103.0, 118.0, 102.0, 117.0),
        bar(2, 117.0, 126.0, 115.0, 125.0),  # high pierces the 120 stop
        bar(3, 125.0, 128.0, 123.0, 127.0),
        bar(4, 127.0, 130.0, 125.0, 129.0),
        bar(5, 129.0, 131.0, 127.0, 130.0),
    ]

    result = simulate_straddle(ce_bars, pe_bars, ts(0), ts(5), 20.0, QTY)

    assert result.pe.exit_reason == STOP_LOSS
    assert result.pe.exit_price == pytest.approx(120.0)
    assert result.pe.exit_ts == ts(2)
    assert result.pe.pnl == pytest.approx(-20.0 * QTY)

    assert result.ce.exit_reason == TIME
    assert result.ce.exit_ts == ts(5)
    assert result.ce.pnl == 50.0 * QTY


# --- 4. both legs stop -------------------------------------------------------


def test_both_legs_stop_at_their_own_stop_prices() -> None:
    """Each leg's stop comes off its own entry price, not off a shared premium."""
    ce_bars = [
        bar(0, 100.0, 106.0, 99.0, 105.0),
        bar(1, 105.0, 122.0, 104.0, 121.0),  # CE stop is 120
        bar(2, 121.0, 124.0, 119.0, 123.0),
        bar(3, 123.0, 126.0, 121.0, 125.0),
    ]
    pe_bars = [
        bar(0, 80.0, 84.0, 79.0, 83.0),
        bar(1, 83.0, 90.0, 82.0, 89.0),
        bar(2, 89.0, 100.0, 88.0, 99.0),  # PE stop is 96
        bar(3, 99.0, 102.0, 97.0, 101.0),
    ]

    result = simulate_straddle(ce_bars, pe_bars, ts(0), ts(3), 20.0, QTY)

    assert result.ce.stop_price == pytest.approx(120.0)
    assert result.ce.exit_price == pytest.approx(120.0)
    assert result.ce.exit_reason == STOP_LOSS
    assert result.ce.exit_ts == ts(1)

    assert result.pe.stop_price == pytest.approx(96.0)
    assert result.pe.exit_price == pytest.approx(96.0)
    assert result.pe.exit_reason == STOP_LOSS
    assert result.pe.exit_ts == ts(2)

    # Different stop levels off different entries, and different exit minutes.
    assert result.ce.stop_price != result.pe.stop_price
    assert result.gross_pnl == pytest.approx((-20.0 - 16.0) * QTY)


def test_both_legs_can_stop_inside_the_same_minute() -> None:
    """No intrabar ordering is claimed, so a shared minute stops both legs."""
    ce_bars = [
        bar(0, 100.0, 102.0, 99.0, 101.0),
        bar(1, 101.0, 140.0, 100.0, 139.0),
        bar(2, 139.0, 142.0, 137.0, 140.0),
    ]
    pe_bars = [
        bar(0, 100.0, 101.0, 98.0, 100.0),
        bar(1, 100.0, 145.0, 99.0, 144.0),
        bar(2, 144.0, 147.0, 142.0, 145.0),
    ]

    result = simulate_straddle(ce_bars, pe_bars, ts(0), ts(2), 20.0, QTY)

    assert result.ce.exit_ts == result.pe.exit_ts == ts(1)
    assert result.ce.exit_reason == result.pe.exit_reason == STOP_LOSS
    assert result.gross_pnl == pytest.approx(-40.0 * QTY)


# --- 5. a 100% stop is a real stop ------------------------------------------


def test_hundred_percent_stop_is_a_real_stop_not_a_disabled_one() -> None:
    """100% means the stop sits at twice the entry, and it fires when touched."""
    bars = [
        bar(0, 100.0, 120.0, 95.0, 118.0),
        bar(1, 118.0, 180.0, 116.0, 178.0),
        bar(2, 178.0, 210.0, 175.0, 205.0),  # pierces the 200 stop
        bar(3, 205.0, 215.0, 200.0, 210.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(3), 100.0, QTY)

    assert leg.stop_price == pytest.approx(200.0)
    assert leg.exit_reason == STOP_LOSS
    assert leg.exit_price == pytest.approx(200.0)
    assert leg.exit_ts == ts(2)
    assert leg.pnl == pytest.approx(-100.0 * QTY)


def test_hundred_percent_stop_still_lets_a_quiet_leg_run_to_time() -> None:
    """The same 100% stop must not fire on a leg that never doubles."""
    bars = [
        bar(0, 100.0, 150.0, 95.0, 140.0),
        bar(1, 140.0, 199.0, 130.0, 150.0),  # 199 is under the 200 stop
        bar(2, 150.0, 160.0, 40.0, 45.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(2), 100.0, QTY)

    assert leg.exit_reason == TIME
    assert leg.exit_price == 45.0
    assert leg.pnl == 55.0 * QTY


# --- 6. one bar list, many stop levels ---------------------------------------


def test_same_bars_different_stop_levels_change_only_the_stop() -> None:
    """A whole heatmap column varies the stop over identical arrays, never a refetch.

    Entry is the same open for every run, so the only thing that may differ is
    where and why the leg came out. This is the property that lets the heatmap
    fetch one contract and simulate ten stop levels against it in memory.
    """
    bars = [
        bar(0, 100.0, 105.0, 98.0, 102.0),
        bar(1, 102.0, 115.0, 100.0, 112.0),
        bar(2, 112.0, 125.0, 110.0, 120.0),
        bar(3, 120.0, 155.0, 118.0, 150.0),
        bar(4, 150.0, 205.0, 148.0, 200.0),
        bar(5, 190.0, 195.0, 50.0, 60.0),
    ]

    results = {pct: simulate_leg(bars, ts(0), ts(5), pct, QTY) for pct in (10, 20, 50, 100)}

    # Identical entry across every stop level: the data was read once.
    assert {leg.entry_price for leg in results.values()} == {100.0}

    expected = {10: (110.0, 1), 20: (120.0, 2), 50: (150.0, 3), 100: (200.0, 4)}
    for pct, (stop, index) in expected.items():
        leg = results[pct]
        assert leg.stop_price == pytest.approx(stop), pct
        assert leg.exit_reason == STOP_LOSS, pct
        assert leg.exit_price == pytest.approx(stop), pct
        assert leg.exit_ts == ts(index), pct
        assert leg.pnl == pytest.approx(-(stop - 100.0) * QTY), pct

    # A wide enough stop over the very same bars simply never fires.
    wide = simulate_leg(bars, ts(0), ts(5), 200.0, QTY)
    assert wide.entry_price == 100.0
    assert wide.exit_reason == TIME
    assert wide.exit_price == 60.0
    assert wide.pnl == 40.0 * QTY


# --- 8. no bar at the entry minute -------------------------------------------


def test_missing_entry_bar_raises_rather_than_substituting() -> None:
    """An illiquid strike that starts late must not be entered on a nearby minute."""
    bars = [
        bar(2, 100.0, 102.0, 99.0, 101.0),
        bar(3, 101.0, 103.0, 100.0, 102.0),
    ]

    with pytest.raises(MissingBarError) as excinfo:
        simulate_leg(bars, ts(0), ts(3), 20.0, QTY)

    assert excinfo.value.ts == ts(0)
    assert str(ts(0)) in str(excinfo.value)


def test_missing_bar_on_one_leg_fails_the_whole_straddle() -> None:
    """Half a straddle is a different trade, so the cell must go unavailable."""
    ce_bars = flat_series(100.0, 50.0)
    pe_bars = [bar(i, 90.0, 92.0, 88.0, 90.0) for i in range(1, 6)]  # starts at 09:16

    with pytest.raises(MissingBarError):
        simulate_straddle(ce_bars, pe_bars, ts(0), ts(5), 20.0, QTY)


def test_no_bar_at_or_before_exit_reports_no_exit_data_and_zero_pnl() -> None:
    """With nothing to close against, the leg is flat rather than guessed at."""
    bars = flat_series(100.0, 50.0)

    # exit_ts before entry_ts leaves the walk window empty.
    leg = simulate_leg(bars, ts(3), ts(1), 20.0, QTY)

    assert leg.exit_reason == NO_EXIT_DATA
    assert leg.pnl == 0.0
    assert leg.bars_examined == 0


# --- 9. exit-time square-off -------------------------------------------------


def test_leg_that_never_stops_exits_at_the_exit_bar_close() -> None:
    bars = [
        bar(0, 120.0, 122.0, 118.0, 119.0),
        bar(1, 119.0, 121.0, 100.0, 102.0),
        bar(2, 102.0, 104.0, 90.0, 91.0),
        bar(3, 91.0, 95.0, 80.0, 84.0),  # exit minute
        bar(4, 84.0, 88.0, 70.0, 72.0),  # after the exit minute, must be ignored
    ]

    leg = simulate_leg(bars, ts(0), ts(3), 50.0, QTY)

    assert leg.exit_reason == TIME
    assert leg.exit_ts == ts(3)
    assert leg.exit_price == 84.0
    assert leg.bars_examined == 4
    assert leg.pnl == 36.0 * QTY


def test_series_ending_early_still_exits_on_time_at_the_last_bar() -> None:
    """A contract whose feed stops before 15:15 exits on its last bar, still TIME."""
    bars = [
        bar(0, 100.0, 102.0, 98.0, 99.0),
        bar(1, 99.0, 100.0, 90.0, 92.0),
        bar(2, 92.0, 93.0, 85.0, 86.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(9), 50.0, QTY)

    assert leg.exit_reason == TIME
    assert leg.exit_ts == ts(2)
    assert leg.exit_price == 86.0
    assert leg.pnl == 14.0 * QTY


# --- 11. gap through the stop ------------------------------------------------


def test_gap_through_the_stop_fills_at_the_open_not_the_stop() -> None:
    """The case that silently flatters results if it is wrong.

    The bar opens above the stop, so the stop price never traded in that minute.
    Filling at 120 here would book a 20-point loss instead of the real 40.
    """
    bars = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 140.0, 150.0, 138.0, 148.0),  # opens through the 120 stop
        bar(2, 148.0, 152.0, 145.0, 150.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(2), 20.0, QTY)

    assert leg.exit_reason == STOP_LOSS_GAP
    assert leg.exit_price == 140.0
    assert leg.exit_price != leg.stop_price
    assert leg.exit_ts == ts(1)
    assert leg.pnl == -40.0 * QTY


def test_open_exactly_at_the_stop_is_a_gap_fill() -> None:
    """The boundary: open == stop is still a gap, and both agree on the price."""
    bars = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 120.0, 125.0, 119.0, 124.0),
        bar(2, 124.0, 126.0, 122.0, 125.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(2), 20.0, QTY)

    assert leg.exit_reason == STOP_LOSS_GAP
    assert leg.exit_price == pytest.approx(120.0)
    assert leg.exit_price == pytest.approx(leg.stop_price)


def test_touch_and_gap_are_distinguished_on_otherwise_identical_bars() -> None:
    """Same high, same stop: only the open decides which reason and which fill."""
    touched = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 110.0, 150.0, 108.0, 148.0),
    ]
    gapped = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 130.0, 150.0, 128.0, 148.0),
    ]

    touch_leg = simulate_leg(touched, ts(0), ts(1), 20.0, QTY)
    gap_leg = simulate_leg(gapped, ts(0), ts(1), 20.0, QTY)

    assert touch_leg.exit_reason == STOP_LOSS
    assert touch_leg.exit_price == pytest.approx(120.0)
    assert gap_leg.exit_reason == STOP_LOSS_GAP
    assert gap_leg.exit_price == 130.0
    assert gap_leg.pnl < touch_leg.pnl


# --- 12. the entry bar itself can stop the leg -------------------------------


def test_stop_can_trigger_on_the_entry_bar() -> None:
    """Entry fills at the open first, then the same minute is checked for the stop."""
    bars = [
        bar(0, 100.0, 125.0, 99.0, 122.0),  # sold at 100, high takes out the 120 stop
        bar(1, 122.0, 130.0, 120.0, 128.0),
    ]

    leg = simulate_leg(bars, ts(0), ts(1), 20.0, QTY)

    assert leg.entry_price == 100.0  # the open, never the high
    assert leg.exit_reason == STOP_LOSS
    assert leg.exit_price == pytest.approx(120.0)
    assert leg.exit_ts == ts(0)
    assert leg.bars_examined == 1
    assert leg.pnl == pytest.approx(-20.0 * QTY)


def test_entry_bar_open_is_never_treated_as_a_gap() -> None:
    """A positive stop is always above the entry open, so entry can only ever touch.

    A gap on the entry bar would mean the leg was filled beyond its own stop,
    which is impossible when the stop is derived from that same open.
    """
    for pct in (0.5, 10.0, 100.0, 500.0):
        bars = [bar(0, 100.0, 10_000.0, 1.0, 9_000.0)]
        leg = simulate_leg(bars, ts(0), ts(0), pct, QTY)
        assert leg.exit_reason == STOP_LOSS, pct
        assert leg.exit_price == pytest.approx(leg.stop_price), pct


# --- 13. unsorted input ------------------------------------------------------


def test_descending_bars_produce_the_same_result_as_ascending() -> None:
    """Upstox returns candles newest first, so the engine sorts its own window.

    This asserts what the implementation actually does: `_window` re-sorts a slice
    that is out of order, so a caller that forgot to sort gets the right answer
    rather than a stop fired on the wrong bar.
    """
    ascending = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 104.0, 112.0, 103.0, 111.0),
        bar(2, 111.0, 125.0, 110.0, 124.0),  # first bar to pierce the 120 stop
        bar(3, 124.0, 135.0, 122.0, 134.0),
        bar(4, 134.0, 140.0, 130.0, 138.0),
    ]
    descending = list(reversed(ascending))

    up = simulate_leg(ascending, ts(0), ts(4), 20.0, QTY)
    down = simulate_leg(descending, ts(0), ts(4), 20.0, QTY)

    assert up == down
    assert down.exit_reason == STOP_LOSS
    assert down.exit_ts == ts(2)  # the earliest piercing bar, not the latest
    assert down.bars_examined == 3


def test_descending_bars_also_agree_on_the_time_exit() -> None:
    """Unsorted input must not close a quiet leg against the wrong minute's close."""
    ascending = [
        bar(0, 100.0, 101.0, 95.0, 96.0),
        bar(1, 96.0, 97.0, 88.0, 90.0),
        bar(2, 90.0, 91.0, 70.0, 72.0),
        bar(3, 72.0, 75.0, 60.0, 61.0),
    ]

    up = simulate_leg(ascending, ts(0), ts(3), 50.0, QTY)
    down = simulate_leg(list(reversed(ascending)), ts(0), ts(3), 50.0, QTY)

    assert up == down
    assert down.exit_reason == TIME
    assert down.exit_ts == ts(3)
    assert down.exit_price == 61.0


# --- extras of my own --------------------------------------------------------


def test_high_exactly_at_the_stop_triggers_and_just_below_does_not() -> None:
    """Pins the direction of rule 4's comparison, which is >= and not >.

    A stop resting at 120 is filled by a print of 120. One tick below it is not,
    and the leg must carry on to the next bar.
    """
    touching = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 104.0, 120.0, 103.0, 119.0),  # high sits exactly on the stop
        bar(2, 119.0, 121.0, 50.0, 55.0),
    ]
    missing = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 104.0, 119.95, 103.0, 119.0),  # one tick short of it
        bar(2, 119.0, 119.9, 50.0, 55.0),
    ]

    hit = simulate_leg(touching, ts(0), ts(2), 20.0, QTY)
    assert hit.exit_reason == STOP_LOSS
    assert hit.exit_ts == ts(1)

    survived = simulate_leg(missing, ts(0), ts(2), 20.0, QTY)
    assert survived.exit_reason == TIME
    assert survived.exit_price == 55.0
    assert survived.pnl == 45.0 * QTY


def test_quantity_scales_pnl_linearly_and_nothing_else() -> None:
    """Lots only multiply. Prices, reasons and timestamps must be identical."""
    bars = flat_series(100.0, 60.0)

    one = simulate_leg(bars, ts(0), ts(5), 30.0, 65)
    ten = simulate_leg(bars, ts(0), ts(5), 30.0, 650)

    assert ten.pnl == pytest.approx(one.pnl * 10)
    assert (ten.entry_price, ten.exit_price, ten.exit_reason, ten.exit_ts) == (
        one.entry_price,
        one.exit_price,
        one.exit_reason,
        one.exit_ts,
    )


def test_bars_outside_the_window_are_never_examined() -> None:
    """Bars before entry or after exit exist in the array but must not be walked."""
    bars = [
        bar(0, 100.0, 300.0, 99.0, 290.0),  # a huge spike BEFORE entry
        bar(1, 100.0, 102.0, 98.0, 101.0),  # entry
        bar(2, 101.0, 103.0, 99.0, 100.0),  # exit minute
        bar(3, 100.0, 400.0, 99.0, 390.0),  # a huge spike AFTER exit
    ]

    leg = simulate_leg(bars, ts(1), ts(2), 20.0, QTY)

    assert leg.entry_price == 100.0
    assert leg.exit_reason == TIME
    assert leg.exit_price == 100.0
    assert leg.bars_examined == 2


def test_trace_records_every_bar_examined_and_flags_the_trigger() -> None:
    """The audit dialog replays this list, so it must match bars_examined exactly."""
    bars = [
        bar(0, 100.0, 105.0, 98.0, 104.0),
        bar(1, 104.0, 110.0, 103.0, 109.0),
        bar(2, 109.0, 125.0, 108.0, 124.0),
        bar(3, 124.0, 130.0, 122.0, 128.0),
    ]

    trace: list[dict] = []
    leg = simulate_leg(bars, ts(0), ts(3), 20.0, QTY, trace)

    assert len(trace) == leg.bars_examined == 3
    assert [entry["stop_hit"] for entry in trace] == [False, False, True]
    assert [entry["ts"] for entry in trace] == [ts(0), ts(1), ts(2)]
    # A leg that runs to time never reports a trigger anywhere in its trace.
    quiet: list[dict] = []
    simulate_leg(flat_series(100.0, 50.0), ts(0), ts(5), 90.0, QTY, quiet)
    assert not any(entry["stop_hit"] for entry in quiet)
