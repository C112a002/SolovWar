CREATE TABLE IF NOT EXISTS game_coin_rewards (
  session_id TEXT NOT NULL,
  discord_id TEXT NOT NULL CHECK (length(discord_id) BETWEEN 17 AND 20 AND discord_id NOT GLOB '*[^0-9]*'),
  wave INTEGER NOT NULL CHECK (wave BETWEEN 1 AND 10000),
  amount INTEGER NOT NULL CHECK (amount = 10),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, wave)
);
CREATE INDEX IF NOT EXISTS game_coin_rewards_player_time_idx
  ON game_coin_rewards (discord_id, created_at DESC);
