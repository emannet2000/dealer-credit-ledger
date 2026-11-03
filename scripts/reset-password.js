#!/usr/bin/env node
"use strict";
// Reset a forgotten password from the server's command line.
// Usage: npm run reset-password -- <username> <new-password>
const path = require("path");
const bcrypt = require("bcryptjs");
const { openDb } = require("../lib/db");

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error("Usage: npm run reset-password -- <username> <new-password (8+ characters)>");
  process.exit(1);
}
const db = openDb(path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")));
const u = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
if (!u) { console.error(`No account named "${username}".`); process.exit(1); }
db.prepare("UPDATE users SET password_hash = ?, active = 1 WHERE id = ?").run(bcrypt.hashSync(password, 10), u.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
db.prepare("INSERT INTO audit (at, user_id, action, collection, doc_id) VALUES (?, NULL, 'password_reset', 'users', ?)").run(Date.now(), u.id);
db.close();
console.log(`Password for "${username}" was reset. They can sign in with the new password now.`);
