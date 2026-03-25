import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
import httpx
import websockets

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
logger = logging.getLogger(__name__)

LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai")
EXPLORER_BASE_URL = os.environ.get("EXPLORER_BASE_URL", "https://explorer.elliot.ai")

_ws_scheme = "wss://" if LIGHTER_BASE_URL.startswith("https://") else "ws://"
LIGHTER_WS_URL = _ws_scheme + LIGHTER_BASE_URL.split("://", 1)[1].rstrip("/") + "/stream"

# ── Simple in-memory cache ────────────────────────────────────────────

_cache = {}       # key → (timestamp, data)
CACHE_TTL = 5.0   # seconds

http_client = None
explorer_client = None


# ── WebSocket proxy ───────────────────────────────────────────────────
#
# Maintains ONE persistent WS connection to Lighter.
# All browser clients connect to /ws on our backend.
# Subscriptions to Lighter are ref-counted and deduplicated:
#   N clients subscribing to the same channel → 1 subscription upstream.

class LighterWSProxy:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        # channel (normalized, with /) → set of client WebSockets
        self._subs: dict[str, set] = {}
        # channel → subscriber ref count (for Lighter-side dedup)
        self._lighter_refs: dict[str, int] = {}
        self._lighter_ws = None
        self._reconnect_delay = 1.0
        # Signals that at least one subscription exists — drives connect/disconnect
        self._has_subs = asyncio.Event()

    def start(self):
        asyncio.create_task(self._lighter_loop())

    # ── Lighter connection ────────────────────────────────────────────

    async def _lighter_loop(self):
        while True:
            # Sleep until at least one client subscribes
            await self._has_subs.wait()
            if not self._lighter_refs:
                continue

            try:
                logger.info("WS proxy: connecting to %s", self.ws_url)
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=None,
                    close_timeout=5,
                ) as ws:
                    self._lighter_ws = ws
                    self._reconnect_delay = 1.0
                    logger.info("WS proxy: connected")
                    for ch in list(self._lighter_refs):
                        await ws.send(json.dumps({"type": "subscribe", "channel": ch}))
                    async for raw in ws:
                        await self._on_lighter_msg(raw)
                logger.info("WS proxy: disconnected cleanly (no clients)")
            except Exception as e:
                logger.warning("WS proxy: lost connection: %s", e)
            finally:
                self._lighter_ws = None

            # If clients are still waiting — reconnect with backoff
            if self._lighter_refs:
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, 30.0)
            # Otherwise loop back and wait for next subscriber

    async def _on_lighter_msg(self, raw: str):
        try:
            msg = json.loads(raw)
        except Exception:
            return

        t = msg.get("type")
        if t == "ping":
            if self._lighter_ws:
                try:
                    await self._lighter_ws.send(json.dumps({"type": "pong"}))
                except Exception:
                    pass
            return
        if t in ("connected", "pong"):
            return

        # Normalize channel separator: "market_stats:0" → "market_stats/0"
        channel = msg.get("channel") or ""
        norm = channel.replace(":", "/")
        raw_out = json.dumps({**msg, "channel": norm})

        # Deliver to all clients whose subscription matches
        dead = []
        for sub_ch, clients in list(self._subs.items()):
            if sub_ch == norm or (sub_ch.endswith("/all") and norm.startswith(sub_ch[:-3])):
                for client in list(clients):
                    try:
                        await client.send_text(raw_out)
                    except Exception:
                        dead.append((sub_ch, client))

        for sub_ch, client in dead:
            await self._unsub(client, sub_ch)

    # ── Client handling ───────────────────────────────────────────────

    async def handle_client(self, ws: WebSocket):
        await ws.accept()
        await ws.send_text(json.dumps({"type": "connected"}))
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                t = msg.get("type")
                ch = msg.get("channel") or ""
                if t == "subscribe" and ch:
                    await self._sub(ws, ch)
                elif t == "unsubscribe" and ch:
                    await self._unsub(ws, ch)
                elif t == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            await self._remove_client(ws)

    async def _sub(self, ws: WebSocket, channel: str):
        if channel not in self._subs:
            self._subs[channel] = set()
        self._subs[channel].add(ws)

        refs = self._lighter_refs.get(channel, 0)
        self._lighter_refs[channel] = refs + 1

        if refs == 0:
            # First subscriber for this channel — signal loop to connect (if not already)
            self._has_subs.set()
            if self._lighter_ws:
                try:
                    await self._lighter_ws.send(json.dumps({"type": "subscribe", "channel": channel}))
                except Exception:
                    pass

    async def _unsub(self, ws: WebSocket, channel: str):
        clients = self._subs.get(channel)
        if clients:
            clients.discard(ws)
            if not clients:
                del self._subs[channel]

        refs = self._lighter_refs.get(channel, 0)
        if refs > 0:
            self._lighter_refs[channel] = refs - 1
            if refs == 1:
                # Last subscriber for this channel
                del self._lighter_refs[channel]
                if self._lighter_ws:
                    try:
                        await self._lighter_ws.send(json.dumps({"type": "unsubscribe", "channel": channel}))
                    except Exception:
                        pass

                # No channels left → close Lighter WS, loop will idle
                if not self._lighter_refs:
                    self._has_subs.clear()
                    lws, self._lighter_ws = self._lighter_ws, None
                    if lws:
                        logger.info("WS proxy: all clients gone, closing Lighter connection")
                        try:
                            await lws.close()
                        except Exception:
                            pass

    async def _remove_client(self, ws: WebSocket):
        for channel in list(self._subs):
            if ws in (self._subs.get(channel) or set()):
                await self._unsub(ws, channel)

    @property
    def stats(self):
        return {
            "lighter_connected": self._lighter_ws is not None,
            "lighter_channels": list(self._lighter_refs),
            "client_count": sum(len(v) for v in self._subs.values()),
        }


ws_proxy = LighterWSProxy(LIGHTER_WS_URL)


# ── App lifecycle ─────────────────────────────────────────────────────

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
    ws_proxy.start()
    logger.info("Lighter Explorer started — upstream=%s, explorer=%s", LIGHTER_BASE_URL, EXPLORER_BASE_URL)
    yield
    await http_client.aclose()
    await explorer_client.aclose()


app = FastAPI(title="Lighter Explorer", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)


# ── Input validation ─────────────────────────────────────────────────

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{1,64}$")
_INDEX_RE = re.compile(r"^\d{1,20}$")


# ── WebSocket endpoint ────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_proxy.handle_client(ws)


# ── Health endpoint ──────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "upstream": LIGHTER_BASE_URL, "ws_proxy": ws_proxy.stats}


# ── Config endpoint ──────────────────────────────────────────────────

@app.get("/api/config")
async def get_config():
    """Return frontend configuration. ws_url is now served by our backend."""
    return {
        "explorer_url": EXPLORER_BASE_URL,
    }


# ── Lighter proxy endpoints ──────────────────────────────────────────

@app.get("/api/account")
async def get_account_detail(
    by: str = Query("index", description="'index' or 'l1_address'"),
    value: str = Query(..., description="Account index or L1 address"),
):
    if by not in ("index", "l1_address"):
        raise HTTPException(status_code=400, detail="Invalid 'by' parameter. Use 'index' or 'l1_address'.")
    if by == "l1_address" and not _ADDRESS_RE.match(value):
        raise HTTPException(status_code=400, detail="Invalid L1 address format.")
    if by == "index" and not _INDEX_RE.match(value):
        raise HTTPException(status_code=400, detail="Invalid account index format.")

    cache_key = f"{by}:{value}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]

    resp = await http_client.get("/api/v1/account", params={"by": by, "value": value})
    if resp.status_code != 200:
        msg = _lighter_error(resp)
        raise HTTPException(status_code=resp.status_code, detail=msg)

    data = resp.json()
    _cache[cache_key] = (now, data)

    if len(_cache) > 500:
        cutoff = now - CACHE_TTL * 2
        expired = [k for k, v in _cache.items() if v[0] < cutoff]
        for k in expired:
            del _cache[k]

    return data


@app.get("/api/markets")
async def get_markets():
    cache_key = "_markets_"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < 300:
        return cached[1]

    resp = await explorer_client.get("/api/markets")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=_lighter_error(resp))

    data = resp.json()
    _cache[cache_key] = (now, data)
    return data


@app.get("/api/contracts")
async def get_contracts():
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
    if not _ADDRESS_RE.match(param) and not _INDEX_RE.match(param):
        raise HTTPException(status_code=400, detail="Invalid param format.")

    resp = await explorer_client.get(
        f"/api/accounts/{param}/logs",
        params={"limit": str(limit), "offset": str(offset)},
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=_lighter_error(resp))
    return resp.json()


_TX_HASH_RE = re.compile(r"^[0-9a-fA-F]{40,80}$")


@app.get("/api/tx")
async def get_tx(hash: str = Query(..., alias="hash")):
    if not _TX_HASH_RE.match(hash):
        raise HTTPException(status_code=400, detail="Invalid tx hash format.")

    resp = await http_client.get("/api/v1/tx", params={"by": "hash", "value": hash})
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=_lighter_error(resp))
    return resp.json()


def _lighter_error(resp) -> str:
    try:
        data = resp.json()
        msg = data.get("message", "Lighter API error")
    except Exception:
        msg = "Lighter API error"
    logger.warning("Upstream error %s: %s", resp.status_code, msg)
    return msg


# ── Serve frontend ───────────────────────────────────────────────────

app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
