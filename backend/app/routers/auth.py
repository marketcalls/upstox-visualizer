"""OAuth handshake with Upstox: authorize, exchange the code, keep the session."""

import base64
import binascii
import json
import secrets
from datetime import datetime
from urllib.parse import quote, urlparse

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import RedirectResponse

from .. import store, upstox
from ..config import BACKEND_URL, DEV_FRONTEND_URL, FRONTEND_DIST
from ..schemas import AuthStatus, LoginUrl
from . import market

router = APIRouter(prefix="/api/auth", tags=["auth"])

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _default_origin() -> str:
    """Without a hint, prefer the built frontend, otherwise the Vite dev server."""
    return BACKEND_URL if FRONTEND_DIST.exists() else DEV_FRONTEND_URL


def _safe_origin(candidate: str | None) -> str:
    """Only ever redirect back to a local origin."""
    if not candidate:
        return _default_origin()
    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.hostname in LOOPBACK_HOSTS:
        return f"{parsed.scheme}://{parsed.netloc}"
    return _default_origin()


def _pack_state(origin: str) -> str:
    """Carry the caller's origin through Upstox so the callback can return to it."""
    token = secrets.token_urlsafe(9)
    encoded = base64.urlsafe_b64encode(origin.encode()).decode().rstrip("=")
    return f"{token}.{encoded}"


def _unpack_state(state: str | None) -> str:
    if not state or "." not in state:
        return _default_origin()
    encoded = state.split(".", 1)[1]
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        return _safe_origin(base64.urlsafe_b64decode(padded).decode())
    except (binascii.Error, UnicodeDecodeError):
        return _default_origin()


def _require_settings():
    row = store.get_settings()
    if row is None:
        raise HTTPException(
            status_code=400,
            detail="Save your API key, API secret and redirect URL before logging in.",
        )
    return row


@router.get("/login-url", response_model=LoginUrl)
def login_url(request: Request) -> LoginUrl:
    row = _require_settings()
    origin = _safe_origin(request.headers.get("origin") or request.headers.get("referer"))
    return LoginUrl(
        login_url=upstox.build_login_url(
            row["api_key"], row["redirect_uri"], _pack_state(origin)
        ),
        redirect_uri=row["redirect_uri"],
    )


@router.get("/login")
def login(request: Request) -> RedirectResponse:
    """Convenience entry point: open this URL and land on the Upstox login page."""
    row = _require_settings()
    origin = _safe_origin(request.headers.get("referer"))
    target = upstox.build_login_url(
        row["api_key"], row["redirect_uri"], _pack_state(origin)
    )
    return RedirectResponse(target, status_code=302)


@router.get("/callback")
async def callback(
    background_tasks: BackgroundTasks,
    code: str | None = None,
    state: str | None = None,
) -> RedirectResponse:
    """Upstox redirects the browser here with a single-use authorization code."""
    origin = _unpack_state(state)

    def back(path: str) -> RedirectResponse:
        return RedirectResponse(f"{origin}{path}", status_code=302)

    if not code:
        return back("/?error=" + quote("Upstox did not return an authorization code."))

    row = store.get_settings()
    if row is None:
        return back("/?error=" + quote("Credentials are missing. Save them and retry."))

    try:
        payload = await upstox.exchange_code(
            code, row["api_key"], row["api_secret"], row["redirect_uri"]
        )
    except upstox.UpstoxError as exc:
        detail = f"{exc.message} ({exc.code})" if exc.code else exc.message
        return back("/?error=" + quote(detail))

    store.save_session(payload)

    # Freshen the instrument master on the way in, so the search box is populated before
    # the user reaches for it. It is a public file needing no token, it runs after this
    # redirect has been sent, and it records its own failures, so a bad download can
    # never turn a good login into an error. Skipped when today's copy is already local.
    market.schedule_master_download(background_tasks, only_if_stale=True)
    return back("/chart?connected=1")


@router.get("/status", response_model=AuthStatus)
def status() -> AuthStatus:
    configured = store.get_settings() is not None
    row = store.get_session_row()
    if row is None:
        return AuthStatus(connected=False, configured=configured)

    expires_at = datetime.fromisoformat(row["expires_at"])
    seconds_left = int((expires_at - store.now_ist()).total_seconds())
    if seconds_left <= 0:
        return AuthStatus(
            connected=False,
            configured=configured,
            user_name=row["user_name"],
            expires_at=row["expires_at"],
        )

    return AuthStatus(
        connected=True,
        configured=configured,
        user_id=row["user_id"],
        user_name=row["user_name"],
        email=row["email"],
        broker=row["broker"],
        exchanges=json.loads(row["exchanges"] or "[]"),
        products=json.loads(row["products"] or "[]"),
        issued_at=row["issued_at"],
        expires_at=row["expires_at"],
        seconds_to_expiry=seconds_left,
    )


@router.post("/logout")
async def logout() -> dict[str, bool]:
    token = store.active_token()
    if token:
        try:
            await upstox.logout(token)
        except Exception:  # the local session is cleared either way
            pass
    store.clear_session()
    return {"disconnected": True}
