(() => {
  const aboutButton = document.querySelector(".about-item");
  const aboutDialog = document.querySelector("#about-dialog");
  const aboutClose = document.querySelector(".dialog-close");
  const settingsButton = document.querySelector(".settings-item");
  const settingsDialog = document.querySelector("#settings-dialog");
  const settingsClose = document.querySelector(".settings-close");
  const exitButton = document.querySelector(".exit-item");
  const notice = document.querySelector("#notice");
  const status = document.querySelector("#settings-status");
  const keybindList = document.querySelector("#keybind-list");
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
    }
  });

  exitButton.addEventListener("click", () => {
    window.close();
    window.setTimeout(() => {
      if (!document.hidden) showNotice("瀏覽器不允許網頁關閉此分頁，請手動關閉分頁離開遊戲。");
    }, 120);
  });
})();
