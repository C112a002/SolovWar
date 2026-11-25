CREATE TABLE IF NOT EXISTS coin_wallets (
  discord_id TEXT PRIMARY KEY NOT NULL CHECK (length(discord_id) BETWEEN 17 AND 20 AND discord_id NOT GLOB '*[^0-9]*'),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  last_daily TEXT,
  last_mine INTEGER
);

CREATE TABLE IF NOT EXISTS coin_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS coin_operations_created_at_idx ON coin_operations(created_at);
