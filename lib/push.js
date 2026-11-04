"use strict";
// Phone notifications (Web Push). Keys come from VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or
// are created once and kept in the data folder. Messages stay generic, because they show on
// lock screens: no dealer names or amounts.
const fs = require("fs");
const path = require("path");
const webPush = require("web-push");

function loadKeys(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const file = path.join(dataDir, "vapid.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* first run */ }
  const keys = webPush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function createPush({ db, dataDir, logger, sender }) {
  const keys = loadKeys(dataDir);
  const contact = process.env.PUSH_CONTACT || "mailto:owner@example.invalid";
  const send = sender || ((sub, payload) => webPush.sendNotification(sub, payload, { vapidDetails: { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 }));
  const q = {
    save: db.prepare("INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys"),
    del: db.prepare("DELETE FROM push_subs WHERE endpoint = ?"),
    forRoles: (roles) => db.prepare(`SELECT p.endpoint, p.keys FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.active = 1 AND u.role IN (${roles.map(() => "?").join(",")})`).all(...roles),
  };
  const subscribe = (userId, sub) => q.save.run(sub.endpoint, userId, JSON.stringify(sub.keys), Date.now());
  const unsubscribe = (endpoint) => q.del.run(endpoint);
  // Never throws: a failed notification must not fail the sale or payment behind it.
  async function notify(roles, title, body, url = "/") {
    const payload = JSON.stringify({ title, body, url });
    await Promise.all(q.forRoles(roles).map(async (s) => {
      try { await send({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload); }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) q.del.run(s.endpoint); else logger.error(`Notification failed: ${e && e.message}`); }
    }));
  }
  return { publicKey: keys.publicKey, subscribe, unsubscribe, notify };
}

module.exports = { createPush };
