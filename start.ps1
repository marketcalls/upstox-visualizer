# Build the frontend once, then serve everything from FastAPI on port 8000.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Set-Location (Join-Path $root "frontend")
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing frontend dependencies"
    npm install
}
Write-Host "Building frontend"
npm run build

Set-Location (Join-Path $root "backend")
Write-Host "Syncing backend dependencies"
uv sync
Write-Host "Starting on http://127.0.0.1:8000"
uv run python run.py
