const API = "https://discord.com/api/v10";

function base64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

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
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  return origin === env.GAME_ORIGIN ? {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, OPTIONS",
    "vary": "Origin"
  } : {};
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
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const session = token ? await verifySession(env.SESSION_SECRET, token) : null;
  const headers = corsHeaders(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);
  return json({ user: { id: session.sub, username: session.username, global_name: session.global_name, avatar: session.avatar } }, 200, headers);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname === "/api/me") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (url.pathname === "/auth/discord/start" && request.method === "GET") return start(request, env);
    if (url.pathname === "/auth/discord/callback" && request.method === "GET") return callback(request, env);
    if (url.pathname === "/api/me" && request.method === "GET") return me(request, env);
    return json({ service: "SolovWar Discord auth", ok: true });
  }
};
