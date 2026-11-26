const API = "https://discord.com/api/v10";

function base64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

import { getPlayerCoinBalance, awardPlayerWaveReward, handleBotCoinRequest } from "./coins.js";

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

async function signValue(secret, value) {
  return base64url(await hmac(secret, value));
}

async function verifyValue(secret, value, signature) {
  const expected = await signValue(secret, value);
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}

async function signSession(secret, payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.${await signValue(secret, `${header}.${body}`)}`;
}

async function verifySession(secret, token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !(await verifyValue(secret, `${parts[0]}.${parts[1]}`, parts[2]))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  return origin === env.GAME_ORIGIN ? {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin"
  } : {};
}

function validDiscordId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function allowedReturnUrl(value, env) {
  try {
    const url = new URL(value || `${env.GAME_ORIGIN}/SolovWar/`);
    const prefix = env.GAME_PATH_PREFIX || "/SolovWar";
    if (url.origin !== env.GAME_ORIGIN || !url.pathname.startsWith(prefix)) return null;
    url.searchParams.delete("discord_session");
    url.searchParams.delete("discord_error");
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function makeStateCookie(env, state, returnTo) {
  const value = base64url(JSON.stringify({ state, returnTo, exp: Math.floor(Date.now() / 1000) + 600 }));
  const signature = await signValue(env.SESSION_SECRET, value);
  return `${value}.${signature}`;
}

async function readStateCookie(request, env) {
  const raw = request.headers.get("Cookie")?.match(/(?:^|;\s*)solovwar_oauth_state=([^;]+)/)?.[1];
  if (!raw) return null;
  const split = raw.lastIndexOf(".");
  if (split < 1) return null;
  const value = raw.slice(0, split);
  if (!(await verifyValue(env.SESSION_SECRET, value, raw.slice(split + 1)))) return null;
  try {
    const result = JSON.parse(new TextDecoder().decode(fromBase64url(value)));
    return result.exp > Math.floor(Date.now() / 1000) ? result : null;
  } catch {
    return null;
  }
}

function clearStateCookie() {
  return "solovwar_oauth_state=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
}

async function sessionFromRequest(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const session = token ? await verifySession(env.SESSION_SECRET, token) : null;
  if (session?.iss !== "solovwar-auth" || !validDiscordId(session.sub)) return null;
  return session;
}

async function isAuthorizedAdmin(env, discordId) {
  const ownerId = String(env.OWNER_DISCORD_ID || "");
  if (validDiscordId(ownerId) && discordId === ownerId) return true;
  if (!env.ADMIN_DB) throw new Error("admin_database_unbound");
  const record = await env.ADMIN_DB
    .prepare("SELECT discord_id FROM admin_allowlist WHERE discord_id = ? LIMIT 1")
    .bind(discordId)
    .first();
  return Boolean(record);
}

async function adminIds(env) {
  if (!env.ADMIN_DB) throw new Error("admin_database_unbound");
  const result = await env.ADMIN_DB
    .prepare("SELECT discord_id FROM admin_allowlist ORDER BY discord_id")
    .all();
  const ownerId = String(env.OWNER_DISCORD_ID || "");
  const ids = new Set((result.results || []).map(row => row.discord_id));
  if (validDiscordId(ownerId)) ids.add(ownerId);
  return { ids: [...ids].sort(), ownerId };
}

function validSessionId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function isPlayerBanned(env, discordId) {
  const record = await env.ADMIN_DB
    .prepare("SELECT reason, banned_at FROM player_bans WHERE discord_id = ? LIMIT 1")
    .bind(discordId)
    .first();
  return record || null;
}

async function requireAdmin(request, env) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return { response: json({ error: "unauthorized" }, 401, headers) };
  try {
    if (!(await isAuthorizedAdmin(env, session.sub))) return { response: json({ error: "forbidden" }, 403, headers) };
    return { session, headers };
  } catch (error) {
    console.error("Admin authorization failed", error);
    return { response: json({ error: "admin_database_unavailable" }, 503, headers) };
  }
}

async function start(request, env) {
  const url = new URL(request.url);
  const returnTo = allowedReturnUrl(url.searchParams.get("return_to"), env);
  if (!returnTo) return json({ error: "invalid_return_to" }, 400);
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const callback = `${new URL(request.url).origin}/auth/discord/callback`;
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `solovwar_oauth_state=${await makeStateCookie(env, state, returnTo)}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store"
    }
  });
}

async function callback(request, env) {
  const requestUrl = new URL(request.url);
  const stateData = await readStateCookie(request, env);
  const fallback = `${env.GAME_ORIGIN}${env.GAME_PATH_PREFIX || "/SolovWar"}/`;
  const returnTo = stateData?.returnTo || fallback;
  const redirect = new URL(returnTo);
  const error = requestUrl.searchParams.get("error");
  if (error || !stateData || requestUrl.searchParams.get("state") !== stateData.state || requestUrl.searchParams.get("iss") !== "https://discord.com") {
    redirect.searchParams.set("discord_error", error || "oauth_state_invalid");
    return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Set-Cookie": clearStateCookie(), "Cache-Control": "no-store" } });
  }

  const callbackUrl = `${new URL(request.url).origin}/auth/discord/callback`;
  const tokenResponse = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: requestUrl.searchParams.get("code"),
      redirect_uri: callbackUrl
    })
  });
  if (!tokenResponse.ok) {
    redirect.searchParams.set("discord_error", "token_exchange_failed");
    return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Set-Cookie": clearStateCookie(), "Cache-Control": "no-store" } });
  }
  const token = await tokenResponse.json();
  const userResponse = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!userResponse.ok) {
    redirect.searchParams.set("discord_error", "discord_profile_failed");
    return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Set-Cookie": clearStateCookie(), "Cache-Control": "no-store" } });
  }
  const user = await userResponse.json();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.ADMIN_DB.prepare("INSERT INTO login_events (discord_id, occurred_at) VALUES (?, ?)").bind(user.id, now).run();
  } catch (error) {
    console.warn("Discord login statistics unavailable", error);
  }
  const session = await signSession(env.SESSION_SECRET, {
    iss: "solovwar-auth",
    sub: user.id,
    username: user.username,
    global_name: user.global_name || user.username,
    avatar: user.avatar || null,
    iat: now,
    exp: now + 86400
  });
  redirect.hash = `discord_session=${encodeURIComponent(session)}`;
  return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Set-Cookie": clearStateCookie(), "Cache-Control": "no-store" } });
}

async function me(request, env) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);
  return json({ user: { id: session.sub, username: session.username, global_name: session.global_name, avatar: session.avatar } }, 200, headers);
}

async function adminStatus(request, env) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);
  try {
    const isOwner = session.sub === String(env.OWNER_DISCORD_ID || "");
    const authorized = await isAuthorizedAdmin(env, session.sub);
    return json({ authorized, isOwner }, 200, headers);
  } catch (error) {
    console.error("Admin access check failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function adminAllowlist(request, env) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);

  try {
    if (!(await isAuthorizedAdmin(env, session.sub))) return json({ error: "forbidden" }, 403, headers);
    if (request.method === "GET") return json(await adminIds(env), 200, headers);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400, headers);
    }
    const targetId = body?.id;
    if (!validDiscordId(targetId)) return json({ error: "invalid_discord_id" }, 400, headers);

    const ownerId = String(env.OWNER_DISCORD_ID || "");
    if (body.action === "add") {
      await env.ADMIN_DB
        .prepare("INSERT OR IGNORE INTO admin_allowlist (discord_id, added_by) VALUES (?, ?)")
        .bind(targetId, session.sub)
        .run();
    } else if (body.action === "remove") {
      if (targetId === ownerId) return json({ error: "owner_cannot_be_removed" }, 400, headers);
      await env.ADMIN_DB
        .prepare("DELETE FROM admin_allowlist WHERE discord_id = ?")
        .bind(targetId)
        .run();
    } else {
      return json({ error: "invalid_action" }, 400, headers);
    }
    return json({ ok: true, ...await adminIds(env) }, 200, headers);
  } catch (error) {
    console.error("Admin allowlist request failed", error);
    if (error?.message === "admin_database_unbound") return json({ error: "admin_database_unavailable" }, 503, headers);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function publicAnnouncements(request, env) {
  const headers = corsHeaders(request, env);
  try {
    const result = await env.ADMIN_DB
      .prepare("SELECT id, title, body, published_at FROM announcements WHERE status = 'published' ORDER BY published_at DESC LIMIT 20")
      .all();
    return json({ announcements: result.results || [] }, 200, headers);
  } catch (error) {
    console.error("Public announcement list unavailable", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function adminAnnouncements(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const { session, headers } = access;
  try {
    if (request.method === "GET") {
      const result = await env.ADMIN_DB
        .prepare("SELECT id, title, body, status, created_by, updated_by, created_at, updated_at, published_at FROM announcements ORDER BY updated_at DESC LIMIT 200")
        .all();
      return json({ announcements: result.results || [] }, 200, headers);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }
    const action = body?.action;
    const id = body?.id;
    const now = Math.floor(Date.now() / 1000);
    if (action === "save") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const content = typeof body.body === "string" ? body.body.trim() : "";
      if (!title || title.length > 100 || !content || content.length > 4000) {
        return json({ error: "invalid_announcement" }, 400, headers);
      }
      if (id !== undefined && !validSessionId(id)) return json({ error: "invalid_announcement_id" }, 400, headers);
      const announcementId = id || crypto.randomUUID();
      const status = body.published === true ? "published" : "draft";
      await env.ADMIN_DB.prepare(`
        INSERT INTO announcements (id, title, body, status, created_by, updated_by, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          status = excluded.status,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at,
          published_at = CASE
            WHEN excluded.status = 'published' THEN COALESCE(announcements.published_at, excluded.published_at)
            ELSE NULL
          END
      `).bind(announcementId, title, content, status, session.sub, session.sub, now, now, status === "published" ? now : null).run();
      return json({ ok: true, id: announcementId }, 200, headers);
    }
    if ((action === "publish" || action === "unpublish") && validSessionId(id)) {
      if (action === "publish") {
        await env.ADMIN_DB.prepare("UPDATE announcements SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?, updated_by = ? WHERE id = ?")
          .bind(now, now, session.sub, id).run();
      } else {
        await env.ADMIN_DB.prepare("UPDATE announcements SET status = 'archived', published_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?")
          .bind(now, session.sub, id).run();
      }
      return json({ ok: true }, 200, headers);
    }
    return json({ error: "invalid_action" }, 400, headers);
  } catch (error) {
    console.error("Announcement management failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function adminPlayers(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const { session, headers } = access;
  try {
    if (request.method === "GET") {
      const result = await env.ADMIN_DB
        .prepare("SELECT discord_id, reason, banned_by, banned_at FROM player_bans ORDER BY banned_at DESC LIMIT 500")
        .all();
      return json({ bans: result.results || [] }, 200, headers);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }
    const targetId = body?.id;
    if (!validDiscordId(targetId)) return json({ error: "invalid_discord_id" }, 400, headers);
    if (body.action === "ban") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length > 500) return json({ error: "invalid_ban_reason" }, 400, headers);
      await env.ADMIN_DB.prepare(`
        INSERT INTO player_bans (discord_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, banned_at = excluded.banned_at
      `).bind(targetId, reason, session.sub, Math.floor(Date.now() / 1000)).run();
    } else if (body.action === "unban") {
      await env.ADMIN_DB.prepare("DELETE FROM player_bans WHERE discord_id = ?").bind(targetId).run();
    } else {
      return json({ error: "invalid_action" }, 400, headers);
    }
    return json({ ok: true }, 200, headers);
  } catch (error) {
    console.error("Player ban management failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function playerStatus(request, env) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);
  try {
    const record = await isPlayerBanned(env, session.sub);
    return json({ banned: Boolean(record), reason: record?.reason || "" }, 200, headers);
  } catch (error) {
    console.error("Player access check failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function adminStats(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const { headers } = access;
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = await env.ADMIN_DB.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT discord_id) FROM login_events) AS unique_players,
        (SELECT COUNT(*) FROM login_events) AS total_logins,
        (SELECT COUNT(*) FROM login_events WHERE occurred_at >= ?) AS logins_last_7d,
        (SELECT COUNT(*) FROM game_sessions) AS total_game_sessions,
        (SELECT COUNT(*) FROM game_sessions WHERE started_at >= ?) AS game_sessions_last_7d,
        (SELECT COUNT(DISTINCT discord_id) FROM game_sessions WHERE discord_id IS NOT NULL) AS unique_game_players,
        (SELECT COUNT(*) FROM game_sessions WHERE ended_at IS NULL AND started_at >= ?) AS active_game_sessions,
        (SELECT COALESCE(AVG(ended_at - started_at), 0) FROM game_sessions WHERE ended_at IS NOT NULL) AS average_session_seconds
    `).bind(now - 7 * 86400, now - 7 * 86400, now - 4 * 3600).first();
    const number = key => Number(result?.[key] || 0);
    return json({
      uniquePlayers: number("unique_players"),
      totalLogins: number("total_logins"),
      loginsLast7d: number("logins_last_7d"),
      totalGameSessions: number("total_game_sessions"),
      gameSessionsLast7d: number("game_sessions_last_7d"),
      uniqueGamePlayers: number("unique_game_players"),
      activeGameSessions: number("active_game_sessions"),
      averageSessionSeconds: Math.round(number("average_session_seconds"))
    }, 200, headers);
  } catch (error) {
    console.error("Game statistics unavailable", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function sessionWriteRateLimit(request, env, headers, session) {
  const limiter = env.GAME_SESSION_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    return json({ error: "rate_limiter_unavailable" }, 503, headers);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = session?.sub ? `discord:${session.sub}` : `anonymous-ip:${ip}`;
  try {
    const result = await limiter.limit({ key });
    return result.success ? null : json({ error: "rate_limited" }, 429, headers);
  } catch (error) {
    console.error("Game session rate limit check failed", error);
    return json({ error: "rate_limiter_unavailable" }, 503, headers);
  }
}

async function startGameSession(request, env) {
  const headers = corsHeaders(request, env);
  const authorization = request.headers.get("Authorization") || "";
  const session = authorization ? await sessionFromRequest(request, env) : null;
  if (authorization && !session) return json({ error: "unauthorized" }, 401, headers);
  const limited = await sessionWriteRateLimit(request, env, headers, session);
  if (limited) return limited;
  try {
    if (session) {
      const ban = await isPlayerBanned(env, session.sub);
      if (ban) return json({ error: "player_banned", reason: ban.reason || "" }, 403, headers);
    }
    const sessionId = crypto.randomUUID();
    await env.ADMIN_DB.prepare("INSERT INTO game_sessions (session_id, discord_id, started_at) VALUES (?, ?, ?)")
      .bind(sessionId, session?.sub || null, Math.floor(Date.now() / 1000)).run();
    return json({ ok: true, sessionId }, 200, headers);
  } catch (error) {
    console.error("Game session start failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

async function endGameSession(request, env) {
  const headers = corsHeaders(request, env);
  const authorization = request.headers.get("Authorization") || "";
  const session = authorization ? await sessionFromRequest(request, env) : null;
  if (authorization && !session) return json({ error: "unauthorized" }, 401, headers);
  const limited = await sessionWriteRateLimit(request, env, headers, session);
  if (limited) return limited;
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }
  if (!validSessionId(body?.sessionId)) return json({ error: "invalid_session_id" }, 400, headers);
  try {
    await env.ADMIN_DB.prepare("UPDATE game_sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL AND discord_id IS ?")
      .bind(Math.floor(Date.now() / 1000), body.sessionId, session?.sub || null).run();
    return json({ ok: true }, 200, headers);
  } catch (error) {
    console.error("Game session end failed", error);
    return json({ error: "admin_database_unavailable" }, 503, headers);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      if (url.pathname === "/auth/discord/start" && request.method === "GET") return await start(request, env);
      if (url.pathname === "/auth/discord/callback" && request.method === "GET") return await callback(request, env);
      if (url.pathname === "/api/me" && request.method === "GET") return await me(request, env);
      if (url.pathname === "/api/admin/status" && request.method === "GET") return await adminStatus(request, env);
      if (url.pathname === "/api/admin/allowlist" && ["GET", "POST"].includes(request.method)) return await adminAllowlist(request, env);
      if (url.pathname === "/api/announcements" && request.method === "GET") return await publicAnnouncements(request, env);
      if (url.pathname === "/api/admin/announcements" && ["GET", "POST"].includes(request.method)) return await adminAnnouncements(request, env);
      if (url.pathname === "/api/admin/players" && ["GET", "POST"].includes(request.method)) return await adminPlayers(request, env);
      if (url.pathname === "/api/admin/stats" && request.method === "GET") return await adminStats(request, env);
      if (url.pathname === "/api/player/status" && request.method === "GET") return await playerStatus(request, env);
      if (url.pathname === "/api/player/coins" && request.method === "GET") {
        return await getPlayerCoinBalance(request, env, sessionFromRequest, corsHeaders);
      }
      if (url.pathname === "/api/player/coins/reward-wave" && request.method === "POST") {
        return await awardPlayerWaveReward(request, env, sessionFromRequest, corsHeaders);
      }
      if (url.pathname.startsWith("/api/bot/coins/")) {
        return await handleBotCoinRequest(request, env, url.pathname);
      }
      if (url.pathname === "/api/game/session/start" && request.method === "POST") return await startGameSession(request, env);
      if (url.pathname === "/api/game/session/end" && request.method === "POST") return await endGameSession(request, env);
      return json({ service: "SolovWar Discord auth", ok: true });
    } catch (error) {
      console.error("Worker request failed", error);
      return json({ error: "internal_error" }, 500, corsHeaders(request, env));
    }
  }
};
