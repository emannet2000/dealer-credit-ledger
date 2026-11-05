"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const express = require("express");
const bcrypt = require("bcryptjs");
const { exec } = require("child_process");
const { openDb } = require("./db");
const Database = require("better-sqlite3");
const { today, dayOf, dealerStatus, settle, r2, splitName, dealerKeys, productKeys, validDay } = require("./credit");
const { fetchImage } = require("./fetch-image");
const { createOps } = require("./ops");
const { createPush } = require("./push");
const { createFinance, issueCost, stockMoved } = require("./finance");
const totp = require("./totp");
const QRCode = require("qrcode");

const STOCK_REASONS = new Set(["Received stock", "Damaged / lost", "Stock count"]);
const COLLECTIONS = new Set(["dealers", "products", "txns", "moves", "settings", "orders", "interactions", "approvals", "cashcloses", "remittances", "reminders", "proofs", "suppliers", "purchases", "expenses", "locations", "signoffs", "disputes", "creditapps"]);
const OPS_COLLECTIONS = new Set(["cashcloses", "remittances", "reminders", "proofs", "suppliers", "purchases", "expenses", "locations", "signoffs"]);
// Dealer CRM: prospects move lead → contacted → interested → dealer (or lost).
const STAGES = ["lead", "contacted", "interested", "dealer", "lost"];
const PROSPECT_STAGES = new Set(["lead", "contacted", "interested"]);
const CONTACT_KINDS = ["call", "visit", "message", "meeting", "note"];
const CONSENT_METHODS = ["signed form", "verbal", "portal"];
const GENDERS = ["male", "female"];
// Personal fields hidden from viewer accounts and removed when a dealer is anonymised (FR-078).
const PERSONAL_FIELDS = ["firstName", "middleName", "lastName", "age", "gender", "phone", "email", "messenger", "birthday", "address", "area", "notes", "tags", "referredBy", "source", "photoId"];
const ORDER_STATUS = ["new", "preparing", "ready", "released", "cancelled"];
const OPEN_ORDER_STATUS = ["new", "preparing", "ready"];
const ID_RE = /^[A-Za-z0-9_\-.:~]{1,80}$/;
const PREFIX = { sale: "DR", payment: "OR", return: "RT", adjustment: "ADJ", writeoff: "WO" };
const SESSION_DAYS = 30;
// PR-10: staff and viewer sessions (collectors' phones) are shorter than owners' and editors',
// which are protected by two-step sign-in instead.
const sessionDays = (role) => (["staff", "viewer"].includes(role) ? Math.max(1, Number(process.env.STAFF_SESSION_DAYS) || 7) : SESSION_DAYS);
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
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}
function createApp({ dataDir, logger = console, pushSender } = {}) {
  dataDir = path.resolve(dataDir || process.env.DATA_DIR || "./data");
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, "uploads");
  const cookieSecure = String(process.env.COOKIE_SECURE || "false") === "true";
  const push = createPush({ db, dataDir, logger, sender: pushSender });
  const notify = (roles, title, body, url) => { push.notify(roles, title, body, url); };

  /* ---------- data access ---------- */
  const q = {
    list: db.prepare("SELECT id, data, version FROM docs WHERE collection = ?"),
    byDealer: db.prepare("SELECT id, data, version FROM docs WHERE collection = ? AND json_extract(data, '$.dealerId') = ?"),
    bySale: db.prepare("SELECT id, data, version FROM docs WHERE collection = 'txns' AND json_extract(data, '$.saleId') = ?"),
    noTaken: db.prepare("SELECT 1 FROM docs WHERE collection = 'txns' AND json_extract(data, '$.no') = ? AND id <> ? LIMIT 1"),
    lastNo: db.prepare("SELECT json_extract(data, '$.no') AS no FROM docs WHERE collection = 'txns' AND json_extract(data, '$.no') >= ? AND json_extract(data, '$.no') < ? ORDER BY length(json_extract(data, '$.no')) DESC, json_extract(data, '$.no') DESC LIMIT 1"),
    get: db.prepare("SELECT id, data, version FROM docs WHERE collection = ? AND id = ?"),
    upsert: db.prepare(`INSERT INTO docs (collection, id, data, version, updated_at) VALUES (@c, @id, @data, 1, @now)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at`),
    del: db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?"),
    audit: db.prepare("INSERT INTO audit (at, user_id, action, collection, doc_id, detail) VALUES (?, ?, ?, ?, ?, ?)"),
    userCount: db.prepare("SELECT COUNT(*) n FROM users"),
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    users: db.prepare("SELECT id, username, name, role, active, created_at, dealer_id, collector, totp_secret IS NOT NULL AS two_step FROM users ORDER BY created_at"),
    insertUser: db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"),
    session: db.prepare(`SELECT s.token, s.expires_at, s.created_at, u.id, u.username, u.name, u.role, u.active, u.dealer_id, u.collector
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
  const controls = () => ({ voidOver: 1000, discountOverPct: 10, ...(settings().controls || {}) });

  // Receipt numbers per type (DR-00001, OR-00001…), using the receipt-number index.
  function nextNo(type) {
    const pre = PREFIX[type];
    const row = q.lastNo.get(pre + "-", pre + ".");
    const max = row ? parseInt(String(row.no).slice(pre.length + 1), 10) || 0 : 0;
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
  // The price list: a product's price and dealer discount for a dealer on a date.
  const dealerPctOf = (dealer) => (dealer && dealer.discountPct != null && dealer.discountPct !== "" ? Number(dealer.discountPct) : Number(settings().discountPct ?? 25));
  function listLine(p, pct, date) {
    const pr = p.promo;
    const promo = !!(pr && Number(pr.price) > 0 && (!pr.from || date >= pr.from) && (!pr.to || date <= pr.to));
    const price = promo ? r2(pr.price) : pct > 0 ? r2(p.srp || p.dealerPrice) : r2(p.dealerPrice || p.srp);
    const linePct = promo && pr.noDiscount ? 0 : p.discountPct != null && p.discountPct !== "" ? Number(p.discountPct) : pct;
    return { price, pct: linePct, promo };
  }
  // PR-04: the server prices credit sales and returns. Each line must match the price
  // list (or the linked sale or online order, or the recorded line when editing);
  // otherwise it is a manual price, allowed for owners and editors or with a reason.
  function priceTxn(next, existing, admin) {
    if (!(next.type === "sale" || next.type === "return") || next.opening) return;
    const items = Array.isArray(next.items) ? next.items : [];
    if (!items.length) {
      if (next.type === "sale" && admin) { next.manualPrice = true; return; }
      throw new HttpError(400, "invalid_argument", "Add at least one product.");
    }
    if (items.length > 200) throw new HttpError(400, "invalid_argument", "That sale has too many lines.");
    const dealer = getDoc("dealers", next.dealerId).data, dpct = dealerPctOf(dealer), date = String(next.date || today());
    const oldLines = existing && Array.isArray(existing.data.items) ? existing.data.items : [];
    const oldPct = existing ? existing.data.discountPct : null;
    const order = next.type === "sale" && next.orderId && ID_RE.test(String(next.orderId)) ? getDoc("orders", String(next.orderId)) : null;
    const sale = next.type === "return" && next.saleId ? getDoc("txns", String(next.saleId)) : null;
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
    let manual = false, listTotal = 0;
    const lines = items.map((it) => {
      const qty = Math.round(Number(it && it.qty)), price = r2(it && it.price);
      const pct = Math.min(100, Math.max(0, Number(it && it.pct != null ? it.pct : next.discountPct) || 0));
      if (!it || !ID_RE.test(String(it.productId)) || !(qty >= 1 && qty <= 99999) || !(Number(it.price) >= 0)) throw new HttpError(400, "invalid_argument", "Check the quantities and prices.");
      const p = getDoc("products", it.productId);
      if (!p) throw new HttpError(400, "invalid_argument", "A product on this record no longer exists.");
      const same = (a, fallbackPct) => a && a.productId === it.productId && near(a.price, price) && near(a.pct != null ? a.pct : fallbackPct || 0, pct);
      const saleLine = sale && (sale.data.items || []).find((x) => x.productId === it.productId);
      const listed = saleLine ? { price: r2(saleLine.price), pct: Number(saleLine.pct != null ? saleLine.pct : sale.data.discountPct || 0) } : listLine(p.data, dpct, date);
      const ok = (near(listed.price, price) && near(listed.pct, pct)) || oldLines.some((a) => same(a, oldPct)) || !!(order && (order.data.items || []).some((a) => same(a, order.data.discountPct)));
      if (!ok) manual = true;
      listTotal += qty * listed.price * (1 - listed.pct / 100);
      const prev = oldLines.find((a) => a.productId === it.productId) || saleLine;
      const cost = prev && prev.cost != null ? r2(prev.cost) : issueCost(p.data, qty, finance.costing());
      return { productId: it.productId, name: String(it.name || p.data.name).slice(0, 160), qty, price, pct, ...(cost != null ? { cost } : {}), ...(it.promo ? { promo: true } : {}), ...(ok ? {} : { manual: true }) };
    });
    const subtotal = r2(lines.reduce((a, i) => a + i.qty * i.price, 0));
    const pctDiscount = r2(lines.reduce((a, i) => a + (i.qty * i.price * i.pct) / 100, 0));
    let extra = next.type === "sale" ? Math.min(r2(subtotal - pctDiscount), Math.max(0, r2(next.discount))) : 0;
    if (extra > 0 && !(existing && near(existing.data.discount || 0, extra))) manual = true;
    const reason = String(next.priceReason || "").trim().slice(0, 300);
    if (manual && !admin && !reason) throw new HttpError(400, "price_reason", "Some prices or discounts differ from the price list. Give a reason, or ask the owner or an editor.");
    // A price well below the list needs the owner, even with a reason.
    const finalAmount = r2(subtotal - pctDiscount - extra), offPct = listTotal > 0 ? ((listTotal - finalAmount) / listTotal) * 100 : 0, limit = controls().discountOverPct;
    if (manual && !admin && next.type === "sale" && limit != null && offPct > limit + 0.004)
      throw new HttpError(409, "needs_approval", `This sale is ${offPct.toFixed(1)}% below the price list, and staff can give up to ${limit}%. Send it to the owner for approval.`);
    const pcts = new Set(lines.map((i) => i.pct));
    Object.assign(next, { items: lines, subtotal, pctDiscount, amount: r2(subtotal - pctDiscount - extra), discountPct: pcts.size === 1 ? lines[0].pct : null });
    if (next.type === "sale") next.discount = extra;
    if (manual) { next.manualPrice = true; if (reason) next.priceReason = reason; } else { delete next.manualPrice; delete next.priceReason; }
  }

  function priceOrder(dealerId, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, "invalid_argument", "Add at least one product to the order.");
    if (rawItems.length > 100) throw new HttpError(400, "invalid_argument", "That order has too many lines.");
    const dealer = getDoc("dealers", dealerId);
    if (!dealer) throw new HttpError(400, "invalid_argument", "Unknown dealer.");
    const pct = dealerPctOf(dealer.data);
    const merged = new Map();
    for (const it of rawItems) {
      const qty = Math.round(Number(it && it.qty));
      if (!it || !ID_RE.test(String(it.productId)) || !(qty >= 1 && qty <= 9999)) throw new HttpError(400, "invalid_argument", "Check the quantities in your order.");
      merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
    }
    const items = [...merged].map(([pid, qty]) => {
      const p = getDoc("products", pid);
      if (!p || p.data.active === false) throw new HttpError(400, "invalid_argument", "A product in your order is no longer available. Remove it and try again.");
      const { price, pct: linePct, promo } = listLine(p.data, pct, today());
      return { productId: pid, name: p.data.name, qty, price, pct: linePct, ...(promo ? { promo: true } : {}) };
    });
    const subtotal = r2(items.reduce((a, i) => a + i.qty * i.price, 0));
    const pctDiscount = r2(items.reduce((a, i) => a + i.qty * i.price * i.pct / 100, 0));
    const pcts = new Set(items.map((i) => i.pct));
    return { items, subtotal, discountPct: pcts.size === 1 ? items[0].pct : null, pctDiscount, amount: r2(subtotal - pctDiscount) };
  }
  function noTaken(no, exceptId) {
    return !!q.noTaken.get(String(no), exceptId || "");
  }

  // Quantity held by online orders that have not been released or cancelled.
  function reservedQty(exceptOrderId) {
    const out = {};
    for (const { id, data: o } of listDocs("orders")) {
      if (id === exceptOrderId || !OPEN_ORDER_STATUS.includes(o.status)) continue;
      for (const i of o.items || []) out[i.productId] = (out[i.productId] || 0) + (Number(i.qty) || 0);
    }
    return out;
  }
  function availableQty(productId, exceptOrderId) {
    const p = getDoc("products", productId);
    if (!p) return 0;
    return (Number(p.data.stock) || 0) - (reservedQty(exceptOrderId)[productId] || 0);
  }
  function orderFlags(dealerId, priced, exceptOrderId) {
    const dealer = getDoc("dealers", dealerId);
    const s = settings();
    const holdDays = Number(s.holdDays ?? 60) || 60;
    const st = dealerStatus(dealerTxnsFor(dealerId));
    const creditHold = st.maxLate > holdDays;
    const overLimit = !!(dealer && dealer.data.creditLimit && s.blockOverLimit !== false && st.balance + priced.amount > dealer.data.creditLimit);
    const shortItems = (priced.items || []).map((i) => {
      const avail = availableQty(i.productId, exceptOrderId);
      return i.qty > avail ? { productId: i.productId, name: i.name, qty: i.qty, available: Math.max(0, avail) } : null;
    }).filter(Boolean);
    return { creditHold, overLimit, backorder: shortItems.length > 0, shortItems };
  }
  // A return linked to a delivery can never give back more than was delivered.
  function validateReturn(next, exceptId) {
    if (!next.saleId) return;
    const sale = getDoc("txns", next.saleId);
    if (!sale || sale.data.type !== "sale" || sale.data.voided) throw new HttpError(400, "invalid_argument", "Choose a valid delivery receipt for this return.");
    if (sale.data.dealerId !== next.dealerId) throw new HttpError(400, "invalid_argument", "That delivery belongs to a different dealer.");
    const sold = new Map();
    for (const i of sale.data.items || []) sold.set(i.productId, (sold.get(i.productId) || 0) + (Number(i.qty) || 0));
    const already = new Map();
    for (const r of q.bySale.all(String(next.saleId))) {
      const id = r.id, t = JSON.parse(r.data);
      if (id === exceptId || t.type !== "return" || t.saleId !== next.saleId || t.voided) continue;
      for (const i of t.items || []) already.set(i.productId, (already.get(i.productId) || 0) + (Number(i.qty) || 0));
    }
    for (const i of next.items || []) {
      const max = (sold.get(i.productId) || 0) - (already.get(i.productId) || 0);
      if ((Number(i.qty) || 0) > max) throw new HttpError(400, "invalid_argument", `Only ${Math.max(0, max)} of ${i.name || "that product"} can still be returned from ${sale.data.no || "that delivery"}.`);
    }
  }

  // FR-088: a dealer or product can never be added twice, including over an archived record.
  // Only new or changed values are checked, so duplicates from before this rule can still be
  // edited and merged by hand. Writes run one at a time, so two people can't slip one past.
  function assertUnique(c, id, existing, next, keysOf) {
    const keys = keysOf(next), old = existing ? keysOf(existing.data) : {};
    const check = Object.entries(keys).filter(([k, v]) => v && v !== old[k]);
    if (!check.length) return;
    for (const other of listDocs(c)) {
      if (other.id === id || other.data.anonymised || other.data.mergedInto) continue;
      const theirs = keysOf(other.data), hit = check.find(([k, v]) => theirs[k] === v);
      if (hit) throw new HttpError(409, "duplicate", `“${other.data.name}”${other.data.active === false ? " (archived)" : ""} already has this ${hit[0]}. Open that record instead of adding it again.`);
    }
  }

  // FR-073: records dated in a closed period can't be added, changed or voided.
  function assertOpenPeriod(date) {
    const closed = settings().closedThrough;
    if (closed && String(date || "") <= closed) throw new HttpError(409, "period_closed", `The books are closed through ${closed}. Post a correction as an adjustment dated after that, or ask the owner or an editor to reopen the period.`);
  }

  // FR-072: check details on a payment. Its status changes only through /api/checks.
  function normaliseCheck(next, existing) {
    if (existing && existing.data.check) { next.check = existing.data.check.status === "pending" && isObj(next.check) ? { ...existing.data.check, bank: next.check.bank, number: next.check.number, date: next.check.date } : existing.data.check; }
    if (next.check == null) { delete next.check; return; }
    if (!isObj(next.check) || next.method !== "Check") throw new HttpError(400, "invalid_argument", "Check details only go on a check payment.");
    const c = next.check, bank = String(c.bank || "").trim().slice(0, 80), number = String(c.number || "").trim().slice(0, 40);
    if (!bank || !number || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || ""))) throw new HttpError(400, "invalid_argument", "Enter the bank, check number and check date.");
    next.check = { ...c, bank, number, status: c.status && existing && existing.data.check ? c.status : "pending" };
  }

  /* ---------- server-side business rules ---------- */
  function orderRules(user, id, existing, next) {
    const now = Date.now();
    if (user.role === "dealer") {
      if (!existing) {
        const priced = priceOrder(user.dealerId, next.items);
        const pickup = typeof next.pickupDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(next.pickupDate) ? next.pickupDate : null;
        if (pickup && pickup < today()) throw new HttpError(400, "invalid_argument", "Choose a pickup date from today onward.");
        notify(["owner", "editor", "staff"], "New online order", "A dealer placed an order in the portal.");
        return { dealerId: user.dealerId, ...priced, ...orderFlags(user.dealerId, priced, id), pickupDate: pickup, note: String(next.note || "").slice(0, 500), status: "new", source: "portal",
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
      return { ...next, ...priced, ...orderFlags(next.dealerId, priced, id), source: next.source || "store", no: nextOrderNo(), createdAt: now, createdBy: user.id, statusHistory: [{ status: next.status, at: now, by: user.id }] };
    }
    const out = { ...next, no: existing.data.no, dealerId: existing.data.dealerId, createdAt: existing.data.createdAt, createdBy: existing.data.createdBy, source: existing.data.source, delivery: existing.data.delivery, deliveryLog: existing.data.deliveryLog };
    if (existing.data.status !== next.status) out.statusHistory = [...(existing.data.statusHistory || []), { status: next.status, at: now, by: user.id }];
    else out.statusHistory = existing.data.statusHistory || [];
    return out;
  }

  const docsForDealer = (c, dealerId) => q.byDealer.all(c, String(dealerId)).map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data) }));
  const dealerTxnsFor = (dealerId, exceptId) => docsForDealer("txns", dealerId).filter((d) => d.id !== exceptId).map((d) => ({ ...d.data, _id: d.id }));
  // FR-085: a payment may name the deliveries it pays; each must be unpaid and not overpaid.
  function validateAlloc(next, id) {
    if (next.alloc == null) return;
    if (next.type !== "payment" || !Array.isArray(next.alloc) || next.alloc.length > 50) throw new HttpError(400, "invalid_argument", "Only payments can be applied to chosen deliveries.");
    const open = new Map(settle(dealerTxnsFor(next.dealerId, id)).open.map((o) => [o.id, o]));
    const seen = new Set(); let sum = 0;
    next.alloc = next.alloc.map((a) => {
      const tid = String((a && a.id) || ""), amt = r2(a && a.amount);
      if (!tid || seen.has(tid) || !(amt > 0)) throw new HttpError(400, "invalid_argument", "Each chosen delivery needs an amount.");
      seen.add(tid);
      const o = open.get(tid);
      if (!o) throw new HttpError(400, "invalid_argument", "A chosen delivery is already paid or doesn't belong to this dealer.");
      if (amt > o.rem + 0.004) throw new HttpError(400, "invalid_argument", `Only ₱${o.rem.toFixed(2)} is unpaid on ${o.t.no || "that delivery"}.`);
      sum = r2(sum + amt);
      return { id: tid, no: o.t.no || "", amount: amt };
    });
    if (sum > r2(next.amount) + 0.004) throw new HttpError(400, "invalid_argument", "The chosen deliveries add up to more than the payment.");
    if (!next.alloc.length) delete next.alloc;
  }
  // Why a staff credit sale would be blocked (credit hold or over the limit).
  function creditBlock(dealerId, amount) {
    const dealer = getDoc("dealers", dealerId).data, s = settings();
    const st = dealerStatus(dealerTxnsFor(dealerId));
    const holdDays = Number(s.holdDays ?? 60) || 60;
    return { name: dealer.name, hold: st.maxLate > holdDays, over: !!(s.blockOverLimit !== false && dealer.creditLimit && st.balance + r2(amount) > dealer.creditLimit),
      balance: st.balance, overdue: st.overdue, maxLate: st.maxLate, creditLimit: dealer.creditLimit ?? null, holdDays };
  }
  const stockEffect = (t) => {
    const m = {}; if (!t || t.voided || t.opening) return m;
    if (t.type === "sale") for (const i of t.items || []) m[i.productId] = (m[i.productId] || 0) - (Math.round(Number(i.qty)) || 0);
    if (t.type === "return" && t.restock) for (const i of t.items || []) m[i.productId] = (m[i.productId] || 0) + (Math.round(Number(i.qty)) || 0);
    return m;
  };
  function stockDiff(oldT, newT) {
    const a = stockEffect(oldT), b = stockEffect(newT), out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[k] || 0) - (a[k] || 0); if (d) out[k] = d; }
    return out;
  }
  // Other collections changed as a side effect of a write: collection → Set of IDs (null = many).
  const touched = new Map();
  const touch = (c, ids) => { if (!ids) return touched.set(c, null); if (touched.get(c) === null) return; const set = touched.get(c) || new Set(); ids.forEach((i) => set.add(i)); touched.set(c, set); };
  function applyRules(user, c, id, existing, next, { restore } = {}) {
    if (c === "orders" && next !== null && !restore) return orderRules(user, id, existing, next);
    if (!canWrite(user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    if (restore) {
      if (!isAdmin(user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can restore a backup.");
      // Restoring one record can't get around closed books.
      if (c === "txns") { assertOpenPeriod(next.date); if (existing) assertOpenPeriod(existing.data.date); }
      if (c === "settings") { next.closedThrough = (existing && existing.data.closedThrough) || null; next.periodLog = (existing && existing.data.periodLog) || []; }
      return next;
    }
    const admin = isAdmin(user);
    const now = Date.now();
    // The stock trail is written by the server alongside each change. Only example records can be touched.
    if (c === "moves" && !(admin && (existing ? existing.data.sample : next && next.sample))) throw new HttpError(403, "invalid_argument", "Stock history is recorded automatically and can't be changed.");
    if (c === "approvals") throw new HttpError(403, "invalid_argument", "Use Approve, Reject or Withdraw on the request.");
    if (OPS_COLLECTIONS.has(c)) return ops.rules(user, c, id, existing, next);
    if (c === "disputes" || c === "creditapps") return finance.rules(user, c);
    if (c === "settings") {
      if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can change store settings.");
      if (id !== "store") throw new HttpError(400, "invalid_argument", "Unknown settings record.");
      next.allowNegativeStock = next.allowNegativeStock === true;
      finance.cleanSettings(next, existing);
      // The books are closed and reopened only through /api/periods, so that is always logged.
      next.closedThrough = (existing && existing.data.closedThrough) || null;
      next.periodLog = (existing && existing.data.periodLog) || [];
      // Monthly targets for the dashboard: { "YYYY-MM": { sales, collections } } (FR-082).
      if (next.targets != null) {
        if (!isObj(next.targets)) throw new HttpError(400, "invalid_argument", "Targets must be per month.");
        const t = {};
        for (const [ym, v] of Object.entries(next.targets)) {
          if (!/^\d{4}-\d{2}$/.test(ym) || !isObj(v)) continue;
          const sales = Number(v.sales) > 0 ? r2(v.sales) : null, collections = Number(v.collections) > 0 ? r2(v.collections) : null;
          if (sales || collections) t[ym] = { sales, collections };
        }
        next.targets = t;
      }
      // What needs the owner's approval when staff do it.
      if (next.controls != null) {
        const n = (v) => (v === "" || v == null || !(Number(v) >= 0) ? null : r2(v));
        next.controls = { voidOver: n(next.controls.voidOver), discountOverPct: n(next.controls.discountOverPct) };
      }
      // FR-071: reminder schedule, in days after the due date (negative = before).
      if (next.reminders != null) {
        const days = (Array.isArray(next.reminders.days) ? next.reminders.days : []).map(Number).filter((n) => Number.isInteger(n) && n >= -30 && n <= 120);
        next.reminders = { enabled: next.reminders.enabled === true, days: [...new Set(days)].sort((a, b) => a - b).slice(0, 8) };
      }
      // FR-078: each change to the privacy notice gets a new version, so consent can name it.
      const prevNotice = existing ? existing.data.privacyNotice || "" : "";
      if (String(next.privacyNotice || "") !== prevNotice) {
        const base = today(), prev = existing && existing.data.privacyVersion;
        next.privacyVersion = prev && String(prev).startsWith(base) ? `${base}.${(Number(String(prev).split(".")[1]) || 1) + 1}` : base;
      } else next.privacyVersion = existing ? existing.data.privacyVersion || null : null;
      return next;
    }
    if (next === null) { // delete
      if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can delete records. Staff can void or archive instead.");
      // Ledger entries are voided, never erased, so past balances and receipt numbers stay
      // accountable. Sample records from the guided start are the one exception.
      if (c === "txns" && !existing.data.sample) throw new HttpError(409, "use_void", "Ledger records can't be deleted. Void this record instead, so the history stays complete.");
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
      // Keep the structured name (first/middle/last) and the display name in step.
      // Older records and clients that only send a full name are split automatically.
      const has = (k) => Object.prototype.hasOwnProperty.call(next, k);
      const cleanText = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
      const prev = existing ? existing.data : null;
      const storedParts = { firstName: String(prev?.firstName ?? "").trim(), middleName: String(prev?.middleName ?? "").trim(), lastName: String(prev?.lastName ?? "").trim() };
      // Records saved before name parts existed fall back to their display name.
      const prevParts = storedParts.firstName || storedParts.middleName || storedParts.lastName ? storedParts : splitName(prev?.name);
      const hasParts = has("firstName") || has("middleName") || has("lastName");
      const nameChanged = has("name") && String(next.name ?? "").trim() !== String(prev?.name ?? "").trim();
      if (!hasParts) {
        // A full name on its own (older app, import or API): split it into parts.
        const p = splitName(next.name);
        next.firstName = p.firstName; next.middleName = p.middleName; next.lastName = p.lastName;
      } else {
        // A partial update only replaces the parts it names, so a surname isn't dropped.
        const parts = {
          firstName: cleanText(has("firstName") ? next.firstName : prevParts.firstName, 60),
          middleName: cleanText(has("middleName") ? next.middleName : prevParts.middleName, 60),
          lastName: cleanText(has("lastName") ? next.lastName : prevParts.lastName, 60),
        };
        next.firstName = parts.firstName; next.middleName = parts.middleName; next.lastName = parts.lastName;
        const partsChanged = parts.firstName !== prevParts.firstName || parts.middleName !== prevParts.middleName || parts.lastName !== prevParts.lastName;
        if (partsChanged) next.name = [parts.firstName, parts.middleName, parts.lastName].filter(Boolean).join(" ");
        else if (nameChanged) {
          const p = splitName(next.name);
          next.firstName = p.firstName; next.middleName = p.middleName; next.lastName = p.lastName;
        }
      }
      // Normalise the display name and refuse a blank one (the API could send "   ").
      next.name = String(next.name ?? "").trim().replace(/\s+/g, " ");
      if (!next.name) next.name = [next.firstName, next.middleName, next.lastName].filter(Boolean).join(" ");
      if (!next.name) throw new HttpError(400, "invalid_argument", "A dealer needs a name.");
      delete next.age; // Worked out from the birthday when shown, so it can't go out of date.
      if (has("gender")) {
        if (next.gender == null || next.gender === "") next.gender = null;
        else {
          const g = String(next.gender).trim().toLowerCase();
          // An older value such as "other" is cleared on the next save, so it can't block an edit.
          if (!GENDERS.includes(g) && g !== String(prev?.gender ?? "").trim().toLowerCase()) throw new HttpError(400, "invalid_argument", "Choose male or female, or leave it blank.");
          next.gender = GENDERS.includes(g) ? g : null;
        }
      } else next.gender = prev ? prev.gender ?? null : null;
      if (!next.anonymised) assertUnique("dealers", id, existing, next, dealerKeys);
      if (next.stage == null || next.stage === "") next.stage = existing ? existing.data.stage || "dealer" : "dealer";
      if (!STAGES.includes(next.stage)) throw new HttpError(400, "invalid_argument", "Unknown dealer stage.");
      if (next.photoId != null && next.photoId !== "" && !(ID_RE.test(String(next.photoId)) && db.prepare("SELECT 1 FROM assets WHERE id = ?").get(String(next.photoId))))
        throw new HttpError(400, "invalid_argument", "That photo wasn't uploaded. Try again.");
      if (!next.photoId) next.photoId = null;
      if (next.tags != null) {
        if (!Array.isArray(next.tags)) throw new HttpError(400, "invalid_argument", "Tags must be a list.");
        next.tags = [...new Set(next.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
      }
      if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(next.email))) throw new HttpError(400, "invalid_argument", "That email address doesn't look right.");
      // FR-078: consent to personal data processing.
      const prevConsent = existing ? existing.data.consent || null : null;
      if (next.consent != null) {
        if (!isObj(next.consent) || !CONSENT_METHODS.includes(next.consent.method)) throw new HttpError(400, "invalid_argument", "Choose how the dealer gave consent.");
        // An unchanged consent record is kept as it was; a new one (no "at") is stamped now.
        const same = prevConsent && prevConsent.method === next.consent.method && prevConsent.at === next.consent.at;
        next.consent = same ? prevConsent : { method: next.consent.method, noticeVersion: settings().privacyVersion || null, at: now, by: user.id, ...(next.consent.method === "portal" ? {} : { note: String(next.consent.note || "").slice(0, 200) }) };
        if (next.consent.method === "portal" && !same) throw new HttpError(400, "invalid_argument", "Portal consent is given by the dealer in the portal.");
      } else if (prevConsent && !admin) next.consent = prevConsent;
      const prevStage = existing ? existing.data.stage || "dealer" : null;
      if (prevStage !== next.stage) next.stageHistory = [...((existing && existing.data.stageHistory) || []), { at: now, by: user.id, from: prevStage, to: next.stage }].slice(-50);
      else next.stageHistory = (existing && existing.data.stageHistory) || next.stageHistory || [];
    }
    if (c === "interactions") {
      if (!next.dealerId || !getDoc("dealers", next.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
      if (!CONTACT_KINDS.includes(next.kind)) throw new HttpError(400, "invalid_argument", "Choose call, visit, message, meeting or note.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(next.date || ""))) throw new HttpError(400, "invalid_argument", "Give the date of the contact.");
      if (next.followUp != null && next.followUp !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(next.followUp))) throw new HttpError(400, "invalid_argument", "The follow-up date is not valid.");
      if (!next.followUp) next.followUp = null;
      next.followUpDone = !!next.followUp && next.followUpDone === true;
      next.note = String(next.note || "").slice(0, 2000);
      next.outcome = String(next.outcome || "").slice(0, 200);
      if (existing && !admin && existing.data.createdBy !== user.id) {
        // Staff may tick off anyone's follow-up, but only edit their own notes.
        const { followUpDone, followUpDoneAt, followUpDoneBy } = next;
        next = { ...existing.data, followUpDone: followUpDone === true, followUpDoneAt, followUpDoneBy };
      }
    }
    if (c === "products") {
      if (existing) { next.stock = existing.data.stock; next.stockAt = existing.data.stockAt; next.layers = existing.data.layers; next.batches = existing.data.batches; } // stock changes only through /api/stock
      if (!admin && existing) { for (const k of ["dealerPrice", "srp", "promo", "discountPct", "priceHistory", "cost", "taxClass", "batchTracked"]) next[k] = existing.data[k] ?? null; }
      if (!admin && !existing) { next.promo = null; next.discountPct = null; next.cost = null; }
      if (!next.name || typeof next.name !== "string") throw new HttpError(400, "invalid_argument", "A product needs a name.");
      assertUnique("products", id, existing, next, productKeys);
      next.dealerPrice = r2(next.dealerPrice);
      next.taxClass = ["exempt", "zero"].includes(next.taxClass) ? next.taxClass : "vat";
      next.batchTracked = next.batchTracked === true;
      next.cost = next.cost == null || next.cost === "" ? null : r2(next.cost);
    }
    if (c === "txns") {
      if (!PREFIX[next.type]) throw new HttpError(400, "invalid_argument", "Unknown transaction type.");
      assertOpenPeriod(next.date);
      if (existing) assertOpenPeriod(existing.data.date);
      if (next.type === "payment") { ops.assertDayOpen(next.date); if (existing) ops.assertDayOpen(existing.data.date); }
      if (next.type === "payment") {
        if (existing) { if (existing.data.collectorId) next.collectorId = existing.data.collectorId; else delete next.collectorId; }
        else if (user.collector) next.collectorId = user.id; // FR-077
        else delete next.collectorId;
        normaliseCheck(next, existing);
      }
      if (next.dealerId && getDoc("dealers", next.dealerId) && !(existing && next.voided && !existing.data.voided)) priceTxn(next, existing, admin);
      if (!(Number(next.amount) > 0)) throw new HttpError(400, "invalid_argument", "The amount must be more than zero.");
      if (!next.dealerId || !getDoc("dealers", next.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
      next.amount = r2(next.amount);
      if (next.type === "writeoff" || next.type === "adjustment") {
        if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can add adjustments or write-offs.");
      }
      if (!validDay(next.date)) throw new HttpError(400, "invalid_argument", "Enter a valid date.");
      if (next.dueDate != null && next.dueDate !== "" && !validDay(next.dueDate)) throw new HttpError(400, "invalid_argument", "Enter a valid due date.");
      if (next.type === "adjustment" && !["debit", "credit"].includes(next.direction))
        throw new HttpError(400, "invalid_argument", "Choose whether the adjustment increases or decreases the balance.");
      if (next.type === "writeoff" && !String(next.reason || "").trim())
        throw new HttpError(400, "invalid_argument", "Give a reason for the write-off.");
      if (next.type === "return") validateReturn(next, id);
      if (!next.voided) validateAlloc(next, id);
      if (next.offline != null) {
        // FR-086: payments recorded on a phone without signal and synced later.
        if (!["payment", "sale", "return"].includes(next.type) || existing || !isObj(next.offline) || !ID_RE.test(String(next.offline.key || "")))
          throw new HttpError(400, "invalid_argument", "Only new payments, sales and returns can be recorded offline.");
        const recordedAt = Number(next.offline.recordedAt);
        next.offline = { key: String(next.offline.key), recordedAt: recordedAt > 0 && recordedAt <= now + 5 * 60e3 ? recordedAt : now, syncedAt: now, confirmed: next.offline.confirmed === true && admin };
        const dl = getDoc("dealers", next.dealerId).data;
        if (dl.active === false && !next.offline.confirmed)
          throw new HttpError(409, "needs_review", `${dl.name} was archived after this payment was recorded offline. An owner or editor must confirm it.`);
      }
      finance.protectTxn(next, existing, user);
      if (existing) {
        if (!admin && !(existing.data.createdBy === user.id && existing.data.createdAt && dayOf(existing.data.createdAt) === today()))
          throw new HttpError(403, "invalid_argument", "Staff can only edit or void what they recorded today. Ask the owner or an editor.");
        next.no = existing.data.no;
        if (!admin) next.override = existing.data.override;
        const voidLimit = controls().voidOver;
        if (!admin && next.voided && !existing.data.voided && voidLimit != null && existing.data.amount >= voidLimit)
          throw new HttpError(409, "needs_approval", `Voids of ₱${voidLimit} or more need the owner's approval.`);
      } else {
        if (!next.no || noTaken(next.no, id)) next.no = nextNo(next.type);
        if (next.type === "sale" && !next.voided) {
          const dl = getDoc("dealers", next.dealerId);
          if (PROSPECT_STAGES.has(dl.data.stage)) {
            const promoted = { ...dl.data, stage: "dealer", convertedAt: now, stageHistory: [...(dl.data.stageHistory || []), { at: now, by: user.id, from: dl.data.stage, to: "dealer", reason: "first sale" }].slice(-50) };
            q.upsert.run({ c: "dealers", id: dl.id, data: JSON.stringify(promoted), now });
            audit(user, "update", "dealers", dl.id, { stage: "dealer", reason: "first sale" });
            touch("dealers", [dl.id]);
          }
        }
        if (!admin) delete next.override;
        if (next.type === "sale" && !next.opening && !next.voided && !admin) {
          const b = creditBlock(next.dealerId, next.amount);
          if (b.hold) throw new HttpError(409, "credit_hold", `${b.name} is on credit hold (${b.maxLate} days late). Send it to the owner for approval.`);
          if (b.over) throw new HttpError(409, "credit_hold", `This sale would put ${b.name} over the ₱${b.creditLimit} credit limit. Send it to the owner for approval.`);
        }
      }
    }
    return next;
  }

  // Created here because the rules above and the routes below both need it.
  const ops = createOps({ db, q, getDoc, listDocs, audit, settings, applyRules, broadcast: (...a) => broadcast(...a), applyDeltas: (...a) => applyDeltas(...a), dealerTxnsFor, HttpError, isAdmin, canWrite, newId,
    storeAsset: (...a) => storeAsset(...a), ID_RE, IMAGE_TYPES, nextNo, assertOpenPeriod, notify, stockDiff, logMove: (...a) => logMove(...a), txnMove: (...a) => txnMove(...a) });

  const finance = createFinance({ db, q, getDoc, listDocs, audit, settings, broadcast: (...a) => broadcast(...a), dealerTxnsFor, HttpError, isAdmin, canWrite, newId, nextNo, notify, assertOpenPeriod, ID_RE });

  /* ---------- live updates (server-sent events) ---------- */
  const clients = new Set();
  // A change event names the collection and, when known, the changed record IDs.
  const broadcast = (c, ids) => { const msg = `event: change\ndata: ${JSON.stringify(ids && ids.length ? { c, ids } : { c })}\n\n`; for (const res of clients) res.write(msg); };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

  /* ---------- app ---------- */
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(self), geolocation=()",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
    // PR-05: behind HTTPS, send browsers to HTTPS and tell them to stay there.
    if (cookieSecure) {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "");
      if (!req.secure && !local && req.path !== "/healthz") {
        if (req.method === "GET" || req.method === "HEAD") return res.redirect(308, "https://" + req.headers.host + req.originalUrl);
        return res.status(403).json({ code: "https_required", message: "Use the https:// address." });
      }
    }
    next();
  });
  // Content-Security-Policy for the app pages: only our own scripts and their
  // inline script blocks (by hash), Google Fonts, and same-origin data.
  const cspCache = new Map();
  function pageCsp(file) {
    const st = fs.statSync(file), hit = cspCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.csp;
    const html = fs.readFileSync(file, "utf8");
    const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => `'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(" ")}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
    cspCache.set(file, { mtime: st.mtimeMs, csp });
    return csp;
  }
  const sendPage = (res, name, headers = {}) => { const f = path.join(pub, name); res.sendFile(f, { headers: { "Content-Security-Policy": pageCsp(f), ...headers } }); };

  // sessions
  const parseCookies = (h) => Object.fromEntries((h || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
  const setSession = (res, token, days = SESSION_DAYS) => res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: cookieSecure, maxAge: days * 864e5, path: "/" });
  function startSession(res, userId, role) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now(), days = sessionDays(role);
    q.insertSession.run(token, userId, now, now + days * 864e5);
    setSession(res, token, days);
  }
  // "Sign out everywhere": sessions are remembered as revoked so the device is told
  // to wipe its offline data the next time it connects.
  function revokeSessions(userId, exceptToken) {
    const now = Date.now();
    if (!exceptToken) db.prepare("DELETE FROM push_subs WHERE user_id = ?").run(userId); // A lost phone stops getting alerts too.
    db.transaction(() => {
      for (const s of db.prepare("SELECT token, expires_at FROM sessions WHERE user_id = ?").all(userId)) {
        if (s.token === exceptToken) continue;
        db.prepare("INSERT OR REPLACE INTO revoked_sessions (token, user_id, revoked_at, expires_at) VALUES (?, ?, ?, ?)").run(s.token, userId, now, s.expires_at);
        q.delSession.run(s.token);
      }
      db.prepare("DELETE FROM revoked_sessions WHERE expires_at < ?").run(now);
    })();
  }
  app.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      const s = q.session.get(token);
      if (s && s.active && s.expires_at > Date.now()) {
        req.user = { id: s.id, username: s.username, name: s.name, role: s.role, dealerId: s.dealer_id || null, collector: !!s.collector };
        req.sessionToken = token;
        const days = sessionDays(s.role);
        if (s.expires_at - Date.now() < (days - 1) * 864e5) { q.touchSession.run(Date.now() + days * 864e5, token); setSession(res, token, days); }
      } else if (!s && db.prepare("SELECT 1 FROM revoked_sessions WHERE token = ?").get(token)) req.revoked = true;
    }
    next();
  });
  // General API limit, per person (or per address before sign-in). Bulk catalog imports fit
  // within it; a runaway script or a stolen session doesn't. API_RATE_LIMIT is per minute.
  const apiHits = new Map();
  let apiWindow = Date.now() + 60e3;
  app.use("/api", (req, res, next) => {
    if (req.path === "/events") return next();
    const limit = Number(process.env.API_RATE_LIMIT) || 3000, now = Date.now();
    if (now >= apiWindow) { apiHits.clear(); apiWindow = now + 60e3; }
    const key = req.user ? req.user.id : `ip:${req.ip}`, n = (apiHits.get(key) || 0) + 1;
    apiHits.set(key, n);
    if (n > (req.user ? limit : Math.ceil(limit / 5))) { res.set("Retry-After", String(Math.ceil((apiWindow - now) / 1000))); return res.status(429).json({ code: "rate_limited", message: "Too many requests. Wait a minute and try again." }); }
    next();
  });
  const needUser = (req, res, next) => (req.user ? next() : res.status(401).json(req.revoked ? { code: "revoked", message: "This device was signed out by the owner." } : { code: "unauthenticated", message: "Please sign in again." }));
  const needAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ code: "invalid_argument", message: "Only the owner or an editor can do this." }));
  const needOwner = (req, res, next) => (req.user.role === "owner" ? next() : res.status(403).json({ code: "invalid_argument", message: "Only the owner can manage team accounts." }));

  // same-origin check for state-changing requests (CSRF protection)
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ code: "invalid_argument", message: "Request blocked." });
    next();
  });
  const jsonSmall = express.json({ limit: "1mb" });
  const jsonBackup = express.json({ limit: "50mb" });
  app.use("/api", (req, res, next) => (req.path === "/backup/restore" ? jsonBackup : jsonSmall)(req, res, next));

  // Login rate limiting (window: 15 minutes). One person's typos behind a shared shop
  // connection don't lock out their colleagues, and guessing one account from many
  // addresses is still stopped. Counts are kept in memory and reset on restart.
  const LOGIN_LIMITS = { pair: 10, user: 30, ip: 100 };
  const attempts = new Map();
  const loginKeys = (ip, username) => { const u = String(username || "").trim().toLowerCase().slice(0, 40); return [["pair", `p:${ip}:${u}`], ["user", `u:${u}`], ["ip", `i:${ip}`]]; };
  const limited = (keys) => keys.some(([kind, k]) => { const a = attempts.get(k); return a && a.n >= LOGIN_LIMITS[kind] && a.until > Date.now(); });
  const fail = (keys) => {
    const now = Date.now();
    if (attempts.size > 10000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
    for (const [, k] of keys) { const a = attempts.get(k); attempts.set(k, { n: a && a.until > now ? a.n + 1 : 1, until: now + 15 * 60e3 }); }
  };
  // Compared for unknown usernames too, so the response time doesn't reveal which ones exist.
  const DUMMY_HASH = bcrypt.hashSync(newId(), 10);

  const validUsername = (u) => typeof u === "string" && /^[a-z0-9._-]{3,40}$/i.test(u);
  const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;

  app.get("/api/setup", (req, res) => res.json({ needsSetup: q.userCount.get().n === 0 }));
  app.post("/api/setup", (req, res) => {
    if (q.userCount.get().n > 0) return res.status(409).json({ message: "The owner account already exists. Sign in instead." });
    const { name, username, password } = req.body || {};
    if (!name || !validUsername(username)) return res.status(400).json({ message: "Enter your name and a username of 3–40 letters or numbers." });
    if (!validPassword(password)) return res.status(400).json({ message: "Use a password with at least 8 characters." });
    const id = "u_" + newId();
    q.insertUser.run(id, username.trim(), String(name).trim().slice(0, 80), "owner", bcrypt.hashSync(password, 10), Date.now(), null);
    audit({ id }, "setup", null, null, { username });
    startSession(res, id);
    res.json({ ok: true });
  });
  app.post("/api/login", async (req, res, next) => { try {
    const { username, password } = req.body || {};
    const keys = loginKeys(req.ip, username);
    if (limited(keys)) return res.status(429).json({ message: "Too many sign-in attempts. Wait 15 minutes and try again." });
    const u = typeof username === "string" ? q.userByName.get(username.trim()) : null;
    const match = await bcrypt.compare(String(password || ""), u ? u.password_hash : DUMMY_HASH);
    if (!u || !u.active || !match) {
      fail(keys);
      return res.status(401).json({ message: "Wrong username or password." });
    }
    if (u.totp_secret) {
      const code = String((req.body && req.body.code) || "").trim();
      if (!code) return res.status(401).json({ code: "totp_required", message: "Enter the 6-digit code from your authenticator app." });
      const step = totp.verify(u.totp_secret, code, u.totp_last ?? -1);
      if (step !== null) db.prepare("UPDATE users SET totp_last = ? WHERE id = ?").run(step, u.id);
      else if (!useRecoveryCode(u, code)) { fail(keys); return res.status(401).json({ code: "totp_invalid", message: "That code isn't right. Check the time on your phone, or use a recovery code." }); }
    }
    for (const [kind, k] of keys) if (kind === "pair") attempts.delete(k);
    q.purgeSessions.run(Date.now());
    startSession(res, u.id, u.role);
    audit(u, "login");
    res.json({ ok: true });
  } catch (e) { next(e); } });
  function useRecoveryCode(u, code) {
    const norm = String(code).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length !== 10) return false;
    const hashes = JSON.parse(u.recovery_hashes || "[]");
    const i = hashes.findIndex((h) => bcrypt.compareSync(norm, h));
    if (i < 0) return false;
    hashes.splice(i, 1);
    db.prepare("UPDATE users SET recovery_hashes = ? WHERE id = ?").run(JSON.stringify(hashes), u.id);
    audit(u, "2fa_recovery_used", null, null, { left: hashes.length });
    return true;
  }

  /* two-step sign-in (FR-059, PR-10) */
  app.post("/api/me/2fa/setup", needUser, async (req, res, next) => {
    try {
      const secret = totp.newSecret();
      db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(secret, req.user.id);
      const issuer = settings().storeName || "Dealer Credit Ledger";
      const otpauth = `otpauth://totp/${encodeURIComponent(`${issuer}:${req.user.username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
      res.json({ secret: secret.replace(/(.{4})/g, "$1 ").trim(), otpauth, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 220 }) });
    } catch (e) { next(e); }
  });
  app.post("/api/me/2fa/enable", needUser, (req, res) => {
    const u = q.userById.get(req.user.id);
    const step = u.totp_pending ? totp.verify(u.totp_pending, req.body && req.body.code) : null;
    if (step === null) return res.status(400).json({ code: "totp_invalid", message: "That code isn't right. Type the 6 digits your app shows now." });
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString("base64").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(10, "x").slice(0, 10));
    db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last = ?, recovery_hashes = ? WHERE id = ?")
      .run(step, JSON.stringify(codes.map((c) => bcrypt.hashSync(c, 8))), u.id);
    revokeSessions(u.id, req.sessionToken);
    audit(req.user, "2fa_enabled");
    res.json({ ok: true, recoveryCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) });
  });
  app.post("/api/me/2fa/disable", needUser, (req, res) => {
    const u = q.userById.get(req.user.id);
    if (!bcrypt.compareSync(String((req.body && req.body.password) || ""), u.password_hash)) return res.status(400).json({ message: "Your password is wrong." });
    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL, recovery_hashes = NULL WHERE id = ?").run(u.id);
    audit(req.user, "2fa_disabled");
    res.json({ ok: true });
  });
  app.post("/api/me/signout-others", needUser, (req, res) => {
    revokeSessions(req.user.id, req.sessionToken);
    audit(req.user, "signout_others");
    res.json({ ok: true });
  });
  app.post("/api/users/:id/signout", needUser, needOwner, (req, res) => {
    const u = q.userById.get(req.params.id);
    if (!u) return res.status(404).json({ message: "Account not found." });
    revokeSessions(u.id, u.id === req.user.id ? req.sessionToken : null);
    audit(req.user, "signout_everywhere", "users", u.id);
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    if (req.sessionToken) q.delSession.run(req.sessionToken);
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  });

  /* forgotten passwords: the owner resets it, or a two-step recovery code does */
  app.post("/api/password/forgot", (req, res) => {
    const { username } = req.body || {}, keys = loginKeys(req.ip, username);
    if (limited(keys)) return res.status(429).json({ message: "Too many attempts. Wait 15 minutes and try again." });
    fail(keys);
    const u = typeof username === "string" ? q.userByName.get(username.trim()) : null;
    if (u && u.active) {
      db.prepare("INSERT OR REPLACE INTO password_requests (user_id, requested_at) VALUES (?, ?)").run(u.id, Date.now());
      audit(u, "password_forgot");
      notify(["owner"], "Password help needed", "A team member or dealer forgot their password.");
    }
    res.json({ ok: true }); // The same answer either way, so it doesn't reveal which usernames exist.
  });
  app.post("/api/password/recover", (req, res) => {
    const { username, code, password } = req.body || {}, keys = loginKeys(req.ip, username);
    if (limited(keys)) return res.status(429).json({ message: "Too many attempts. Wait 15 minutes and try again." });
    if (!validPassword(password)) return res.status(400).json({ message: "Use a password with at least 8 characters." });
    const u = typeof username === "string" ? q.userByName.get(username.trim()) : null;
    if (!u || !u.active || !useRecoveryCode(u, String(code || ""))) { fail(keys); return res.status(401).json({ message: "That username or recovery code isn't right." }); }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), u.id);
    db.prepare("DELETE FROM password_requests WHERE user_id = ?").run(u.id);
    revokeSessions(u.id);
    audit(u, "password_recover");
    res.json({ ok: true });
  });
  app.get("/api/password/requests", needUser, needOwner, (req, res) => res.json(db.prepare("SELECT r.user_id AS id, r.requested_at AS at, u.name, u.username FROM password_requests r JOIN users u ON u.id = r.user_id ORDER BY r.requested_at").all()));

  /* phone notifications */
  app.get("/api/push/key", needUser, (req, res) => res.json({ key: push.publicKey }));
  app.post("/api/push/subscribe", needUser, (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!canWrite(req.user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    if (!isObj(sub) || !/^https:\/\//.test(String(sub.endpoint)) || !isObj(sub.keys) || !sub.keys.p256dh || !sub.keys.auth) throw new HttpError(400, "invalid_argument", "This device can't receive notifications.");
    push.subscribe(req.user.id, sub);
    res.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", needUser, (req, res) => { push.unsubscribe(String((req.body && req.body.endpoint) || "")); res.json({ ok: true }); });

  /* system health */
  app.get("/api/status", needUser, needAdmin, (req, res) => res.json(systemStatus()));
  app.get("/api/me", needUser, (req, res) => res.json({ ...req.user, twoStep: !!q.userById.get(req.user.id).totp_secret }));
  // QR codes for receipts, statements, reports and dealer/product labels. The
  // browser sends the text it wants encoded (an app deep link), never a file path.
  app.get("/api/qr", needUser, async (req, res, next) => {
    try {
      const data = typeof req.query.data === "string" ? req.query.data.trim() : "";
      if (!data) return res.status(400).json({ code: "invalid_argument", message: "There is nothing to put in the QR code." });
      if (data.length > 600) return res.status(400).json({ code: "invalid_argument", message: "That text is too long for a QR code." });
      const size = Math.min(600, Math.max(96, Math.round(Number(req.query.size) || 240)));
      let buf;
      try {
        buf = await QRCode.toBuffer(data, { type: "png", margin: 1, width: size, errorCorrectionLevel: "M" });
      } catch (e) {
        return res.status(400).json({ code: "invalid_argument", message: "That text is too long for a QR code." });
      }
      res.set({ "Content-Type": "image/png", "Content-Length": String(buf.length), "Cache-Control": "private, max-age=3600", Vary: "Cookie" });
      res.send(buf);
    } catch (e) { next(e); }
  });
  app.post("/api/me/password", needUser, (req, res) => {
    const { current, next } = req.body || {};
    const u = q.userById.get(req.user.id);
    if (!bcrypt.compareSync(String(current || ""), u.password_hash)) return res.status(400).json({ message: "Your current password is wrong." });
    if (!validPassword(next)) return res.status(400).json({ message: "Use a new password with at least 8 characters." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(next, 10), u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(u.id, req.sessionToken);
    audit(req.user, "password_change");
    res.json({ ok: true });
  });

  /* team accounts */
  app.get("/api/users", needUser, (req, res) => {
    if (req.user.role === "dealer") return res.json([]);
    const rows = q.users.all();
    res.json(rows.map((u) => (isAdmin(req.user) ? { ...u, dealerId: u.dealer_id, active: !!u.active, twoStep: !!u.two_step, collector: !!u.collector } : { id: u.id, ...(u.role === "dealer" ? {} : { username: u.username }), name: u.name, role: u.role, active: !!u.active, collector: !!u.collector })));
  });
  app.post("/api/users", needUser, needOwner, (req, res) => {
    const { name, username, password, role, dealerId } = req.body || {};
    if (!name || !validUsername(username)) return res.status(400).json({ message: "Enter a name and a username of 3–40 letters or numbers." });
    if (!STAFF_ROLES.includes(role)) return res.status(400).json({ message: "Choose a role." });
    if (role === "dealer" && !(dealerId && getDoc("dealers", dealerId))) return res.status(400).json({ message: "Choose which dealer this portal account is for." });
    if (!validPassword(password)) return res.status(400).json({ message: "Use a password with at least 8 characters." });
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
    if (password) db.prepare("DELETE FROM password_requests WHERE user_id = ?").run(u.id);
    db.prepare("UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash) WHERE id = ?")
      .run(name ? String(name).trim().slice(0, 80) : null, role || null, active === undefined ? null : active ? 1 : 0, password ? bcrypt.hashSync(password, 10) : null, u.id);
    if (req.body.resetTwoStep === true) { db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL, recovery_hashes = NULL WHERE id = ?").run(u.id); revokeSessions(u.id); }
    if (active === false || password) revokeSessions(u.id, u.id === req.user.id ? req.sessionToken : null);
    if (req.body.collector !== undefined) {
      if (req.body.collector === true && !["staff", "editor", "owner"].includes(role || u.role)) return res.status(400).json({ message: "Only team members can be collectors." });
      db.prepare("UPDATE users SET collector = ? WHERE id = ?").run(req.body.collector === true ? 1 : 0, u.id);
    }
    audit(req.user, "user_update", "users", u.id, { name, role, active, password: password ? "changed" : undefined });
    res.json({ ok: true });
  });

  /* documents */
  const checkCol = (req, res, next) => {
    if (!COLLECTIONS.has(req.params.col)) return res.status(404).json({ code: "invalid_argument", message: "Unknown collection." });
    if (req.params.id !== undefined && !ID_RE.test(req.params.id)) return res.status(400).json({ code: "invalid_argument", message: "Invalid record ID." });
    next();
  };
  // Dealer portal accounts only ever receive their own records.
  function scopeForViewer(col, docs) {
    if (["interactions", "reminders", "proofs", "suppliers", "purchases", "disputes", "creditapps"].includes(col)) return [];
    if (col === "dealers") return docs.map((d) => { const data = { ...d.data }; for (const k of PERSONAL_FIELDS) delete data[k]; delete data.consent; return { ...d, data }; });
    return docs;
  }
  function scopeForDealer(user, col, docs) {
    const own = user.dealerId;
    if (col === "dealers") return docs.filter((d) => d.id === own).map((d) => ({ ...d, data: { name: d.data.name, phone: d.data.phone, area: d.data.area, creditLimit: d.data.creditLimit, terms: d.data.terms, discountPct: d.data.discountPct, consent: d.data.consent || null } }));
    if (col === "txns") return docs.filter((d) => d.data.dealerId === own).map((d) => { const { createdBy, updated, override, voidedBy, ...rest } = d.data; return { ...d, data: rest }; });
    if (col === "products") { const held = reservedQty(); return docs.filter((d) => d.data.active !== false).map((d) => ({ ...d, data: { name: d.data.name, code: d.data.code, category: d.data.category, srp: d.data.srp, imageId: d.data.imageId, promo: d.data.promo || null, discountPct: d.data.discountPct ?? null, available: (Number(d.data.stock) || 0) - (held[d.id] || 0) > 0 } })); }
    if (["proofs", "disputes", "creditapps"].includes(col)) return docs.filter((d) => d.data.dealerId === own);
    if (col === "orders") return docs.filter((d) => d.data.dealerId === own).map((d) => ({ ...d, data: { ...d.data, statusHistory: (d.data.statusHistory || []).map(({ status, at }) => ({ status, at })) } }));
    if (col === "settings") return docs.filter((d) => d.id === "store").map((d) => ({ ...d, data: { storeName: d.data.storeName, phone: d.data.phone, address: d.data.address, paymentInfo: d.data.paymentInfo, discountPct: d.data.discountPct, holdDays: d.data.holdDays, footer: d.data.footer, catalogName: d.data.catalogName, privacyNotice: d.data.privacyNotice || null, privacyVersion: d.data.privacyVersion || null } }));
    return [];
  }
  // FR-061: cost prices stay with the owner and editors, including in write responses.
  function hideCost(col, data) {
    if (col === "products") { const { cost, layers, ...rest } = data; return rest; }
    if (col === "txns" || col === "orders") return { ...data, items: (data.items || []).map(({ cost, ...l }) => l) };
    if (col === "purchases") { const { total, ...rest } = data; return { ...rest, lines: (data.lines || []).map(({ cost, ...l }) => l), receipts: (data.receipts || []).map((x) => ({ ...x, lines: (x.lines || []).map(({ cost, ...l }) => l) })) }; }
    return data;
  }
  const COST_COLS = new Set(["products", "txns", "orders", "purchases"]);
  // PR-09: large lists are sent without re-encoding each record and gzipped;
  // ?ids=a,b fetches just the records a live update says have changed.
  function sendJson(req, res, body) {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    if (body.length > 8192 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) { res.set({ "Content-Encoding": "gzip", Vary: "Accept-Encoding" }); return res.end(zlib.gzipSync(body, { level: 4 })); }
    res.end(body);
  }
  app.get("/api/c/:col", needUser, checkCol, (req, res) => {
    const col = req.params.col;
    if (col === "approvals") sweepApprovals();
    let rows;
    if (typeof req.query.ids === "string") {
      const ids = [...new Set(req.query.ids.split(",").filter((x) => ID_RE.test(x)))].slice(0, 500);
      rows = ids.length ? db.prepare(`SELECT id, data, version FROM docs WHERE collection = ? AND id IN (${ids.map(() => "?").join(",")})`).all(col, ...ids) : [];
    } else rows = q.list.all(col);
    if (req.user.role === "staff" && COST_COLS.has(col)) {
      return sendJson(req, res, JSON.stringify(rows.map((r) => ({ id: r.id, version: r.version, data: hideCost(col, JSON.parse(r.data)) }))));
    }
    if (req.user.role === "viewer" || req.user.role === "dealer") {
      const docs = rows.map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data) }));
      return sendJson(req, res, JSON.stringify(req.user.role === "viewer" ? scopeForViewer(col, docs) : scopeForDealer(req.user, col, docs)));
    }
    sendJson(req, res, "[" + rows.map((r) => `{"id":${JSON.stringify(r.id)},"version":${r.version},"data":${r.data}}`).join(",") + "]");
  });

  function write(req, res, merge) {
    const { col, id } = req.params;
    const body = req.body && req.body.data;
    if (!isObj(body)) return res.status(400).json({ code: "invalid_argument", message: "Missing record data." });
    const restore = req.get("x-restore") === "1";
    touched.clear();
    const result = db.transaction(() => {
      const existing = getDoc(col, id);
      if (merge && !existing) throw new HttpError(404, "invalid_argument", "That record no longer exists.");
      // A payment recorded offline may be sent more than once; the same key means it is already saved.
      const key = col === "txns" && !merge && isObj(body.offline) ? String(body.offline.key || "") : "";
      if (key && existing) {
        if (!canWrite(req.user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
        if (existing.data.offline && existing.data.offline.key === key) return { id, data: existing.data, version: existing.version, duplicate: true };
        throw new HttpError(409, "conflict", "Another record already uses this ID.");
      }
      let next = merge ? deepMerge(existing.data, body) : { ...body };
      next = applyRules(req.user, col, id, existing, next, { restore });
      // PR-03: a sale or return and its stock change are saved together.
      if (col === "txns" && !restore) { const d = stockDiff(existing && existing.data, next); if (Object.keys(d).length) { applyDeltas(req.user, d, next.locationId, { move: txnMove(id, existing && existing.data, next) }); touch("products", Object.keys(d)); touch("moves"); } }
      const json = JSON.stringify(next);
      if (json.length > 256 * 1024) throw new HttpError(413, "invalid_argument", "This record is too large.");
      q.upsert.run({ c: col, id, data: json, now: Date.now() });
      if (col === "products" && !existing && !restore && !next.sample && Number(next.stock) > 0) { logMove(req.user, { id, data: next }, Number(next.stock), { reason: "Starting stock" }); touch("moves"); }
      audit(req.user, restore ? "restore" : existing ? "update" : "create", col, id, next);
      return { id, data: next, version: (existing ? existing.version : 0) + 1 };
    })();
    if (result.duplicate) return res.json(result);
    broadcast(col, [id]);
    for (const [t, ids] of touched) if (t !== col) broadcast(t, ids && [...ids]);
    touched.clear();
    res.json(req.user.role === "staff" && COST_COLS.has(col) ? { ...result, data: hideCost(col, result.data) } : result);
  }
  app.put("/api/c/:col/:id", needUser, checkCol, (req, res) => write(req, res, false));
  app.patch("/api/c/:col/:id", needUser, checkCol, (req, res) => write(req, res, true));
  app.delete("/api/c/:col/:id", needUser, checkCol, (req, res) => {
    const { col, id } = req.params;
    touched.clear();
    db.transaction(() => {
      const existing = getDoc(col, id);
      if (!existing) return;
      applyRules(req.user, col, id, existing, null);
      if (col === "txns") { const d = stockDiff(existing.data, null); if (Object.keys(d).length) { applyDeltas(req.user, d, existing.data.locationId, { move: txnMove(id, existing.data, null) }); touch("products", Object.keys(d)); touch("moves"); } }
      if (col === "products" && !existing.data.sample && Number(existing.data.stock)) { logMove(req.user, { id, data: { ...existing.data, stock: 0 } }, -Number(existing.data.stock), { reason: "Product deleted" }); touch("moves"); }
      q.del.run(col, id);
      audit(req.user, "delete", col, id, existing.data);
    })();
    broadcast(col, [id]);
    for (const [t, ids] of touched) if (t !== col) broadcast(t, ids && [...ids]);
    touched.clear();
    res.json({ ok: true });
  });

  // The stock trail (FR-013): what changed, the balance after it, when, and who did it.
  // Written in the same step as the stock, so a change can't happen without its record.
  function logMove(user, product, qty, { date, ...details }) {
    const now = Date.now();
    const data = { note: "", ...details, productId: product.id, productName: product.data.name, qty, after: Number(product.data.stock) || 0, date: validDay(date) ? date : today(), createdAt: now, createdBy: user.id, byName: user.name };
    q.upsert.run({ c: "moves", id: newId(), data: JSON.stringify(data), now });
  }
  // How a sale or return appears in the trail. Example records leave no trace.
  function txnMove(id, before, after) {
    const t = after || before;
    if (t.sample) return null;
    const kind = t.type === "return" ? "Return" : "Sale";
    const voiding = after && after.voided && !(before && before.voided);
    const reason = !after ? `${kind} deleted` : voiding ? `${kind} voided` : before ? `${kind} edited` : kind;
    return { reason, date: !after || voiding ? today() : after.date, note: t.no || "", txnId: id };
  }

  // atomic stock changes: { deltas: { productId: +/-qty } }
  // locationId names where a sale's stock came from; without it, stock moves at the main store.
  // move describes the change for the stock trail; null leaves no record (example data only).
  function applyDeltas(user, deltas, locationId, { receiving, move = { reason: "Stock adjustment" } } = {}) {
    const allowNegative = settings().allowNegativeStock === true;
    const out = {};
    for (const [pid, d] of Object.entries(deltas)) {
      const qty = Math.round(Number(d));
      if (!ID_RE.test(pid) || !Number.isFinite(qty) || !qty) continue;
      const p = getDoc("products", pid);
      if (!p) continue;
      const nextStock = (Number(p.data.stock) || 0) + qty;
      if (nextStock < 0 && !allowNegative)
        throw new HttpError(409, "insufficient_stock", `Not enough stock for ${p.data.name}. On hand: ${Number(p.data.stock) || 0}, needed: ${Math.abs(qty)}.`);
      const at = { ...(p.data.stockAt || {}) }, placed = Object.values(at).reduce((a, v) => a + (Number(v) || 0), 0);
      if (locationId) {
        const here = (Number(at[locationId]) || 0) + qty;
        if (here < 0 && !allowNegative) throw new HttpError(409, "insufficient_stock", `Not enough ${p.data.name} at that location. Available: ${Number(at[locationId]) || 0}.`);
        at[locationId] = here;
        if (!here) delete at[locationId];
        p.data.stockAt = at;
      } else if (qty < 0 && nextStock - placed < 0 && !allowNegative)
        throw new HttpError(409, "insufficient_stock", `Not enough ${p.data.name} at the main store. Available: ${Math.max(0, (Number(p.data.stock) || 0) - placed)}. The rest is at other locations.`);
      p.data.stock = nextStock;
      if (!receiving) stockMoved(p.data, qty, settings());
      q.upsert.run({ c: "products", id: pid, data: JSON.stringify(p.data), now: Date.now() });
      if (move) logMove(user, p, qty, locationId ? { ...move, locationId } : move);
      out[pid] = p.data.stock;
    }
    if (Object.keys(out).length) audit(user, "stock", "products", null, deltas);
    return out;
  }

  /* ---------- personal data (FR-078, PR-06) ---------- */
  // A dealer accepts the store's current privacy notice in the portal.
  app.post("/api/portal/consent", needUser, (req, res) => {
    if (req.user.role !== "dealer") throw new HttpError(403, "invalid_argument", "Only dealers accept the notice in the portal.");
    const d = getDoc("dealers", req.user.dealerId), version = settings().privacyVersion || null;
    if (!d) throw new HttpError(404, "invalid_argument", "Your dealer account isn't linked.");
    const data = { ...d.data, consent: { method: "portal", noticeVersion: version, at: Date.now(), by: req.user.id } };
    q.upsert.run({ c: "dealers", id: d.id, data: JSON.stringify(data), now: Date.now() });
    audit(req.user, "consent_given", "dealers", d.id, { noticeVersion: version });
    broadcast("dealers");
    res.json({ ok: true, consent: data.consent });
  });
  // Opening a dealer's profile is logged (throttled to once per person per dealer per 10 minutes).
  const viewLog = new Map();
  app.post("/api/dealers/:id/viewed", needUser, (req, res) => {
    if (req.user.role === "dealer" || !ID_RE.test(req.params.id)) return res.json({ ok: true });
    const k = req.user.id + "|" + req.params.id, last = viewLog.get(k) || 0;
    if (Date.now() - last > 10 * 60e3 && getDoc("dealers", req.params.id)) { viewLog.set(k, Date.now()); audit(req.user, "view_profile", "dealers", req.params.id); }
    res.json({ ok: true });
  });
  function dealerPersonalData(id) {
    const d = getDoc("dealers", id);
    if (!d) throw new HttpError(404, "invalid_argument", "That dealer no longer exists.");
    const mine = (c) => docsForDealer(c, id);
    const audits = db.prepare("SELECT at, user_id, action FROM audit WHERE collection = 'dealers' AND doc_id = ? ORDER BY at").all(id);
    const accounts = db.prepare("SELECT id, username, name, role, active, created_at FROM users WHERE dealer_id = ?").all(id);
    return { d, txns: mine("txns"), orders: mine("orders"), interactions: mine("interactions"), approvals: mine("approvals"), proofs: mine("proofs"), reminders: mine("reminders"), disputes: mine("disputes"), creditApplications: mine("creditapps"), audits, accounts };
  }
  app.get("/api/dealers/:id/export", needUser, needOwner, (req, res) => {
    const p = dealerPersonalData(req.params.id);
    audit(req.user, "personal_data_export", "dealers", p.d.id);
    res.set("Content-Disposition", `attachment; filename="personal-data-${p.d.id}.json"`);
    res.json({ app: "dealer-credit-ledger", kind: "personal-data-export", exportedAt: new Date().toISOString(), store: settings().storeName || null,
      dealer: { id: p.d.id, ...p.d.data }, portalAccounts: p.accounts, contactLog: p.interactions, transactions: p.txns, orders: p.orders, approvalRequests: p.approvals, proofsOfPayment: p.proofs, reminders: p.reminders, disputes: p.disputes, creditApplications: p.creditApplications, accessLog: p.audits });
  });
  // Removes personal details on request. Financial records stay, without personal fields.
  app.post("/api/dealers/:id/anonymise", needUser, needOwner, (req, res) => {
    const p = dealerPersonalData(req.params.id), d = p.d.data, live = p.txns.filter((t) => !t.data.voided);
    const years = Math.max(1, Number(settings().retentionYears) || 10);
    const cutoff = new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
    const balance = dealerStatus(dealerTxnsFor(p.d.id)).balance;
    const lostProspect = d.stage === "lost" && !live.length;
    const lastDate = live.map((t) => t.data.date || "").sort().pop() || "";
    if (!lostProspect && (Math.abs(balance) > 0.004 || (lastDate && lastDate > cutoff)))
      throw new HttpError(409, "retention", Math.abs(balance) > 0.004 ? "This dealer still has a balance. Settle it before removing their personal data." : `This dealer has transactions after ${cutoff}. Records must be kept for ${years} years (Store → Privacy).`);
    const now = Date.now(), label = `Removed dealer ${p.d.id.slice(-4).toUpperCase()}`;
    db.transaction(() => {
      for (const [c, rows] of [["proofs", p.proofs], ["reminders", p.reminders], ["disputes", p.disputes], ["creditapps", p.creditApplications]]) for (const r of rows) q.del.run(c, r.id);
      const data = { ...d, name: label, anonymised: { at: now, by: req.user.id }, consent: null };
      for (const k of PERSONAL_FIELDS) delete data[k];
      delete data.stageHistory; delete data.limitHistory;
      if (d.photoId) { db.prepare("DELETE FROM assets WHERE id = ?").run(d.photoId); fs.rmSync(path.join(uploads, d.photoId), { force: true }); }
      q.upsert.run({ c: "dealers", id: p.d.id, data: JSON.stringify(data), now });
      for (const i of p.interactions) q.del.run("interactions", i.id);
      for (const o of p.orders) q.upsert.run({ c: "orders", id: o.id, data: JSON.stringify({ ...o.data, note: "" }), now });
      for (const a of p.accounts) { db.prepare("UPDATE users SET active = 0, name = ? WHERE id = ?").run(label, a.id); revokeSessions(a.id); }
      audit(req.user, "personal_data_anonymise", "dealers", p.d.id, { contactEntries: p.interactions.length, accounts: p.accounts.length });
    })();
    for (const c of ["dealers", "interactions", "orders", "proofs", "reminders", "disputes", "creditapps"]) broadcast(c);
    res.json({ ok: true });
  });

  /* ---------- approval requests (FR-084) ---------- */
  const approvalHours = () => Math.min(24 * 14, Math.max(1, Number(settings().approvalHours) || 24));
  function sweepApprovals() {
    const now = Date.now(); let n = 0;
    for (const d of listDocs("approvals")) if (d.data.status === "pending" && d.data.expiresAt < now) {
      q.upsert.run({ c: "approvals", id: d.id, data: JSON.stringify({ ...d.data, status: "expired", decidedAt: d.data.expiresAt }), now }); n++;
    }
    if (n) broadcast("approvals");
  }
  const approvalSweep = setInterval(sweepApprovals, 5 * 60e3);
  function pendingApproval(id) {
    const d = getDoc("approvals", id);
    if (!d) throw new HttpError(404, "invalid_argument", "That request no longer exists.");
    if (d.data.status !== "pending") throw new HttpError(409, "conflict", `This request was already ${d.data.status}.`);
    if (d.data.expiresAt < Date.now()) throw new HttpError(409, "conflict", "This request has expired. Ask staff to send it again.");
    return d;
  }
  app.post("/api/approvals", needUser, (req, res) => {
    if (!canWrite(req.user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    const { sale, reason, orderId, paidMethod } = req.body || {};
    const why = String(reason || "").trim();
    if (!isObj(sale) || sale.type !== "sale" || !Array.isArray(sale.items) || !(Number(sale.amount) > 0)) throw new HttpError(400, "invalid_argument", "Send the credit sale to approve.");
    if (!sale.dealerId || !getDoc("dealers", sale.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
    if (why.length < 3) throw new HttpError(400, "invalid_argument", "Give the owner a reason for the request.");
    const block = creditBlock(sale.dealerId, sale.amount);
    try { priceTxn({ ...sale, items: sale.items, priceReason: why }, null, false); } catch (e) { if (e.code === "needs_approval") block.discount = e.message; else throw e; }
    if (!block.hold && !block.over && !block.discount) throw new HttpError(400, "invalid_argument", "This sale isn't blocked. Record it normally.");
    const now = Date.now(), id = newId();
    const { no, override, createdAt, createdBy, updated, ...clean } = sale;
    const data = { kind: "sale", status: "pending", dealerId: sale.dealerId, amount: r2(sale.amount), sale: clean, reason: why.slice(0, 500),
      orderId: orderId && ID_RE.test(String(orderId)) ? String(orderId) : null, paidMethod: paidMethod ? String(paidMethod).slice(0, 40) : null,
      requestedBy: req.user.id, requestedAt: now, expiresAt: now + approvalHours() * 3600e3, block };
    q.upsert.run({ c: "approvals", id, data: JSON.stringify(data), now });
    audit(req.user, "approval_request", "approvals", id, { dealerId: data.dealerId, amount: data.amount, reason: data.reason });
    broadcast("approvals");
    notify(["owner", "editor"], "Approval needed", "A credit sale is waiting for your approval.");
    res.json({ id, data });
  });
  app.post("/api/approvals/:id/approve", needUser, (req, res) => {
    if (!isAdmin(req.user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can approve requests.");
    const note = String((req.body && req.body.note) || "").trim().slice(0, 500);
    sweepApprovals();
    const out = db.transaction(() => {
      const r = pendingApproval(req.params.id), now = Date.now();
      const txnId = newId();
      let sale = { ...r.data.sale, createdBy: r.data.requestedBy, createdAt: now, override: { by: req.user.id, at: now, requestId: r.id, ...(note ? { note } : {}) } };
      sale = applyRules(req.user, "txns", txnId, null, sale);
      q.upsert.run({ c: "txns", id: txnId, data: JSON.stringify(sale), now });
      audit(req.user, "create", "txns", txnId, sale);
      const deltas = {}; for (const i of sale.items || []) if (i.productId) deltas[i.productId] = (deltas[i.productId] || 0) - (Math.round(Number(i.qty)) || 0);
      applyDeltas(req.user, deltas, sale.locationId, { move: txnMove(txnId, null, sale) });
      let payNo = null;
      if (r.data.paidMethod) {
        const pid = newId();
        const pay = applyRules(req.user, "txns", pid, null, { type: "payment", dealerId: sale.dealerId, date: sale.date, amount: sale.amount, method: r.data.paidMethod, ref: "", note: `Paid on release ${sale.no}`, createdBy: r.data.requestedBy, createdAt: now + 1 });
        q.upsert.run({ c: "txns", id: pid, data: JSON.stringify(pay), now }); audit(req.user, "create", "txns", pid, pay); payNo = pay.no;
      }
      if (r.data.orderId) {
        const o = getDoc("orders", r.data.orderId);
        if (o && OPEN_ORDER_STATUS.includes(o.data.status)) {
          const od = { ...o.data, status: "released", saleId: txnId, saleNo: sale.no, statusHistory: [...(o.data.statusHistory || []), { status: "released", at: now, by: req.user.id }] };
          q.upsert.run({ c: "orders", id: o.id, data: JSON.stringify(od), now });
        }
      }
      const data = { ...r.data, status: "approved", decidedBy: req.user.id, decidedAt: now, note, txnId, txnNo: sale.no, ...(payNo ? { paymentNo: payNo } : {}) };
      q.upsert.run({ c: "approvals", id: r.id, data: JSON.stringify(data), now });
      audit(req.user, "approval_approve", "approvals", r.id, { txnId, no: sale.no, note });
      return { id: r.id, data };
    })();
    for (const c of ["approvals", "txns", "products", "orders", "dealers"]) broadcast(c);
    res.json(out);
  });
  app.post("/api/approvals/:id/reject", needUser, (req, res) => {
    if (!isAdmin(req.user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can reject requests.");
    const note = String((req.body && req.body.note) || "").trim().slice(0, 500);
    if (note.length < 3) throw new HttpError(400, "invalid_argument", "Tell staff why the request is rejected.");
    sweepApprovals();
    const r = pendingApproval(req.params.id), now = Date.now();
    const data = { ...r.data, status: "rejected", decidedBy: req.user.id, decidedAt: now, note };
    q.upsert.run({ c: "approvals", id: r.id, data: JSON.stringify(data), now });
    audit(req.user, "approval_reject", "approvals", r.id, { note });
    broadcast("approvals");
    res.json({ id: r.id, data });
  });
  app.post("/api/approvals/:id/withdraw", needUser, (req, res) => {
    sweepApprovals();
    const r = pendingApproval(req.params.id);
    if (r.data.requestedBy !== req.user.id && !isAdmin(req.user)) throw new HttpError(403, "invalid_argument", "Only the person who asked can withdraw this request.");
    const now = Date.now(), data = { ...r.data, status: "withdrawn", decidedBy: req.user.id, decidedAt: now };
    q.upsert.run({ c: "approvals", id: r.id, data: JSON.stringify(data), now });
    audit(req.user, "approval_withdraw", "approvals", r.id, {});
    broadcast("approvals");
    res.json({ id: r.id, data });
  });

  app.post("/api/stock", needUser, (req, res) => {
    if (!canWrite(req.user)) return res.status(403).json({ code: "invalid_argument", message: "Your account can only view the ledger." });
    const { deltas = {}, reason, date, note, matched } = req.body || {};
    const move = { reason: STOCK_REASONS.has(reason) ? reason : "Stock adjustment", date, note: String(note ?? "").trim().slice(0, 500) };
    const out = db.transaction(() => {
      const stock = applyDeltas(req.user, deltas, undefined, { move });
      // A count where everything matched changes nothing, but it still happened.
      const counted = matched && reason === "Stock count" ? getDoc("products", String(matched)) : null;
      if (counted) logMove(req.user, counted, 0, move);
      return { stock, logged: !!counted || Object.keys(stock).length > 0 };
    })();
    if (Object.keys(out.stock).length) broadcast("products");
    if (out.logged) broadcast("moves");
    res.json({ stock: out.stock });
  });

  app.get("/api/events", needUser, (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  /* photos */
  app.post("/api/assets", needUser, express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
    if (!canWrite(req.user)) return res.status(403).json({ code: "not_granted", message: "Your account can only view the ledger." });
    const type = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return res.status(415).json({ code: "unsupported_type", message: "Use a JPG, PNG, WebP or GIF image." });
    if (!req.body || !req.body.length) return res.status(400).json({ code: "invalid_request", message: "The file is empty." });
    res.json(storeAsset(req.user, req.body, type));
  });
  function storeAsset(user, body, type, source) {
    const id = newId();
    fs.writeFileSync(path.join(uploads, id), body);
    db.prepare("INSERT INTO assets (id, content_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, type, body.length, user.id, Date.now());
    audit(user, "upload", "assets", id, source ? { size: body.length, source } : { size: body.length });
    return { id, url: "/_blob/" + id, sizeBytes: body.length, contentType: type, ...(source ? { source } : {}) };
  }
  // Product photo from an internet link: the server downloads it (see lib/fetch-image.js).
  app.post("/api/assets/fetch", needUser, (req, res, next) => {
    if (!canWrite(req.user)) return res.status(403).json({ code: "not_granted", message: "Your account can only view the ledger." });
    const url = req.body && req.body.url;
    if (typeof url !== "string" || url.length > 4096) return res.status(400).json({ code: "invalid_url", message: "Paste a link to a picture." });
    fetchImage(url, { allowPrivate: process.env.IMAGE_FETCH_ALLOW_PRIVATE === "1" })
      .then((img) => res.json(storeAsset(req.user, img.body, img.contentType, img.source)))
      .catch((e) => {
        if (!e.code || e instanceof TypeError) return next(e);
        const status = { invalid_url: 400, blocked: 400, not_image: 415, too_large: 413, timeout: 504 }[e.code] || 502;
        res.status(status).json({ code: e.code, message: e.message });
      });
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
    // A dealer's payment receipts are only for that dealer and the store's staff (FR-076).
    if (a.dealer_id && (req.user.role === "viewer" || (req.user.role === "dealer" && req.user.dealerId !== a.dealer_id))) return res.status(404).end();
    res.set({ "Content-Type": a.content_type, "Cache-Control": "private, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'; sandbox" });
    res.sendFile(path.join(uploads, a.id));
  });

  /* admin tools */
  app.get("/api/audit", needUser, needAdmin, (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(db.prepare(`SELECT a.seq, a.at, a.action, a.collection, a.doc_id, a.detail, u.name AS user_name
      FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.seq DESC LIMIT ?`).all(limit));
  });

  /* period close and lock (FR-073) */
  const saveSettings = (data) => { q.upsert.run({ c: "settings", id: "store", data: JSON.stringify(data), now: Date.now() }); broadcast("settings", ["store"]); };
  app.post("/api/periods/close", needUser, needAdmin, (req, res) => {
    const through = req.body && req.body.through, s = settings();
    if (!validDay(through) || through >= today()) throw new HttpError(400, "invalid_argument", "Choose a date before today.");
    if (s.closedThrough && through <= s.closedThrough) throw new HttpError(400, "invalid_argument", `The books are already closed through ${s.closedThrough}.`);
    const entry = { action: "close", through, from: s.closedThrough || null, at: Date.now(), by: req.user.id, byName: req.user.name };
    db.transaction(() => { saveSettings({ ...s, closedThrough: through, periodLog: [...(s.periodLog || []), entry].slice(-200) }); audit(req.user, "period_close", "settings", "store", entry); })();
    res.json({ closedThrough: through });
  });
  app.post("/api/periods/reopen", needUser, needAdmin, (req, res) => {
    const { to, reason } = req.body || {}, s = settings(), why = String(reason || "").trim().slice(0, 300);
    if (!s.closedThrough) throw new HttpError(400, "invalid_argument", "No period is closed.");
    if (!why) throw new HttpError(400, "invalid_argument", "Give a reason for reopening.");
    if (to != null && to !== "" && (!validDay(to) || to >= s.closedThrough)) throw new HttpError(400, "invalid_argument", "Keep the books closed through an earlier date, or leave it blank to reopen everything.");
    const closedThrough = to || null, entry = { action: "reopen", through: closedThrough, from: s.closedThrough, reason: why, at: Date.now(), by: req.user.id, byName: req.user.name };
    db.transaction(() => { saveSettings({ ...s, closedThrough, periodLog: [...(s.periodLog || []), entry].slice(-200) }); audit(req.user, "period_reopen", "settings", "store", entry); })();
    res.json({ closedThrough });
  });

  ops.mount(app, needUser);
  finance.mount(app, needUser);

  /* full backup and restore */
  app.get("/api/backup/full", needUser, needAdmin, (req, res) => res.json(fullBackup()));
  app.get("/api/backup/status", needUser, needAdmin, (req, res) => res.json(backupStatus()));
  app.post("/api/backup/run", needUser, needAdmin, async (req, res) => {
    try { await backupNow(); audit(req.user, "backup_run", null, null, {}); res.json(backupStatus()); }
    catch (e) { res.status(500).json({ code: "backup_failed", message: `Backup failed: ${e.message}`, status: backupStatus() }); }
  });
  app.get("/api/backup/db", needUser, needAdmin, async (req, res, next) => {
    const tmp = path.join(dataDir, "backups", `download-${Date.now()}-${newId(6)}.db`);
    try {
      await db.backup(tmp);
      res.download(tmp, `ledger-${today()}.db`, () => fs.rmSync(tmp, { force: true }));
    } catch (e) { fs.rmSync(tmp, { force: true }); next(e); }
  });
  app.post("/api/backup/restore", needUser, needAdmin, (req, res) => {
    const body = req.body || {};
    const backup = body.backup && typeof body.backup === "object" ? body.backup : body;
    if (!backup || backup.app !== "dealer-credit-ledger" || typeof backup.collections !== "object")
      return res.status(400).json({ code: "invalid_argument", message: "That file isn't a ledger backup." });
    const replace = body.replace === true;
    const count = db.transaction(() => {
      let docs = 0, users = 0, assets = 0;
      for (const [c, rows] of Object.entries(backup.collections || {})) {
        if (!COLLECTIONS.has(c) || !Array.isArray(rows)) continue;
        if (replace) db.prepare("DELETE FROM docs WHERE collection = ?").run(c);
        for (const row of rows) {
          const id = row && (row.id || row._id);
          if (!ID_RE.test(String(id))) continue;
          const data = row.data !== undefined ? row.data : row;
          if (!isObj(data)) continue;
          q.upsert.run({ c, id, data: JSON.stringify(data), now: Date.now() });
          docs++;
        }
      }
      const upUser = db.prepare(`INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id, collector)
        VALUES (@id, @username, @name, @role, @password_hash, @active, @created_at, @dealer_id, @collector)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role,
          password_hash = excluded.password_hash, active = excluded.active, dealer_id = excluded.dealer_id, collector = excluded.collector`);
      for (const u of backup.users || []) {
        if (!u || !ID_RE.test(String(u.id)) || !u.username || !u.password_hash) continue;
        upUser.run({ id: u.id, username: u.username, name: u.name || u.username, role: u.role || "staff", password_hash: u.password_hash, active: u.active ? 1 : 0, created_at: u.created_at || Date.now(), collector: u.collector ? 1 : 0, dealer_id: u.dealer_id || null });
        users++;
      }
      const upAsset = db.prepare(`INSERT INTO assets (id, content_type, size, created_by, created_at, dealer_id)
        VALUES (@id, @content_type, @size, @created_by, @created_at, @dealer_id)
        ON CONFLICT(id) DO UPDATE SET content_type = excluded.content_type, size = excluded.size, dealer_id = excluded.dealer_id`);
      for (const a of backup.assets || []) {
        if (!a || !ID_RE.test(String(a.id)) || !a.data) continue;
        const buf = Buffer.from(String(a.data), "base64");
        fs.writeFileSync(path.join(uploads, a.id), buf);
        upAsset.run({ id: a.id, content_type: a.content_type || "application/octet-stream", size: buf.length, created_by: a.created_by || null, created_at: a.created_at || Date.now(), dealer_id: a.dealer_id || null });
        assets++;
      }
      return { docs, users, assets };
    })();
    audit(req.user, "restore_full", null, null, { replace, ...count });
    for (const c of COLLECTIONS) broadcast(c);
    res.json({ ok: true, replace, ...count });
  });

  /* pages */
  const pub = path.join(__dirname, "..", "public");
  app.get("/healthz", (req, res) => { db.prepare("SELECT 1").get(); res.json({ ok: true }); });
  app.get("/login", (req, res) => sendPage(res, "login.html"));
  app.get("/", (req, res) => {
    if (!req.user) return res.redirect(req.revoked ? "/login?wiped=1" : "/login");
    sendPage(res, req.user.role === "dealer" ? "portal.html" : "index.html", { "Cache-Control": "no-cache" });
  });
  for (const f of ["install.js", "shim.js", "fonts.js", "app.js", "ops.js", "app.css"]) app.get("/" + f, (req, res) => res.sendFile(path.join(pub, f), { headers: { "Cache-Control": "no-cache" } }));
  // Installable app and offline shell (FR-086).
  app.get("/sw.js", (req, res) => res.sendFile(path.join(pub, "sw.js"), { headers: { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8", "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com" } }));
  app.get("/credit.js", (req, res) => res.sendFile(path.join(__dirname, "credit.js"), { headers: { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" } }));
  app.get("/manifest.webmanifest", (req, res) => res.sendFile(path.join(pub, "manifest.webmanifest"), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } }));
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) app.get("/" + f, (req, res) => res.sendFile(path.join(pub, f), { headers: { "Cache-Control": "public, max-age=604800" } }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ code: "too_large", message: "That file is too large." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ code: "invalid_argument", message: "That request couldn't be read." });
    logger.error(err);
    recordError(`${req.method} ${req.path}: ${err.message}`);
    res.status(500).json({ code: "internal", message: "Something went wrong on the server." });
  });

  function fullBackup() {
    const assets = db.prepare("SELECT id, content_type, size, created_by, created_at, dealer_id FROM assets").all().map((a) => {
      let data = null;
      try { data = fs.readFileSync(path.join(uploads, a.id)).toString("base64"); } catch (e) { /* missing file */ }
      return { ...a, data };
    });
    return {
      app: "dealer-credit-ledger",
      version: 3,
      exportedAt: new Date().toISOString(),
      collections: Object.fromEntries([...COLLECTIONS].map((c) => [c, listDocs(c)])),
      users: db.prepare("SELECT id, username, name, role, password_hash, active, created_at, dealer_id, collector FROM users").all(),
      assets,
    };
  }

  function syncBackup(file) {
    const cmd = process.env.BACKUP_SYNC_CMD;
    if (!cmd) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      exec(cmd, { env: { ...process.env, BACKUP_FILE: file }, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "backup sync failed").trim()));
        resolve(String(stdout || "").trim());
      });
    });
  }

  /* automatic daily backups */
  /* ---------- backup verification and alerts (FR-067, PR-08) ---------- */
  const statusFile = path.join(dataDir, "backups", "status.json");
  const readBackupStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { return {}; } };
  const writeBackupStatus = (st) => { try { fs.writeFileSync(statusFile, JSON.stringify(st, null, 1)); } catch (e) { logger.error(e); } };
  // Opens a backup read-only and checks it is a sound, complete ledger database.
  function verifyBackup(file) {
    const v = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const integrity = v.pragma("integrity_check", { simple: true });
      const docs = v.prepare("SELECT COUNT(*) n FROM docs").get().n, users = v.prepare("SELECT COUNT(*) n FROM users").get().n;
      return { ok: integrity === "ok", integrity, docs, users };
    } finally { v.close(); }
  }
  // Problems are logged and, when configured, sent by command and/or webhook.
  /* ---------- monitoring ---------- */
  const startedAt = Date.now(), recentErrors = [];
  let lastErrorAlert = 0, lastHealthAlert = 0;
  // Keeps the last 50 errors for the Store tab, and alerts at most every 15 minutes.
  function recordError(message) {
    recentErrors.unshift({ at: Date.now(), message: String(message).slice(0, 300) });
    recentErrors.length = Math.min(recentErrors.length, 50);
    if (Date.now() - lastErrorAlert > 15 * 60e3) { lastErrorAlert = Date.now(); sendAlert(`Server error: ${message}`); }
  }
  function systemStatus() {
    const size = (f) => { try { return fs.statSync(path.join(dataDir, f)).size; } catch (e) { return 0; } };
    let disk = null;
    try { const s = fs.statfsSync(dataDir); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (e) { /* not available here */ }
    const b = backupStatus(), now = Date.now(), problems = [];
    if (disk && disk.free < Math.min(1e9, disk.total * 0.1)) problems.push("The server is running out of disk space.");
    if (now - startedAt > 26 * 3600e3 && (!b.lastSuccessAt || now - b.lastSuccessAt > 26 * 3600e3)) problems.push("No backup has finished in the last 26 hours.");
    return { startedAt, uptimeSec: Math.round(process.uptime()), node: process.version, dbBytes: size("ledger.db") + size("ledger.db-wal"), disk, memoryBytes: process.memoryUsage().rss,
      onlineClients: clients.size, lastBackupAt: b.lastSuccessAt || null, errors: recentErrors.slice(0, 10), errorsToday: recentErrors.filter((e) => now - e.at < 864e5).length,
      alertsConfigured: b.alertsConfigured, problems };
  }
  const healthCheck = setInterval(() => {
    try { const { problems } = systemStatus(); if (problems.length && Date.now() - lastHealthAlert > 6 * 3600e3) { lastHealthAlert = Date.now(); sendAlert(problems.join(" ")); } }
    catch (e) { logger.error(e); }
  }, 3600e3);
  healthCheck.unref?.();

  function sendAlert(message) {
    logger.error(`ALERT: ${message}`);
    if (process.env.ALERT_CMD) exec(process.env.ALERT_CMD, { env: { ...process.env, ALERT_MESSAGE: message }, timeout: 60000 }, (err) => { if (err) logger.error(`Alert command failed: ${err.message}`); });
    if (process.env.ALERT_WEBHOOK_URL) fetch(process.env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Dealer Credit Ledger: ${message}` }), signal: AbortSignal.timeout(15000) })
      .catch((e) => logger.error(`Alert webhook failed: ${e.message}`));
  }
  async function backupNow() {
    const dir = path.join(dataDir, "backups");
    const file = path.join(dir, `ledger-${today()}.db`);
    const st = readBackupStatus();
    try {
      await db.backup(file);
      const v = verifyBackup(file);
      if (!v.ok) throw new Error(`the backup failed its integrity check (${v.integrity})`);
      Object.assign(st, { lastSuccessAt: Date.now(), lastFile: path.basename(file), lastSize: fs.statSync(file).size, lastDocs: v.docs, lastUsers: v.users, lastError: null, lastErrorAt: null });
    } catch (e) {
      Object.assign(st, { lastError: e.message, lastErrorAt: Date.now() });
      writeBackupStatus(st);
      sendAlert(`Daily backup failed: ${e.message}`);
      throw e;
    }
    const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 30);
    const files = fs.readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    if (process.env.BACKUP_SYNC_CMD) {
      try { await syncBackup(file); st.offsite = { lastSuccessAt: Date.now(), lastError: null, lastErrorAt: null }; }
      catch (e) { st.offsite = { ...(st.offsite || {}), lastError: e.message, lastErrorAt: Date.now() }; sendAlert(`Offsite backup copy failed: ${e.message}`); }
    } else st.offsite = null;
    writeBackupStatus(st);
    return file;
  }
  function backupStatus() {
    const dir = path.join(dataDir, "backups");
    const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse()
      .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
    return { ...readBackupStatus(), files: files.slice(0, 10), count: files.length, offsiteConfigured: !!process.env.BACKUP_SYNC_CMD, alertsConfigured: !!(process.env.ALERT_CMD || process.env.ALERT_WEBHOOK_URL) };
  }

  // PR-11: pictures uploaded or downloaded but never saved on a record (for example
  // a product form that was cancelled) are removed after a day. A picture is kept
  // while any record mentions its ID.
  function cleanupAssets(maxAgeMs = 24 * 3600e3) {
    const cutoff = Date.now() - maxAgeMs, used = db.prepare("SELECT 1 FROM docs WHERE instr(data, ?) > 0 LIMIT 1");
    const removed = [];
    for (const a of db.prepare("SELECT id, size FROM assets WHERE created_at < ?").all(cutoff)) {
      if (used.get(a.id)) continue;
      db.prepare("DELETE FROM assets WHERE id = ?").run(a.id);
      fs.rmSync(path.join(uploads, a.id), { force: true });
      removed.push(a.id);
    }
    if (removed.length) audit(null, "asset_cleanup", "assets", null, { removed, count: removed.length });
    return removed;
  }
  const assetCleanup = setInterval(() => { try { cleanupAssets(); } catch (e) { logger.error(e); } }, 6 * 3600e3);
  assetCleanup.unref?.();

  function close() { clearInterval(heartbeat); clearInterval(approvalSweep); clearInterval(assetCleanup); clearInterval(healthCheck); for (const r of clients) r.end(); db.close(); }
  return { app, db, close, backupNow, dataDir, cleanupAssets, runReminders: ops.runReminders, recordError };
}

module.exports = { createApp };
