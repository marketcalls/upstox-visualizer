"""FastAPI entry point for the Upstox chart console."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import DEV_FRONTEND_URL, FRONTEND_DIST
from .db import init_db
from .routers import auth, market, settings
from .upstox import UpstoxError


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Upstox Chart Console",
    description="Upstox OAuth setup and 5-minute candle charts, backed by SQLite.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[DEV_FRONTEND_URL, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(UpstoxError)
async def upstox_error_handler(_, exc: UpstoxError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})


app.include_router(settings.router)
app.include_router(auth.router)
app.include_router(market.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
