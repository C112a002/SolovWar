# 本次任務 TODO

- [x] **遊戲 C 幣 HUD**：依照「給遊戲添加C幣（先暫時不在遊戲裡添加C幣獲取方式，只添加顯示C幣的欄）」新增顯示欄；登入 Discord 的玩家顯示其共用餘額，訪客不得讀取他人餘額；不增加遊戲內任何 C 幣獲取方式。HUD 已加入 Pages ZIP；訪客分支不呼叫餘額 API，登入 session 讀取失敗會顯示不可用狀態。
- [x] **Discord 登入與安全讀取**：只有使用有效 Discord 登入 session 的玩家，才能由遊戲查詢對應 Discord ID 的 C 幣餘額；bot 服務端憑證不得放進前端或 Git；餘額讀取失敗時不可誤顯示為 0。Worker 已部署；無登入 session 的 `/api/player/coins` smoke test 回應 401；secret binding 只核對名稱，沒有讀出或輸出其值。
- [ ] **bot 與遊戲雙向共用同一份餘額**：bot 現有 C 幣操作與遊戲顯示採用同一權威資料源；保留 bot 的既有簽到、轉帳、下注、挖礦、管理發放與礦場消費行為，並避免負餘額、重複發放或 API 故障時切換成互相分裂的本地餘額。共用 Worker API 與 D1 已部署；修改版 bot 檔案已交付，但使用者 bot 主機尚未安裝修改版、設定 `SOLVOWAR_COINS_API_URL` 和 `SOLVOWAR_COINS_API_SECRET` 並重啟，因此雙向同步尚未啟用。
- [ ] **保留既有餘額資料**：確認要使用的舊 bot SQLite 資料庫後，僅匯入 `coins` 資料所需的 Discord ID、餘額和冷卻資料；匯入不得覆蓋已存在的共用餘額。已確認以附件 `Bot/bot.db` 為來源；匯入程式只新增 D1 不存在的錢包並保留簽到／挖礦冷卻。D1 目前錢包與操作紀錄皆為 0，尚未匯入；待使用者以修改版設定啟動 bot 後，才會從該 bot 的本機資料庫自動匯入。
- [x] **bot 檔案交付與秘密保護**：只提供實際修改的 bot 檔案，不提供完整 bot ZIP；附件中的 AI API key、token 及其他 secret 不得複述、寫入提交或放進交付檔。已交付精簡 ZIP，僅含五個修改檔；敏感字串掃描未發現疑似憑證。
- [x] **發佈準備與線上核驗**：更新 Pages 發佈用遊戲 ZIP 與 Worker/migration 原始碼；完成適用的語法與餘額路徑測試。已完成 Python／Worker ESM 語法檢查、Wrangler dry-run bundle、SQLite migration／交易冪等測試、礦場逾時恢復測試與 ZIP integrity check；程式碼已推送至 `origin/main`。Cloudflare Worker 已部署，D1 migration history 已核對並記錄 `0001`–`0003`；玩家與 bot API 在未授權請求下均回應 401。GitHub Pages 對應 `c734ad1` 的工作流成功，首頁回應 HTTP 200。bot 主機設定與舊餘額匯入仍待完成。
- [x] **主選單 C 幣圖標**：讓遊戲裡的主選單在顯示 C 幣時會使用使用者提供的圖標。已以原始透明 PNG 替換餘額欄的文字標籤，加入自適應像素化圖示樣式；C 幣讀取與訪客／錯誤狀態邏輯不變。已驗證圖檔 hash、透明通道、HTML/CSS 資源引用及 ZIP 完整性。
- [x] **根目錄主選單 C 幣面板**：「遊戲的主選單並未正常顯示C幣的面板在右上角」；在主選單右上角顯示提供的金幣圖標及登入玩家的 Discord 共用 C 幣餘額，訪客顯示登入提示，並處理載入／不可用狀態，失敗時不得顯示為 0；登入或登出時重新更新，且不新增遊戲內獲幣方式。已完成主選單 HTML/CSS/JS，圖標載入自 `./game/assets/ui/coin-icon.png`，沿用現有登入 session 查詢 `/api/player/coins`。
