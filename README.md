只有遊戲的UI的.zip檔可以拿，遊戲的index.html不能拿，遊戲UI可使用但不能用於商業用途

## Discord 登入

Discord OAuth2 的安全後端位於 `worker/`。請先閱讀 [`worker/README.md`](worker/README.md)，部署 Worker 並設定 `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET` 三個 secret，再把 Worker URL 填入 `auth-config.js` 與 `SolovWar/auth-config.js`。Client secret 與 session secret 絕不能放進 GitHub Pages 前端。
