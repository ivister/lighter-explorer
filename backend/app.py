import os

from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
import httpx

LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai")

app = FastAPI(title="Lighter Perps Dashboard")

http_client = httpx.AsyncClient(base_url=LIGHTER_BASE_URL, timeout=15.0)


@app.on_event("shutdown")
async def shutdown():
    await http_client.aclose()


# ── Lighter proxy endpoints ──────────────────────────────────────────

@app.get("/api/accounts")
async def get_accounts_by_l1(l1_address: str = Query(..., description="Ethereum L1 address")):
    """Return all sub-accounts linked to an L1 address."""
    resp = await http_client.get(
        "/api/v1/accountsByL1Address",
        params={"l1_address": l1_address},
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="Lighter API error")
    return resp.json()


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
        raise HTTPException(status_code=resp.status_code, detail="Lighter API error")
    return resp.json()


# ── Serve frontend ───────────────────────────────────────────────────

app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
