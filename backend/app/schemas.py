"""Request and response models for the API."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator


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
