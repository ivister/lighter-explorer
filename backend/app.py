import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
import httpx

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
logger = logging.getLogger(__name__)

LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai")
EXPLORER_BASE_URL = os.environ.get("EXPLORER_BASE_URL", "https://explorer.elliot.ai")

# Derive WS URL from base: https:// → wss://, http:// → ws://, append /stream
_ws_scheme = "wss://" if LIGHTER_BASE_URL.startswith("https://") else "ws://"
LIGHTER_WS_URL = _ws_scheme + LIGHTER_BASE_URL.split("://", 1)[1].rstrip("/") + "/stream"

# ── Simple in-memory cache ────────────────────────────────────────────

_cache = {}       # key → (timestamp, data)
CACHE_TTL = 5.0   # seconds

http_client = None
explorer_client = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, explorer_client
    http_client = httpx.AsyncClient(
        base_url=LIGHTER_BASE_URL,
        timeout=15.0,
        transport=httpx.AsyncHTTPTransport(retries=2),
    )
    explorer_client = httpx.AsyncClient(
        base_url=EXPLORER_BASE_URL,
        timeout=30.0,
        transport=httpx.AsyncHTTPTransport(retries=1),
    )
    logger.info("Lighter Explorer started — upstream=%s, explorer=%s", LIGHTER_BASE_URL, EXPLORER_BASE_URL)
    yield
    await http_client.aclose()
    await explorer_client.aclose()


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
        "explorer_url": EXPLORER_BASE_URL,
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


@app.get("/api/markets")
async def get_markets():
    """Proxy markets list from explorer API (cached)."""
    cache_key = "_markets_"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < 300:  # 5-minute cache
        return cached[1]

    resp = await explorer_client.get("/api/markets")
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)

    data = resp.json()
    _cache[cache_key] = (now, data)
    return data


@app.get("/api/contracts")
async def get_contracts():
    """Return condensed contract/market specs (price_decimals, size_decimals) cached 10 min."""
    cache_key = "_contracts_"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < 600:
        return cached[1]

    resp = await http_client.get("/api/v1/orderBookDetails?filter=all")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="upstream error")

    raw = resp.json()
    result = []
    for src in ("order_book_details", "spot_order_book_details"):
        for m in raw.get(src) or []:
            result.append({
                "market_id":       m["market_id"],
                "symbol":          m["symbol"],
                "price_decimals":  m["price_decimals"],
                "size_decimals":   m["size_decimals"],
                "quote_decimals":  m.get("supported_quote_decimals", 6),
                "min_base_amount": m.get("min_base_amount"),
                "taker_fee":       m.get("taker_fee"),
                "maker_fee":       m.get("maker_fee"),
            })

    _cache[cache_key] = (now, result)
    return result


@app.get("/api/account-logs/{param}")
async def get_account_logs(
    param: str,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Proxy account logs from explorer API."""
    if not _ADDRESS_RE.match(param) and not _INDEX_RE.match(param):
        raise HTTPException(status_code=400, detail="Invalid param format.")

    resp = await explorer_client.get(
        f"/api/accounts/{param}/logs",
        params={"limit": str(limit), "offset": str(offset)},
    )
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)
    return resp.json()


_TX_HASH_RE = re.compile(r"^[0-9a-fA-F]{40,80}$")


@app.get("/api/tx")
async def get_tx(hash: str = Query(..., alias="hash")):
    """Proxy transaction lookup from Lighter API."""
    if not _TX_HASH_RE.match(hash):
        raise HTTPException(status_code=400, detail="Invalid tx hash format.")

    resp = await http_client.get("/api/v1/tx", params={"by": "hash", "value": hash})
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)
    return resp.json()


def _lighter_error(resp) -> str:
    """Extract human-readable error from Lighter API response."""
    try:
        data = resp.json()
        msg = data.get("message", "Lighter API error")
    except Exception:
        msg = "Lighter API error"
    logger.warning("Upstream error %s: %s", resp.status_code, msg)
    return msg


# ── Serve frontend ───────────────────────────────────────────────────

app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
