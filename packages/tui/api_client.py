"""Async HTTP client for the rfb2-agent API server."""

import json
import os
from typing import Any
import aiohttp
from dotenv import load_dotenv

load_dotenv()

API_BASE = os.getenv("RFB2_API_URL", "http://localhost:3200").rstrip("/")


async def api_get(path: str) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        async with session.get(
            f"{API_BASE}{path}", timeout=aiohttp.ClientTimeout(total=10)
        ) as r:
            data = await r.json()
            if not isinstance(data, dict):
                return {"error": "unexpected response", "raw": str(data)[:500]}
            if "error" in data:
                return {"error": data["error"]}
            return data


async def api_post(path: str, body: dict | None = None) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{API_BASE}{path}",
            json=body or {},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as r:
            data = await r.json()
            if not isinstance(data, dict):
                return {"error": "unexpected response", "raw": str(data)[:500]}
            if "error" in data:
                return {"error": data["error"]}
            return data


async def get_health() -> dict:
    return await api_get("/health")


async def get_dashboard() -> dict:
    return await api_get("/dashboard")


async def get_mispricings(limit: int = 25, min_edge: float = 0.02) -> dict:
    return await api_get(f"/mispricings?limit={limit}&min_edge={min_edge}")


async def get_trades(status: str = "open") -> dict:
    return await api_get(f"/trades?status={status}")


async def get_calibration() -> dict:
    return await api_get("/calibration")


async def get_log(n: int = 200) -> dict:
    return await api_get(f"/log?n={n}")


async def get_summary() -> dict:
    return await api_get("/summary")


async def post_tick() -> dict:
    return await api_post("/tick")


async def post_backtest() -> dict:
    return await api_post("/backtest")
