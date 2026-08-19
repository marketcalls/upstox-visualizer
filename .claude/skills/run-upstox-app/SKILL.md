---
name: run-upstox-app
description: Launch and drive the Upstox Console app (FastAPI + SQLite backend on port 8000 serving the built React frontend). Use when asked to run, start, restart, smoke test, or screenshot this app, or to confirm a change works in the real app rather than only in tests.
---

# Run the Upstox Console

FastAPI on `127.0.0.1:8000` serves both the JSON API under `/api` and the built
React SPA from `frontend/dist`. One process, one origin. Vite dev mode on 5173 is
optional and only worth starting when you are iterating on frontend source.

Paths below are relative to the project root, `upstox app/`.

## Port 8000 is not negotiable

`PORT = 8000` is hardcoded in `backend/app/config.py`, and `DEFAULT_REDIRECT_URI`
is derived from it. That exact string, `http://127.0.0.1:8000/api/auth/callback`,
is what the user registered on their Upstox developer app. Change the port and
OAuth login breaks until the URL is re-registered on upstox.com.

So: before launching, check the port and clear it rather than working around it.

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

If something is listening, identify it before doing anything:

```powershell
(Get-CimInstance Win32_Process -Filter "ProcessId=<PID>").CommandLine
```

- Command line contains `run.py` or `uvicorn` -> this app is already running.
  Reuse it, or stop it if you need a clean restart.
- Anything else -> an unrelated process owns the port. Ask the user before
  killing it. Do not silently `Stop-Process` someone else's server, and do not
  quietly switch ports, because that breaks the login flow described above.

## Launch

Dependencies are managed by `uv`. `backend/.venv` is gitignored, so a fresh clone
needs a sync; it is a no-op once the venv exists.

```bash
cd "backend"
uv sync
```

Start the server in the background, never the foreground. `run.py` calls
`uvicorn.run(..., reload=True)`, so it never returns.

```bash
cd "backend" && uv run python run.py     # run_in_background: true
```

Then block until it answers rather than sleeping a fixed amount:

```bash
until curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/health | grep -q 200; do sleep 0.5; done
echo "backend up"
```

`init_db()` runs in the FastAPI lifespan hook, so `backend/upstox.db` is created
and seeded on first start. No migration step.

### Frontend

`frontend/dist` is committed and already built, so the server has something to
serve immediately. Rebuild only when you changed something under `frontend/src`:

```bash
cd "frontend"
npm install     # only if node_modules is missing
npm run build   # tsc -b && vite build
```

`main.py` mounts `/assets` from `frontend/dist/assets` and adds a catch-all SPA
route, but only if `FRONTEND_DIST` exists at import time. If you delete `dist`,
restart the backend after rebuilding or every route 404s.

For hot reload on frontend work, run `npm run dev` alongside the backend and use
port 5173; Vite proxies `/api` to 8000 and CORS already allows that origin.

## Drive it

Launching alone proves nothing. Smoke the API, then look at the UI.

```bash
curl -s http://127.0.0.1:8000/api/health
curl -s http://127.0.0.1:8000/api/settings
curl -s http://127.0.0.1:8000/api/auth/status
curl -s http://127.0.0.1:8000/api/market/instruments
curl -s "http://127.0.0.1:8000/api/market/candles?symbol=RELIANCE&unit=minutes&interval=5&sessions=5" | head -c 600
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:8000/
```

Then open it in the browser with the `claude-in-chrome` tools and screenshot both
routes. Look at the screenshot; a blank frame means the SPA mount failed.

- `/` -> Setup screen, "Set up Upstox API access", the callback URL, key/secret form.
- `/chart` -> RELIANCE 5-minute candles, stat row, TradingView candlestick chart.

The first screenshot of `/chart` can time out at 30s while Lightweight Charts
does its initial render. Retry once before treating it as a failure.

Interactive API docs are at `/docs`.

## Expect the offline path

An expired access token is the normal state, not a bug. Tokens die at 03:30 IST
the day after they are issued, and the stored one is usually stale.

What that correctly looks like:

- `/api/auth/status` returns `connected: false` with `seconds_to_expiry: 0`,
  while `configured: true` and the saved `user_name` persist.
- `/api/market/candles` still returns 200, served from the `candles` table in
  SQLite, flagged as `cache`.
- The chart renders history with an `OFFLINE` header pill, a `SQLITE CACHE`
  badge, an amber "No active Upstox session" banner and a toast saying the data
  is local.

That is a working app. Report it as running. Only a real Upstox login refreshes
the token, and that means the user completing OAuth on upstox.com in their own
browser: do not attempt it, and never type API keys or secrets into the setup
form yourself.

## Stopping and resetting

Stop the background task rather than killing python broadly; `reload=True` means
uvicorn runs a reloader parent plus a worker child, and killing only the child
gets it silently respawned.

To start from a clean database, stop the backend first, then delete
`backend/upstox.db`. This wipes the saved API key, secret and token, so the user
has to re-enter credentials and log in again. Confirm before doing it.
