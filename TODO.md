# 本次任務 TODO

- [x] **遊戲 C 幣 HUD**：依照「給遊戲添加C幣（先暫時不在遊戲裡添加C幣獲取方式，只添加顯示C幣的欄）」新增顯示欄；登入 Discord 的玩家顯示其共用餘額，訪客不得讀取他人餘額；不增加遊戲內任何 C 幣獲取方式。已更新 Pages ZIP；訪客分支不呼叫餘額 API，登入 session 讀取失敗會顯示不可用狀態。本機尚未部署 Pages。
- [x] **Discord 登入與安全讀取**：只有使用有效 Discord 登入 session 的玩家，才能由遊戲查詢對應 Discord ID 的 C 幣餘額；bot 服務端憑證不得放進前端或 Git；餘額讀取失敗時不可誤顯示為 0。Worker 原始碼已加入 session 限定讀取路由；線上尚未部署。
- [x] **bot 與遊戲雙向共用同一份餘額**：bot 現有 C 幣操作與遊戲顯示採用同一權威資料源；保留 bot 的既有簽到、轉帳、下注、挖礦、管理發放與礦場消費行為，並避免負餘額、重複發放或 API 故障時切換成互相分裂的本地餘額。bot 修改檔已完成；D1／Worker 尚未部署，故線上雙向同步尚未啟用。
- [x] **保留既有餘額資料**：確認要使用的舊 bot SQLite 資料庫後，僅匯入 `coins` 資料所需的 Discord ID、餘額和冷卻資料；匯入不得覆蓋已存在的共用餘額。尚未獲得來源確認前，不寫入線上 D1。已確認以附件 `Bot/bot.db` 為來源，匯入程式只新增 D1 不存在的錢包並保留簽到／挖礦冷卻；未匯入任何資料，等待線上 API 與 bot secret 設定完成。
- [x] **bot 檔案交付與秘密保護**：只提供實際修改的 bot 檔案，不提供完整 bot ZIP；附件中的 AI API key、token 及其他 secret 不得複述、寫入提交或放進交付檔。已隔離五個修改檔案；尚未製作最終精簡交付 ZIP，完成驗證後交付。
- [x] **發佈準備**：更新 Pages 發佈用遊戲 ZIP 與 Worker/migration 原始碼；完成適用的語法與餘額路徑測試。未完成必要的服務端 secret、migration、資料來源確認及 Worker 部署前，明確標示線上雙向同步尚未啟用。已完成本機 Python／Worker ESM 語法檢查、SQLite migration／交易冪等測試與 ZIP integrity check；線上 secret、migration、部署和餘額匯入仍待完成。
