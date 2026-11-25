const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const MINE_COOLDOWN_SECONDS = 6 * 60 * 60;
const DISCORD_ID_RE = /^\d{17,20}$/;
const OP_ID_RE = /^[0-9a-f-]{32,36}$/i;

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
