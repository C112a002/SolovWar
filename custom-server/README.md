# SolovWar 自訂伺服器

這是 SolovWar「自訂伺服器」模式使用的相容 Node.js + Socket.IO 範本。玩家可把它部署到自己的 VPS、Render、Railway、Fly.io 或其他支援 Node.js 20 的主機；遊戲前端會直接連到這個網址，官方三台公開伺服器不會承擔自訂房間流量。

## 本機啟動

```bash
npm install
npm start
```

預設監聽 `http://localhost:3000`，健康檢查是 `/health`。在遊戲的「自訂伺服器」頁面輸入可從玩家裝置連到的公開 HTTPS 網址。若只在區域網路測試，請輸入同網路內其他裝置可存取的 IP 與埠號。

## 環境變數

- `PORT`：監聽埠，預設 `3000`。
- `MAX_PLAYERS`：每個房間上限，預設 `16`，範圍 2–64。
- `CORS_ORIGIN`：允許的前端來源；預設 `*`。正式部署可設為 `https://c112a002.github.io`。

## 遊戲內流程

主機在「自訂伺服器」輸入伺服器網址、玩家代號與房間名稱，勾選「設定／使用房間密碼」後按「建立房間」。建立成功會顯示房間代碼；把伺服器網址與房間代碼交給其他玩家。加入者輸入相同網址、代碼與密碼（無密碼房間則不要勾選）後按「加入房間」。

範本支援 `room:create`、`room:join`、`room:state`、`room:leave`、`player:state` 與 `combat:shot` 事件，並只在記憶體保存目前房間；伺服器重新啟動後房間會清除。密碼以 SHA-256 雜湊保存，仍建議使用 HTTPS 與足夠長的房間密碼。

## Docker

```bash
docker build -t solovwar-custom-server .
docker run --rm -p 3000:3000 -e CORS_ORIGIN=https://c112a002.github.io solovwar-custom-server
```
