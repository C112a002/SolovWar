"""SolovWar shared C coin API client. Never falls back to local balance writes."""
from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any
from urllib.parse import urlencode

import aiohttp


class CoinAPIError(RuntimeError):
    """The authoritative shared wallet could not complete a request."""


class CoinAPI:
    def __init__(self, base_url: str, secret: str):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self._timeout = aiohttp.ClientTimeout(total=12)

    @classmethod
    def from_env(cls) -> CoinAPI | None:
        base_url = os.getenv("SOLVOWAR_COINS_API_URL", "").strip()
        secret = os.getenv("SOLVOWAR_COINS_API_SECRET", "").strip()
        if not base_url and not secret:
            return None
        if not base_url or not secret:
            raise CoinAPIError(
                "SOLVOWAR_COINS_API_URL 與 SOLVOWAR_COINS_API_SECRET 必須同時設定"
            )
        if len(secret) < 32:
            raise CoinAPIError("SOLVOWAR_COINS_API_SECRET 至少需要 32 個字元")
        if not base_url.startswith("https://") and not base_url.startswith("http://127.0.0.1"):
            raise CoinAPIError("C 幣 API 必須使用 HTTPS")
        return cls(base_url, secret)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.secret}",
            "Accept": "application/json",
            "Cache-Control": "no-store",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                async with aiohttp.ClientSession(timeout=self._timeout) as session:
                    async with session.request(
                        method,
                        url,
                        headers=self._headers(),
                        json=payload,
                    ) as response:
                        try:
                            body = await response.json(content_type=None)
                        except (aiohttp.ContentTypeError, ValueError):
                            body = {}
                        if response.status >= 500 and attempt == 0:
                            await asyncio.sleep(0.25)
                            continue
                        if response.status < 200 or response.status >= 300:
                            code = body.get("error", f"http_{response.status}")
                            raise CoinAPIError(f"C 幣服務回應錯誤：{code}")
                        if not isinstance(body, dict):
                            raise CoinAPIError("C 幣服務回應格式無效")
                        return body
            except CoinAPIError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                last_error = exc
                if attempt == 0:
                    await asyncio.sleep(0.25)
                    continue
        raise CoinAPIError("目前無法連線至共用 C 幣服務") from last_error

    async def account(self, user_id: int | str) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/api/bot/coins/balance",
            params={"userId": str(user_id)},
        )

    async def import_legacy(self, accounts: list[dict[str, Any]]) -> tuple[int, int]:
        """Seed absent wallets only; D1 INSERT OR IGNORE never overwrites an existing balance."""
        inserted = ignored = 0
        for offset in range(0, len(accounts), 100):
            result = await self._request(
                "POST",
                "/api/bot/coins/import",
                payload={"accounts": accounts[offset : offset + 100]},
            )
            inserted += int(result.get("inserted", 0))
            ignored += int(result.get("ignored", 0))
        return inserted, ignored

    async def operation(self, operation: str, user_id: int | str, **fields: Any) -> dict[str, Any]:
        payload = {
            "operation": operation,
            "userId": str(user_id),
            "idempotencyKey": fields.pop("idempotency_key", None) or uuid.uuid4().hex,
            **fields,
        }
        return await self._request("POST", "/api/bot/coins/operation", payload=payload)
