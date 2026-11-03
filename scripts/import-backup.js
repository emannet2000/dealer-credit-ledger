#!/usr/bin/env node
"use strict";
// Import a backup file downloaded from the ledger ("Store → Download backup")
// into the Node.js database. Records with the same ID are overwritten.
// Usage: npm run import -- path/to/ledger-backup.json
const fs = require("fs");
const path = require("path");
const { openDb } = require("../lib/db");

const file = process.argv[2];
if (!file) { console.error("Usage: npm run import -- path/to/ledger-backup.json"); process.exit(1); }
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("Couldn't read that file as JSON:", e.message); process.exit(1); }
if (data.app !== "dealer-credit-ledger") { console.error("That file isn't a Dealer Credit Ledger backup."); process.exit(1); }

const db = openDb(path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")));
const upsert = db.prepare(`INSERT INTO docs (collection, id, data, version, updated_at) VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at`);
const counts = {};
db.transaction(() => {
  for (const c of ["dealers", "products", "txns", "moves", "orders"]) {
    for (const [id, doc] of Object.entries(data[c] || {})) {
      // Photos live in the old app's storage and aren't in the backup file.
      if (c === "products" && doc.imageId) delete doc.imageId;
      upsert.run(c, id, JSON.stringify(doc), Date.now());
      counts[c] = (counts[c] || 0) + 1;
    }
  }
  if (data.settings && Object.keys(data.settings).length) { upsert.run("settings", "store", JSON.stringify(data.settings), Date.now()); counts.settings = 1; }
  db.prepare("INSERT INTO audit (at, user_id, action, detail) VALUES (?, NULL, 'restore', ?)").run(Date.now(), JSON.stringify({ file: path.basename(file), counts }));
})();
db.close();
console.log("Imported:", Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing");
console.log("Product photos aren't included in backup files. Add them again from the Products tab.");
