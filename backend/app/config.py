"""Static configuration. Everything user-specific lives in SQLite, not in a .env file."""

from datetime import timedelta, timezone
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
PROJECT_DIR = BACKEND_DIR.parent
DB_PATH = BACKEND_DIR / "upstox.db"
FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"

# Where the browser is sent after the OAuth handshake completes. When the built
# frontend is served by this app the redirect stays on the same origin.
DEV_FRONTEND_URL = "http://127.0.0.1:5173"

HOST = "127.0.0.1"
PORT = 8000
BACKEND_URL = f"http://{HOST}:{PORT}"
DEFAULT_REDIRECT_URI = f"{BACKEND_URL}/api/auth/callback"

UPSTOX_AUTH_DIALOG = "https://api.upstox.com/v2/login/authorization/dialog"
UPSTOX_TOKEN_URL = "https://api.upstox.com/v2/login/authorization/token"
UPSTOX_PROFILE_URL = "https://api.upstox.com/v2/user/profile"
UPSTOX_LOGOUT_URL = "https://api.upstox.com/v2/logout"
UPSTOX_HISTORICAL_V3 = "https://api.upstox.com/v3/historical-candle"
UPSTOX_INTRADAY_V3 = "https://api.upstox.com/v3/historical-candle/intraday"
UPSTOX_NSE_INSTRUMENTS = (
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
)
# The complete BOD master: every exchange in one file, ~124k rows / 3.4 MB gzipped.
# NSE.json.gz above cannot see BSE, MCX or the global feeds at all. Public asset, so
# it is fetched without a bearer token.
UPSTOX_COMPLETE_INSTRUMENTS = (
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
)

IST = timezone(timedelta(hours=5, minutes=30))

# Access tokens issued by Upstox stay valid until 3:30 AM IST the next day.
TOKEN_EXPIRY_HOUR = 3
TOKEN_EXPIRY_MINUTE = 30

# Seeded instruments. Keys are refreshed from the Upstox NSE instrument file
# whenever /api/market/instruments/refresh is called.
SEED_INSTRUMENTS = [
    ("RELIANCE", "Reliance Industries", "NSE_EQ|INE002A01018", "NSE_EQ"),
    ("TCS", "Tata Consultancy Services", "NSE_EQ|INE467B01029", "NSE_EQ"),
    ("INFY", "Infosys", "NSE_EQ|INE009A01021", "NSE_EQ"),
    ("HDFCBANK", "HDFC Bank", "NSE_EQ|INE040A01034", "NSE_EQ"),
    ("SBIN", "State Bank of India", "NSE_EQ|INE062A01020", "NSE_EQ"),
]

DEFAULT_SYMBOL = "RELIANCE"
DEFAULT_UNIT = "minutes"
DEFAULT_INTERVAL = "5"
DEFAULT_SESSIONS = 5

# --- instrument master ------------------------------------------------------

# The 12 segments the complete file publishes. Kept as a whitelist rather than a
# mapping so a segment Upstox adds later shows up as unknown instead of vanishing.
KNOWN_SEGMENTS = (
    "NSE_EQ",
    "BSE_EQ",
    "NSE_INDEX",
    "BSE_INDEX",
    "GLOBAL_INDEX",
    "GLOBAL_INDICATOR",
    "NSE_FO",
    "BSE_FO",
    "NSE_COM",
    "MCX_FO",
    "NCD_FO",
    "BCD_FO",
)

# The `exchange` column is coarser than `segment` (four values for twelve segments),
# so filter on segment wherever precision matters.
KNOWN_EXCHANGES = ("NSE", "BSE", "MCX", "GLOBAL")

EQUITY_SEGMENTS = ("NSE_EQ", "BSE_EQ")
INDEX_SEGMENTS = ("NSE_INDEX", "BSE_INDEX", "GLOBAL_INDEX")

# GLOBAL_INDICATOR feeds (USDINR, Brent, WTI) are LTP-only: the OHLC and quote
# endpoints reject them, so they must never be offered as a chartable result.
UNCHARTABLE_SEGMENTS = ("GLOBAL_INDICATOR",)

# Search result ordering. Cash and index rows must outrank derivatives, otherwise a
# search for NIFTY buries the index under 35k option contracts.
SEGMENT_SEARCH_RANK = {
    "NSE_EQ": 0,
    "BSE_EQ": 1,
    "NSE_INDEX": 2,
    "BSE_INDEX": 3,
    "GLOBAL_INDEX": 4,
    "NSE_FO": 5,
    "BSE_FO": 6,
    "MCX_FO": 7,
    "NSE_COM": 8,
    "NCD_FO": 9,
    "BCD_FO": 10,
    "GLOBAL_INDICATOR": 11,
}
UNRANKED_SEGMENT_RANK = 99

SEARCH_LIMIT_DEFAULT = 25
SEARCH_LIMIT_MAX = 50

# instrument_sync.status values.
SYNC_IDLE = "idle"
SYNC_RUNNING = "running"
SYNC_OK = "ok"
SYNC_ERROR = "error"
SYNC_STATUSES = (SYNC_IDLE, SYNC_RUNNING, SYNC_OK, SYNC_ERROR)
