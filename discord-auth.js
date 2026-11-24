(() => {
  const config = window.SOLOVWAR_AUTH_CONFIG || {};
  const storageKey = "solovwar-discord-session";
  const workerUrl = String(config.workerUrl || "").replace(/\/$/, "");
  const currentUrl = () => `${location.origin}${location.pathname}${location.search}`;
  const state = { user: null, canAccessAdmin: false, isAdminOwner: false, playerAccess: null };

  function getToken() {
    try { return localStorage.getItem(storageKey) || ""; } catch { return ""; }
  }
  function setToken(token) {
    try { token ? localStorage.setItem(storageKey, token) : localStorage.removeItem(storageKey); } catch {}
  }
  function showMessage(message) {
    document.querySelectorAll("[data-discord-message]").forEach(el => { el.textContent = message; });
  }
  function avatarUrl(user) {
    if (!user?.avatar || !user.id) return "";
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png?size=64`;
  }
  function render() {
    document.querySelectorAll("[data-discord-auth]").forEach(panel => {
      const login = panel.querySelector("[data-discord-login]");
      const logout = panel.querySelector("[data-discord-logout]");
      const name = panel.querySelector("[data-discord-name]");
      const avatar = panel.querySelector("[data-discord-avatar]");
      const loggedIn = Boolean(state.user);
      if (login) login.hidden = loggedIn;
      if (logout) logout.hidden = !loggedIn;
      if (name) name.textContent = loggedIn ? (state.user.global_name || state.user.username) : "尚未登入 Discord";
      if (avatar) {
        const src = avatarUrl(state.user);
        avatar.hidden = !src;
        if (src) avatar.src = src;
      }
      panel.dataset.loggedIn = loggedIn ? "true" : "false";
      panel.dataset.playerStatus = state.playerAccess?.status || "unknown";
    });
    if (state.user && state.playerAccess?.status === "banned") {
      showMessage(`此 Discord 帳戶已被封鎖，無法進入遊戲。${state.playerAccess.reason ? `原因：${state.playerAccess.reason}` : ""}`);
    } else if (state.user && state.playerAccess?.status === "unavailable") {
      showMessage("目前無法驗證帳戶狀態，為保護遊戲服務，暫時無法以此帳戶進入遊戲。");
    }
    document.querySelectorAll("[data-admin-button]").forEach(button => {
      button.hidden = !state.user || !state.canAccessAdmin;
    });
    window.dispatchEvent(new CustomEvent("solovwar:auth-updated", {
      detail: { loggedIn: Boolean(state.user), canAccessAdmin: state.canAccessAdmin, isAdminOwner: state.isAdminOwner, playerAccess: state.playerAccess }
    }));
  }
  async function loadAdminAccess(token) {
    state.canAccessAdmin = false;
    state.isAdminOwner = false;
    if (!workerUrl || !token) { render(); return; }
    try {
      const response = await fetch(`${workerUrl}/api/admin/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) {
        const access = await response.json();
        if (getToken() === token) {
          state.canAccessAdmin = Boolean(access.authorized);
          state.isAdminOwner = Boolean(access.isOwner);
        }
      }
    } catch {
      // Keep the admin entry hidden if the authorization service cannot be reached.
    }
    if (getToken() === token) render();
  }
  async function loadPlayerAccess(token) {
    state.playerAccess = { status: "checking", reason: "" };
    render();
    try {
      const response = await fetch(`${workerUrl}/api/player/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("player_status_unavailable");
      const result = await response.json();
      if (getToken() !== token) return;
      state.playerAccess = result.banned
        ? { status: "banned", reason: String(result.reason || "") }
        : { status: "allowed", reason: "" };
    } catch {
      if (getToken() !== token) return;
      state.playerAccess = { status: "unavailable", reason: "" };
    }
    if (getToken() === token) render();
  }
  async function loadProfile() {
    const token = getToken();
    if (!token) {
      state.user = null;
      state.canAccessAdmin = false;
      state.isAdminOwner = false;
      state.playerAccess = null;
      render();
      return;
    }
    if (!workerUrl) {
      setToken("");
      state.user = null;
      state.canAccessAdmin = false;
      state.isAdminOwner = false;
      state.playerAccess = null;
      render();
      return;
    }
    try {
      const response = await fetch(`${workerUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("session_expired");
      const profile = await response.json();
      if (getToken() !== token) return;
      state.user = profile.user;
      state.playerAccess = { status: "checking", reason: "" };
      render();
      await Promise.all([loadAdminAccess(token), loadPlayerAccess(token)]);
    } catch {
      if (getToken() !== token) return;
      setToken("");
      state.user = null;
      state.canAccessAdmin = false;
      state.isAdminOwner = false;
      state.playerAccess = null;
      render();
    }
  }
  function login() {
    if (!workerUrl) {
      showMessage("尚未設定 Discord Worker URL；請先完成 worker/README.md 的部署步驟。");
      return;
    }
    const returnTo = encodeURIComponent(currentUrl());
    location.assign(`${workerUrl}/auth/discord/start?return_to=${returnTo}`);
  }
  function logout() {
    setToken("");
    state.user = null;
    state.canAccessAdmin = false;
    state.isAdminOwner = false;
    state.playerAccess = null;
    render();
    showMessage("已登出 Discord。");
  }
  function consumeCallback() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const token = params.get("discord_session");
    const error = new URLSearchParams(location.search).get("discord_error");
    if (token) {
      setToken(token);
      history.replaceState(null, "", `${location.pathname}${location.search.replace(/([?&])discord_error=[^&]*/g, "").replace(/[?&]$/, "")}`);
      showMessage("Discord 登入成功。");
    } else if (error) {
      showMessage(`Discord 登入未完成：${error}`);
      const clean = new URL(location.href); clean.searchParams.delete("discord_error"); history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
    }
  }
  window.SolovWarDiscord = Object.freeze({
    login,
    logout,
    getUser: () => state.user,
    getToken,
    getWorkerUrl: () => workerUrl,
    getAdminStatus: () => ({ authorized: state.canAccessAdmin, isOwner: state.isAdminOwner }),
    getPlayerAccess: () => state.playerAccess ? { ...state.playerAccess } : null
  });
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const loginButton = target?.closest("[data-discord-login]");
    const logoutButton = target?.closest("[data-discord-logout]");
    if (loginButton) login();
    if (logoutButton) logout();
  });
  consumeCallback();
  render();
  loadProfile();
})();
