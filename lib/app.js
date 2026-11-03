"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { exec } = require("child_process");
const { openDb } = require("./db");
const { today, dayOf, dealerStatus, settle, r2 } = require("./credit");
const { fetchImage } = require("./fetch-image");

const COLLECTIONS = new Set(["dealers", "products", "txns", "moves", "settings", "orders", "interactions", "approvals"]);
// Dealer CRM: prospects move lead → contacted → interested → dealer (or lost).
const STAGES = ["lead", "contacted", "interested", "dealer", "lost"];
const PROSPECT_STAGES = new Set(["lead", "contacted", "interested"]);
const CONTACT_KINDS = ["call", "visit", "message", "meeting", "note"];
const ORDER_STATUS = ["new", "preparing", "ready", "released", "cancelled"];
const OPEN_ORDER_STATUS = ["new", "preparing", "ready"];
const ID_RE = /^[A-Za-z0-9_\-.:~]{1,80}$/;
const PREFIX = { sale: "DR", payment: "OR", return: "RT", adjustment: "ADJ", writeoff: "WO" };
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
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
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
    let manual = false;
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
      const prev = oldLines.find((a) => a.productId === it.productId) || saleLine;
      const cost = prev && prev.cost != null ? r2(prev.cost) : p.data.cost != null && p.data.cost !== "" ? r2(p.data.cost) : null;
      return { productId: it.productId, name: String(it.name || p.data.name).slice(0, 160), qty, price, pct, ...(cost != null ? { cost } : {}), ...(it.promo ? { promo: true } : {}), ...(ok ? {} : { manual: true }) };
    });
    const subtotal = r2(lines.reduce((a, i) => a + i.qty * i.price, 0));
    const pctDiscount = r2(lines.reduce((a, i) => a + (i.qty * i.price * i.pct) / 100, 0));
    let extra = next.type === "sale" ? Math.min(r2(subtotal - pctDiscount), Math.max(0, r2(next.discount))) : 0;
    if (extra > 0 && !(existing && near(existing.data.discount || 0, extra))) manual = true;
    const reason = String(next.priceReason || "").trim().slice(0, 300);
    if (manual && !admin && !reason) throw new HttpError(400, "price_reason", "Some prices or discounts differ from the price list. Give a reason, or ask the owner or an editor.");
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
    return listDocs("txns").some((d) => d.id !== exceptId && d.data.no === no);
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
    for (const { id, data: t } of listDocs("txns")) {
      if (id === exceptId || t.type !== "return" || t.saleId !== next.saleId || t.voided) continue;
      for (const i of t.items || []) already.set(i.productId, (already.get(i.productId) || 0) + (Number(i.qty) || 0));
    }
    for (const i of next.items || []) {
      const max = (sold.get(i.productId) || 0) - (already.get(i.productId) || 0);
      if ((Number(i.qty) || 0) > max) throw new HttpError(400, "invalid_argument", `Only ${Math.max(0, max)} of ${i.name || "that product"} can still be returned from ${sale.data.no || "that delivery"}.`);
    }
  }

  /* ---------- server-side business rules ---------- */
  function orderRules(user, id, existing, next) {
    const now = Date.now();
    if (user.role === "dealer") {
      if (!existing) {
        const priced = priceOrder(user.dealerId, next.items);
        const pickup = typeof next.pickupDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(next.pickupDate) ? next.pickupDate : null;
        if (pickup && pickup < today()) throw new HttpError(400, "invalid_argument", "Choose a pickup date from today onward.");
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
    const out = { ...next, no: existing.data.no, dealerId: existing.data.dealerId, createdAt: existing.data.createdAt, createdBy: existing.data.createdBy, source: existing.data.source };
    if (existing.data.status !== next.status) out.statusHistory = [...(existing.data.statusHistory || []), { status: next.status, at: now, by: user.id }];
    else out.statusHistory = existing.data.statusHistory || [];
    return out;
  }

  const dealerTxnsFor = (dealerId, exceptId) => listDocs("txns").filter((d) => d.data.dealerId === dealerId && d.id !== exceptId).map((d) => ({ ...d.data, _id: d.id }));
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
  const touched = new Set(); // other collections changed as a side effect of a write
  function applyRules(user, c, id, existing, next, { restore } = {}) {
    if (c === "orders" && next !== null && !restore) return orderRules(user, id, existing, next);
    if (!canWrite(user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger.");
    if (restore) {
      if (!isAdmin(user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can restore a backup.");
      return next;
    }
    const admin = isAdmin(user);
    const now = Date.now();
    if (c === "approvals") throw new HttpError(403, "invalid_argument", "Use Approve, Reject or Withdraw on the request.");
    if (c === "settings") {
      if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can change store settings.");
      if (id !== "store") throw new HttpError(400, "invalid_argument", "Unknown settings record.");
      next.allowNegativeStock = next.allowNegativeStock === true;
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
      if (next.stage == null || next.stage === "") next.stage = existing ? existing.data.stage || "dealer" : "dealer";
      if (!STAGES.includes(next.stage)) throw new HttpError(400, "invalid_argument", "Unknown dealer stage.");
      if (next.tags != null) {
        if (!Array.isArray(next.tags)) throw new HttpError(400, "invalid_argument", "Tags must be a list.");
        next.tags = [...new Set(next.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
      }
      if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(next.email))) throw new HttpError(400, "invalid_argument", "That email address doesn't look right.");
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
      if (existing) next.stock = existing.data.stock; // stock changes only through /api/stock
      if (!admin && existing) { for (const k of ["dealerPrice", "srp", "promo", "discountPct", "priceHistory", "cost"]) next[k] = existing.data[k] ?? null; }
      if (!admin && !existing) { next.promo = null; next.discountPct = null; next.cost = null; }
      if (!next.name || typeof next.name !== "string") throw new HttpError(400, "invalid_argument", "A product needs a name.");
      next.dealerPrice = r2(next.dealerPrice);
      next.cost = next.cost == null || next.cost === "" ? null : r2(next.cost);
    }
    if (c === "moves" && existing && !admin) throw new HttpError(403, "invalid_argument", "Stock history can't be edited.");
    if (c === "txns") {
      if (!PREFIX[next.type]) throw new HttpError(400, "invalid_argument", "Unknown transaction type.");
      if (next.dealerId && getDoc("dealers", next.dealerId) && !(existing && next.voided && !existing.data.voided)) priceTxn(next, existing, admin);
      if (!(Number(next.amount) > 0)) throw new HttpError(400, "invalid_argument", "The amount must be more than zero.");
      if (!next.dealerId || !getDoc("dealers", next.dealerId)) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
      next.amount = r2(next.amount);
      if (next.type === "writeoff" || next.type === "adjustment") {
        if (!admin) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can add adjustments or write-offs.");
      }
      if (next.type === "adjustment" && !["debit", "credit"].includes(next.direction))
        throw new HttpError(400, "invalid_argument", "Choose whether the adjustment increases or decreases the balance.");
      if (next.type === "writeoff" && !String(next.reason || "").trim())
        throw new HttpError(400, "invalid_argument", "Give a reason for the write-off.");
      if (next.type === "return") validateReturn(next, id);
      if (!next.voided) validateAlloc(next, id);
      if (next.offline != null) {
        // FR-086: payments recorded on a phone without signal and synced later.
        if (next.type !== "payment" || existing || !isObj(next.offline) || !ID_RE.test(String(next.offline.key || "")))
          throw new HttpError(400, "invalid_argument", "Only new payments can be recorded offline.");
        const recordedAt = Number(next.offline.recordedAt);
        next.offline = { key: String(next.offline.key), recordedAt: recordedAt > 0 && recordedAt <= now + 5 * 60e3 ? recordedAt : now, syncedAt: now, confirmed: next.offline.confirmed === true && admin };
        const dl = getDoc("dealers", next.dealerId).data;
        if (dl.active === false && !next.offline.confirmed)
          throw new HttpError(409, "needs_review", `${dl.name} was archived after this payment was recorded offline. An owner or editor must confirm it.`);
      }
      if (existing) {
        if (!admin && !(existing.data.createdBy === user.id && existing.data.createdAt && dayOf(existing.data.createdAt) === today()))
          throw new HttpError(403, "invalid_argument", "Staff can only edit or void what they recorded today. Ask the owner or an editor.");
        next.no = existing.data.no;
        if (!admin) next.override = existing.data.override;
      } else {
        if (!next.no || noTaken(next.no, id)) next.no = nextNo(next.type);
        if (next.type === "sale" && !next.voided) {
          const dl = getDoc("dealers", next.dealerId);
          if (PROSPECT_STAGES.has(dl.data.stage)) {
            const promoted = { ...dl.data, stage: "dealer", convertedAt: now, stageHistory: [...(dl.data.stageHistory || []), { at: now, by: user.id, from: dl.data.stage, to: "dealer", reason: "first sale" }].slice(-50) };
            q.upsert.run({ c: "dealers", id: dl.id, data: JSON.stringify(promoted), now });
            audit(user, "update", "dealers", dl.id, { stage: "dealer", reason: "first sale" });
            touched.add("dealers");
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

  /* ---------- live updates (server-sent events) ---------- */
  const clients = new Set();
  const broadcast = (c) => { const msg = `event: change\ndata: ${JSON.stringify({ c })}\n\n`; for (const res of clients) res.write(msg); };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

  /* ---------- app ---------- */
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(self), geolocation=()" });
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
  const jsonSmall = express.json({ limit: "1mb" });
  const jsonBackup = express.json({ limit: "50mb" });
  app.use("/api", (req, res, next) => (req.path === "/backup/restore" ? jsonBackup : jsonSmall)(req, res, next));

  // login rate limiting
  const attempts = new Map();
  const limited = (key) => { const a = attempts.get(key); return a && a.n >= 10 && a.until > Date.now(); };
  const fail = (key) => { const a = attempts.get(key); const n = a && a.until > Date.now() ? a.n + 1 : 1; attempts.set(key, { n, until: Date.now() + 15 * 60e3 }); };

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
  app.post("/api/login", (req, res) => {
    const key = req.ip;
    if (limited(key)) return res.status(429).json({ message: "Too many sign-in attempts. Wait 15 minutes and try again." });
    const { username, password } = req.body || {};
    const u = typeof username === "string" ? q.userByName.get(username.trim()) : null;
    if (!u || !u.active || !bcrypt.compareSync(String(password || ""), u.password_hash)) {
      fail(key);
      return res.status(401).json({ message: "Wrong username or password." });
    }
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
    res.json(rows.map((u) => (isAdmin(req.user) ? { ...u, dealerId: u.dealer_id, active: !!u.active } : { id: u.id, name: u.name, role: u.role, active: !!u.active })));
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
    db.prepare("UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash) WHERE id = ?")
      .run(name ? String(name).trim().slice(0, 80) : null, role || null, active === undefined ? null : active ? 1 : 0, password ? bcrypt.hashSync(password, 10) : null, u.id);
    if (active === false || password) q.delUserSessions.run(u.id);
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
  function scopeForDealer(user, col, docs) {
    const own = user.dealerId;
    if (col === "dealers") return docs.filter((d) => d.id === own).map((d) => ({ ...d, data: { name: d.data.name, phone: d.data.phone, area: d.data.area, creditLimit: d.data.creditLimit, terms: d.data.terms, discountPct: d.data.discountPct } }));
    if (col === "txns") return docs.filter((d) => d.data.dealerId === own).map((d) => { const { createdBy, updated, override, voidedBy, ...rest } = d.data; return { ...d, data: rest }; });
    if (col === "products") { const held = reservedQty(); return docs.filter((d) => d.data.active !== false).map((d) => ({ ...d, data: { name: d.data.name, code: d.data.code, category: d.data.category, srp: d.data.srp, imageId: d.data.imageId, promo: d.data.promo || null, discountPct: d.data.discountPct ?? null, available: (Number(d.data.stock) || 0) - (held[d.id] || 0) > 0 } })); }
    if (col === "orders") return docs.filter((d) => d.data.dealerId === own).map((d) => ({ ...d, data: { ...d.data, statusHistory: (d.data.statusHistory || []).map(({ status, at }) => ({ status, at })) } }));
    if (col === "settings") return docs.filter((d) => d.id === "store").map((d) => ({ ...d, data: { storeName: d.data.storeName, phone: d.data.phone, address: d.data.address, paymentInfo: d.data.paymentInfo, discountPct: d.data.discountPct, holdDays: d.data.holdDays, footer: d.data.footer, catalogName: d.data.catalogName } }));
    return [];
  }
  app.get("/api/c/:col", needUser, checkCol, (req, res) => {
    if (req.params.col === "approvals") sweepApprovals();
    const docs = listDocs(req.params.col);
    res.json(req.user.role === "dealer" ? scopeForDealer(req.user, req.params.col, docs) : docs);
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
      if (col === "txns" && !restore) { const d = stockDiff(existing && existing.data, next); if (Object.keys(d).length) { applyDeltas(req.user, d); touched.add("products"); } }
      const json = JSON.stringify(next);
      if (json.length > 256 * 1024) throw new HttpError(413, "invalid_argument", "This record is too large.");
      q.upsert.run({ c: col, id, data: json, now: Date.now() });
      audit(req.user, restore ? "restore" : existing ? "update" : "create", col, id, next);
      return { id, data: next, version: (existing ? existing.version : 0) + 1 };
    })();
    if (result.duplicate) return res.json(result);
    broadcast(col);
    for (const t of touched) if (t !== col) broadcast(t);
    touched.clear();
    res.json(result);
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
      if (col === "txns") { const d = stockDiff(existing.data, null); if (Object.keys(d).length) { applyDeltas(req.user, d); touched.add("products"); } }
      q.del.run(col, id);
      audit(req.user, "delete", col, id, existing.data);
    })();
    broadcast(col);
    for (const t of touched) if (t !== col) broadcast(t);
    touched.clear();
    res.json({ ok: true });
  });

  // atomic stock changes: { deltas: { productId: +/-qty } }
  function applyDeltas(user, deltas) {
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
      p.data.stock = nextStock;
      q.upsert.run({ c: "products", id: pid, data: JSON.stringify(p.data), now: Date.now() });
      out[pid] = p.data.stock;
    }
    if (Object.keys(out).length) audit(user, "stock", "products", null, deltas);
    return out;
  }

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
    if (!block.hold && !block.over) throw new HttpError(400, "invalid_argument", "This sale isn't blocked. Record it normally.");
    const now = Date.now(), id = newId();
    const { no, override, createdAt, createdBy, updated, ...clean } = sale;
    const data = { kind: "sale", status: "pending", dealerId: sale.dealerId, amount: r2(sale.amount), sale: clean, reason: why.slice(0, 500),
      orderId: orderId && ID_RE.test(String(orderId)) ? String(orderId) : null, paidMethod: paidMethod ? String(paidMethod).slice(0, 40) : null,
      requestedBy: req.user.id, requestedAt: now, expiresAt: now + approvalHours() * 3600e3, block };
    q.upsert.run({ c: "approvals", id, data: JSON.stringify(data), now });
    audit(req.user, "approval_request", "approvals", id, { dealerId: data.dealerId, amount: data.amount, reason: data.reason });
    broadcast("approvals");
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
      applyDeltas(req.user, deltas);
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
    const deltas = (req.body && req.body.deltas) || {};
    const changed = db.transaction(() => applyDeltas(req.user, deltas))();
    if (Object.keys(changed).length) broadcast("products");
    res.json({ stock: changed });
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
    res.set({ "Content-Type": a.content_type, "Cache-Control": "private, max-age=31536000, immutable" });
    res.sendFile(path.join(uploads, a.id));
  });

  /* admin tools */
  app.get("/api/audit", needUser, needAdmin, (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(db.prepare(`SELECT a.seq, a.at, a.action, a.collection, a.doc_id, a.detail, u.name AS user_name
      FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.seq DESC LIMIT ?`).all(limit));
  });

  /* full backup and restore */
  app.get("/api/backup/full", needUser, needAdmin, (req, res) => res.json(fullBackup()));
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
      const upUser = db.prepare(`INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id)
        VALUES (@id, @username, @name, @role, @password_hash, @active, @created_at, @dealer_id)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role,
          password_hash = excluded.password_hash, active = excluded.active, dealer_id = excluded.dealer_id`);
      for (const u of backup.users || []) {
        if (!u || !ID_RE.test(String(u.id)) || !u.username || !u.password_hash) continue;
        upUser.run({ id: u.id, username: u.username, name: u.name || u.username, role: u.role || "staff", password_hash: u.password_hash, active: u.active ? 1 : 0, created_at: u.created_at || Date.now(), dealer_id: u.dealer_id || null });
        users++;
      }
      const upAsset = db.prepare(`INSERT INTO assets (id, content_type, size, created_by, created_at)
        VALUES (@id, @content_type, @size, @created_by, @created_at)
        ON CONFLICT(id) DO UPDATE SET content_type = excluded.content_type, size = excluded.size`);
      for (const a of backup.assets || []) {
        if (!a || !ID_RE.test(String(a.id)) || !a.data) continue;
        const buf = Buffer.from(String(a.data), "base64");
        fs.writeFileSync(path.join(uploads, a.id), buf);
        upAsset.run({ id: a.id, content_type: a.content_type || "application/octet-stream", size: buf.length, created_by: a.created_by || null, created_at: a.created_at || Date.now() });
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
  app.get("/login", (req, res) => res.sendFile(path.join(pub, "login.html")));
  app.get("/", (req, res) => {
    if (!req.user) return res.redirect("/login");
    res.sendFile(path.join(pub, req.user.role === "dealer" ? "portal.html" : "index.html"), { headers: { "Cache-Control": "no-cache" } });
  });
  app.get("/shim.js", (req, res) => res.sendFile(path.join(pub, "shim.js"), { headers: { "Cache-Control": "no-cache" } }));
  // Installable app and offline shell (FR-086).
  app.get("/sw.js", (req, res) => res.sendFile(path.join(pub, "sw.js"), { headers: { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" } }));
  app.get("/manifest.webmanifest", (req, res) => res.sendFile(path.join(pub, "manifest.webmanifest"), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } }));
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) app.get("/" + f, (req, res) => res.sendFile(path.join(pub, f), { headers: { "Cache-Control": "public, max-age=604800" } }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ code: "too_large", message: "That file is too large." });
    logger.error(err);
    res.status(500).json({ code: "internal", message: "Something went wrong on the server." });
  });

  function fullBackup() {
    const assets = db.prepare("SELECT id, content_type, size, created_by, created_at FROM assets").all().map((a) => {
      let data = null;
      try { data = fs.readFileSync(path.join(uploads, a.id)).toString("base64"); } catch (e) { /* missing file */ }
      return { ...a, data };
    });
    return {
      app: "dealer-credit-ledger",
      version: 3,
      exportedAt: new Date().toISOString(),
      collections: Object.fromEntries([...COLLECTIONS].map((c) => [c, listDocs(c)])),
      users: db.prepare("SELECT id, username, name, role, password_hash, active, created_at, dealer_id FROM users").all(),
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
  async function backupNow() {
    const dir = path.join(dataDir, "backups");
    const file = path.join(dir, `ledger-${today()}.db`);
    await db.backup(file);
    const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 30);
    const files = fs.readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    try { await syncBackup(file); }
    catch (e) { logger.error(`Offsite backup failed: ${e.message}`); }
    return file;
  }

  function close() { clearInterval(heartbeat); clearInterval(approvalSweep); for (const r of clients) r.end(); db.close(); }
  return { app, db, close, backupNow, dataDir };
}

module.exports = { createApp };
