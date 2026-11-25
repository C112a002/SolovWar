(() => {
  const aboutButton = document.querySelector(".about-item");
  const aboutDialog = document.querySelector("#about-dialog");
  const aboutClose = document.querySelector(".dialog-close");
  const settingsButton = document.querySelector(".settings-item");
  const settingsDialog = document.querySelector("#settings-dialog");
  const settingsClose = document.querySelector(".settings-close");
  const exitButton = document.querySelector(".exit-item");
  const notice = document.querySelector("#notice");
  const startLink = document.querySelector(".start-item");
  const announcementButton = document.querySelector("#announcement-open");
  const announcementDialog = document.querySelector("#announcement-dialog");
  const announcementClose = document.querySelector(".announcement-close");
  const announcementList = document.querySelector("#announcement-list");
  const announcementLoading = document.querySelector("#announcement-loading");
  const status = document.querySelector("#settings-status");
  const keybindList = document.querySelector("#keybind-list");
  const coinBalancePanel = document.querySelector("[data-coin-balance]");
  const coinAmount = document.querySelector("[data-coin-amount]");
  const desktopKeys = window.matchMedia("(pointer: fine)");
  const touchDevice = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const STORAGE_KEY = "solovwar-settings";
  const DEFAULT_BIND = {
    fwd: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", jump: "Space",
    run: "ShiftLeft", crouch: "KeyC", aim: "KeyV", respawn: "KeyT", reload: "KeyR"
  };
  const ACTIONS = [
    ["fwd", "前進"], ["back", "後退"], ["left", "向左"], ["right", "向右"],
    ["jump", "跳躍"], ["run", "衝刺"], ["crouch", "蹲下／滑鏟"],
    ["aim", "瞄準"], ["reload", "換彈"], ["respawn", "重新出生"]
  ];
  const DEFAULTS = {
    sens: 1, gyroSens: 1, fov: 75, resolution: 1, quality: "medium", concreteRoughness: .95,
    vol: .7, diff: 1, showPos: false, gyro: false, kf: true, chat: true,
    blood: true, showTouchControls: touchDevice, best: 0, bind: { ...DEFAULT_BIND }
  };
  let noticeTimer;
  let capturing = null;
  let coinRequestId = 0;

  function readSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      const prefs = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}), bind: { ...DEFAULT_BIND, ...(saved?.bind || {}) } };
      prefs.gyroSens = typeof saved?.gyroSens === "number" && Number.isFinite(saved.gyroSens) ? Math.min(3, Math.max(.25, saved.gyroSens)) : DEFAULTS.gyroSens;
      return prefs;
    } catch {
      return { ...DEFAULTS, bind: { ...DEFAULT_BIND } };
    }
  }

  let prefs = readSettings();

  function saveSettings(message = "設定已儲存，開始遊戲時會套用。") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      status.textContent = message;
    } catch {
      status.textContent = "無法儲存設定，請檢查瀏覽器儲存空間。";
    }
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 3800);
  }

  function updateStartAvailability() {
    const auth = window.SolovWarDiscord;
    const loggedIn = Boolean(auth?.getUser());
    const access = auth?.getPlayerAccess();
    const statusValue = access?.status || "unknown";
    const unavailable = loggedIn && statusValue !== "allowed";
    startLink.classList.toggle("player-banned", statusValue === "banned");
    startLink.setAttribute("aria-disabled", String(unavailable));
  }

  async function refreshCoinBalance() {
    const requestId = ++coinRequestId;
    const auth = window.SolovWarDiscord;
    const token = auth?.getToken();
    if (!token) {
      coinBalancePanel.dataset.state = "guest";
      coinAmount.textContent = "登入後查看";
      return;
    }

    const workerUrl = auth?.getWorkerUrl();
    if (!workerUrl) {
      coinBalancePanel.dataset.state = "error";
      coinAmount.textContent = "暫時不可用";
      return;
    }
    coinBalancePanel.dataset.state = "loading";
    coinAmount.textContent = "載入中…";
    try {
      const response = await fetch(`${workerUrl}/api/player/coins`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("coin_balance_unavailable");
      const result = await response.json();
      if (requestId !== coinRequestId || auth.getToken() !== token) return;
      if (!Number.isSafeInteger(result.balance) || result.balance < 0) throw new Error("invalid_coin_balance");
      coinBalancePanel.dataset.state = "ready";
      coinAmount.textContent = result.balance.toLocaleString("zh-TW");
    } catch {
      if (requestId !== coinRequestId) return;
      coinBalancePanel.dataset.state = "error";
      coinAmount.textContent = "暫時不可用";
    }
  }

  function renderAnnouncements(items) {
    announcementList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "announcement-empty";
      empty.textContent = "目前沒有已發布的公告。";
      announcementList.append(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement("li");
      card.className = "announcement-card";
      const title = document.createElement("h2");
      title.textContent = item.title;
      const time = document.createElement("time");
      const seconds = Number(item.published_at);
      if (Number.isFinite(seconds) && seconds > 0) {
        const date = new Date(seconds * 1000);
        time.dateTime = date.toISOString();
        time.textContent = date.toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
      } else {
        time.textContent = "發布時間未提供";
      }
      const body = document.createElement("p");
      body.textContent = item.body;
      card.append(title, time, body);
      announcementList.append(card);
    }
  }

  async function loadAnnouncements() {
    const workerUrl = window.SolovWarDiscord?.getWorkerUrl();
    if (!workerUrl) {
      announcementLoading.textContent = "公告服務尚未設定，請稍後再試。";
      renderAnnouncements([]);
      return;
    }
    announcementLoading.textContent = "正在載入公告…";
    try {
      const response = await fetch(`${workerUrl}/api/announcements`);
      if (!response.ok) throw new Error("announcement_load_failed");
      const result = await response.json();
      renderAnnouncements(Array.isArray(result.announcements) ? result.announcements : []);
      announcementLoading.textContent = "公告由遊戲管理後台即時更新。";
    } catch {
      announcementLoading.textContent = "目前無法連線至公告服務，請稍後再試。";
      renderAnnouncements([]);
    }
  }

  function closeAnnouncements({ restoreFocus = true } = {}) {
    if (announcementDialog.hidden) return;
    announcementDialog.hidden = true;
    if (restoreFocus) announcementButton.focus();
  }

  function displayCode(code) {
    const names = { Space: "空白鍵", ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Ctrl", ControlRight: "Ctrl", AltLeft: "Alt", AltRight: "Alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
    if (names[code]) return names[code];
    return code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "數字 ");
  }

  function renderSettings() {
    document.querySelectorAll("[data-setting]").forEach(control => {
      const key = control.dataset.setting;
      if (control.type === "checkbox") control.checked = Boolean(prefs[key]);
      else if (control.type === "range") {
        const percentKeys = { sens: prefs.sens * 100, gyroSens: prefs.gyroSens * 100, resolution: prefs.resolution * 100, concreteRoughness: prefs.concreteRoughness * 100, vol: prefs.vol * 100 };
        control.value = percentKeys[key] ?? prefs[key];
        const output = document.querySelector(`[data-value="${key}"]`);
        if (output) output.value = key === "fov" ? `${control.value}°` : `${control.value}%`;
      } else control.value = String(prefs[key]);
    });
    keybindList.replaceChildren();
    ACTIONS.forEach(([action, label]) => {
      const row = document.createElement("div");
      row.className = "keybind-row";
      const name = document.createElement("span");
      name.textContent = label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `keybind-button${capturing === action ? " waiting" : ""}`;
      button.textContent = capturing === action ? "請按鍵…" : displayCode(prefs.bind[action] || DEFAULT_BIND[action]);
      button.setAttribute("aria-label", `${label}按鍵：${button.textContent}`);
      button.addEventListener("click", () => {
        capturing = capturing === action ? null : action;
        renderSettings();
        if (capturing) keybindList.querySelector(".waiting")?.focus();
      });
      row.append(name, button);
      keybindList.append(row);
    });
  }

  function openSettings() {
    aboutDialog.hidden = true;
    renderSettings();
    settingsDialog.hidden = false;
    settingsButton.setAttribute("aria-expanded", "true");
    settingsClose.focus();
  }

  function closeSettings({ restoreFocus = true } = {}) {
    if (settingsDialog.hidden) return;
    capturing = null;
    settingsDialog.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) settingsButton.focus();
  }

  function toggleSettings() {
    if (settingsDialog.hidden) openSettings();
    else closeSettings();
  }

  function updateSetting(control) {
    const key = control.dataset.setting;
    let value;
    if (control.type === "checkbox") value = control.checked;
    else if (control.type === "range") {
      const number = Number(control.value);
      value = ({ sens: number / 100, gyroSens: number / 100, resolution: number / 100, concreteRoughness: number / 100, vol: number / 100 })[key] ?? number;
      const output = document.querySelector(`[data-value="${key}"]`);
      if (output) output.value = key === "fov" ? `${number}°` : `${number}%`;
    } else value = key === "diff" ? Number(control.value) : control.value;
    prefs[key] = value;
    saveSettings();
  }

  function closeAbout() {
    aboutDialog.hidden = true;
    aboutButton.focus();
  }

  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", () => closeSettings());
  settingsDialog.addEventListener("click", event => {
    if (event.target === settingsDialog) closeSettings();
  });
  settingsDialog.querySelectorAll("[data-setting]").forEach(control => {
    control.addEventListener(control.type === "range" ? "input" : "change", () => updateSetting(control));
  });

  document.querySelector(".reset-settings").addEventListener("click", () => {
    prefs = { ...DEFAULTS, best: prefs.best, bind: { ...DEFAULT_BIND } };
    renderSettings();
    saveSettings("已還原預設設定。");
  });

  aboutButton.addEventListener("click", () => {
    aboutDialog.hidden = false;
    aboutClose.focus();
  });
  aboutClose.addEventListener("click", closeAbout);
  aboutDialog.addEventListener("click", event => {
    if (event.target === aboutDialog) closeAbout();
  });
  announcementButton.addEventListener("click", () => {
    announcementDialog.hidden = false;
    announcementClose.focus();
    loadAnnouncements();
  });
  announcementClose.addEventListener("click", () => closeAnnouncements());
  announcementDialog.addEventListener("click", event => {
    if (event.target === announcementDialog) closeAnnouncements();
  });
  startLink.addEventListener("click", event => {
    const auth = window.SolovWarDiscord;
    if (!auth?.getUser()) return;
    const access = auth.getPlayerAccess();
    if (access?.status === "allowed") return;
    event.preventDefault();
    if (access?.status === "banned") {
      showNotice(`此 Discord 帳戶已被封鎖，無法開始遊戲。${access.reason ? `原因：${access.reason}` : ""}`);
    } else if (access?.status === "checking") {
      showNotice("正在確認 Discord 帳戶狀態，請稍候再開始遊戲。");
    } else {
      showNotice("目前無法確認 Discord 帳戶狀態，請稍後再試；也可以先登出後以訪客身分遊玩。");
    }
  });
  window.addEventListener("solovwar:auth-updated", () => {
    updateStartAvailability();
    refreshCoinBalance();
  });
  updateStartAvailability();
  refreshCoinBalance();
  loadAnnouncements();

  document.addEventListener("keydown", event => {
    if (capturing) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "KeyO") {
        status.textContent = "O 鍵保留作設定開關，請選擇其他按鍵。";
        capturing = null;
        renderSettings();
        return;
      }
      if (["Escape", "Tab", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) {
        if (event.code === "Escape") { capturing = null; renderSettings(); }
        return;
      }
      prefs.bind[capturing] = event.code;
      capturing = null;
      renderSettings();
      saveSettings("按鍵已儲存。");
      return;
    }

    if (event.code === "KeyO" && desktopKeys.matches && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input,select,textarea"))) return;
      event.preventDefault();
      toggleSettings();
      return;
    }
    if (event.key === "Escape") {
      if (!settingsDialog.hidden) closeSettings();
      else if (!aboutDialog.hidden) closeAbout();
      else if (!announcementDialog.hidden) closeAnnouncements();
    }
  });

  exitButton.addEventListener("click", () => {
    window.close();
    window.setTimeout(() => {
      if (!document.hidden) showNotice("瀏覽器不允許網頁關閉此分頁，請手動關閉分頁離開遊戲。");
    }, 120);
  });
})();
