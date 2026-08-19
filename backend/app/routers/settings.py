"""Credential setup: the API key, secret and redirect URL registered with Upstox."""

from fastapi import APIRouter

from .. import store
from ..config import DEFAULT_REDIRECT_URI
from ..schemas import SettingsIn, SettingsOut

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _mask(secret: str) -> str:
    if len(secret) <= 4:
        return "----"
    return f"{secret[:2]}{'-' * 8}{secret[-2:]}"


@router.get("", response_model=SettingsOut)
def read_settings() -> SettingsOut:
    row = store.get_settings()
    if row is None:
        return SettingsOut(
            configured=False,
            redirect_uri=DEFAULT_REDIRECT_URI,
            suggested_redirect_uri=DEFAULT_REDIRECT_URI,
        )
    return SettingsOut(
        configured=True,
        api_key=row["api_key"],
        api_secret_masked=_mask(row["api_secret"]),
        redirect_uri=row["redirect_uri"],
        updated_at=row["updated_at"],
        suggested_redirect_uri=DEFAULT_REDIRECT_URI,
    )


@router.post("", response_model=SettingsOut)
def write_settings(payload: SettingsIn) -> SettingsOut:
    store.save_settings(payload.api_key, payload.api_secret, payload.redirect_uri)
    return read_settings()
