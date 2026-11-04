'use strict';
// Shared schema for explicit initialization and existing-database migrations.
function initializeSchema(db) {
 db.exec('PRAGMA foreign_keys = ON;');
 db.exec('BEGIN IMMEDIATE');
 try {

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
        CHECK (is_admin IN (0, 1))
    );
    
    CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        scroll_top INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        telemetry_json TEXT,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        system_prompt TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.7,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        thinking INTEGER NOT NULL DEFAULT 0
            CHECK (thinking IN (0, 1)),
        theme TEXT NOT NULL DEFAULT 'dark'
            CHECK (theme IN ('dark', 'light', 'normal-dark', 'normal-light')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

`);

const userSettingsColumns = db.prepare(`
    PRAGMA table_info(user_settings)
`).all();

if (!userSettingsColumns.some((column) => column.name === "theme")) {
    db.exec(`
        ALTER TABLE user_settings
        ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'
            CHECK (theme IN ('dark', 'light', 'normal-dark', 'normal-light'))
    `);
}

if (!userSettingsColumns.some(column=>column.name==='model_selection')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN model_selection TEXT');
}

const userSettingsSql = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_settings'
`).get()?.sql || "";

if (!userSettingsSql.includes("'normal-dark'")) {
    db.exec(`
        ALTER TABLE user_settings RENAME TO user_settings_legacy;
        CREATE TABLE user_settings (
            user_id TEXT PRIMARY KEY,
            system_prompt TEXT NOT NULL DEFAULT '',
            temperature REAL NOT NULL DEFAULT 0.7,
            max_tokens INTEGER NOT NULL DEFAULT 4096,
            thinking INTEGER NOT NULL DEFAULT 0 CHECK (thinking IN (0, 1)),
            theme TEXT NOT NULL DEFAULT 'dark'
                CHECK (theme IN ('dark', 'light', 'normal-dark', 'normal-light')),
            model_selection TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO user_settings (
            user_id, system_prompt, temperature, max_tokens, thinking, theme, model_selection
        )
        SELECT user_id, system_prompt, temperature, max_tokens, thinking, theme, model_selection
        FROM user_settings_legacy;
        DROP TABLE user_settings_legacy;
    `);
}

const chatColumns = db.prepare(`
    PRAGMA table_info(chats)
`).all();

if (!chatColumns.some((column) => column.name === "user_id")) {
    db.exec(`
        ALTER TABLE chats
        ADD COLUMN user_id TEXT
        REFERENCES users(id)
    `);
}

const messageColumns = db.prepare(`
    PRAGMA table_info(messages)
`).all();

if (!messageColumns.some((column) => column.name === "display_content")) {
    db.exec(`
        ALTER TABLE messages
        ADD COLUMN display_content TEXT
    `);
}

// The revision migration is atomic and must succeed before this module loads.
{
    const columns = db.prepare("PRAGMA table_info(chats)").all();
    if (!columns.some((column) => column.name === "revision")) {
        db.exec(`
            ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
        `);
    }
    if (db.prepare(`
        SELECT 1 FROM chats WHERE revision IS NULL OR typeof(revision) != 'integer'
            OR revision < 0 OR revision > 9007199254740991 LIMIT 1
    `).get()) {
        throw new Error("Invalid stored chat revision");
    }
}
 // Additive OpenAI reliability/accounting migration; legacy rows stay unspecified.
 const responseColumns=db.prepare('PRAGMA table_info(messages)').all();
 if(!responseColumns.some(c=>c.name==='response_status'))db.exec('ALTER TABLE messages ADD COLUMN response_status TEXT');
 if(!responseColumns.some(c=>c.name==='response_request_id'))db.exec('ALTER TABLE messages ADD COLUMN response_request_id TEXT');
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS message_response_request ON messages(response_request_id) WHERE response_request_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS openai_safeguards (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 1024, max_concurrent INTEGER NOT NULL DEFAULT 1,
  per_hour INTEGER NOT NULL DEFAULT 20, per_day INTEGER NOT NULL DEFAULT 100,
  estimated_daily_usd REAL
 );
 INSERT OR IGNORE INTO openai_safeguards(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS openai_usage (
  request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
  latency_ms REAL, provider_response_id TEXT
 );
 CREATE INDEX IF NOT EXISTS openai_usage_user_time ON openai_usage(user_id,started_at);`);
 db.exec(`CREATE TABLE IF NOT EXISTS deepseek_safeguards (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
 max_output_tokens INTEGER NOT NULL DEFAULT 1024, max_concurrent INTEGER NOT NULL DEFAULT 1,
 per_hour INTEGER NOT NULL DEFAULT 20, per_day INTEGER NOT NULL DEFAULT 100, estimated_daily_usd REAL);
 INSERT OR IGNORE INTO deepseek_safeguards(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS deepseek_usage (
 request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
 user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
 latency_ms REAL, provider_response_id TEXT);
 CREATE INDEX IF NOT EXISTS deepseek_usage_user_time ON deepseek_usage(user_id,started_at);`);
 db.exec(`CREATE TABLE IF NOT EXISTS system_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at) <= 32),
  severity TEXT NOT NULL CHECK(severity IN ('DEBUG','INFO','WARN','ERROR')),
  category TEXT NOT NULL CHECK(category IN ('AUTH','PROVIDER','CONFIG','RUNTIME','SYSTEM')),
  event_code TEXT NOT NULL CHECK(length(event_code) BETWEEN 1 AND 64),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 160),
  metadata_json TEXT CHECK(metadata_json IS NULL OR length(metadata_json) <= 2048),
  correlation_id TEXT CHECK(correlation_id IS NULL OR length(correlation_id) <= 128),
  actor_id TEXT CHECK(actor_id IS NULL OR length(actor_id) <= 128),
  provider_id TEXT CHECK(provider_id IS NULL OR length(provider_id) <= 128),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCESS','FAILURE','DENIED','UNKNOWN'))
 );
 CREATE INDEX IF NOT EXISTS system_events_time ON system_events(occurred_at DESC, event_id);
 CREATE INDEX IF NOT EXISTS system_events_severity_time ON system_events(severity, occurred_at DESC);
 CREATE INDEX IF NOT EXISTS system_events_category_time ON system_events(category, occurred_at DESC);
 CREATE INDEX IF NOT EXISTS system_events_provider_time ON system_events(provider_id, occurred_at DESC);
 CREATE INDEX IF NOT EXISTS system_events_correlation ON system_events(correlation_id) WHERE correlation_id IS NOT NULL;`);
 db.exec('COMMIT');
 } catch(error) { if(db.isTransaction)db.exec('ROLLBACK'); throw error; }
}
module.exports={initializeSchema};
