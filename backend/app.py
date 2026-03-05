import os

from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
import httpx

LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai")

# Derive WS URL from base: https:// → wss://, http:// → ws://, append /stream
_ws_scheme = "wss://" if LIGHTER_BASE_URL.startswith("https://") else "ws://"
LIGHTER_WS_URL = _ws_scheme + LIGHTER_BASE_URL.split("://", 1)[1].rstrip("/") + "/stream"

app = FastAPI(title="Lighter Explorer")

http_client = httpx.AsyncClient(base_url=LIGHTER_BASE_URL, timeout=15.0)


@app.on_event("shutdown")
async def shutdown():
    await http_client.aclose()


# ── Config endpoint ──────────────────────────────────────────────────

@app.get("/api/config")
async def get_config():
    """Return frontend configuration."""
    return {
        "ws_url": LIGHTER_WS_URL,
    }


# ── Lighter proxy endpoints ──────────────────────────────────────────

@app.get("/api/account")
async def get_account_detail(
    by: str = Query("index", description="'index' or 'l1_address'"),
    value: str = Query(..., description="Account index or L1 address"),
):
    """Return detailed account info (positions, balances, etc.)."""
    resp = await http_client.get(
        "/api/v1/account",
        params={"by": by, "value": value},
    )
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)
    return resp.json()


def _lighter_error(resp) -> str:
    """Extract human-readable error from Lighter API response."""
    try:
        data = resp.json()
        return data.get("message", "Lighter API error")
    except Exception:
        return "Lighter API error"


# ── Serve frontend ───────────────────────────────────────────────────

app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
