"""Request and response models for the API."""

import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator


class SettingsIn(BaseModel):
    api_key: str = Field(min_length=6, max_length=200)
    api_secret: str = Field(min_length=4, max_length=200)
    redirect_uri: str = Field(min_length=8, max_length=500)

    @field_validator("api_key", "api_secret", "redirect_uri")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("redirect_uri")
    @classmethod
    def valid_url(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("Redirect URL must start with http:// or https://")
        return value


class SettingsOut(BaseModel):
    configured: bool
    api_key: str | None = None
    api_secret_masked: str | None = None
    redirect_uri: str
    updated_at: str | None = None
    suggested_redirect_uri: str


class AuthStatus(BaseModel):
    connected: bool
    configured: bool
    user_id: str | None = None
    user_name: str | None = None
    email: str | None = None
    broker: str | None = None
    exchanges: list[str] = []
    products: list[str] = []
    issued_at: str | None = None
    expires_at: str | None = None
    seconds_to_expiry: int = 0


class LoginUrl(BaseModel):
    login_url: str
    redirect_uri: str


class Candle(BaseModel):
    time: int  # epoch seconds (UTC), what the chart plots
    iso: str  # timestamp exactly as Upstox returned it, in IST
    open: float
    high: float
    low: float
    close: float
    volume: int


class SessionSummary(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    change_pct: float
    candles: int


class CandleStats(BaseModel):
    last_price: float
    change: float
    change_pct: float
    day_high: float
    day_low: float
    range_high: float
    range_low: float
    total_volume: int
    candle_count: int
    first_candle: str
    last_candle: str


class Instrument(BaseModel):
    symbol: str
    name: str
    instrument_key: str
    segment: str


class InstrumentSearchResult(BaseModel):
    """One row of the instrument master, shaped for the search box and the chart header."""

    instrument_key: str
    trading_symbol: str
    name: str | None = None
    short_name: str | None = None
    exchange: str | None = None
    segment: str | None = None
    instrument_type: str | None = None
    isin: str | None = None
    lot_size: int | None = None
    # Upstox publishes tick_size in paise. Divide by 100 before showing a rupee tick.
    tick_size: float | None = None
    expiry: str | None = None
    strike_price: float | None = None
    underlying_key: str | None = None
    underlying_symbol: str | None = None
    # Null on cash and index rows, where "weekly" has no meaning at all.
    weekly: bool | None = None
    security_type: str | None = None


class SegmentCount(BaseModel):
    segment: str
    count: int


class InstrumentSyncStatus(BaseModel):
    """State of the instrument master download, polled by the UI while it runs."""

    status: Literal["idle", "running", "ok", "error"]
    row_count: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    source_url: str | None = None
    message: str | None = None
    segments: list[SegmentCount] = []


class CandleResponse(BaseModel):
    instrument: Instrument
    unit: Literal["minutes", "hours", "days", "weeks", "months"]
    interval: str
    sessions: list[SessionSummary]
    candles: list[Candle]
    stats: CandleStats | None
    source: Literal["upstox", "cache"]
    fetched_at: str
    notice: str | None = None


# --- ATM short straddle heatmap ------------------------------------------------

# Closed sets shared by the engine, the services and the routers. Aliased so the
# allowed values are written down once instead of being repeated on every model.
Underlying = Literal["NIFTY", "BANKNIFTY", "SENSEX"]
ExitReason = Literal["STOP_LOSS", "STOP_LOSS_GAP", "TIME", "NO_EXIT_DATA"]
CellStatus = Literal["ok", "unavailable"]

# What the ATM strike is measured against at the entry minute:
#   spot      - the index bar's open, the original behaviour and still the default
#   synthetic - put-call parity on the expiry being traded, K + CE - PE
#   future    - the current-month FUT contract's bar open
# Spot and the two futures-based measures routinely pick different strikes, which is the
# whole reason the mode is a request field rather than a constant.
UnderlyingMode = Literal["spot", "synthetic", "future"]

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _clean_date(value: str, field: str) -> str:
    text = value.strip()
    if not _DATE_RE.match(text):
        raise ValueError(f"{field} must be a YYYY-MM-DD date, got {value!r}")
    return text


def _clean_time(value: str, field: str) -> str:
    text = value.strip()
    if not _TIME_RE.match(text):
        raise ValueError(f"{field} must be HH:MM in 24-hour form, got {value!r}")
    return text


class UnderlyingInfo(BaseModel):
    """One supported index, with the keys the resolver needs to reach its options."""

    symbol: str
    index_instrument_key: str
    option_segment: str
    lot_size: int


class LastSessionInfo(BaseModel):
    """The most recent date that actually has 1-minute data for one underlying.

    The form defaults to this instead of to today, because before the open, and on a
    weekend or a holiday, today has no bars at all and every cell would come back
    unavailable. is_today lets the UI say which of the two it is offering.
    """

    date: str  # YYYY-MM-DD
    is_today: bool


class BarTrace(BaseModel):
    """One minute bar as the engine saw it, so a cell can be checked by hand."""

    time: str  # HH:MM in IST, stamped at the bar open
    open: float
    high: float
    low: float
    close: float
    stop_price: float
    triggered: bool


class LegDetail(BaseModel):
    """The fill history of one short leg, CE or PE."""

    symbol: str
    instrument_key: str
    entry_price: float
    stop_price: float
    exit_price: float
    exit_reason: ExitReason
    exit_time: str  # HH:MM in IST
    pnl: float


class HeatmapCell(BaseModel):
    """One (entry time, stop loss) simulation. Everything but the key is null when unavailable."""

    entry_time: str
    stop_loss: float
    status: CellStatus
    reason: str | None = None  # why the cell is unavailable, e.g. no bar at the entry minute
    gross_pnl: float | None = None
    net_pnl: float | None = None
    ce: LegDetail | None = None
    pe: LegDetail | None = None
    strike: float | None = None
    # Always the raw index spot, whatever the mode, so the two can be compared side by side.
    spot_at_entry: float | None = None
    quantity: int | None = None
    # The number the ATM decision actually used: equal to spot_at_entry in spot mode, and
    # the synthetic or futures price otherwise. Carried per cell because the mode is
    # evaluated at each entry minute and a single minute can be unavailable on its own.
    underlying_price: float | None = None
    underlying_mode: str | None = None


class HeatmapRequest(BaseModel):
    """One backtest date, one expiry, a grid of entry times against stop-loss levels."""

    underlying: Underlying
    date: str  # YYYY-MM-DD
    expiry: str  # YYYY-MM-DD, must still be live in instrument_master
    entry_times: list[str]  # HH:MM
    stop_losses: list[float]  # percent, e.g. 20 means a stop 20% above entry
    exit_time: str = "15:15"
    lots: int = Field(default=1, ge=1, le=100)
    # Defaults to spot, so a body written before this field existed runs exactly as it did.
    underlying_mode: UnderlyingMode = "spot"

    @field_validator("date", "expiry")
    @classmethod
    def valid_date(cls, value: str, info: ValidationInfo) -> str:
        return _clean_date(value, info.field_name)

    @field_validator("exit_time")
    @classmethod
    def valid_exit_time(cls, value: str, info: ValidationInfo) -> str:
        return _clean_time(value, info.field_name)

    @field_validator("entry_times")
    @classmethod
    def valid_entry_times(cls, value: list[str]) -> list[str]:
        cleaned = [_clean_time(item, "entry_times") for item in value]
        # Dedup before the size check: the grid cost is driven by DISTINCT minutes, so a
        # caller repeating 09:20 twice should not be charged a row or be rejected for it.
        unique = sorted(set(cleaned))
        if not 1 <= len(unique) <= 40:
            raise ValueError(f"entry_times needs 1 to 40 distinct times, got {len(unique)}")
        return unique

    @field_validator("stop_losses")
    @classmethod
    def valid_stop_losses(cls, value: list[float]) -> list[float]:
        for pct in value:
            if pct <= 0:
                raise ValueError(f"stop_losses must all be greater than 0, got {pct}")
        unique = sorted(set(value))
        if not 1 <= len(unique) <= 20:
            raise ValueError(f"stop_losses needs 1 to 20 distinct values, got {len(unique)}")
        return unique

    @model_validator(mode="after")
    def entries_before_exit(self) -> "HeatmapRequest":
        # Zero-padded HH:MM sorts and compares correctly as plain text, so no parsing here.
        for entry in self.entry_times:
            if entry >= self.exit_time:
                raise ValueError(
                    f"entry time {entry} must be strictly before exit time {self.exit_time}"
                )
        return self


class HeatmapResponse(BaseModel):
    """The full grid, row major, plus the context needed to read it without a second call."""

    underlying: str
    date: str
    expiry: str
    exit_time: str
    lots: int
    lot_size: int
    quantity: int  # lots * lot_size, the per-leg quantity every pnl was computed against
    entry_times: list[str]
    stop_losses: list[float]
    cells: list[HeatmapCell]
    row_totals: dict[str, float]  # entry_time -> sum of that row
    col_totals: dict[str, float]  # str(stop_loss) -> sum of that column
    # Diagnostic only. It adds up independent hypothetical trades that were never all
    # taken together, so the UI must label it as such and never call it a strategy pnl.
    grand_total: float
    unavailable_count: int
    warnings: list[str] = []
    # Echoed back so a saved or shared grid still says what its strikes were picked from.
    # Defaulted rather than required, so the field can be added here before every caller
    # sets it, and the old spot-only behaviour is what a caller that never sets it gets.
    underlying_mode: str = "spot"


class AuditRequest(BaseModel):
    """Re-run a single cell and keep every bar the engine walked."""

    underlying: Underlying
    date: str
    expiry: str
    entry_time: str
    stop_loss: float = Field(gt=0)
    exit_time: str = "15:15"
    lots: int = Field(default=1, ge=1, le=100)
    # Must match the heatmap request that produced the cell, or the audit re-runs a
    # different strike and disagrees with the grid it is supposed to explain.
    underlying_mode: UnderlyingMode = "spot"

    @field_validator("date", "expiry")
    @classmethod
    def valid_date(cls, value: str, info: ValidationInfo) -> str:
        return _clean_date(value, info.field_name)

    @field_validator("entry_time", "exit_time")
    @classmethod
    def valid_time(cls, value: str, info: ValidationInfo) -> str:
        return _clean_time(value, info.field_name)

    @model_validator(mode="after")
    def entry_before_exit(self) -> "AuditRequest":
        if self.entry_time >= self.exit_time:
            raise ValueError(
                f"entry time {self.entry_time} must be strictly before exit time {self.exit_time}"
            )
        return self


class AuditResponse(BaseModel):
    """One cell with its resolved contracts and its bar-by-bar trace, for manual verification."""

    underlying: str
    date: str
    expiry: str
    spot_at_entry: float
    strike: float
    lot_size: int
    quantity: int
    ce_key: str
    ce_symbol: str
    pe_key: str
    pe_symbol: str
    cell: HeatmapCell
    ce_trace: list[BarTrace] = []
    pe_trace: list[BarTrace] = []
