"use strict";
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner','editor','staff','viewer')),
     password_hash TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE docs (
     collection TEXT NOT NULL,
     id TEXT NOT NULL,
     data TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (collection, id)
   );
   CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     content_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     created_by TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     user_id TEXT,
     action TEXT NOT NULL,
     collection TEXT,
     doc_id TEXT,
     detail TEXT
   );
   CREATE INDEX audit_at ON audit(at);`,
  // v2: dealer portal accounts (role "dealer" linked to one dealer record)
  `CREATE TABLE users_v2 (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner','editor','staff','viewer','dealer')),
     password_hash TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     dealer_id TEXT
   );
   INSERT INTO users_v2 (id, username, name, role, password_hash, active, created_at)
     SELECT id, username, name, role, password_hash, active, created_at FROM users;
   DROP TABLE users;
   ALTER TABLE users_v2 RENAME TO users;`,
  // v3: two-step sign-in and remote sign-out (PR-10, FR-059)
  `ALTER TABLE users ADD COLUMN totp_secret TEXT;
   ALTER TABLE users ADD COLUMN totp_pending TEXT;
   ALTER TABLE users ADD COLUMN totp_last INTEGER;
   ALTER TABLE users ADD COLUMN recovery_hashes TEXT;
   CREATE TABLE revoked_sessions (token TEXT PRIMARY KEY, user_id TEXT, revoked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`,
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  const db = new Database(path.join(dataDir, "ledger.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const current = db.pragma("user_version", { simple: true });
  if (current < MIGRATIONS.length) {
    db.pragma("foreign_keys = OFF"); // table rebuilds must not cascade-delete sessions
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
    db.pragma("foreign_keys = ON");
  }
  return db;
}

module.exports = { openDb };
