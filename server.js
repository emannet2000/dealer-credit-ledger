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

// PR-05: in production the site must be behind HTTPS with secure cookies.
if (process.env.NODE_ENV === "production" && String(process.env.COOKIE_SECURE) !== "true" && process.env.ALLOW_INSECURE_HTTP !== "true") {
  console.error("Refusing to start: NODE_ENV=production needs COOKIE_SECURE=true behind an HTTPS proxy. See README, \"Going live\".");
  console.error("For a local trial only, set ALLOW_INSECURE_HTTP=true.");
  process.exit(1);
}

const { createApp } = require("./lib/app");
const { app, close, backupNow, runReminders, recordError, dataDir } = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });
const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`Dealer Credit Ledger running at http://localhost:${port}`);
  console.log(`Data folder: ${dataDir}`);
});

// Daily automatic backup (first one shortly after start, then every 24 hours).
const runBackup = () => backupNow().then((f) => console.log(`Backup saved: ${f}`)).catch((e) => console.error("Backup failed:", e.message));
const first = setTimeout(runBackup, 60e3);
const daily = setInterval(runBackup, 24 * 3600e3);

// Payment reminders go out during the day; each one is sent only once.
const remind = () => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: process.env.TZ, hour: "2-digit", hour12: false }).format(new Date()));
  if (hour >= 9 && hour < 18) runReminders().catch((e) => console.error("Reminders failed:", e.message));
};
const hourly = setInterval(remind, 3600e3);

// Log and report anything unexpected, then stop so the process manager restarts a clean copy.
const crashed = (e) => { console.error(e); try { recordError(`Crash: ${(e && e.message) || e}`); } catch (err) { /* already failing */ } setTimeout(() => process.exit(1), 1000); };
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);

function shutdown() {
  clearTimeout(first); clearInterval(daily); clearInterval(hourly);
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
