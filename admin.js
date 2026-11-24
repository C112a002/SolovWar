(() => {
  const api = window.SolovWarDiscord;
  const status = document.querySelector("#admin-status");
  const content = document.querySelector("#admin-content");
  const list = document.querySelector("#admin-list");
  const form = document.querySelector("#add-admin-form");
  const input = document.querySelector("#discord-id");
  const addButton = document.querySelector("#add-admin-button");
  const refreshButton = document.querySelector("#refresh-list");
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
      admin_database_unavailable: "後台資料庫暫時無法連線，請稍後再試。"
    };
    return messages[code] || "操作失敗，請稍後再試。";
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  function renderIds(ids, ownerId) {
    list.replaceChildren();
    const validIds = Array.isArray(ids) ? ids : [];
    if (!validIds.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "目前沒有授權 ID。";
      list.append(empty);
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
        removeButton.addEventListener("click", () => mutate("remove", id));
        row.append(removeButton);
      }
      list.append(row);
    }
  }

  async function initialize() {
    const version = ++requestVersion;
    const user = api?.getUser();
    const token = api?.getToken();
    const workerUrl = api?.getWorkerUrl();
    content.hidden = true;
    list.replaceChildren();

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

      const listResponse = await fetch(`${workerUrl}/api/admin/allowlist`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await readJson(listResponse);
      if (version !== requestVersion) return;
      if (!listResponse.ok) {
        setStatus(explainError(data.error), "error");
        return;
      }
      activeOwnerId = data.ownerId || "";
      renderIds(data.ids, activeOwnerId);
      content.hidden = false;
      setStatus(`已登入為 ${user.global_name || user.username}。此名單會套用至所有使用者。`, "success");
    } catch {
      if (version === requestVersion) setStatus("無法連線到 Discord 權限服務，請確認網路後重試。", "error");
    }
  }

  async function mutate(action, id) {
    const token = api?.getToken();
    const workerUrl = api?.getWorkerUrl();
    if (!token || !workerUrl) {
      setStatus(explainError("unauthorized"), "warning");
      return;
    }
    const buttons = content.querySelectorAll("button");
    buttons.forEach(button => { button.disabled = true; });
    setStatus(action === "add" ? "正在新增授權…" : "正在移除授權…");
    try {
      const response = await fetch(`${workerUrl}/api/admin/allowlist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action, id })
      });
      const result = await readJson(response);
      if (!response.ok) {
        setStatus(explainError(result.error), "error");
        return;
      }
      if (action === "add") input.value = "";
      setStatus(action === "add" ? "授權已新增。" : "授權已移除。", "success");
      await initialize();
    } catch {
      setStatus("操作失敗，請確認網路後重試。", "error");
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const id = input.value.trim();
    if (!/^\d{17,20}$/.test(id)) {
      input.setCustomValidity("請輸入 17–20 位數字的 Discord ID。");
      input.reportValidity();
      input.setCustomValidity("");
      return;
    }
    mutate("add", id);
  });
  refreshButton.addEventListener("click", initialize);
  window.addEventListener("solovwar:auth-updated", initialize);
  initialize();
})();
