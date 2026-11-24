# SolovWar Discord OAuth Worker

這個 Worker 負責 Discord OAuth2 登入，並以簽章 session 保存 Discord 使用者 ID。管理員授權名單存放在 Cloudflare D1；前端顯示「後台」按鈕只是一項介面提示，真正的進入與名單操作權限都由 Worker 驗證。

## 1. Discord Application 與 Worker secrets

在 Discord Developer Portal 建立 Application，並於 OAuth2 Redirects 加入 Worker 的 callback URL：

```text
https://YOUR-WORKER-DOMAIN/auth/discord/callback
```

此 URL 必須與 Worker 實際公開網址完全一致。

在 `worker/` 目錄設定 OAuth secrets 並部署：

```bash
npm install
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

`SESSION_SECRET` 請使用至少 32 bytes 的隨機值。不要把 secrets 寫入 Git 或前端檔案。`wrangler.toml` 的 `keep_vars = true` 會保留 Cloudflare Dashboard 中設定的非 secret vars；Wrangler 另外會保留既有 secret，除非明確執行 `wrangler secret delete`。

## 2. 後台授權資料庫

Worker 使用 D1 binding `ADMIN_DB`，資料庫名稱為 `solovwar-admin-access`。目前 Cloudflare D1 ID 已寫入 `wrangler.toml`。資料表 migration 位於 `migrations/0001_admin_allowlist.sql`，部署前可執行：

```bash
npx wrangler d1 migrations apply solovwar-admin-access --remote
```

固定主要管理員 Discord ID 設為 `1096316400529842206`，並由 Worker 的 `OWNER_DISCORD_ID` vars 設定。此 ID 一定能進入後台，也不能從後台名單移除。主要管理員可在後台新增或移除其他 ID；清單內的每個已授權 ID 都可以進入並管理同一份清單。

每次修改 Worker 程式或 `wrangler.toml` 後，在 `worker/` 目錄執行：

```bash
npx wrangler deploy
```

## 3. GitHub Pages 前端

前端 Worker URL 設定於根目錄 `auth-config.js`。GitHub Actions 只部署 GitHub Pages 靜態前端，不會自動部署此 Worker；Worker 必須依上方流程另外部署。後台頁面為根目錄 `admin.html`，只有 Worker 回傳授權成功時，主選單才會顯示「後台」入口。

## 4. OAuth 與後台 API

1. 前端前往 `/auth/discord/start?return_to=...`。
2. Worker 產生 `state`，以 Secure、HttpOnly、SameSite=Lax cookie 保存。
3. Discord 回調 Worker `/auth/discord/callback`。
4. Worker 使用 client secret 在伺服器端交換 authorization code，向 Discord 取得真實使用者資料。
5. Worker 簽發有效期 24 小時的 HMAC session；前端以 Bearer token 呼叫 `/api/me`。
6. 主選單以 `/api/admin/status` 查詢授權，管理頁再使用 `/api/admin/allowlist` 讀取或維護名單。

授權判斷使用 session 簽章內的 Discord ID，不接受前端自稱的登入者 ID。新增名單時送入的 Discord ID 只代表要授權的目標帳戶；執行新增／移除的人仍以簽章 session 驗證。未登入與未授權請求都無法讀取或變更名單。
