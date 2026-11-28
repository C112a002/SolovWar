const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const MINE_COOLDOWN_SECONDS = 6 * 60 * 60;
const GAME_WAVE_REWARD = 10;
const GAME_WAVE_DAILY_LIMIT = 10;
const GAME_SESSION_MAX_WAVE = 10000;
const GAME_WAVE_COOLDOWN_SECONDS = 15;
const GAME_SESSION_MIN_SECONDS = 25;
const DISCORD_ID_RE = /^\d{17,20}$/;
const OP_ID_RE = /^[0-9a-f-]{32,36}$/i;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function validAmount(value, { allowZero = false } = {}) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) && value <= MAX_BALANCE;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index++) difference |= x[index] ^ y[index];
  return difference === 0;
}

async function authorizedBotRequest(request, env) {
  const expected = env.COIN_BOT_API_SECRET;
  const header = request.headers.get("Authorization") || "";
  if (!expected || expected.length < 32) return false;
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  if (provided.length < 32 || provided.length > 512) return false;
  return constantTimeEqual(provided, expected);
}

async function authorizedWidgetRequest(request, env) {
  const expected = env.WIDGET_COINS_API_SECRET;
  const header = request.headers.get("Authorization") || "";
  if (!expected || expected.length < 32) return false;
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  if (provided.length < 32 || provided.length > 512) return false;
  return constantTimeEqual(provided, expected);
}

async function readWallet(env, discordId) {
  const row = await env.ADMIN_DB.prepare(
    "SELECT balance, last_daily, last_mine FROM coin_wallets WHERE discord_id = ?"
  ).bind(discordId).first();
  return {
    discordId,
    balance: Number(row?.balance || 0),
    lastDaily: row?.last_daily || null,
    lastMine: row?.last_mine == null ? null : Number(row.last_mine)
  };
}

export async function getPlayerCoinBalance(request, env, sessionFromRequest, corsHeaders) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);
  try {
    const wallet = await readWallet(env, session.sub);
    return json({ balance: wallet.balance }, 200, headers);
  } catch (error) {
    console.error("Player C coin balance unavailable", error);
    return json({ error: "coin_wallet_unavailable" }, 503, headers);
  }
}

export async function getWidgetCoinBalance(request, env) {
  if (!(await authorizedWidgetRequest(request, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const discordId = url.searchParams.get("discordId");
  const allowedId = env.WIDGET_DISCORD_ID;
  if (!discordId || !DISCORD_ID_RE.test(discordId)) return json({ error: "invalid_discord_id" }, 400);
  if (!allowedId || !DISCORD_ID_RE.test(allowedId)) return json({ error: "widget_not_configured" }, 503);
  if (discordId !== allowedId) return json({ error: "forbidden" }, 403);
  try {
    const wallet = await readWallet(env, discordId);
    return json({ discordId, balance: wallet.balance, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Widget C coin balance unavailable", error);
    return json({ error: "coin_wallet_unavailable" }, 503);
  }
}

export async function awardPlayerWaveReward(request, env, sessionFromRequest, corsHeaders) {
  const headers = corsHeaders(request, env);
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, headers);

  const limiter = env.GAME_SESSION_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    return json({ error: "rate_limiter_unavailable" }, 503, headers);
  }
  try {
    const limited = await limiter.limit({ key: `discord:${session.sub}` });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  } catch (error) {
    console.error("Game coin reward rate limit failed", error);
    return json({ error: "rate_limiter_unavailable" }, 503, headers);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ error: "request_too_large" }, 413, headers);
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  const sessionId = body?.sessionId;
  const wave = body?.wave;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId) || !Number.isSafeInteger(wave) || wave < 1 || wave > GAME_SESSION_MAX_WAVE) {
    return json({ error: "invalid_wave_reward" }, 400, headers);
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const ban = await env.ADMIN_DB.prepare("SELECT 1 AS banned FROM player_bans WHERE discord_id = ? LIMIT 1")
      .bind(session.sub).first();
    if (ban) return json({ error: "player_banned" }, 403, headers);

    const gameSession = await env.ADMIN_DB.prepare(
      "SELECT started_at, ended_at FROM game_sessions WHERE session_id = ? AND discord_id = ? LIMIT 1"
    ).bind(sessionId, session.sub).first();
    if (!gameSession || gameSession.ended_at !== null) return json({ error: "game_session_invalid" }, 403, headers);

    const alreadyAwarded = await env.ADMIN_DB.prepare(
      "SELECT amount FROM game_coin_rewards WHERE session_id = ? AND wave = ? LIMIT 1"
    ).bind(sessionId, wave).first();
    if (alreadyAwarded) {
      const wallet = await readWallet(env, session.sub);
      return json({ awarded: false, alreadyAwarded: true, balance: wallet.balance }, 200, headers);
    }
    if (Number(gameSession.started_at) > now - GAME_SESSION_MIN_SECONDS) {
      return json({ error: "game_session_too_new" }, 409, headers);
    }

    const expected = await env.ADMIN_DB.prepare(
      "SELECT COALESCE(MAX(wave), 0) + 1 AS next_wave FROM game_coin_rewards WHERE session_id = ?"
    ).bind(sessionId).first();
    if (wave !== Number(expected?.next_wave || 1)) return json({ error: "wave_not_eligible" }, 409, headers);

    const recent = await env.ADMIN_DB.prepare(`
      SELECT COUNT(*) AS reward_count, COALESCE(MAX(created_at), 0) AS last_reward
      FROM game_coin_rewards WHERE discord_id = ? AND created_at >= ?
    `).bind(session.sub, now - 86400).first();
    if (Number(recent?.reward_count || 0) >= GAME_WAVE_DAILY_LIMIT) {
      return json({ error: "daily_reward_limit" }, 429, headers);
    }
    if (Number(recent?.last_reward || 0) > now - GAME_WAVE_COOLDOWN_SECONDS) {
      return json({ error: "reward_cooldown" }, 429, headers);
    }

    const results = await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare(`
        INSERT OR IGNORE INTO coin_wallets (discord_id, balance)
        SELECT ?, 0 WHERE EXISTS (
          SELECT 1 FROM game_sessions
          WHERE session_id = ? AND discord_id = ? AND ended_at IS NULL
        )
      `).bind(session.sub, sessionId, session.sub),
      env.ADMIN_DB.prepare(`
        INSERT OR IGNORE INTO game_coin_rewards (session_id, discord_id, wave, amount, created_at)
        SELECT gs.session_id, gs.discord_id, ?, ?, ? FROM game_sessions gs
        WHERE gs.session_id = ? AND gs.discord_id = ? AND gs.ended_at IS NULL
          AND gs.started_at <= ?
          AND ? = (SELECT COALESCE(MAX(wave), 0) + 1 FROM game_coin_rewards WHERE session_id = ?)
          AND (SELECT COUNT(*) FROM game_coin_rewards WHERE discord_id = ? AND created_at >= ?) < ?
          AND (SELECT COALESCE(MAX(created_at), 0) FROM game_coin_rewards WHERE discord_id = ?) <= ?
          AND (SELECT balance FROM coin_wallets WHERE discord_id = ?) <= ?
      `).bind(
        wave, GAME_WAVE_REWARD, now, sessionId, session.sub, now - GAME_SESSION_MIN_SECONDS,
        wave, sessionId, session.sub, now - 86400, GAME_WAVE_DAILY_LIMIT,
        session.sub, now - GAME_WAVE_COOLDOWN_SECONDS, session.sub, MAX_BALANCE - GAME_WAVE_REWARD
      ),
      env.ADMIN_DB.prepare(`
        UPDATE coin_wallets SET balance = balance + ?
        WHERE discord_id = ? AND changes() = 1
      `).bind(GAME_WAVE_REWARD, session.sub)
    ]);
    const inserted = Number(results[1]?.meta?.changes || 0);
    const balance = await readWallet(env, session.sub);
    if (!inserted) {
      const racedDuplicate = await env.ADMIN_DB.prepare(
        "SELECT 1 AS awarded FROM game_coin_rewards WHERE session_id = ? AND wave = ? LIMIT 1"
      ).bind(sessionId, wave).first();
      if (racedDuplicate) return json({ awarded: false, alreadyAwarded: true, balance: balance.balance }, 200, headers);
      return json({ error: "wave_not_eligible" }, 409, headers);
    }
    return json({ awarded: true, amount: GAME_WAVE_REWARD, balance: balance.balance }, 200, headers);
  } catch (error) {
    console.error("Game wave coin reward unavailable", error);
    return json({ error: "coin_wallet_unavailable" }, 503, headers);
  }
}

function opExistsCondition(opId, payload) {
  return "EXISTS (SELECT 1 FROM coin_operations WHERE operation_id = ? AND payload = ? AND status = 'pending')";
}

async function runCoinOperation(env, body) {
  const operationId = body.idempotencyKey;
  const operation = body.operation;
  const userId = body.userId;
  if (typeof operationId !== "string" || !OP_ID_RE.test(operationId)) {
    return json({ error: "invalid_idempotency_key" }, 400);
  }
  if (typeof userId !== "string" || !DISCORD_ID_RE.test(userId)) {
    return json({ error: "invalid_discord_id" }, 400);
  }

  const payloadBody = { ...body };
  delete payloadBody.idempotencyKey;
  const payload = canonicalJson(payloadBody);
  const existing = await env.ADMIN_DB.prepare(
    "SELECT payload, status, applied FROM coin_operations WHERE operation_id = ?"
  ).bind(operationId).first();
  if (existing && existing.payload !== payload) return json({ error: "idempotency_key_reused" }, 409);

  if (operation === "balance") {
    const wallet = await readWallet(env, userId);
    return json({ balance: wallet.balance, lastDaily: wallet.lastDaily, lastMine: wallet.lastMine });
  }

  const allowedOperations = new Set(["add", "spend", "transfer", "daily", "gamble", "mine"]);
  if (!allowedOperations.has(operation)) return json({ error: "invalid_operation" }, 400);

  const targetId = body.targetId;
  const ids = operation === "transfer" ? [userId, targetId] : [userId];
  if (operation === "transfer" && (typeof targetId !== "string" || !DISCORD_ID_RE.test(targetId) || targetId === userId)) {
    return json({ error: "invalid_transfer_target" }, 400);
  }

  let amount = body.amount;
  let minimum = 0;
  let today = null;
  let now = Math.floor(Date.now() / 1000);
  if (["add", "spend", "transfer"].includes(operation) && !validAmount(amount)) {
    return json({ error: "invalid_amount" }, 400);
  }
  if (operation === "daily") {
    amount = body.amount;
    today = body.today;
    if (!validAmount(amount) || typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      return json({ error: "invalid_daily_claim" }, 400);
    }
  }
  if (operation === "gamble") {
    amount = body.delta;
    minimum = body.bet;
    if (!validAmount(minimum) || !Number.isSafeInteger(amount) || amount < -minimum || amount > MAX_BALANCE) {
      return json({ error: "invalid_gamble" }, 400);
    }
  }
  if (operation === "mine" && !validAmount(amount, { allowZero: true })) {
    return json({ error: "invalid_mining_reward" }, 400);
  }

  const statements = [env.ADMIN_DB.prepare(
    "INSERT OR IGNORE INTO coin_operations (operation_id, operation, payload, status, applied, created_at) VALUES (?, ?, ?, 'pending', 0, ?)"
  ).bind(operationId, operation, payload, now)];

  for (const discordId of new Set(ids)) {
    statements.push(env.ADMIN_DB.prepare(`
      INSERT OR IGNORE INTO coin_wallets (discord_id, balance)
      SELECT ?, 0 WHERE ${opExistsCondition("?", "?")}
    `).bind(discordId, operationId, payload));
  }

  const pending = opExistsCondition("?", "?");
  if (operation === "add") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets SET balance = balance + ?
      WHERE discord_id = ? AND balance <= ? AND ${pending}
    `).bind(amount, userId, MAX_BALANCE - amount, operationId, payload));
  } else if (operation === "spend") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets SET balance = balance - ?
      WHERE discord_id = ? AND balance >= ? AND ${pending}
    `).bind(amount, userId, amount, operationId, payload));
  } else if (operation === "transfer") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets
      SET balance = CASE WHEN discord_id = ? THEN balance - ? ELSE balance + ? END
      WHERE discord_id IN (?, ?) AND ${pending}
        AND (SELECT balance FROM coin_wallets WHERE discord_id = ?) >= ?
        AND (SELECT balance FROM coin_wallets WHERE discord_id = ?) <= ?
    `).bind(userId, amount, amount, userId, targetId, operationId, payload, userId, amount, targetId, MAX_BALANCE - amount));
  } else if (operation === "daily") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets SET balance = balance + ?, last_daily = ?
      WHERE discord_id = ? AND (last_daily IS NULL OR last_daily != ?)
        AND balance <= ? AND ${pending}
    `).bind(amount, today, userId, today, MAX_BALANCE - amount, operationId, payload));
  } else if (operation === "gamble") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets SET balance = balance + ?
      WHERE discord_id = ? AND balance >= ? AND balance + ? <= ? AND ${pending}
    `).bind(amount, userId, minimum, amount, MAX_BALANCE, operationId, payload));
  } else if (operation === "mine") {
    statements.push(env.ADMIN_DB.prepare(`
      UPDATE coin_wallets SET balance = balance + ?, last_mine = ?
      WHERE discord_id = ? AND balance <= ?
        AND (last_mine IS NULL OR last_mine <= ?)
        AND ${pending}
    `).bind(amount, now, userId, MAX_BALANCE - amount, now - MINE_COOLDOWN_SECONDS, operationId, payload));
  }

  statements.push(env.ADMIN_DB.prepare(`
    UPDATE coin_operations SET status = 'done', applied = changes()
    WHERE operation_id = ? AND payload = ? AND status = 'pending'
  `).bind(operationId, payload));

  await env.ADMIN_DB.batch(statements);
  const receipt = await env.ADMIN_DB.prepare(
    "SELECT payload, status, applied FROM coin_operations WHERE operation_id = ?"
  ).bind(operationId).first();
  if (!receipt || receipt.payload !== payload || receipt.status !== "done") {
    return json({ error: "coin_operation_conflict" }, 409);
  }
  const success = operation === "transfer" ? Number(receipt.applied) === 2 : Number(receipt.applied) === 1;
  const wallets = {};
  for (const discordId of new Set(ids)) wallets[discordId] = (await readWallet(env, discordId)).balance;
  return json({ success, applied: Number(receipt.applied), balances: wallets });
}

async function importLegacyAccounts(env, body) {
  const accounts = body.accounts;
  if (!Array.isArray(accounts) || accounts.length > 100) return json({ error: "invalid_import_batch" }, 400);
  const statements = [];
  for (const account of accounts) {
    const discordId = account?.userId;
    const balance = account?.balance;
    const lastDaily = account?.lastDaily ?? null;
    const lastMine = account?.lastMine ?? null;
    if (typeof discordId !== "string" || !DISCORD_ID_RE.test(discordId) || !validAmount(balance, { allowZero: true })) {
      return json({ error: "invalid_import_account" }, 400);
    }
    if (lastDaily !== null && (typeof lastDaily !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastDaily))) {
      return json({ error: "invalid_import_cooldown" }, 400);
    }
    if (lastMine !== null && (!Number.isSafeInteger(lastMine) || lastMine < 0)) {
      return json({ error: "invalid_import_cooldown" }, 400);
    }
    statements.push(env.ADMIN_DB.prepare(`
      INSERT OR IGNORE INTO coin_wallets (discord_id, balance, last_daily, last_mine)
      VALUES (?, ?, ?, ?)
    `).bind(discordId, balance, lastDaily, lastMine));
  }
  if (!statements.length) return json({ inserted: 0, ignored: 0 });
  const results = await env.ADMIN_DB.batch(statements);
  const inserted = results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0);
  return json({ inserted, ignored: accounts.length - inserted });
}

export async function handleBotCoinRequest(request, env, pathname) {
  if (!env.COIN_BOT_API_SECRET || env.COIN_BOT_API_SECRET.length < 32) {
    return json({ error: "coin_service_not_configured" }, 503);
  }
  if (!(await authorizedBotRequest(request, env))) return json({ error: "unauthorized" }, 401);

  try {
    if (pathname === "/api/bot/coins/balance" && request.method === "GET") {
      const userId = new URL(request.url).searchParams.get("userId");
      if (!userId || !DISCORD_ID_RE.test(userId)) return json({ error: "invalid_discord_id" }, 400);
      const wallet = await readWallet(env, userId);
      return json({ balance: wallet.balance, lastDaily: wallet.lastDaily, lastMine: wallet.lastMine });
    }
    if (pathname === "/api/bot/coins/import" && request.method === "POST") {
      const text = await request.text();
      if (text.length > 100_000) return json({ error: "request_too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
      return await importLegacyAccounts(env, body || {});
    }
    if (pathname === "/api/bot/coins/operation" && request.method === "POST") {
      const text = await request.text();
      if (text.length > 8_000) return json({ error: "request_too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
      if (body?.operation === "balance") {
        if (typeof body.userId !== "string" || !DISCORD_ID_RE.test(body.userId)) {
          return json({ error: "invalid_discord_id" }, 400);
        }
        const wallet = await readWallet(env, body.userId);
        return json({ balance: wallet.balance, lastDaily: wallet.lastDaily, lastMine: wallet.lastMine });
      }
      return await runCoinOperation(env, body || {});
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    console.error("Bot C coin operation failed", error);
    return json({ error: "coin_wallet_unavailable" }, 503);
  }
}
