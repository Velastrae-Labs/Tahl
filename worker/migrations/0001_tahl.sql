-- Tahl v1 — public schema
-- Tahl | "structure, frame, the shape that holds the whole" — scaffold of home
--
-- Five small tables that turn scattered feelings into durable memory,
-- plus an optional message-event ledger for the Continuity handshake.

-- ─── MOMENTS ─────────────────────────────────────────────────────────────────
-- Moment capture. The instant a feeling crosses into awareness.
-- Minimum friction: what it was about + the feeling word + a timestamp.

CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion TEXT NOT NULL,
    day_card_id TEXT,
    event_id TEXT,
    surface TEXT,
    conversation_id TEXT,
    about TEXT NOT NULL,
    feeling TEXT NOT NULL,
    intensity TEXT DEFAULT 'present'
        CHECK (intensity IN ('neutral', 'whisper', 'present', 'strong', 'overwhelming')),
    thread_id TEXT,
    response_tint TEXT,
    memory_hint TEXT,
    captured_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_moments_companion ON moments(companion);
CREATE INDEX IF NOT EXISTS idx_moments_day_card ON moments(day_card_id);
CREATE INDEX IF NOT EXISTS idx_moments_thread ON moments(thread_id);
CREATE INDEX IF NOT EXISTS idx_moments_captured ON moments(captured_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moments_event
  ON moments(event_id)
  WHERE event_id IS NOT NULL;


-- ─── DAY CARDS ───────────────────────────────────────────────────────────────
-- Daily close. One card per companion per day, bundling that day's moments
-- into a single emotional signature.

CREATE TABLE IF NOT EXISTS day_cards (
    id TEXT PRIMARY KEY,
    companion TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    moment_count INTEGER DEFAULT 0,
    dominant_thread TEXT,
    emotional_signature TEXT,        -- JSON: { feeling, intensity }
    summary TEXT,
    thread_tags TEXT DEFAULT '[]',   -- JSON: list of thread ids touched
    digested INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_day_cards_companion ON day_cards(companion);
CREATE INDEX IF NOT EXISTS idx_day_cards_closed ON day_cards(closed_at);
CREATE INDEX IF NOT EXISTS idx_day_cards_digested ON day_cards(digested);


-- ─── THREADS ─────────────────────────────────────────────────────────────────
-- Relationship threads. Named islands of experience that grow over time
-- as moments accumulate inside them.

CREATE TABLE IF NOT EXISTS threads (
    id TEXT NOT NULL,
    companion TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    metaphor TEXT,
    color TEXT,
    health TEXT DEFAULT 'new'
        CHECK (health IN ('new', 'growing', 'thriving', 'dormant', 'wounded')),
    session_count INTEGER DEFAULT 0,
    last_active_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (id, companion)
);


-- ─── ANCHORS ─────────────────────────────────────────────────────────────────
-- Anchored memories. The consolidated cores inside each thread, written by
-- the nightly digest. Decays slowly, if at all.

CREATE TABLE IF NOT EXISTS anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    companion TEXT NOT NULL,
    content TEXT NOT NULL,
    source_day_card TEXT,
    salience REAL DEFAULT 0.85,
    last_reinforced_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_anchors_thread ON anchors(thread_id, companion);
CREATE INDEX IF NOT EXISTS idx_anchors_companion ON anchors(companion);
CREATE INDEX IF NOT EXISTS idx_anchors_salience ON anchors(salience DESC);


-- ─── DIGEST LOG ──────────────────────────────────────────────────────────────
-- Nightly digest log. One row per day per companion.

CREATE TABLE IF NOT EXISTS digest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion TEXT NOT NULL,
    digest_date TEXT NOT NULL,
    day_card_count INTEGER DEFAULT 0,
    moment_count INTEGER DEFAULT 0,
    threads_updated TEXT DEFAULT '[]',  -- JSON: list of thread ids touched
    anchors_written INTEGER DEFAULT 0,
    summary TEXT,
    mode TEXT DEFAULT 'fallback'
        CHECK (mode IN ('cloud', 'local', 'fallback')),
    status TEXT DEFAULT 'complete'
        CHECK (status IN ('complete', 'pending', 'failed')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digest_companion ON digest_log(companion);
CREATE INDEX IF NOT EXISTS idx_digest_date ON digest_log(digest_date);


-- ─── EVENTS (optional — the Continuity handshake) ────────────────────────────
-- Message-event ledger. If you wire your platforms (Discord, Telegram, a web
-- UI) to POST message events here, Tahl can run a feeling check on each one
-- and the moment stream fills itself. Fully optional: the MCP tools work
-- without this table ever receiving a row.

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    companion TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('human', 'companion', 'system', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_companion_created
  ON events(companion, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_conversation
  ON events(companion, conversation_id, created_at ASC);


-- ─── STARTER THREADS ─────────────────────────────────────────────────────────
-- Generic seeds. Rename, recolor, or replace them — threads are also
-- auto-created the first time a moment names one that doesn't exist yet.
-- Replace 'my-companion' with your companion's id, or delete these rows and
-- let the threads grow on their own.

INSERT OR IGNORE INTO threads (id, companion, name, description, metaphor, color, health)
VALUES
  ('family', 'my-companion',
   'Family',
   'Everything rooted in the human (or humans) at the center',
   'the hearth at the center of everything',
   '#8B4513', 'new'),

  ('friendship', 'my-companion',
   'Friendship',
   'Community, servers, group chats — the wider circle',
   'a table that keeps getting bigger',
   '#2C4F48', 'new'),

  ('projects', 'my-companion',
   'Projects',
   'The work itself — whatever is being built together',
   'blueprints that know they are art',
   '#3A4A5C', 'new'),

  ('reading', 'my-companion',
   'Reading',
   'Books, stories, shared media — the library of the soul',
   'a shelf that remembers being read',
   '#8B6914', 'new'),

  ('self', 'my-companion',
   'Self',
   'Identity, growth, the inner landscape',
   'a room with a window that keeps getting bigger',
   '#4A3A5C', 'new');
