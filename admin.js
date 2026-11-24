(() => {
  const api = window.SolovWarDiscord;
  const status = document.querySelector("#admin-status");
  const content = document.querySelector("#admin-content");
  const adminList = document.querySelector("#admin-list");
  const adminForm = document.querySelector("#add-admin-form");
  const adminInput = document.querySelector("#discord-id");
  const announcementForm = document.querySelector("#announcement-form");
  const announcementList = document.querySelector("#announcement-list");
  const banForm = document.querySelector("#ban-form");
  const banList = document.querySelector("#ban-list");
  const statsGrid = document.querySelector("#stats-grid");
  let requestVersion = 0;
  let activeOwnerId = "";

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function explainError(code) {
    const messages = {
      unauthorized: "登入狀態已失效，請重新登入 Discord。",
      forbidden: "此 Discord 帳戶尚未獲得後台權限。",
      invalid_discord_id: "Discord ID 格式錯誤，請輸入 17–20 位數字。",
      owner_cannot_be_removed: "主要管理員 ID 固定保留，無法移除。",
      invalid_announcement: "請輸入標題與內容；標題最多 100 字，內容最多 4,000 字。",
      invalid_announcement_id: "公告資料格式錯誤，請重新載入後再試。",
      invalid_ban_reason: "封鎖原因最多 500 字元。",
      admin_database_unavailable: "後台資料庫暫時無法連線，請稍後再試。"
    };
    return messages[code] || "操作失敗，請稍後再試。";
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  async function request(path, options = {}) {
    const token = api?.getToken();
    const workerUrl = api?.getWorkerUrl();
    if (!token || !workerUrl) throw new Error("unauthorized");
    const headers = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${workerUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = await readJson(response);
    return { response, data };
  }

  function renderIds(ids, ownerId) {
    adminList.replaceChildren();
    const validIds = Array.isArray(ids) ? ids : [];
    if (!validIds.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "目前沒有授權 ID。";
      adminList.append(empty);
      return;
    }
    for (const id of validIds) {
      const row = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = id;
      row.append(label);
      if (id === ownerId) {
        const badge = document.createElement("span");
        badge.className = "owner-badge";
        badge.textContent = "主要管理員・固定";
        row.append(badge);
      } else {
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "remove-button";
        removeButton.textContent = "移除";
        removeButton.setAttribute("aria-label", `移除 ${id} 的後台權限`);
        removeButton.addEventListener("click", () => mutateAdmin("remove", id));
        row.append(removeButton);
      }
      adminList.append(row);
    }
  }

  function makeButton(label, className, handler, ariaLabel = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", handler);
    return button;
  }

  function formatTime(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" })
      : "時間未提供";
  }

  function renderAnnouncements(items) {
    announcementList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "目前沒有公告。";
      announcementList.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("li");
      row.className = "feature-list-item";
      const main = document.createElement("div");
      main.className = "feature-list-main";
      const heading = document.createElement("div");
      heading.className = "feature-list-heading";
      const title = document.createElement("h3");
      title.textContent = item.title;
      const badge = document.createElement("span");
      badge.className = `state-badge state-${item.status}`;
      badge.textContent = item.status === "published" ? "已發布" : item.status === "archived" ? "已下架" : "草稿";
      heading.append(title, badge);
      const preview = document.createElement("p");
      preview.className = "list-preview";
      preview.textContent = item.body;
      const date = document.createElement("small");
      date.textContent = `${item.status === "published" ? "發布" : "更新"}：${formatTime(item.published_at || item.updated_at)}`;
      main.append(heading, preview, date);
      const actions = document.createElement("div");
      actions.className = "list-actions";
      actions.append(makeButton("編輯", "secondary-button", () => editAnnouncement(item)));
      actions.append(item.status === "published"
        ? makeButton("下架", "remove-button", () => mutateAnnouncement("unpublish", item.id))
        : makeButton("發布", "primary-button small-action", () => mutateAnnouncement("publish", item.id)));
      row.append(main, actions);
      announcementList.append(row);
    }
  }

  function renderBans(items) {
    banList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "目前沒有封鎖中的玩家。";
      banList.append(empty);
      return;
    }
    for (const ban of items) {
      const row = document.createElement("li");
      row.className = "feature-list-item";
      const main = document.createElement("div");
      main.className = "feature-list-main";
      const id = document.createElement("code");
      id.textContent = ban.discord_id;
      const reason = document.createElement("p");
      reason.className = "list-preview";
      reason.textContent = ban.reason || "未填寫封鎖原因。";
      const date = document.createElement("small");
      date.textContent = `封鎖時間：${formatTime(ban.banned_at)}`;
      main.append(id, reason, date);
      row.append(main, makeButton("解除封鎖", "secondary-button", () => mutateBan("unban", ban.discord_id)));
      banList.append(row);
    }
  }

  function renderStats(data) {
    const avg = Number(data.averageSessionSeconds || 0);
    const avgMinutes = avg > 0 ? `${Math.floor(avg / 60)} 分 ${avg % 60} 秒` : "—";
    const metrics = [
      ["已登入玩家", data.uniquePlayers],
      ["Discord 登入次數", data.totalLogins],
      ["近 7 日登入", data.loginsLast7d],
      ["遊戲啟動次數", data.totalGameSessions],
      ["近 7 日遊戲啟動", data.gameSessionsLast7d],
      ["已登入遊玩的玩家", data.uniqueGamePlayers],
      ["近 4 小時未結束場次", data.activeGameSessions],
      ["平均遊玩時間", avgMinutes]
    ];
    statsGrid.replaceChildren();
    for (const [label, value] of metrics) {
      const card = document.createElement("article");
      card.className = "stat-card";
      const name = document.createElement("span");
      name.textContent = label;
      const number = document.createElement("strong");
      number.textContent = typeof value === "number" ? value.toLocaleString("zh-TW") : String(value);
      card.append(name, number);
      statsGrid.append(card);
    }
  }

  async function loadAdminList(version = requestVersion) {
    const { response, data } = await request("/api/admin/allowlist");
    if (version !== requestVersion) return;
    if (!response.ok) throw new Error(data.error || "request_failed");
    activeOwnerId = data.ownerId || "";
    renderIds(data.ids, activeOwnerId);
  }

  async function loadAnnouncements() {
    const localStatus = document.querySelector("#announcement-status");
    localStatus.textContent = "正在載入公告…";
    try {
      const { response, data } = await request("/api/admin/announcements");
      if (!response.ok) throw new Error(data.error || "request_failed");
      renderAnnouncements(Array.isArray(data.announcements) ? data.announcements : []);
      localStatus.textContent = "公告清單已更新。";
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  }

  async function loadBans() {
    const localStatus = document.querySelector("#ban-status");
    localStatus.textContent = "正在載入封鎖名單…";
    try {
      const { response, data } = await request("/api/admin/players");
      if (!response.ok) throw new Error(data.error || "request_failed");
      renderBans(Array.isArray(data.bans) ? data.bans : []);
      localStatus.textContent = "封鎖名單已更新。";
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  }

  async function loadStats() {
    const localStatus = document.querySelector("#stats-status");
    localStatus.textContent = "正在載入統計…";
    try {
      const { response, data } = await request("/api/admin/stats");
      if (!response.ok) throw new Error(data.error || "request_failed");
      renderStats(data);
      localStatus.textContent = "統計已更新。";
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  }

  async function loadFeatureData() {
    await Promise.all([loadAnnouncements(), loadBans(), loadStats()]);
  }

  async function initialize() {
    const version = ++requestVersion;
    const user = api?.getUser();
    const token = api?.getToken();
    const workerUrl = api?.getWorkerUrl();
    content.hidden = true;
    adminList.replaceChildren();

    if (!user || !token) {
      setStatus("請先使用上方按鈕登入 Discord。", "warning");
      return;
    }
    if (!workerUrl) {
      setStatus("Discord 驗證服務尚未設定。", "error");
      return;
    }

    setStatus("正在確認後台權限…");
    try {
      const accessResponse = await fetch(`${workerUrl}/api/admin/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const access = await readJson(accessResponse);
      if (version !== requestVersion) return;
      if (accessResponse.status === 401) {
        setStatus(explainError("unauthorized"), "warning");
        return;
      }
      if (!accessResponse.ok) {
        setStatus(explainError(access.error), "error");
        return;
      }
      if (!access.authorized) {
        setStatus(explainError("forbidden"), "warning");
        return;
      }
      await loadAdminList(version);
      if (version !== requestVersion) return;
      content.hidden = false;
      setStatus(`已登入為 ${user.global_name || user.username}。所有管理員共用同一份資料。`, "success");
      await loadFeatureData();
    } catch (error) {
      if (version === requestVersion) setStatus(explainError(error.message) || "無法連線到後台服務，請稍後再試。", "error");
    }
  }

  async function mutateAdmin(action, id) {
    const buttons = content.querySelectorAll("button");
    buttons.forEach(button => { button.disabled = true; });
    setStatus(action === "add" ? "正在新增授權…" : "正在移除授權…");
    try {
      const { response, data } = await request("/api/admin/allowlist", { method: "POST", body: { action, id } });
      if (!response.ok) throw new Error(data.error || "request_failed");
      if (action === "add") adminInput.value = "";
      setStatus(action === "add" ? "授權已新增。" : "授權已移除。", "success");
      await loadAdminList();
    } catch (error) {
      setStatus(explainError(error.message), "error");
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function resetAnnouncementForm() {
    announcementForm.reset();
    document.querySelector("#announcement-id").value = "";
    document.querySelector("#announcement-published").checked = true;
    document.querySelector("#announcement-submit").textContent = "新增公告";
    document.querySelector("#announcement-cancel").hidden = true;
  }

  function editAnnouncement(item) {
    document.querySelector("#announcement-id").value = item.id;
    document.querySelector("#announcement-title").value = item.title;
    document.querySelector("#announcement-body").value = item.body;
    document.querySelector("#announcement-published").checked = item.status === "published";
    document.querySelector("#announcement-submit").textContent = "儲存公告";
    document.querySelector("#announcement-cancel").hidden = false;
    document.querySelector("#announcement-title").focus();
    activateTab("announcements");
  }

  async function mutateAnnouncement(action, id) {
    const localStatus = document.querySelector("#announcement-status");
    localStatus.textContent = action === "unpublish" ? "正在下架公告…" : "正在發布公告…";
    try {
      const { response, data } = await request("/api/admin/announcements", { method: "POST", body: { action, id } });
      if (!response.ok) throw new Error(data.error || "request_failed");
      localStatus.textContent = action === "unpublish" ? "公告已下架。" : "公告已發布。";
      await loadAnnouncements();
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  }

  async function mutateBan(action, id, reason = "") {
    const localStatus = document.querySelector("#ban-status");
    localStatus.textContent = action === "ban" ? "正在封鎖玩家…" : "正在解除封鎖…";
    try {
      const { response, data } = await request("/api/admin/players", { method: "POST", body: { action, id, reason } });
      if (!response.ok) throw new Error(data.error || "request_failed");
      if (action === "ban") banForm.reset();
      localStatus.textContent = action === "ban" ? "玩家已封鎖。" : "玩家封鎖已解除。";
      await loadBans();
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  }

  function activateTab(name) {
    document.querySelectorAll("[data-admin-tab]").forEach(button => {
      const selected = button.dataset.adminTab === name;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll("[data-admin-panel]").forEach(panel => {
      panel.hidden = panel.dataset.adminPanel !== name;
    });
  }

  adminForm.addEventListener("submit", event => {
    event.preventDefault();
    const id = adminInput.value.trim();
    if (!/^\d{17,20}$/.test(id)) {
      adminInput.setCustomValidity("請輸入 17–20 位數字的 Discord ID。");
      adminInput.reportValidity();
      adminInput.setCustomValidity("");
      return;
    }
    mutateAdmin("add", id);
  });

  announcementForm.addEventListener("submit", async event => {
    event.preventDefault();
    const id = document.querySelector("#announcement-id").value.trim();
    const title = document.querySelector("#announcement-title").value.trim();
    const body = document.querySelector("#announcement-body").value.trim();
    const published = document.querySelector("#announcement-published").checked;
    const localStatus = document.querySelector("#announcement-status");
    localStatus.textContent = "正在儲存公告…";
    try {
      const { response, data } = await request("/api/admin/announcements", {
        method: "POST",
        body: { action: "save", ...(id ? { id } : {}), title, body, published }
      });
      if (!response.ok) throw new Error(data.error || "request_failed");
      localStatus.textContent = published ? "公告已儲存並發布。" : "公告草稿已儲存。";
      resetAnnouncementForm();
      await loadAnnouncements();
    } catch (error) {
      localStatus.textContent = explainError(error.message);
    }
  });

  document.querySelector("#announcement-cancel").addEventListener("click", resetAnnouncementForm);
  banForm.addEventListener("submit", event => {
    event.preventDefault();
    const id = document.querySelector("#ban-discord-id").value.trim();
    const reason = document.querySelector("#ban-reason").value.trim();
    if (!/^\d{17,20}$/.test(id)) {
      const input = document.querySelector("#ban-discord-id");
      input.setCustomValidity("請輸入 17–20 位數字的 Discord ID。");
      input.reportValidity();
      input.setCustomValidity("");
      return;
    }
    mutateBan("ban", id, reason);
  });

  document.querySelectorAll("[data-admin-tab]").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.adminTab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll("[data-admin-tab]")];
      const current = tabs.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[next].dataset.adminTab);
      tabs[next].focus();
    });
  });

  document.querySelector("#refresh-list").addEventListener("click", async () => {
    try {
      await loadAdminList();
      setStatus("後台授權清單已更新。", "success");
    } catch (error) {
      setStatus(explainError(error.message), "error");
    }
  });
  document.querySelector("#refresh-all").addEventListener("click", initialize);
  window.addEventListener("solovwar:auth-updated", initialize);
  initialize();
})();
