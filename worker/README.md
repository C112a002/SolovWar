# SolovWar Discord OAuth Worker

這個 Worker 只負責 Discord OAuth2 登入，不保存 Discord access token。登入成功後，Worker 會簽發有效期 24 小時的 HMAC session token，前端只保存這個 session token。

## 1. 建立 Discord Application

在 Discord Developer Portal 建立 Application，並於 OAuth2 Redirects 加入 Worker 的 callback URL：

```text
https://YOUR-WORKER-DOMAIN/auth/discord/callback
```

此 URL 必須與 Worker 實際公開網址完全一致。

## 2. 設定 secrets

在 `worker/` 目錄執行：

```bash
npm install -g wrangler
wrangler login
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put SESSION_SECRET
wrangler deploy
```

`SESSION_SECRET` 請使用至少 32 bytes 的隨機值，例如：

```bash
openssl rand -base64 48
```

不要把三個 secret 寫入 Git 或前端檔案。

## 3. 設定 GitHub Pages 前端

部署後，複製 Worker URL，填入：

```text
auth-config.js
SolovWar/auth-config.js
```

例如：

```js
window.SOLOVWAR_AUTH_CONFIG = {
  workerUrl: "https://solovwar-discord-auth.example.workers.dev"
};
```

然後重新 commit/push 遊戲。登入入口會在主選單與遊戲開始面板顯示。

## 4. OAuth 流程

1. 前端前往 `/auth/discord/start?return_to=...`。
2. Worker 產生 `state`，以 Secure、HttpOnly、SameSite=Lax cookie 保存。
3. Discord 回調 Worker `/auth/discord/callback`。
4. Worker 驗證 `state` 與 issuer，使用 client secret 在伺服器端交換 authorization code。
5. Worker 讀取 `/users/@me`，只把必要的 Discord profile claims 放入簽名 session token。
6. 前端從 URL fragment 取出 token，清除 URL，再以 Bearer token 呼叫 `/api/me`。

目前 session 是無狀態 Worker token，有效期 24 小時。若未來要保存遊戲存檔、排行榜或跨裝置資料，應再接 Cloudflare D1／Durable Objects，並以 Discord `sub` 作為穩定玩家 ID。
