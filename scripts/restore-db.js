#!/usr/bin/env node
"use strict";
// Restore a daily backup (data/backups/ledger-YYYY-MM-DD.db) as the live database.
// Stop the app first. The current database is kept as ledger.before-restore-<time>.db.
// Usage: npm run restore -- path/to/ledger-2026-11-03.db
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const src = process.argv[2];
if (!src) { console.error("Usage: npm run restore -- path/to/ledger-YYYY-MM-DD.db"); process.exit(1); }
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const live = path.join(dataDir, "ledger.db");
const started = Date.now();

// 1. Check the backup before touching anything.
let info;
try {
  const v = new Database(path.resolve(src), { readonly: true, fileMustExist: true });
  const integrity = v.pragma("integrity_check", { simple: true });
  info = { integrity, docs: v.prepare("SELECT COUNT(*) n FROM docs").get().n, users: v.prepare("SELECT COUNT(*) n FROM users").get().n };
  v.close();
} catch (e) { console.error(`Can't open ${src} as a ledger backup: ${e.message}`); process.exit(1); }
if (info.integrity !== "ok") { console.error(`The backup failed its integrity check: ${info.integrity}`); process.exit(1); }
if (!info.users) { console.error("The backup has no accounts; refusing to restore it."); process.exit(1); }

// 2. Keep the current database, then put the backup in its place.
fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(live)) {
  const keep = path.join(dataDir, `ledger.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  const cur = new Database(live);
  cur.pragma("wal_checkpoint(TRUNCATE)");
  cur.close();
  fs.copyFileSync(live, keep);
  console.log(`Current database saved as ${keep}`);
}
for (const f of ["ledger.db-wal", "ledger.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
fs.copyFileSync(path.resolve(src), live);

const db = new Database(live);
db.prepare("INSERT INTO audit (at, user_id, action, detail) VALUES (?, NULL, 'restore', ?)").run(Date.now(), JSON.stringify({ file: path.basename(src), docs: info.docs, users: info.users }));
db.close();
console.log(`Restored ${path.basename(src)}: ${info.docs} records, ${info.users} accounts, in ${((Date.now() - started) / 1000).toFixed(1)} s. Start the app again.`);
