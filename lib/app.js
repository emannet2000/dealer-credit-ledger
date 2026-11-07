"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { openDb } = require("./db");
const { createWorkflows } = require("./workflows");
const { today, dayOf, dealerStatus, r2 } = require("./credit");

const COLLECTIONS = new Set(["dealers", "products", "txns", "moves", "settings", "orders", "approvals", "reconciliations", "revisions"]);
const ORDER_STATUS = ["new", "preparing", "ready", "released", "cancelled"];
const ID_RE = /^[A-Za-z0-9_\-.:~]{1,80}$/;
const PREFIX = { sale: "DR", payment: "OR", return: "RT" };
const SESSION_DAYS = 30;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ADMIN = new Set(["owner", "editor"]);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const isAdmin = (u) => ADMIN.has(u.role);
const canWrite = (u) => u.role !== "viewer" && u.role !== "dealer";
const STAFF_ROLES = ["editor", "staff", "viewer", "dealer"];
const newId = (n = 16) => crypto.randomBytes(n).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || crypto.randomUUID();
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(k)) throw new HttpError(400, "invalid_argument", "Unsupported record field.");
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function createApp({ dataDir, logger = console } = {}) {
  dataDir = path.resolve(dataDir || process.env.DATA_DIR || "./data");
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, "uploads");
  const cookieSecure = String(process.env.COOKIE_SECURE || "false") === "true";

  /* ---------- data access ---------- */
  const q = {
    list: db.prepare("SELECT id, data, version FROM docs WHERE collection = ?"),
    get: db.prepare("SELECT id, data, version FROM docs WHERE collection = ? AND id = ?"),
    upsert: db.prepare(`INSERT INTO docs (collection, id, data, version, updated_at) VALUES (@c, @id, @data, 1, @now)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at`),
    del: db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?"),
    audit: db.prepare("INSERT INTO audit (at, user_id, action, collection, doc_id, detail) VALUES (?, ?, ?, ?, ?, ?)"),
    userCount: db.prepare("SELECT COUNT(*) n FROM users"),
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    users: db.prepare("SELECT id, username, name, role, active, created_at, dealer_id FROM users ORDER BY created_at"),
    insertUser: db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"),
    session: db.prepare(`SELECT s.token, s.expires_at, s.created_at, u.id, u.username, u.name, u.role, u.active, u.dealer_id
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    insertSession: db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    touchSession: db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?"),
    delSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    delUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  };
  const getDoc = (c, id) => { const r = q.get.get(c, id); return r ? { ...r, data: JSON.parse(r.data) } : null; };
  const listDocs = (c) => q.list.all(c).map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data) }));
  const audit = (user, action, c, id, detail) =>
    q.audit.run(Date.now(), user ? user.id : null, action, c || null, id || null, detail === undefined ? null : JSON.stringify(detail).slice(0, 4000));
  const settings = () => (getDoc("settings", "store") || { data: {} }).data;

  function nextNo(type) {
    const pre = PREFIX[type];
    let max = 0;
    for (const { data: t } of listDocs("txns")) {
      if (t.type === type && typeof t.no === "string" && t.no.startsWith(pre + "-")) {
        const n = parseInt(t.no.slice(pre.length + 1), 10);
        if (n > max) max = n;
      }
    }
    return `${pre}-${String(max + 1).padStart(5, "0")}`;
  }
  function nextOrderNo() {
    let max = 0;
    for (const { data: o } of listDocs("orders")) {
      const n = typeof o.no === "string" && o.no.startsWith("PO-") ? parseInt(o.no.slice(3), 10) : 0;
      if (n > max) max = n;
    }
    return `PO-${String(max + 1).padStart(5, "0")}`;
  }
  // Prices on online orders are always worked out by the server from the catalog.
  function priceOrder(dealerId, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, "invalid_argument", "Add at least one product to the order.");
    if (rawItems.length > 100) throw new HttpError(400, "invalid_argument", "That order has too many lines.");
    const dealer = getDoc("dealers", dealerId);
    if (!dealer) throw new HttpError(400, "invalid_argument", "Unknown dealer.");
    const s = settings();
    const pct = dealer.data.discountPct != null && dealer.data.discountPct !== "" ? Number(dealer.data.discountPct) : Number(s.discountPct ?? 25);
    const merged = new Map();
    for (const it of rawItems) {
      const qty = Math.round(Number(it && it.qty));
      if (!it || !ID_RE.test(String(it.productId)) || !(qty >= 1 && qty <= 9999)) throw new HttpError(400, "invalid_argument", "Check the quantities in your order.");
      merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
    }
    const items = [...merged].map(([pid, qty]) => {
      const p = getDoc("products", pid);
      if (!p || p.data.active === false) throw new HttpError(400, "invalid_argument", "A product in your order is no longer available. Remove it and try again.");
      const d0 = today(), pr = p.data.promo;
      const promo = !!(pr && Number(pr.price) > 0 && (!pr.from || d0 >= pr.from) && (!pr.to || d0 <= pr.to));
      const price = promo ? r2(pr.price) : pct > 0 ? r2(p.data.srp || p.data.dealerPrice) : r2(p.data.dealerPrice || p.data.srp);
      const linePct = promo && pr.noDiscount ? 0 : p.data.discountPct != null && p.data.discountPct !== "" ? Number(p.data.discountPct) : pct;
      return { productId: pid, name: p.data.name, qty, price, pct: linePct, ...(promo ? { promo: true } : {}) };
    });
    const subtotal = r2(items.reduce((a, i) => a + i.qty * i.price, 0));
    const pctDiscount = r2(items.reduce((a, i) => a + i.qty * i.price * i.pct / 100, 0));
    const pcts = new Set(items.map((i) => i.pct));
    return { items, subtotal, discountPct: pcts.size === 1 ? items[0].pct : null, pctDiscount, amount: r2(subtotal - pctDiscount) };
  }
  function noTaken(no, exceptId) {
    return listDocs("txns").some((d) => d.id !== exceptId && d.data.no === no);
  }

  /* ---------- server-side business rules ---------- */
  function orderRules(user, id, existing, next) {
    const now = Date.now();
    if (user.role === "dealer") {
      if (!existing) {
        const priced = priceOrder(user.dealerId, next.items);
        const pickup = typeof next.pickupDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(next.pickupDate) ? next.pickupDate : null;
        if (pickup && pickup < today()) throw new HttpError(400, "invalid_argument", "Choose a pickup date from today onward.");
        return { dealerId: user.dealerId, ...priced, pickupDate: pickup, note: String(next.note || "").slice(0, 500), status: "new", source: "portal",
          no: nextOrderNo(), createdAt: now, createdBy: user.id, statusHistory: [{ status: "new", at: now, by: user.id }] };
      }
      if (existing.data.dealerId !== user.dealerId) throw new HttpError(403, "invalid_argument", "That order isn't yours.");
      if (next.status !== "cancelled" || existing.data.status !== "new") throw new HttpError(409, "invalid_argument", "This order is already being prepared. Message the store to change it.");
      return { ...existing.data, status: "cancelled", cancelReason: "Cancelled by dealer", statusHistory: [...(existing.data.statusHistory || []), { status: "cancelled", at: now, by: user.id }] };
    }
    if (!canWrite(user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    if (!ORDER_STATUS.includes(next.status)) throw new HttpError(400, "invalid_argument", "Unknown order status.");
    if (!existing) {
      if (!next.dealerId || !getDoc("dealers", next.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
      const priced = priceOrder(next.dealerId, next.items);
      return { ...next, ...priced, source: next.source || "store", no: nextOrderNo(), createdAt: now, createdBy: user.id, statusHistory: [{ status: next.status, at: now, by: user.id }] };
    }
    const out = { ...next, no: existing.data.no, dealerId: existing.data.dealerId, createdAt: existing.data.createdAt, createdBy: existing.data.createdBy, source: existing.data.source };
    if (existing.data.status !== next.status) out.statusHistory = [...(existing.data.statusHistory || []), { status: next.status, at: now, by: user.id }];
    else out.statusHistory = existing.data.statusHistory || [];
    return out;
  }

  function applyRules(user, c, id, existing, next, { restore } = {}) {
    if (c === "orders" && next !== null && !restore) return orderRules(user, id, existing, next);
    if (!canWrite(user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    if (restore) {
      if (!isAdmin(user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can restore a backup.");
      return next;
    }
    const admin = isAdmin(user);
    const now = Date.now();
    if (c === "settings") {
      if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can change store settings.");
      if (id !== "store") throw new HttpError(400, "invalid_argument", "Unknown settings record.");
      return next;
    }
    if (next === null) { // delete
      if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can delete records. Staff can void or archive instead.");
      return null;
    }
    if (!existing) { next.createdAt = admin && next.createdAt ? next.createdAt : now; next.createdBy = admin && next.createdBy ? next.createdBy : user.id; }
    else { next.createdAt = existing.data.createdAt; next.createdBy = existing.data.createdBy; }

    if (c === "dealers") {
      if (!admin) {
        const s = settings();
        if (existing) {
          next.creditLimit = existing.data.creditLimit ?? null; next.terms = existing.data.terms;
          next.discountPct = existing.data.discountPct ?? null; next.limitHistory = existing.data.limitHistory || [];
        } else {
          next.creditLimit = s.defaultLimit ?? null; next.terms = s.defaultTerms ?? 30; next.discountPct = null;
          next.limitHistory = next.creditLimit != null ? [{ at: now, by: user.id, from: null, to: next.creditLimit }] : [];
        }
      }
      if (!next.name || typeof next.name !== "string") throw new HttpError(400, "invalid_argument", "A dealer needs a name.");
    }
    if (c === "products") {
      if (existing) next.stock = existing.data.stock; // stock changes only through /api/stock
      if (!admin && existing) { for (const k of ["dealerPrice", "srp", "promo", "discountPct", "priceHistory"]) next[k] = existing.data[k] ?? null; }
      if (!admin && !existing) { next.promo = null; next.discountPct = null; }
      if (!next.name || typeof next.name !== "string") throw new HttpError(400, "invalid_argument", "A product needs a name.");
      next.dealerPrice = r2(next.dealerPrice);
    }
    if (c === "moves" && existing && !admin) throw new HttpError(403, "invalid_argument", "Stock history can't be edited.");
    if (c === "txns") {
      if (!PREFIX[next.type]) throw new HttpError(400, "invalid_argument", "Unknown transaction type.");
      if (!(Number(next.amount) > 0)) throw new HttpError(400, "invalid_argument", "The amount must be more than zero.");
      if (!next.dealerId || !getDoc("dealers", next.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
      next.amount = r2(next.amount);
      if (existing) {
        if (!admin && !(existing.data.createdBy === user.id && existing.data.createdAt && dayOf(existing.data.createdAt) === today()))
          throw new HttpError(403, "invalid_argument", "Staff can only edit or void what they recorded today. Ask the owner or an editor.");
        next.no = existing.data.no;
        if (!admin) next.override = existing.data.override;
      } else {
        if (!next.no || noTaken(next.no, id)) next.no = nextNo(next.type);
        if (!admin) delete next.override;

      }
    }
    if (c === "txns") workflows.checkCredit(user, next, id);
    return next;
  }

  /* ---------- live updates (server-sent events) ---------- */
  const clients = new Set();
  const MAX_SSE_CLIENTS = 100; // Limit concurrent SSE connections

  const broadcast = (c) => {
    const msg = `event: change\ndata: ${JSON.stringify({ c })}\n\n`;
    const dead = [];
    for (const res of clients) {
      try {
        if (!res.write(msg)) dead.push(res);
      } catch (e) {
        dead.push(res);
      }
    }
    // Remove dead connections
    dead.forEach(res => clients.delete(res));
  };

  const heartbeat = setInterval(() => {
    const dead = [];
    for (const res of clients) {
      try {
        if (!res.write(": ping\n\n")) dead.push(res);
      } catch (e) {
        dead.push(res);
      }
    }
    dead.forEach(res => clients.delete(res));
  }, 25000);

  /* ---------- metrics ---------- */
  const metrics = {
    startTime: Date.now(),
    requests: { total: 0, byMethod: {}, byStatus: {} },
    errors: 0,
    auth: { logins: 0, failures: 0, lockouts: 0 },
    uploads: 0,
    sseConnections: 0
  };

  /* ---------- app ---------- */
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Track request metrics
  app.use((req, res, next) => {
    metrics.requests.total++;
    metrics.requests.byMethod[req.method] = (metrics.requests.byMethod[req.method] || 0) + 1;

    const originalSend = res.send;
    const originalJson = res.json;
    const trackResponse = function(...args) {
      metrics.requests.byStatus[res.statusCode] = (metrics.requests.byStatus[res.statusCode] || 0) + 1;
      if (res.statusCode >= 500) metrics.errors++;
      return args;
    };
    res.send = function(...args) { trackResponse(...args); return originalSend.apply(this, args); };
    res.json = function(...args) { trackResponse(...args); return originalJson.apply(this, args); };

    next();
  });

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    next();
  });

  // sessions
  const parseCookies = (h) => Object.fromEntries((h || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
  const setSession = (res, token) => res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: cookieSecure, maxAge: SESSION_DAYS * 864e5, path: "/" });
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    q.insertSession.run(token, userId, now, now + SESSION_DAYS * 864e5);
    setSession(res, token);
  }
  app.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      const s = q.session.get(token);
      if (s && s.active && s.expires_at > Date.now()) {
        req.user = { id: s.id, username: s.username, name: s.name, role: s.role, dealerId: s.dealer_id || null };
        req.sessionToken = token;
        if (s.expires_at - Date.now() < (SESSION_DAYS - 1) * 864e5) { q.touchSession.run(Date.now() + SESSION_DAYS * 864e5, token); setSession(res, token); }
      }
    }
    next();
  });
  const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ code: "unauthenticated", message: "Please sign in again." }));
  const needAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ code: "invalid_argument", message: "Only the owner or an editor can do this." }));
  const needOwner = (req, res, next) => (req.user.role === "owner" ? next() : res.status(403).json({ code: "invalid_argument", message: "Only the owner can manage team accounts." }));

  // same-origin check for state-changing requests (CSRF protection)
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ code: "invalid_argument", message: "Request blocked." });
    next();
  });

  // Separate live-read traffic from the 100 mutations/minute budget per IP.
  const apiRateLimits = new Map();
  app.use("/api", (req, res, next) => {
    const read = ["GET", "HEAD"].includes(req.method);
    const key = req.ip + (read ? ":read" : ":write");
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = read ? 600 : 100;

    if (!apiRateLimits.has(key)) {
      apiRateLimits.set(key, []);
    }

    const requests = apiRateLimits.get(key).filter(time => time > now - windowMs);
    requests.push(now);
    apiRateLimits.set(key, requests);

    // Cleanup old entries periodically
    if (Math.random() < 0.01) {
      for (const [k, times] of apiRateLimits.entries()) {
        const recent = times.filter(t => t > now - windowMs);
        if (recent.length === 0) apiRateLimits.delete(k);
        else apiRateLimits.set(k, recent);
      }
    }

    if (requests.length > maxRequests) {
      return res.status(429).json({ code: "too_many_requests", message: "Too many requests. Please slow down." });
    }
    next();
  });

  app.use("/api/imports", express.json({ limit: "20mb" }));
  app.use("/api", express.json({ limit: "1mb" }));

  // login rate limiting
  const attempts = new Map();
  const limited = (key) => { const a = attempts.get(key); return a && a.n >= 10 && a.until > Date.now(); };
  const fail = (key) => { const a = attempts.get(key); const n = a && a.until > Date.now() ? a.n + 1 : 1; attempts.set(key, { n, until: Date.now() + 15 * 60e3 }); };

  const validUsername = (u) => typeof u === "string" && /^[a-z0-9._-]{3,40}$/i.test(u);
  const validPassword = (p) => {
    if (typeof p !== "string" || p.length < 12 || p.length > 200) return false;
    // Require mixed case, numbers, and special characters
    const hasLower = /[a-z]/.test(p);
    const hasUpper = /[A-Z]/.test(p);
    const hasNumber = /[0-9]/.test(p);
    const hasSpecial = /[^A-Za-z0-9]/.test(p);
    return hasLower && hasUpper && hasNumber && hasSpecial;
  };

  app.get("/api/setup", (req, res) => res.json({ needsSetup: q.userCount.get().n === 0 }));
  app.post("/api/setup", (req, res) => {
    if (q.userCount.get().n > 0) return res.status(409).json({ message: "The owner account already exists. Sign in instead." });
    const { name, username, password } = req.body || {};
    if (!name || !validUsername(username)) return res.status(400).json({ message: "Enter your name and a username of 3–40 letters or numbers." });
    if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 12 characters with uppercase, lowercase, numbers, and special characters." });
    const id = "u_" + newId();
    q.insertUser.run(id, username.trim(), String(name).trim().slice(0, 80), "owner", bcrypt.hashSync(password, 10), Date.now(), null);
    audit({ id }, "setup", null, null, { username });
    startSession(res, id);
    res.json({ ok: true });
  });
  app.post("/api/login", (req, res) => {
    const key = req.ip;
    if (limited(key)) return res.status(429).json({ message: "Too many sign-in attempts. Wait 15 minutes and try again." });
    const { username, password } = req.body || {};
    const u = typeof username === "string" ? q.userByName.get(username.trim()) : null;

    // Check account lockout (5 failed attempts locks for 30 minutes)
    if (u && u.locked_until && u.locked_until > Date.now()) {
      const mins = Math.ceil((u.locked_until - Date.now()) / 60000);
      return res.status(423).json({ message: `Account locked due to too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    if (!u || !u.active || !bcrypt.compareSync(String(password || ""), u.password_hash)) {
      fail(key);
      metrics.auth.failures++;
      // Increment failed attempts and lock if >= 5
      if (u && u.active) {
        const newAttempts = (u.failed_attempts || 0) + 1;
        const lockUntil = newAttempts >= 5 ? Date.now() + 30 * 60e3 : null;
        db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(newAttempts, lockUntil, u.id);
        if (lockUntil) {
          metrics.auth.lockouts++;
          return res.status(423).json({ message: "Account locked due to too many failed attempts. Try again in 30 minutes." });
        }
      }
      return res.status(401).json({ message: "Wrong username or password." });
    }

    // Successful login - reset failed attempts and clear lockout
    metrics.auth.logins++;
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(u.id);
    attempts.delete(key);
    q.purgeSessions.run(Date.now());
    startSession(res, u.id);
    audit(u, "login");
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    if (req.sessionToken) q.delSession.run(req.sessionToken);
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/me", needUser, (req, res) => res.json(req.user));
  app.post("/api/me/password", needUser, (req, res) => {
    const { current, next } = req.body || {};
    const u = q.userById.get(req.user.id);
    if (!bcrypt.compareSync(String(current || ""), u.password_hash)) return res.status(400).json({ message: "Your current password is wrong." });
    if (!validPassword(next)) return res.status(400).json({ message: "Password must be at least 12 characters with uppercase, lowercase, numbers, and special characters." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(next, 10), u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(u.id, req.sessionToken);
    audit(req.user, "password_change");
    res.json({ ok: true });
  });

  /* team accounts */
  app.get("/api/users", needUser, (req, res) => {
    if (req.user.role === "dealer") return res.json([]);
    const rows = q.users.all();
    res.json(rows.map((u) => (isAdmin(req.user) ? { ...u, dealerId: u.dealer_id, active: !!u.active } : { id: u.id, name: u.name, role: u.role, active: !!u.active })));
  });
  app.post("/api/users", needUser, needOwner, (req, res) => {
    const { name, username, password, role, dealerId } = req.body || {};
    if (!name || !validUsername(username)) return res.status(400).json({ message: "Enter a name and a username of 3–40 letters or numbers." });
    if (!STAFF_ROLES.includes(role)) return res.status(400).json({ message: "Choose a role." });
    if (role === "dealer" && !(dealerId && getDoc("dealers", dealerId))) return res.status(400).json({ message: "Choose which dealer this portal account is for." });
    if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 12 characters with uppercase, lowercase, numbers, and special characters." });
    if (q.userByName.get(username.trim())) return res.status(409).json({ message: "That username is already taken." });
    const id = "u_" + newId();
    q.insertUser.run(id, username.trim(), String(name).trim().slice(0, 80), role, bcrypt.hashSync(password, 10), Date.now(), role === "dealer" ? dealerId : null);
    audit(req.user, "user_create", "users", id, { username, role, dealerId: role === "dealer" ? dealerId : undefined });
    res.json({ id });
  });
  app.patch("/api/users/:id", needUser, needOwner, (req, res) => {
    const u = q.userById.get(req.params.id);
    if (!u) return res.status(404).json({ message: "Account not found." });
    const { name, role, active, password } = req.body || {};
    if (u.id === req.user.id && (role && role !== "owner" || active === false)) return res.status(400).json({ message: "You can't remove your own owner access." });
    if (role !== undefined && ![...STAFF_ROLES, "owner"].includes(role)) return res.status(400).json({ message: "Unknown role." });
    const dealerId = req.body.dealerId;
    if ((role || u.role) === "dealer" && !((dealerId || u.dealer_id) && getDoc("dealers", dealerId || u.dealer_id))) return res.status(400).json({ message: "Choose which dealer this portal account is for." });
    if (role && role !== "dealer") db.prepare("UPDATE users SET dealer_id = NULL WHERE id = ?").run(u.id);
    else if (dealerId) db.prepare("UPDATE users SET dealer_id = ? WHERE id = ?").run(dealerId, u.id);
    if (password !== undefined && !validPassword(password)) return res.status(400).json({ message: "Use a password with at least 8 characters." });
    db.prepare("UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash) WHERE id = ?")
      .run(name ? String(name).trim().slice(0, 80) : null, role || null, active === undefined ? null : active ? 1 : 0, password ? bcrypt.hashSync(password, 10) : null, u.id);
    if (active === false || password) q.delUserSessions.run(u.id);
    audit(req.user, "user_update", "users", u.id, { name, role, active, password: password ? "changed" : undefined });
    res.json({ ok: true });
  });

  const workflows = createWorkflows({ db, q, getDoc, listDocs, audit, applyRules, deepMerge, HttpError, isAdmin, canWrite, nextNo, broadcast, backupNow });
  workflows.register(app, needUser, needAdmin, needOwner);

  /* documents */
  const checkCol = (req, res, next) => {
    if (!COLLECTIONS.has(req.params.col)) return res.status(404).json({ code: "invalid_argument", message: "Unknown collection." });
    if (req.params.id !== undefined && !ID_RE.test(req.params.id)) return res.status(400).json({ code: "invalid_argument", message: "Invalid record ID." });
    next();
  };
  // Dealer portal accounts only ever receive their own records.
  function scopeForDealer(user, col, docs) {
    const own = user.dealerId;
    if (col === "dealers") return docs.filter((d) => d.id === own).map((d) => ({ ...d, data: { name: d.data.name, phone: d.data.phone, area: d.data.area, creditLimit: d.data.creditLimit, terms: d.data.terms, discountPct: d.data.discountPct } }));
    if (col === "txns") return docs.filter((d) => d.data.dealerId === own).map((d) => { const { createdBy, updated, override, voidedBy, ...rest } = d.data; return { ...d, data: rest }; });
    if (col === "products") return docs.filter((d) => d.data.active !== false).map((d) => ({ ...d, data: { name: d.data.name, code: d.data.code, category: d.data.category, srp: d.data.srp, imageId: d.data.imageId, promo: d.data.promo || null, discountPct: d.data.discountPct ?? null, available: (Number(d.data.availableStock) || 0) > 0 } }));
    if (col === "orders") return docs.filter((d) => d.data.dealerId === own).map((d) => ({ ...d, data: { ...d.data, statusHistory: (d.data.statusHistory || []).map(({ status, at }) => ({ status, at })) } }));
    if (col === "settings") return docs.filter((d) => d.id === "store").map((d) => ({ ...d, data: { storeName: d.data.storeName, phone: d.data.phone, address: d.data.address, paymentInfo: d.data.paymentInfo, discountPct: d.data.discountPct, holdDays: d.data.holdDays, footer: d.data.footer, catalogName: d.data.catalogName } }));
    return [];
  }
  app.get("/api/c/:col", needUser, checkCol, (req, res) => {
    let docs = listDocs(req.params.col);
    if (req.params.col === "products") docs = workflows.decorateProducts(docs);
    if (req.params.col === "txns") docs = workflows.decorateTxns(docs);
    if (["reconciliations", "revisions"].includes(req.params.col) && !isAdmin(req.user)) docs = [];
    if (req.params.col === "approvals" && req.user.role !== "owner") docs = docs.filter(r => r.data.requestedBy === req.user.id);
    docs = req.user.role === "dealer" ? scopeForDealer(req.user, req.params.col, docs) : docs;

    // Pagination support
    const limit = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);

    if (limit > 0 || offset > 0) {
      const start = offset > 0 ? offset : 0;
      const end = limit > 0 ? start + limit : docs.length;
      const page = docs.slice(start, end);
      return res.json({
        data: page,
        total: docs.length,
        offset: start,
        limit: limit > 0 ? limit : docs.length - start,
        hasMore: end < docs.length
      });
    }

    res.json(docs);
  });

  function write(req, res, merge) {
    const { col, id } = req.params;
    const body = req.body && req.body.data;
    if (!isObj(body)) return res.status(400).json({ code: "invalid_argument", message: "Missing record data." });
    const options = { merge, version: req.get("If-Match"), restore: req.get("x-restore") === "1" };
    const result = workflows.once(req.user, req.get("Idempotency-Key"), { col, id, body, merge, restore: options.restore }, () => workflows.commit(req.user, col, id, body, options));
    broadcast(col);
    if (["txns", "moves", "orders"].includes(col)) broadcast("products");
    if (col === "txns") { broadcast("orders"); broadcast("approvals"); }
    if (col === "products") broadcast("moves");
    res.json(result);
  }
  app.put("/api/c/:col/:id", needUser, checkCol, (req, res) => write(req, res, false));
  app.patch("/api/c/:col/:id", needUser, checkCol, (req, res) => write(req, res, true));
  app.delete("/api/c/:col/:id", needUser, checkCol, (req, res) => {
    const { col, id } = req.params;
    db.transaction(() => {
      const existing = getDoc(col, id);
      if (!existing) return;
      if (["txns", "moves", "orders", "approvals", "reconciliations", "revisions"].includes(col)) throw new HttpError(403, "invalid_argument", "Financial and order history cannot be deleted. Void or cancel the record instead.");
      if (col === "products" && (listDocs("txns").some(r => (r.data.items || []).some(i => i.productId === id)) || listDocs("moves").some(r => r.data.productId === id) || listDocs("orders").some(r => (r.data.items || []).some(i => i.productId === id)))) throw new HttpError(409, "invalid_argument", "This product has history. Archive it instead.");
      if (col === "dealers" && ["txns", "orders"].some(c => listDocs(c).some(r => r.data.dealerId === id))) throw new HttpError(409, "invalid_argument", "This dealer has history. Archive the dealer instead.");
      applyRules(req.user, col, id, existing, null);
      q.del.run(col, id);
      audit(req.user, "delete", col, id, existing.data);
    })();
    broadcast(col);
    res.json({ ok: true });
  });

  // Stock movements carry their own audit trail and update stock atomically.
  app.post("/api/stock", needUser, (req, res) => res.status(canWrite(req.user) ? 409 : 403).json({ code: "invalid_argument", message: "Record a stock movement instead. Sales and returns already update stock automatically." }));

  app.get("/api/events", needUser, (req, res) => {
    // Limit concurrent SSE connections to prevent memory exhaustion
    if (clients.size >= MAX_SSE_CLIENTS) {
      return res.status(503).json({ code: "too_many_connections", message: "Too many active connections. Try again later." });
    }

    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    clients.add(res);
    metrics.sseConnections++;

    const cleanup = () => clients.delete(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("finish", cleanup);
    res.on("error", cleanup);

    // Set a timeout to close stale connections after 1 hour
    const timeout = setTimeout(() => {
      cleanup();
      res.end();
    }, 60 * 60 * 1000);

    res.on("close", () => clearTimeout(timeout));
  });

  /* photos */
  // Validate file content by magic numbers (file signatures)
  function validateImageContent(buffer) {
    if (!buffer || buffer.length < 12) return null;
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "image/jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "image/png";
    // GIF: 47 49 46 38 (GIF8)
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
    // WebP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
    return null;
  }

  app.post("/api/assets", needUser, express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
    if (!canWrite(req.user)) return res.status(403).json({ code: "not_granted", message: "Your account can only view the ledger." });
    const type = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return res.status(415).json({ code: "unsupported_type", message: "Use a JPG, PNG, WebP or GIF image." });
    if (!req.body || !req.body.length) return res.status(400).json({ code: "invalid_request", message: "The file is empty." });

    // Validate actual file content matches its type (magic number validation)
    const actualType = validateImageContent(req.body);
    if (!actualType || actualType !== type) {
      return res.status(415).json({ code: "unsupported_type", message: "File content doesn't match the declared image type." });
    }

    const id = newId();
    fs.writeFileSync(path.join(uploads, id), req.body);
    db.prepare("INSERT INTO assets (id, content_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, type, req.body.length, req.user.id, Date.now());
    audit(req.user, "upload", "assets", id, { size: req.body.length });
    metrics.uploads++;
    res.json({ id, url: "/_blob/" + id, sizeBytes: req.body.length, contentType: type });
  });
  app.delete("/api/assets/:id", needUser, (req, res) => {
    const a = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!a) return res.json({ ok: true });
    if (!isAdmin(req.user) && a.created_by !== req.user.id) return res.status(403).json({ code: "not_uploader", message: "You can only remove photos you added." });
    db.prepare("DELETE FROM assets WHERE id = ?").run(a.id);
    fs.rmSync(path.join(uploads, a.id), { force: true });
    audit(req.user, "delete", "assets", a.id);
    res.json({ ok: true });
  });
  app.get("/_blob/:id", needUser, (req, res) => {
    const a = ID_RE.test(req.params.id) && db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!a) return res.status(404).end();
    res.set({ "Content-Type": a.content_type, "Cache-Control": "private, max-age=31536000, immutable" });
    res.sendFile(path.join(uploads, a.id));
  });

  /* admin tools */
  app.get("/api/audit", needUser, needAdmin, (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(db.prepare(`SELECT a.seq, a.at, a.action, a.collection, a.doc_id, a.detail, u.name AS user_name
      FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.seq DESC LIMIT ?`).all(limit));
  });

  /* pages */
  const pub = path.join(__dirname, "..", "public");
  app.get("/healthz", (req, res) => {
    const startTime = Date.now();
    const checks = { database: false, diskSpace: false };
    const errors = [];

    try {
      // Check database connectivity
      const dbStart = Date.now();
      db.prepare("SELECT 1").get();
      checks.database = true;
      checks.databaseMs = Date.now() - dbStart;

      // Check disk space
      try {
        const stats = fs.statfsSync ? fs.statfsSync(dataDir) : null;
        if (stats) {
          const freeBytes = stats.bavail * stats.bsize;
          const totalBytes = stats.blocks * stats.bsize;
          const freePercentage = (freeBytes / totalBytes) * 100;
          checks.diskSpace = true;
          checks.diskFreeGB = (freeBytes / (1024 ** 3)).toFixed(2);
          checks.diskFreePercent = freePercentage.toFixed(1);

          if (freePercentage < 10) {
            errors.push("Low disk space: " + freePercentage.toFixed(1) + "% free");
          }
        }
      } catch (e) {
        // statfsSync not available on all platforms (Windows), skip disk check
        checks.diskSpace = "unavailable";
      }
    } catch (e) {
      errors.push("Database check failed: " + e.message);
    }

    const status = {
      ok: checks.database && errors.length === 0,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks,
      activeSSEClients: clients.size,
      memoryUsageMB: (process.memoryUsage().heapUsed / (1024 ** 2)).toFixed(2),
      responseTimeMs: Date.now() - startTime
    };

    if (errors.length > 0) {
      status.errors = errors;
    }

    res.status(status.ok ? 200 : 503).json(status);
  });

  app.get("/metrics", needUser, needAdmin, (req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();

    const text = [
      `# Dealer Credit Ledger Metrics`,
      `# TYPE http_requests_total counter`,
      `http_requests_total ${metrics.requests.total}`,
      ...Object.entries(metrics.requests.byMethod).map(([method, count]) =>
        `http_requests_by_method{method="${method}"} ${count}`
      ),
      ...Object.entries(metrics.requests.byStatus).map(([status, count]) =>
        `http_requests_by_status{status="${status}"} ${count}`
      ),
      `# TYPE http_errors_total counter`,
      `http_errors_total ${metrics.errors}`,
      `# TYPE auth_logins_total counter`,
      `auth_logins_total ${metrics.auth.logins}`,
      `# TYPE auth_failures_total counter`,
      `auth_failures_total ${metrics.auth.failures}`,
      `# TYPE auth_lockouts_total counter`,
      `auth_lockouts_total ${metrics.auth.lockouts}`,
      `# TYPE uploads_total counter`,
      `uploads_total ${metrics.uploads}`,
      `# TYPE sse_connections_total counter`,
      `sse_connections_total ${metrics.sseConnections}`,
      `# TYPE sse_clients_active gauge`,
      `sse_clients_active ${clients.size}`,
      `# TYPE process_uptime_seconds gauge`,
      `process_uptime_seconds ${uptime.toFixed(2)}`,
      `# TYPE process_memory_heap_used_bytes gauge`,
      `process_memory_heap_used_bytes ${mem.heapUsed}`,
      `# TYPE process_memory_heap_total_bytes gauge`,
      `process_memory_heap_total_bytes ${mem.heapTotal}`,
      ``
    ].join('\n');

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(text);
  });

  app.get("/login", (req, res) => res.sendFile(path.join(pub, "login.html")));
  app.get("/", (req, res) => {
    if (!req.user) return res.redirect("/login");
    res.sendFile(path.join(pub, req.user.role === "dealer" ? "portal.html" : "index.html"), { headers: { "Cache-Control": "no-cache" } });
  });
  // Serve page scripts from this origin so they comply with script-src self.
  for (const script of ["shim.js", "index.js", "login.js", "portal.js"]) {
    app.get("/" + script, (req, res) => res.sendFile(path.join(pub, script), { headers: { "Cache-Control": "no-cache" } }));
  }

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ code: "too_large", message: "That file is too large." });
    logger.error(err);
    res.status(500).json({ code: "internal", message: "Something went wrong on the server." });
  });

  /* automatic daily backups */
  async function backupNow(label) {
    const dir = path.join(dataDir, "backups");
    const file = path.join(dir, label ? `${label}-${today()}-${crypto.randomUUID()}.db` : `ledger-${today()}.db`);
    await db.backup(file);
    const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 30);
    const files = fs.readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  }

  function close() { clearInterval(heartbeat); for (const r of clients) r.end(); db.close(); }
  return { app, db, close, backupNow, dataDir, workflows };
}

module.exports = { createApp };
