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


## 5. 公告、玩家管理與遊戲統計

後台新增公告管理、玩家封鎖／解除封鎖和遊戲統計。這些資料使用同一個 `ADMIN_DB` D1 資料庫；不會修改或取代 Discord OAuth secrets。升級時只新增資料表與索引：

```bash
npx wrangler d1 migrations apply solovwar-admin-access --remote
npx wrangler deploy
```

請先確認 `wrangler.toml` 的 D1 binding `ADMIN_DB` 指向既有的 `solovwar-admin-access`。Migration `0002_admin_features.sql` 會建立公告、玩家封鎖、登入事件及遊戲 session 表；不會刪除既有授權資料。重新部署 Worker 時，保留既有 `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET` secrets 與 `OWNER_DISCORD_ID`、`GAME_ORIGIN`、`GAME_PATH_PREFIX` vars。不要在前端或 Git 中輸出／改寫 OAuth secrets。

`GAME_SESSION_LIMITER` 是 Cloudflare 原生 Rate Limiting binding，對已驗證玩家依 Discord ID、對訪客依 Cloudflare 提供的來源 IP，分別限制 session 開始與結束寫入每分鐘最多 20 次。拒絕請求會在執行 D1 寫入前回傳 HTTP 429；限流服務不可用時則回傳 503，避免失去保護後仍持續寫入。Cloudflare 限流計數為近似值並按 Cloudflare 網路位置分開，不是嚴格的全域配額；訪客來源 IP 僅用作限流 key，不寫入應用程式資料庫。設定與限制詳見 [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

### 管理功能

- 後台「公告管理」可新增、編輯、發布及下架公告。主選單透過公開的 `GET /api/announcements` 讀取已發布公告；公告內容以純文字呈現。
- 「玩家管理」可封鎖或解除封鎖 17–20 位數字 Discord ID。封鎖只對已登入的該帳戶生效；訪客遊玩仍可使用。已登入玩家會在遊戲模組載入前接受 Worker 檢查。
- 「遊戲統計」包含唯一登入玩家、登入次數、近 7 日登入、遊戲啟動次數、近 7 日遊戲啟動、已登入遊玩玩家、近 4 小時未結束 session 及平均遊玩時間。統計自 migration 與 Worker 上線後累積，不回填上線前的歷史資料；平均遊玩時間僅計入已收到結束事件的 session。

### 新增 API

| Method / path | 用途 | 權限 |
| --- | --- | --- |
| `GET /api/announcements` | 取得已發布公告 | 公開，只讀 |
| `GET /api/admin/announcements` | 取得公告清單 | 已授權後台管理員 |
| `POST /api/admin/announcements` | `save` 新增／編輯，`publish` 發布，`unpublish` 下架 | 已授權後台管理員 |
| `GET /api/admin/players` | 取得封鎖清單 | 已授權後台管理員 |
| `POST /api/admin/players` | `ban` 封鎖或 `unban` 解除封鎖 | 已授權後台管理員 |
| `GET /api/player/status` | 查詢目前登入者是否被封鎖 | 有效 Discord session |
| `POST /api/game/session/start` | 檢查封鎖狀態並記錄遊戲啟動（可為訪客） | 公開；登入時驗證 session；依 Discord ID 或訪客來源 IP 每分鐘最多 20 次開始／結束請求 |
| `POST /api/game/session/end` | 依 session ID 記錄遊戲結束時間 | 公開；登入時只可結束自己的 session；受相同限流保護 |
| `GET /api/admin/stats` | 取得後台統計 | 已授權後台管理員 |

遊戲 session 由頁面進入時建立，離開頁面時以 `pagehide` 回報結束；瀏覽器強制關閉、斷線或中止請求可能使部分 session 沒有結束時間。來源 IP 僅供 Cloudflare 限流計數，不會寫入 D1；統計資料本身不包含 IP 位址。
