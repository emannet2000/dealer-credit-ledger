"use strict";
// Load .env if present (no extra dependency needed).
const fs = require("fs");
const path = require("path");
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.TZ = process.env.TZ || "Asia/Manila";

const { createApp } = require("./lib/app");
const { app, close, backupNow, dataDir } = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });
const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`Dealer Credit Ledger running at http://localhost:${port}`);
  console.log(`Data folder: ${dataDir}`);
});

// Daily automatic backup (first one shortly after start, then every 24 hours).
const runBackup = () => backupNow().then((f) => console.log(`Backup saved: ${f}`)).catch((e) => console.error("Backup failed:", e.message));
const first = setTimeout(runBackup, 60e3);
const daily = setInterval(runBackup, 24 * 3600e3);

function shutdown() {
  clearTimeout(first); clearInterval(daily);
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
