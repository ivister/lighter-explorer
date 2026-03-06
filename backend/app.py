import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
import httpx

LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai")

# Derive WS URL from base: https:// → wss://, http:// → ws://, append /stream
_ws_scheme = "wss://" if LIGHTER_BASE_URL.startswith("https://") else "ws://"
LIGHTER_WS_URL = _ws_scheme + LIGHTER_BASE_URL.split("://", 1)[1].rstrip("/") + "/stream"

# ── Simple in-memory cache ────────────────────────────────────────────

_cache = {}       # key → (timestamp, data)
CACHE_TTL = 5.0   # seconds

http_client = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        base_url=LIGHTER_BASE_URL,
        timeout=15.0,
        transport=httpx.AsyncHTTPTransport(retries=2),
    )
    yield
    await http_client.aclose()


app = FastAPI(title="Lighter Explorer", lifespan=lifespan)


# ── Input validation ─────────────────────────────────────────────────

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{1,64}$")
_INDEX_RE = re.compile(r"^\d{1,20}$")


# ── Health endpoint ──────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    """Basic health check."""
    return {"status": "ok", "upstream": LIGHTER_BASE_URL}


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
    # Validate 'by' parameter
    if by not in ("index", "l1_address"):
        raise HTTPException(status_code=400, detail="Invalid 'by' parameter. Use 'index' or 'l1_address'.")

    # Validate 'value' format
    if by == "l1_address" and not _ADDRESS_RE.match(value):
        raise HTTPException(status_code=400, detail="Invalid L1 address format.")
    if by == "index" and not _INDEX_RE.match(value):
        raise HTTPException(status_code=400, detail="Invalid account index format.")

    # Check cache
    cache_key = f"{by}:{value}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]

    resp = await http_client.get(
        "/api/v1/account",
        params={"by": by, "value": value},
    )
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)

    data = resp.json()
    _cache[cache_key] = (now, data)

    # Prune old cache entries periodically
    if len(_cache) > 500:
        cutoff = now - CACHE_TTL * 2
        expired = [k for k, v in _cache.items() if v[0] < cutoff]
        for k in expired:
            del _cache[k]

    return data


def _lighter_error(resp) -> str:
    """Extract human-readable error from Lighter API response."""
    try:
        data = resp.json()
        return data.get("message", "Lighter API error")
    except Exception:
        return "Lighter API error"


# ── Serve frontend ───────────────────────────────────────────────────

app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
