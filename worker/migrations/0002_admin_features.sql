CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS announcements_status_published_idx
  ON announcements (status, published_at DESC);

CREATE TABLE IF NOT EXISTS player_bans (
  discord_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_bans_banned_at_idx
  ON player_bans (banned_at DESC);

CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_discord_time_idx
  ON login_events (discord_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS login_events_time_idx
  ON login_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS game_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  discord_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS game_sessions_started_idx
  ON game_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_discord_idx
  ON game_sessions (discord_id, started_at DESC);
