# SolovWar C 幣共用餘額實作計畫

## 目標與行為

遊戲新增 C 幣 HUD 欄，只讓有效 Discord 登入玩家讀取本人餘額；不提供任何遊戲內獲幣方式。Discord bot 與遊戲共用同一份餘額，雙方的查詢、發放、簽到、轉帳、賭幣、挖礦與礦場消費均使用同一服務端帳本。訪客不得查詢任何 C 幣帳戶。

## 實作方式

- 以現有 Cloudflare Worker 綁定的 D1 作為唯一權威錢包資料源；餘額主鍵使用 Discord ID 的十進位字串，避免 JavaScript Number 精度損失。
- 新增 D1 migration，建立 C 幣帳戶、冷卻欄位及必要的冪等操作記錄；建立前不改動既有管理／session 表。
- Worker 為已登入遊戲提供 `GET /api/player/coins`，只從已驗證 session 的 Discord ID 讀取本人餘額。bot 僅透過 Worker 服務端 API，使用獨立 secret 認證；該 secret 不進前端、不提交 Git、不輸出到紀錄。
- bot 保留原有 Discord 命令及面板，但 coin 操作改呼叫 Worker API；首次啟動以舊 SQLite `coins` 表匯入不存在的 D1 帳戶，使用 D1 原子條件避免覆蓋既有共用餘額。不得在 API 失敗時退回本地 SQLite，避免形成分裂帳本。
- 遊戲 HUD 顯示符合現有戰術風格的 C 幣欄，透過登入 token 讀取本人餘額並定期刷新；未登入者不取得帳戶餘額。API 失敗時顯示不可用狀態而不是錯誤的 0。
- 同步更新 Pages 發佈用 `SolovWar-textures-updated.zip`。bot 交付只包含變更過的 bot 檔案與必要的設定範例，不回傳整個附件 ZIP。

## 既有資料與部署界線

附件包含 `Bot/bot.db` 和較舊備份，兩份 `coins` 資料不同。以附件主 `Bot/bot.db` 作為預設匯入候選；在使用者確認來源之前不得寫入線上 D1。資料匯入只含 C 幣帳戶餘額及 cooldown 欄位，不複製其他 bot 資料表。Worker migration／secret 設定／部署及舊餘額匯入均須在確認好來源、部署配置後再執行；金鑰僅提供設定方式，不放進程式碼或附件。

## 專案結構

- `worker/src/index.js`：遊戲登入餘額讀取、bot 服務端認證及 C 幣 API。
- `worker/migrations/0003_coins.sql`：錢包、冷卻及冪等資料表。
- `SolovWar-textures-updated.zip`：Pages 實際使用的遊戲檔案；新增 HUD 客戶端腳本並更新 HTML/CSS。
- bot 交付目錄：`coin.py` 等實際改動的程式碼，以及明確列出需要設定的環境變數範例。

## 驗證與交付

只對 C 幣路徑做語法、SQLite/D1 操作與 API 測試，不讀取或記錄玩家 ID／逐筆餘額；確認未登入不能查詢、未設定服務端 secret 時 fail closed、所有幣值使用安全整數並且消費不造成負餘額。Worker 需完成設定和資料初始化後才算上線；僅推送遊戲靜態包不代表雙向同步已啟用。

## Socket.IO 多人模式增補

主選單的「多人連線」模式導向 `game/?mode=multiplayer`。遊戲頁透過 Socket.IO CDN 載入 `multiplayer.js`，提供玩家代號、3 個公開伺服器選擇、即時成員狀態與進入戰場操作；`loader.js` 先設定 `window.__MULTIPLAYER_MODE`，再於既有主迴圈後載入多人模組。多人模式保留 Three.js 場景、玩家物理與武器，但跳過單人 AI 波次。

後端位於獨立的 WebDev Managed Git 專案，使用 Node.js 20、Express 與 Socket.IO。服務固定提供 3 個公開伺服器，每台最多 4 人，並同步玩家位置、旋轉、生命值與基礎射擊事件；部署採 Autoscale／on_demand，閒置後可能冷啟動，多實例切換時不保證成員狀態持續。前端必須提示這些限制。既有 Discord 封鎖驗證會阻止被封鎖玩家進入。

## 自訂伺服器模式增補

主選單新增「自訂伺服器」卡片並導向 `game/?mode=custom`。遊戲端共用多人玩家同步與射擊事件，但自訂模式不連線官方 endpoint；玩家輸入自己的 Socket.IO 網址、房間名稱、房間代碼與可選密碼，建立／加入操作直接送至該伺服器。密碼欄以勾選方式啟用，未勾選代表無密碼房間。官方 `multiplayer` 模式的三個公開伺服器流程保留。

`custom-server/` 是可獨立部署的 Node.js 20 範本，使用 Express + Socket.IO，在記憶體保存房間與玩家狀態，支援 `room:create`、`room:join`、`room:state`、`room:leave`、`player:state` 與 `combat:shot`。以 SHA-256 雜湊保存房間密碼，透過 `MAX_PLAYERS`、`CORS_ORIGIN` 與 `PORT` 環境變數調整部署設定，並附 Dockerfile、健康檢查與本機啟動說明。

## P2P 手動交換模式增補

自訂伺服器頁面提供「伺服器房間」與「P2P 手動交換」兩種傳輸方式。P2P 限制為兩名玩家，不使用自訂 Socket.IO 伺服器；房主以 Google 公開 STUN `stun:stun.l.google.com:19302` 建立 WebRTC SDP Offer 並等待 ICE gathering 完成，訪客貼上 Offer 產生 SDP Answer，房主貼回 Answer 後以 RTCDataChannel 傳送玩家狀態與射擊事件。介面明確標示 P2P 無法提供伺服器端防外掛，若直連失敗則改用伺服器房間。

## 靶場模式架構
靶場資產放在遊戲包 `assets/models/range/`，包含修正後的 `range.obj`／`range.mtl` 與 `textures/` 下 13 張原始材質。載入器只有在 URL `?mode=range` 時預載靶場 OBJ 與貼圖；`world.js` 以 54×6×31 的輕量碰撞邊界提供地面與外牆碰撞，`scene.js` 以自有 OBJ 解析器按材質組建立完整貼圖網格。靶場不進入多人模組，也不建立 AI 波次，保留返回主選單與一般單人操作。
