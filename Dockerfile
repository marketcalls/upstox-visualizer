# syntax=docker/dockerfile:1

# Upstox Visualizer as a single container: the React bundle is built once and
# then served by the same FastAPI process that answers /api, so the whole app
# stays on one origin and one port, exactly as it does on the host.


# --- 1. Build the React bundle ----------------------------------------------
FROM node:22-slim AS frontend

WORKDIR /build

# Dependencies first so an edit under src/ does not re-run npm ci.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# --- 2. Runtime: FastAPI plus the built bundle -------------------------------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Upstox Visualizer"
LABEL org.opencontainers.image.description="Upstox OAuth, instrument master and canvas charting terminal"
LABEL org.opencontainers.image.licenses="MIT"

# The venv lives outside /app so copying source never invalidates it and a
# bind-mounted source tree cannot shadow it.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV PATH=/opt/venv/bin:$PATH
ENV PYTHONUNBUFFERED=1

# The venv is byte-compiled at build time, so nothing needs to write .pyc at
# runtime. Required for the read-only root filesystem used in production.
ENV PYTHONDONTWRITEBYTECODE=1

# config.py derives DB_PATH from this, putting the SQLite file and its WAL
# sidecars on the mounted volume instead of inside the container filesystem.
ENV UPSTOX_DB_PATH=/app/data/upstox.db

WORKDIR /app/backend

# Locked install of the four runtime dependencies. No dev group, no tests.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

# config.py resolves FRONTEND_DIST as ../frontend/dist relative to the backend
# directory, so the layout below has to mirror the repository.
COPY backend/app ./app
COPY backend/run.py ./
COPY --from=frontend /build/dist /app/frontend/dist

# Unprivileged runtime user. /app/data is created and chowned here so a fresh
# named volume inherits the ownership when Docker seeds it.
RUN useradd --create-home --uid 10001 upstox \
    && mkdir -p /app/data \
    && chown -R upstox:upstox /app
USER upstox

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]

# run.py hardcodes host 127.0.0.1 with reload=True, which is right on a laptop
# and wrong in a container: the port would not be reachable through the bridge
# and the reloader has no source tree worth watching. Bind the container's own
# interfaces instead.
#
# --proxy-headers keeps the scheme correct behind a TLS terminator. Trusting
# forwarded headers from any peer is safe in both supported topologies, because
# nothing but the proxy can open a connection to this port: production
# publishes no port at all, and the local compose file publishes to loopback.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
