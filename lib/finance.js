"use strict";
// Payment plans (FR-010), late fees (FR-011), costing (FR-023), batches (FR-024), delivery
// (FR-033), tax documents (FR-069), credit applications (FR-074) and disputes (FR-080).
const { today, daysBetween, settle, dueParts, r2, validDay } = require("./credit");

const text = (v, max) => String(v ?? "").trim().slice(0, max);
const VAT_RATE = 0.12;
const FREQUENCY = { weekly: 7, biweekly: 14, monthly: 30 };
const DISPUTE_REASONS = ["not received", "wrong quantity", "wrong price", "other"];
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
function addMonths(date, n) {
  const d = new Date(date + "T00:00:00Z"), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
}
function schedule(amount, count, frequency, start) {
  const each = Math.floor((amount / count) * 100) / 100, out = [];
  for (let i = 0; i < count; i++) out.push({ due: frequency === "monthly" ? addMonths(start, i) : addDays(start, i * FREQUENCY[frequency]), amount: i === count - 1 ? r2(amount - each * (count - 1)) : each });
  return out;
}
function lateFee(amount, daysLate, policy) {
  const over = daysLate - (Number(policy.graceDays) || 0), rate = (Number(policy.ratePct) || 0) / 100;
  if (over <= 0 || !(rate > 0)) return 0;
  const months = Math.ceil(over / 30);
  return r2(policy.compounding === "monthly" ? amount * ((1 + rate) ** months - 1) : amount * rate * months);
}

/* ---------- stock side effects, kept in sync by applyDeltas ---------- */
// What a sale of qty costs now. FIFO takes the oldest layers, then the product's cost.
function issueCost(p, qty, method) {
  const fallback = Number(p.cost) || 0;
  if (method !== "fifo" || !(p.layers || []).length) return p.cost == null ? null : fallback;
  let left = qty, total = 0;
  for (const l of p.layers) { const take = Math.min(left, l.qty); total += take * l.cost; left -= take; if (!left) break; }
  return r2((total + left * fallback) / qty);
}
function sortBatches(batches, rule) {
  return [...batches].sort((a, b) => (rule === "fifo" ? a.receivedAt - b.receivedAt : String(a.expiry || "9").localeCompare(String(b.expiry || "9")) || a.receivedAt - b.receivedAt));
}
function stockMoved(p, qty, s) {
  if (qty < 0) {
    let left = -qty;
    if ((p.layers || []).length) { p.layers = p.layers.map((l) => ({ ...l })); for (const l of p.layers) { const take = Math.min(left, l.qty); l.qty -= take; left -= take; if (!left) break; } p.layers = p.layers.filter((l) => l.qty > 0); }
    left = -qty;
    if ((p.batches || []).length) { const sorted = sortBatches(p.batches, s.batchRule).map((b) => ({ ...b })); for (const b of sorted) { const take = Math.min(left, b.qty); b.qty -= take; left -= take; if (!left) break; } p.batches = sorted.filter((b) => b.qty > 0); }
  } else if (qty > 0) {
    if (s.costing === "fifo" && p.cost != null) p.layers = [{ qty, cost: Number(p.cost) }, ...(p.layers || [])];
    // Stock coming back has no known lot, so it is listed on its own for checking.
    if (p.batchTracked) { const at = Date.now(), b = (p.batches || []).find((x) => x.lot === "RETURNED"); p.batches = b ? p.batches.map((x) => (x === b ? { ...x, qty: x.qty + qty } : x)) : [...(p.batches || []), { lot: "RETURNED", expiry: null, qty, receivedAt: at }]; }
  }
}
// Called once for each received line, after the stock itself has gone up.
function received(p, qty, cost, method, lot) {
  const out = { ...p };
  if (method === "average") { const before = Math.max(0, (Number(p.stock) || 0) - qty), had = Number(p.cost) || 0; out.cost = before + qty ? r2((before * had + qty * cost) / (before + qty)) : cost; }
  else out.cost = cost;
  if (method === "fifo") out.layers = [...(p.layers || []), { qty, cost, at: Date.now() }];
  if (lot) out.batches = [...(p.batches || []), { lot: lot.lot, expiry: lot.expiry, qty, receivedAt: Date.now() }];
  return out;
}

/* ---------- VAT ---------- */
// Prices include VAT. Discounts are shared across lines in proportion.
function taxFor(next, classOf) {
  const lines = (next.items || []).map((i) => ({ cls: classOf(i.productId), gross: i.qty * i.price * (1 - (Number(i.pct) || 0) / 100) }));
  const sum = lines.reduce((a, l) => a + l.gross, 0), scale = sum > 0 ? next.amount / sum : 0;
  const by = (c) => lines.filter((l) => l.cls === c).reduce((a, l) => a + l.gross * scale, 0);
  const inclusive = by("vat"), exempt = r2(by("exempt")), zero = r2(by("zero")), vatable = r2(next.amount - exempt - zero - (inclusive - inclusive / (1 + VAT_RATE)));
  return { vatable, vat: r2(next.amount - exempt - zero - vatable), exempt, zero };
}

function createFinance(ctx) {
  const { db, q, getDoc, listDocs, audit, settings, broadcast, dealerTxnsFor, HttpError, isAdmin, canWrite, newId, nextNo, notify, assertOpenPeriod, ID_RE } = ctx;
  const put = (c, id, data) => q.upsert.run({ c, id, data: JSON.stringify(data), now: Date.now() });
  const needAdmin = (req) => { if (!isAdmin(req.user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can do this."); };
  const needTeam = (req) => { if (!canWrite(req.user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger."); };
  const costing = () => settings().costing || "latest";
  const openOn = (dealerId, id) => settle(dealerTxnsFor(dealerId)).open.find((o) => o.id === id);
  const charge = (id) => { const t = getDoc("txns", String(id || "")); if (!t || t.data.voided) throw new HttpError(404, "invalid_argument", "That record no longer exists."); return t; };
  const dealerFor = (req) => {
    const id = req.user.role === "dealer" ? req.user.dealerId : (req.body || {}).dealerId;
    if (req.user.role !== "dealer") needTeam(req);
    if (!getDoc("dealers", String(id || ""))) throw new HttpError(400, "invalid_argument", "Choose an existing dealer.");
    return String(id);
  };
  const ownPhotos = (dealerId, photos) => {
    const ids = Array.isArray(photos) ? photos.map(String).slice(0, 5) : [], ok = db.prepare("SELECT 1 FROM assets WHERE id = ? AND (dealer_id = ? OR dealer_id IS NULL)");
    if (!ids.every((a) => ID_RE.test(a) && ok.get(a, dealerId))) throw new HttpError(400, "invalid_argument", "A photo couldn't be found. Add it again.");
    return ids;
  };
  function postAdjustment(user, dealerId, direction, amount, reason, extra) {
    const id = newId(), date = today(), data = { type: "adjustment", direction, dealerId, date, dueDate: date, amount: r2(amount), reason, note: reason, no: nextNo("adjustment"), createdAt: Date.now(), createdBy: user.id, ...extra };
    put("txns", id, data); audit(user, "create", "txns", id, data);
    return { id, no: data.no };
  }

  /* ---------- rules for transactions ---------- */
  // Plans, disputes and tax figures are the server's alone: an edit can't change them.
  function protectTxn(next, existing, user) {
    for (const k of ["plan", "disputed", "tax", "invoiceNo", "lateFeeFor"]) { if (existing && existing.data[k] !== undefined) next[k] = existing.data[k]; else delete next[k]; }
    const s = settings();
    if (!s.tax || !s.tax.vatRegistered || next.opening || !["sale", "return"].includes(next.type)) return;
    next.tax = taxFor(next, (pid) => (getDoc("products", pid) || { data: {} }).data.taxClass || "vat");
    if (existing || next.type !== "sale" || !s.tax.series) return;
    // Gapless: the number is taken inside the same transaction as the sale.
    const r = s.tax.series, n = (Number(s.tax.lastInvoice) || Number(r.from) - 1) + 1;
    if (n > Number(r.to)) throw new HttpError(409, "series_full", "The registered invoice series is used up. Register a new one in Store.");
    next.invoiceNo = `${r.prefix}-${String(n).padStart(6, "0")}`;
    put("settings", "store", { ...s, tax: { ...s.tax, lastInvoice: n } });
    audit(user, "invoice_number", "settings", "store", { no: next.invoiceNo });
  }
  function cleanSettings(next, existing) {
    const prev = existing ? existing.data : {};
    if (next.tax == null && prev.tax) next.tax = prev.tax; // A partial save can't lose the invoice counter.
    if (next.tax != null) {
      const t = next.tax, last = prev.tax && prev.tax.lastInvoice, series = t.series && text(t.series.prefix, 10) ? { prefix: text(t.series.prefix, 10).toUpperCase(), from: Math.max(1, Math.round(Number(t.series.from)) || 1), to: Math.round(Number(t.series.to)) || 999999, atp: text(t.series.atp, 60), registeredAt: Date.now() } : null;
      next.tax = { tin: text(t.tin, 30), vatRegistered: t.vatRegistered === true, permit: text(t.permit, 60), series: last && prev.tax.series ? prev.tax.series : series, lastInvoice: last || null };
    }
    if (next.lateFee != null) next.lateFee = { ratePct: Math.max(0, Number(next.lateFee.ratePct) || 0), graceDays: Math.max(0, Math.round(Number(next.lateFee.graceDays)) || 0), compounding: next.lateFee.compounding === "monthly" ? "monthly" : "simple" };
    if (next.costing != null && !["latest", "average", "fifo"].includes(next.costing)) next.costing = "latest";
    if (next.batchRule != null && next.batchRule !== "fifo") next.batchRule = "fefo";
  }
  function rules(user, c) { throw new HttpError(403, "invalid_argument", "Use the buttons in the app for this record."); }

  /* ---------- late fees ---------- */
  function feesDue(asOf = today()) {
    const policy = settings().lateFee, out = [];
    if (!policy || !policy.ratePct) return out;
    const all = listDocs("txns").map((d) => d.data), posted = {};
    for (const t of all) if (t.lateFeeFor && !t.voided) posted[t.lateFeeFor] = r2((posted[t.lateFeeFor] || 0) + t.amount);
    for (const { id, data: d } of listDocs("dealers")) {
      if (d.active === false || d.anonymised) continue;
      for (const o of settle(dealerTxnsFor(id)).open) {
        if (o.t.lateFeeFor || o.t.bounceFee) continue;
        const total = dueParts(o.t, o.rem).reduce((a, p) => a + (p.due && p.due < asOf ? lateFee(p.amount, daysBetween(p.due, asOf), policy) : 0), 0);
        const fee = r2(total - (posted[o.id] || 0));
        if (fee > 0.004) out.push({ txnId: o.id, no: o.t.no || "", dealerId: id, dealerName: d.name, unpaid: o.rem, due: o.t.dueDate, fee });
      }
    }
    return out;
  }

  function mount(app, needUser) {
    /* payment plans */
    app.post("/api/plans", needUser, (req, res) => {
      needAdmin(req);
      const { txnId, count, frequency, start } = req.body || {}, n = Math.round(Number(count));
      if (!(n >= 2 && n <= 60) || !FREQUENCY[frequency] || !validDay(start)) throw new HttpError(400, "invalid_argument", "Choose 2 to 60 installments, how often, and a start date.");
      db.transaction(() => {
        const t = charge(txnId), o = openOn(t.data.dealerId, t.id);
        if (!o) throw new HttpError(409, "invalid_argument", "This charge is already paid.");
        if (t.data.plan) throw new HttpError(409, "invalid_argument", "This charge already has a payment plan.");
        const plan = { count: n, frequency, start, base: r2(t.data.amount - o.rem), schedule: schedule(o.rem, n, frequency, start), at: Date.now(), by: req.user.id };
        put("txns", t.id, { ...t.data, plan });
        audit(req.user, "plan_create", "txns", t.id, { count: n, frequency, amount: o.rem });
      })();
      broadcast("txns", [txnId]);
      res.json({ ok: true });
    });
    app.post("/api/plans/:id/cancel", needUser, (req, res) => {
      needAdmin(req);
      const t = charge(req.params.id);
      if (!t.data.plan) throw new HttpError(404, "invalid_argument", "This charge has no payment plan.");
      const { plan, ...rest } = t.data;
      db.transaction(() => { put("txns", t.id, rest); audit(req.user, "plan_cancel", "txns", t.id, {}); })();
      broadcast("txns", [t.id]);
      res.json({ ok: true });
    });

    /* late fees */
    app.get("/api/latefees", needUser, (req, res) => { needAdmin(req); res.json(feesDue()); });
    app.post("/api/latefees/post", needUser, (req, res) => {
      needAdmin(req);
      const want = new Set(Array.isArray(req.body && req.body.txnIds) ? req.body.txnIds.map(String) : []), posted = [];
      db.transaction(() => { for (const f of feesDue()) if (want.has(f.txnId)) posted.push(postAdjustment(req.user, f.dealerId, "debit", f.fee, `Late fee on ${f.no}`, { lateFeeFor: f.txnId })); })();
      if (posted.length) broadcast("txns");
      res.json({ posted });
    });

    /* delivery */
    app.post("/api/orders/:id/delivery", needUser, (req, res) => {
      needTeam(req);
      const { driver, vehicle, date, remarks, status } = req.body || {}, now = Date.now();
      const o = getDoc("orders", req.params.id);
      if (!o) throw new HttpError(404, "invalid_argument", "That order no longer exists.");
      if (o.data.status !== "released") throw new HttpError(409, "invalid_argument", "Release the order before recording its delivery.");
      if (!["scheduled", "out", "delivered", "failed"].includes(status)) throw new HttpError(400, "invalid_argument", "Choose a delivery status.");
      if (!text(driver, 80)) throw new HttpError(400, "invalid_argument", "Enter the driver.");
      if (!validDay(date)) throw new HttpError(400, "invalid_argument", "Enter the delivery date.");
      const delivery = { driver: text(driver, 80), vehicle: text(vehicle, 40), date, remarks: text(remarks, 300), status };
      const data = { ...o.data, delivery, deliveryLog: [...(o.data.deliveryLog || []), { ...delivery, at: now, by: req.user.id, byName: req.user.name }].slice(-30) };
      db.transaction(() => { put("orders", o.id, data); audit(req.user, "delivery", "orders", o.id, delivery); })();
      broadcast("orders", [o.id]);
      res.json({ ok: true });
    });

    /* credit applications and limit reviews */
    function setLimit(user, dealerId, limit, nextReview, why) {
      const d = getDoc("dealers", dealerId), now = Date.now();
      put("dealers", d.id, { ...d.data, creditLimit: limit, nextReview: validDay(nextReview) ? nextReview : d.data.nextReview || null, limitHistory: [...(d.data.limitHistory || []), { at: now, by: user.id, from: d.data.creditLimit ?? null, to: limit, reason: why }].slice(-50) });
      audit(user, "credit_limit", "dealers", d.id, { to: limit, reason: why });
    }
    app.post("/api/creditapps", needUser, (req, res) => {
      const dealerId = dealerFor(req), { limit, references, photos, note } = req.body || {};
      if (!(Number(limit) > 0)) throw new HttpError(400, "invalid_argument", "Enter the credit limit requested.");
      if (listDocs("creditapps").some((a) => a.data.dealerId === dealerId && a.data.status === "submitted")) throw new HttpError(409, "invalid_argument", "An application is already being reviewed.");
      const id = newId(), data = { dealerId, limit: r2(limit), references: text(references, 500), note: text(note, 500), photos: ownPhotos(dealerId, photos), status: "submitted", submittedAt: Date.now(), submittedBy: req.user.id };
      db.transaction(() => { put("creditapps", id, data); audit(req.user, "credit_apply", "creditapps", id, { limit: data.limit }); })();
      broadcast("creditapps", [id]);
      notify(["owner", "editor"], "Credit application", "A credit application is waiting for review.");
      res.json({ id, data });
    });
    const pendingApp = (req) => {
      needAdmin(req);
      const a = getDoc("creditapps", req.params.id);
      if (!a) throw new HttpError(404, "invalid_argument", "That application no longer exists.");
      if (a.data.status !== "submitted") throw new HttpError(409, "invalid_argument", "This application has already been decided.");
      return a;
    };
    app.post("/api/creditapps/:id/approve", needUser, (req, res) => {
      const a = pendingApp(req), { limit, nextReview } = req.body || {}, approved = r2(limit ?? a.data.limit);
      if (!(approved > 0)) throw new HttpError(400, "invalid_argument", "Enter the credit limit.");
      db.transaction(() => {
        setLimit(req.user, a.data.dealerId, approved, nextReview, "Credit application");
        put("creditapps", a.id, { ...a.data, status: "approved", approvedLimit: approved, decidedAt: Date.now(), decidedBy: req.user.id, decidedByName: req.user.name });
      })();
      broadcast("creditapps", [a.id]); broadcast("dealers", [a.data.dealerId]);
      res.json({ ok: true });
    });
    app.post("/api/creditapps/:id/reject", needUser, (req, res) => {
      const a = pendingApp(req), reason = text(req.body && req.body.reason, 300);
      if (!reason) throw new HttpError(400, "invalid_argument", "Give a reason.");
      db.transaction(() => { put("creditapps", a.id, { ...a.data, status: "rejected", reason, decidedAt: Date.now(), decidedBy: req.user.id, decidedByName: req.user.name }); audit(req.user, "credit_reject", "creditapps", a.id, { reason }); })();
      broadcast("creditapps", [a.id]);
      res.json({ ok: true });
    });
    app.post("/api/dealers/:id/review", needUser, (req, res) => {
      needAdmin(req);
      const { limit, nextReview } = req.body || {};
      if (!getDoc("dealers", req.params.id)) throw new HttpError(404, "invalid_argument", "That dealer no longer exists.");
      if (!(Number(limit) >= 0) || !validDay(nextReview)) throw new HttpError(400, "invalid_argument", "Enter the limit and the next review date.");
      db.transaction(() => setLimit(req.user, req.params.id, r2(limit), nextReview, "Limit review"))();
      broadcast("dealers", [req.params.id]);
      res.json({ ok: true });
    });

    /* disputes */
    app.post("/api/disputes", needUser, (req, res) => {
      const dealerId = dealerFor(req), { txnId, reason, amount, note, photos } = req.body || {};
      if (!DISPUTE_REASONS.includes(reason)) throw new HttpError(400, "invalid_argument", "Choose a reason.");
      const out = db.transaction(() => {
        const t = charge(txnId);
        if (t.data.dealerId !== dealerId) throw new HttpError(403, "invalid_argument", "That charge isn't on this account.");
        if (t.data.disputed) throw new HttpError(409, "invalid_argument", "This charge is already being reviewed.");
        const o = openOn(dealerId, t.id), amt = r2(amount);
        if (!o) throw new HttpError(409, "invalid_argument", "This charge is already paid.");
        if (!(amt > 0) || amt > o.rem + 0.004) throw new HttpError(400, "invalid_argument", `Enter an amount up to ₱${o.rem.toFixed(2)}.`);
        const id = newId(), data = { dealerId, txnId: t.id, no: t.data.no || "", reason, amount: amt, note: text(note, 500), photos: ownPhotos(dealerId, photos), status: "open", openedAt: Date.now(), openedBy: req.user.id, byDealer: req.user.role === "dealer" };
        put("disputes", id, data); put("txns", t.id, { ...t.data, disputed: amt });
        audit(req.user, "dispute_open", "disputes", id, { no: data.no, amount: amt, reason });
        return { id, data };
      })();
      broadcast("disputes", [out.id]); broadcast("txns", [txnId]);
      notify(["owner", "editor", "staff"], "Charge disputed", "A charge needs review.");
      res.json(out);
    });
    app.post("/api/disputes/:id/resolve", needUser, (req, res) => {
      needTeam(req);
      const { outcome, note } = req.body || {}, why = text(note, 500);
      if (!["accepted", "rejected"].includes(outcome)) throw new HttpError(400, "invalid_argument", "Accept or reject the dispute.");
      if (outcome === "accepted") needAdmin(req);
      if (!why) throw new HttpError(400, "invalid_argument", "Explain the decision. The dealer sees this.");
      const d = getDoc("disputes", req.params.id);
      if (!d) throw new HttpError(404, "invalid_argument", "That dispute no longer exists.");
      if (d.data.status !== "open") throw new HttpError(409, "invalid_argument", "This dispute has already been resolved.");
      let credit = null;
      db.transaction(() => {
        const t = getDoc("txns", d.data.txnId);
        if (t) { const { disputed, ...rest } = t.data; put("txns", t.id, rest); }
        if (outcome === "accepted") credit = postAdjustment(req.user, d.data.dealerId, "credit", d.data.amount, `Dispute accepted on ${d.data.no}`, { disputeId: d.id, sourceId: d.data.txnId });
        put("disputes", d.id, { ...d.data, status: outcome, resolution: why, resolvedAt: Date.now(), resolvedBy: req.user.id, resolvedByName: req.user.name, creditNo: credit ? credit.no : null });
        audit(req.user, "dispute_resolve", "disputes", d.id, { outcome, note: why });
      })();
      broadcast("disputes", [d.id]); broadcast("txns");
      res.json({ ok: true, credit });
    });
  }

  return { rules, mount, protectTxn, cleanSettings, costing, assertOpenPeriod };
}

module.exports = { createFinance, issueCost, stockMoved, received, taxFor, lateFee, schedule };
