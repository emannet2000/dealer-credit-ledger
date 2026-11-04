"use strict";
// Daily operations: cash close (FR-079), collector remittance (FR-077), checks (FR-072),
// reminders (FR-071), proof of payment (FR-076) and purchasing (FR-019 to FR-021).
// createApp() passes in the data helpers, so all rules stay on the server.
const express = require("express");
const { today, daysBetween, settle, r2 } = require("./credit");

const METHODS = ["Cash", "GCash", "Maya", "Bank transfer", "Check", "Other"];
const PURCHASE_OPEN = ["ordered", "partial"];
const near = (a, b) => Math.abs(a - b) <= 0.004;
const money = (v) => r2(Math.max(0, Number(v) || 0));
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const DEFAULT_REMINDER = "Hi {name}, reminder from {store}: {amount} is due on {due}. Questions? Contact us at {contact}. Salamat po!";

function createOps(ctx) {
  const { db, q, getDoc, listDocs, audit, settings, applyRules, broadcast, applyDeltas, dealerTxnsFor, HttpError, isAdmin, canWrite, newId, storeAsset, ID_RE, IMAGE_TYPES, nextNo } = ctx;
  const validDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  const put = (c, id, data) => { q.upsert.run({ c, id, data: JSON.stringify(data), now: Date.now() }); };
  const needWrite = (req) => { if (!canWrite(req.user)) throw new HttpError(403, "invalid_argument", "Your account can only view the ledger."); };
  const needAdminUser = (req) => { if (!isAdmin(req.user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can do this."); };

  /* ---------- cash close ---------- */
  const paymentsOn = (date) => listDocs("txns").filter((d) => d.data.type === "payment" && !d.data.voided && d.data.date === date);
  function expectedByMethod(date) {
    const out = Object.fromEntries(METHODS.map((m) => [m, 0]));
    for (const { data: t } of paymentsOn(date)) { const m = METHODS.includes(t.method) ? t.method : "Other"; out[m] = r2(out[m] + t.amount); }
    return out;
  }
  const dayClosed = (date) => { const d = getDoc("cashcloses", String(date || "")); return !!(d && d.data.status === "closed"); };
  // A record can't change a day or period that has been closed.
  const locked = (date) => { const c = settings().closedThrough; return (c && date <= c) || dayClosed(date); };
  function assertDayOpen(date) {
    if (dayClosed(date)) throw new HttpError(409, "day_closed", `The cash for ${date} is closed. The owner must reopen that day first.`);
  }
  const dayRemittances = (date) => listDocs("remittances").filter((d) => d.data.date === date);

  /* ---------- writes to the collections this file owns ---------- */
  function rules(user, c, id, existing, next) {
    if (["cashcloses", "remittances", "reminders", "proofs"].includes(c)) throw new HttpError(403, "invalid_argument", "Use the buttons in the app for this record.");
    if (!isAdmin(user)) throw new HttpError(403, "invalid_argument", "Only the owner or an editor can change purchasing records.");
    if (c === "suppliers") {
      if (next === null) {
        if (listDocs("purchases").some((p) => p.data.supplierId === id)) throw new HttpError(409, "in_use", "This supplier has purchase orders. Archive it instead.");
        return null;
      }
      const name = text(next.name, 120);
      if (!name) throw new HttpError(400, "invalid_argument", "A supplier needs a name.");
      return { name, contact: text(next.contact, 120), phone: text(next.phone, 40), address: text(next.address, 300), terms: Math.max(0, Math.round(Number(next.terms) || 0)), notes: text(next.notes, 1000), active: next.active !== false };
    }
    // Purchase orders
    if (next === null) {
      if (existing.data.status !== "draft") throw new HttpError(409, "use_cancel", "Only a draft can be deleted. Cancel this purchase order instead.");
      return null;
    }
    const prev = existing && existing.data, received = !!(prev && (prev.receipts || []).length);
    if (prev && ["received", "cancelled"].includes(prev.status)) throw new HttpError(409, "invalid_argument", `This purchase order is ${prev.status} and can't be changed.`);
    if (next.status === "cancelled") {
      if (received) throw new HttpError(409, "invalid_argument", "Goods were already received on this purchase order, so it can't be cancelled.");
      return { ...prev, status: "cancelled" };
    }
    if (received) return { ...prev, expected: validDay(next.expected) ? next.expected : prev.expected, note: text(next.note, 500) };
    if (!["draft", "ordered"].includes(next.status)) throw new HttpError(400, "invalid_argument", "Save the purchase order as a draft or as ordered.");
    if (!getDoc("suppliers", String(next.supplierId || ""))) throw new HttpError(400, "invalid_argument", "Choose a supplier.");
    if (!validDay(next.date)) throw new HttpError(400, "invalid_argument", "Give the order date.");
    if (!Array.isArray(next.lines) || !next.lines.length || next.lines.length > 200) throw new HttpError(400, "invalid_argument", "Add at least one product.");
    const lines = next.lines.map((l) => {
      const qty = Math.round(Number(l && l.qty)), p = l && ID_RE.test(String(l.productId)) ? getDoc("products", l.productId) : null;
      if (!p || !(qty >= 1 && qty <= 999999) || !(Number(l.cost) >= 0)) throw new HttpError(400, "invalid_argument", "Check the products, quantities and costs.");
      return { productId: p.id, name: p.data.name, qty, cost: r2(l.cost), received: 0 };
    });
    return { no: prev ? prev.no : nextPurchaseNo(), supplierId: next.supplierId, date: next.date, expected: validDay(next.expected) ? next.expected : null, lines,
      total: r2(lines.reduce((a, l) => a + l.qty * l.cost, 0)), status: next.status, note: text(next.note, 500), receipts: [], createdAt: prev ? prev.createdAt : Date.now(), createdBy: prev ? prev.createdBy : user.id };
  }
  // SPO- keeps supplier orders apart from the PO- numbers dealers' online orders already use.
  function nextPurchaseNo() {
    const max = listDocs("purchases").reduce((m, p) => Math.max(m, parseInt(String(p.data.no || "").slice(4), 10) || 0), 0);
    return `SPO-${String(max + 1).padStart(5, "0")}`;
  }

  /* ---------- routes ---------- */
  function mount(app, needUser) {
    /* cash close (FR-079) */
    app.get("/api/cash/day/:date", needUser, (req, res) => {
      needWrite(req);
      const date = req.params.date;
      if (!validDay(date)) throw new HttpError(400, "invalid_argument", "Choose a valid day.");
      res.json({ date, expected: expectedByMethod(date), remittances: dayRemittances(date), close: getDoc("cashcloses", date) });
    });
    app.post("/api/cash/close", needUser, (req, res) => {
      needWrite(req);
      const { date, counted, note } = req.body || {};
      if (!validDay(date) || date > today()) throw new HttpError(400, "invalid_argument", "Choose today or an earlier day.");
      if (dayClosed(date)) throw new HttpError(409, "day_closed", "This day is already closed.");
      const expected = expectedByMethod(date), rows = {};
      let diff = 0;
      for (const m of METHODS) { const c = r2(Number(counted && counted[m]) || 0); rows[m] = { expected: expected[m], counted: c, diff: r2(c - expected[m]) }; diff = r2(diff + rows[m].diff); }
      const off = METHODS.some((m) => !near(rows[m].diff, 0)), why = text(note, 500);
      if (off && !why) throw new HttpError(400, "note_required", "The count doesn't match. Add a note saying why.");
      const prior = getDoc("cashcloses", date);
      const data = { date, rows, diff, note: why, status: "closed", closedAt: Date.now(), closedBy: req.user.id, closedByName: req.user.name, remittances: dayRemittances(date).map((r) => r.id), log: (prior && prior.data.log) || [] };
      db.transaction(() => { put("cashcloses", date, data); audit(req.user, "cash_close", "cashcloses", date, { diff, note: why }); })();
      broadcast("cashcloses", [date]);
      res.json(data);
    });
    app.post("/api/cash/reopen", needUser, (req, res) => {
      if (req.user.role !== "owner") throw new HttpError(403, "invalid_argument", "Only the owner can reopen a closed day.");
      const { date, reason } = req.body || {}, why = text(reason, 300), d = getDoc("cashcloses", String(date || ""));
      if (!d || d.data.status !== "closed") throw new HttpError(404, "invalid_argument", "That day isn't closed.");
      if (!why) throw new HttpError(400, "invalid_argument", "Give a reason for reopening.");
      const data = { ...d.data, status: "reopened", log: [...(d.data.log || []), { at: Date.now(), by: req.user.id, byName: req.user.name, reason: why }] };
      db.transaction(() => { put("cashcloses", d.id, data); audit(req.user, "cash_reopen", "cashcloses", d.id, { reason: why }); })();
      broadcast("cashcloses", [d.id]);
      res.json(data);
    });

    /* collector remittance (FR-077) */
    app.post("/api/remittances", needUser, (req, res) => {
      if (!req.user.collector) throw new HttpError(403, "invalid_argument", "Only collectors hand in a remittance.");
      const { date, cash, checks, note } = req.body || {};
      if (!validDay(date) || date > today()) throw new HttpError(400, "invalid_argument", "Choose today or an earlier day.");
      const id = `${req.user.id}.${date}`, prior = getDoc("remittances", id);
      if (prior && prior.data.status === "approved") throw new HttpError(409, "invalid_argument", "This remittance has already been approved.");
      const mine = paymentsOn(date).filter((d) => d.data.collectorId === req.user.id);
      const sum = (test) => r2(mine.filter((d) => test(d.data.method)).reduce((a, d) => a + d.data.amount, 0));
      const expectedCash = sum((m) => m === "Cash"), expectedChecks = sum((m) => m === "Check");
      const c = money(cash), k = money(checks), diff = r2(c + k - expectedCash - expectedChecks);
      const data = { collectorId: req.user.id, collectorName: req.user.name, date, cash: c, checks: k, expectedCash, expectedChecks, other: sum((m) => m !== "Cash" && m !== "Check"), diff,
        note: text(note, 500), status: near(diff, 0) ? "matched" : "pending", submittedAt: Date.now() };
      db.transaction(() => { put("remittances", id, data); audit(req.user, "remittance", "remittances", id, { diff }); })();
      broadcast("remittances", [id]);
      res.json({ id, data });
    });
    app.post("/api/remittances/:id/decide", needUser, (req, res) => {
      needAdminUser(req);
      const d = getDoc("remittances", req.params.id), note = text(req.body && req.body.note, 500);
      if (!d) throw new HttpError(404, "invalid_argument", "That remittance no longer exists.");
      if (d.data.status !== "pending") throw new HttpError(409, "invalid_argument", "This remittance doesn't need approval.");
      if (!note) throw new HttpError(400, "invalid_argument", "Add a note about the difference.");
      const data = { ...d.data, status: "approved", decidedAt: Date.now(), decidedBy: req.user.id, decidedByName: req.user.name, decisionNote: note };
      db.transaction(() => { put("remittances", d.id, data); audit(req.user, "remittance_approve", "remittances", d.id, { diff: d.data.diff, note }); })();
      broadcast("remittances", [d.id]);
      res.json({ id: d.id, data });
    });

    /* checks (FR-072) */
    const checkTxn = (id) => {
      const t = getDoc("txns", id);
      if (!t || t.data.type !== "payment" || !t.data.check) throw new HttpError(404, "invalid_argument", "That check no longer exists.");
      return t;
    };
    // Posted directly because staff record bounced checks, while other adjustments are admin-only.
    function postDebit(user, dealerId, amount, reason, extra) {
      const id = newId(), now = Date.now(), date = today();
      const data = { type: "adjustment", direction: "debit", dealerId, date, dueDate: date, amount: r2(amount), reason, note: reason, no: nextNo("adjustment"), createdAt: now, createdBy: user.id, ...extra };
      put("txns", id, data); audit(user, "create", "txns", id, data);
      return { id, no: data.no };
    }
    app.post("/api/checks/:id/clear", needUser, (req, res) => {
      needWrite(req);
      const t = checkTxn(req.params.id);
      if (t.data.check.status !== "pending") throw new HttpError(409, "invalid_argument", "This check has already been settled.");
      const data = { ...t.data, check: { ...t.data.check, status: "cleared", clearedAt: Date.now(), clearedBy: req.user.id } };
      db.transaction(() => { put("txns", t.id, data); audit(req.user, "check_cleared", "txns", t.id, { no: t.data.no }); })();
      broadcast("txns", [t.id]);
      res.json({ id: t.id, data });
    });
    app.post("/api/checks/:id/bounce", needUser, (req, res) => {
      needWrite(req);
      const t = checkTxn(req.params.id), fee = money(req.body && req.body.fee), reason = text(req.body && req.body.reason, 200) || "Check bounced";
      if (t.data.check.status === "bounced") throw new HttpError(409, "invalid_argument", "This check is already marked as bounced.");
      const now = Date.now(), label = `Bounced check ${t.data.check.number || ""} on ${t.data.no || "payment"}`.replace(/\s+/g, " ");
      const posted = [];
      db.transaction(() => {
        const check = { ...t.data.check, status: "bounced", bouncedAt: now, bouncedBy: req.user.id, bounceReason: reason };
        // Closed books aren't rewritten: the reversal is posted as a debit dated today instead.
        if (locked(t.data.date)) { put("txns", t.id, { ...t.data, check }); posted.push(postDebit(req.user, t.data.dealerId, t.data.amount, label, { bounce: t.id })); }
        else put("txns", t.id, { ...t.data, check, voided: true, voidedAt: now, voidedBy: req.user.id, voidReason: reason });
        if (fee > 0) posted.push(postDebit(req.user, t.data.dealerId, fee, `Bounce fee: ${label}`, { bounceFee: t.id }));
        audit(req.user, "check_bounced", "txns", t.id, { no: t.data.no, amount: t.data.amount, fee, reason });
      })();
      broadcast("txns");
      res.json({ ok: true, posted });
    });

    /* proof of payment (FR-076) */
    app.post("/api/portal/proofs/photo", needUser, express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
      if (req.user.role !== "dealer") throw new HttpError(403, "invalid_argument", "Only dealers upload proof here.");
      const type = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) throw new HttpError(415, "unsupported_type", "Use a JPG, PNG, WebP or GIF image.");
      if (!req.body || !req.body.length) throw new HttpError(400, "invalid_request", "The file is empty.");
      const up = storeAsset(req.user, req.body, type);
      db.prepare("UPDATE assets SET dealer_id = ? WHERE id = ?").run(req.user.dealerId, up.id);
      res.json(up);
    });
    const refUsed = (ref, exceptProof) => {
      const r = ref.toLowerCase();
      if (!r) return null;
      const tx = listDocs("txns").find((t) => !t.data.voided && String(t.data.ref || "").trim().toLowerCase() === r);
      if (tx) return tx.data.no || "another payment";
      const p = listDocs("proofs").find((d) => d.id !== exceptProof && d.data.status !== "rejected" && String(d.data.ref || "").trim().toLowerCase() === r);
      return p ? "another submission" : null;
    };
    app.post("/api/portal/proofs", needUser, (req, res) => {
      if (req.user.role !== "dealer") throw new HttpError(403, "invalid_argument", "Only dealers submit proof of payment.");
      const { amount, method, ref, date, photos } = req.body || {};
      if (!(Number(amount) > 0)) throw new HttpError(400, "invalid_argument", "Enter the amount you paid.");
      if (!METHODS.includes(method)) throw new HttpError(400, "invalid_argument", "Choose how you paid.");
      if (!validDay(date) || date > today()) throw new HttpError(400, "invalid_argument", "Enter the date you paid.");
      const ids = Array.isArray(photos) ? photos.map(String).slice(0, 5) : [];
      if (!ids.length) throw new HttpError(400, "invalid_argument", "Add a photo of your receipt.");
      const own = db.prepare("SELECT 1 FROM assets WHERE id = ? AND dealer_id = ?");
      if (!ids.every((a) => own.get(a, req.user.dealerId))) throw new HttpError(400, "invalid_argument", "A photo couldn't be found. Add it again.");
      const id = newId(), r = text(ref, 80);
      const data = { dealerId: req.user.dealerId, amount: r2(amount), method, ref: r, date, photos: ids, status: "pending", submittedAt: Date.now(), submittedBy: req.user.id, refUsedOn: refUsed(r, id) };
      db.transaction(() => { put("proofs", id, data); audit(req.user, "proof_submit", "proofs", id, { amount: data.amount, method, ref: r }); })();
      broadcast("proofs", [id]);
      res.json({ id, data });
    });
    const pendingProof = (id) => {
      const p = getDoc("proofs", id);
      if (!p) throw new HttpError(404, "invalid_argument", "That submission no longer exists.");
      if (p.data.status !== "pending") throw new HttpError(409, "invalid_argument", "This submission has already been decided.");
      return p;
    };
    app.post("/api/proofs/:id/approve", needUser, (req, res) => {
      needWrite(req);
      const out = db.transaction(() => {
        const p = pendingProof(req.params.id), txnId = newId();
        const pay = applyRules(req.user, "txns", txnId, null, { type: "payment", dealerId: p.data.dealerId, date: p.data.date, amount: p.data.amount, method: p.data.method, ref: p.data.ref, note: "From dealer's uploaded proof", proofId: p.id, photos: p.data.photos });
        put("txns", txnId, pay); audit(req.user, "create", "txns", txnId, pay);
        put("proofs", p.id, { ...p.data, status: "approved", decidedAt: Date.now(), decidedBy: req.user.id, txnId, txnNo: pay.no });
        audit(req.user, "proof_approve", "proofs", p.id, { no: pay.no });
        return { txnId, no: pay.no };
      })();
      broadcast("txns", [out.txnId]); broadcast("proofs", [req.params.id]);
      res.json(out);
    });
    app.post("/api/proofs/:id/reject", needUser, (req, res) => {
      needWrite(req);
      const p = pendingProof(req.params.id), reason = text(req.body && req.body.reason, 300);
      if (!reason) throw new HttpError(400, "invalid_argument", "Tell the dealer why, so they can fix it.");
      db.transaction(() => { put("proofs", p.id, { ...p.data, status: "rejected", decidedAt: Date.now(), decidedBy: req.user.id, reason }); audit(req.user, "proof_reject", "proofs", p.id, { reason }); })();
      broadcast("proofs", [p.id]);
      res.json({ ok: true });
    });

    /* goods received (FR-021) */
    app.post("/api/purchases/:id/receive", needUser, (req, res) => {
      needWrite(req);
      const { date, ref, lines, invoice } = req.body || {};
      const d = date || today();
      if (!validDay(d) || d > today()) throw new HttpError(400, "invalid_argument", "Choose today or an earlier day.");
      if (!Array.isArray(lines)) throw new HttpError(400, "invalid_argument", "Enter the quantities received.");
      const now = Date.now(), admin = isAdmin(req.user);
      const out = db.transaction(() => {
        const po = getDoc("purchases", req.params.id);
        if (!po) throw new HttpError(404, "invalid_argument", "That purchase order no longer exists.");
        if (!PURCHASE_OPEN.includes(po.data.status)) throw new HttpError(409, "invalid_argument", "Only an ordered purchase can be received.");
        const poLines = po.data.lines.map((l) => ({ ...l })), got = [], deltas = {};
        for (const raw of lines) {
          const qty = Math.round(Number(raw && raw.qty)), l = poLines.find((x) => x.productId === (raw && raw.productId));
          if (!l || !qty) continue;
          if (qty < 0 || qty > l.qty - l.received) throw new HttpError(400, "invalid_argument", `Only ${l.qty - l.received} of ${l.name} are still outstanding.`);
          const cost = admin && Number(raw.cost) >= 0 && raw.cost !== "" && raw.cost != null ? r2(raw.cost) : l.cost;
          l.received += qty; deltas[l.productId] = (deltas[l.productId] || 0) + qty;
          got.push({ productId: l.productId, name: l.name, qty, cost });
        }
        if (!got.length) throw new HttpError(400, "invalid_argument", "Enter at least one quantity received.");
        applyDeltas(req.user, deltas);
        for (const g of got) {
          const p = getDoc("products", g.productId);
          if (p) put("products", p.id, { ...p.data, cost: g.cost });
          put("moves", newId(), { productId: g.productId, qty: g.qty, reason: "Purchase received", date: d, note: `${po.data.no}${ref ? " · " + text(ref, 80) : ""}`, purchaseId: po.id, createdAt: now, createdBy: req.user.id });
        }
        const inv = invoice && text(invoice.no, 80) ? { no: text(invoice.no, 80), amount: money(invoice.amount), dueDate: validDay(invoice.dueDate) ? invoice.dueDate : null } : null;
        const done = poLines.every((l) => l.received >= l.qty);
        const data = { ...po.data, lines: poLines, status: done ? "received" : "partial", receipts: [...(po.data.receipts || []), { date: d, ref: text(ref, 80), lines: got, invoice: inv, at: now, by: req.user.id, byName: req.user.name }] };
        put("purchases", po.id, data);
        audit(req.user, "goods_received", "purchases", po.id, { no: po.data.no, lines: got.length, invoice: inv && inv.no });
        return { id: po.id, data, products: Object.keys(deltas) };
      })();
      broadcast("purchases", [out.id]); broadcast("products", out.products); broadcast("moves");
      res.json({ id: out.id, data: out.data });
    });

    /* reminders (FR-071) */
    app.post("/api/reminders/run", needUser, async (req, res, next) => {
      try { needAdminUser(req); audit(req.user, "reminders_run", null, null, {}); res.json(await runReminders()); } catch (e) { next(e); }
    });
  }

  /* ---------- reminders ---------- */
  // One message per dealer, due date and schedule step. Failures stay visible and are
  // tried again on the next run that day; sent messages are never repeated.
  function dueReminders(asOf = today()) {
    const cfg = settings().reminders || {}, days = Array.isArray(cfg.days) ? cfg.days : [];
    if (!cfg.enabled || !days.length) return [];
    const s = settings(), out = [];
    for (const { id, data: d } of listDocs("dealers")) {
      if (d.active === false || d.noReminders || d.anonymised) continue;
      const groups = new Map();
      for (const o of settle(dealerTxnsFor(id)).open) {
        if (!o.t.dueDate) continue;
        const offset = daysBetween(o.t.dueDate, asOf);
        if (!days.includes(offset)) continue;
        const g = groups.get(o.t.dueDate) || { dueDate: o.t.dueDate, offset, amount: 0 };
        g.amount = r2(g.amount + o.rem); groups.set(o.t.dueDate, g);
      }
      for (const g of groups.values()) {
        const key = `${id}.${g.dueDate}.${g.offset}`;
        const prior = getDoc("reminders", key);
        if (prior && prior.data.status === "sent") continue;
        const channel = d.phone ? "sms" : d.email ? "email" : null;
        const message = (s.reminderAuto || DEFAULT_REMINDER).replace(/\{name\}/g, String(d.name || "").split(" ")[0]).replace(/\{store\}/g, s.storeName || "the store")
          .replace(/\{amount\}/g, `₱${g.amount.toFixed(2)}`).replace(/\{due\}/g, g.dueDate).replace(/\{contact\}/g, s.phone || s.storeName || "the store");
        out.push({ key, dealerId: id, dueDate: g.dueDate, offset: g.offset, amount: g.amount, channel, to: channel === "sms" ? d.phone : channel === "email" ? d.email : "", message, attempts: prior ? prior.data.attempts || 0 : 0 });
      }
    }
    return out;
  }
  async function deliver(r) {
    if (!r.channel) return "This dealer has no mobile number or email.";
    const url = process.env.REMINDER_WEBHOOK_URL;
    if (!url) return "No message provider is set up (REMINDER_WEBHOOK_URL).";
    try {
      const resp = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...(process.env.REMINDER_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.REMINDER_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ channel: r.channel, to: r.to, message: r.message }) });
      return resp.ok ? null : `The provider answered ${resp.status}.`;
    } catch (e) { return `Couldn't reach the provider: ${e.message}`; }
  }
  let running = false;
  async function runReminders(asOf = today()) {
    if (running) return { sent: 0, failed: 0, busy: true };
    running = true;
    let sent = 0, failed = 0;
    try {
      for (const r of dueReminders(asOf)) {
        const error = await deliver(r);
        const { key, attempts, ...log } = r;
        put("reminders", key, { ...log, status: error ? "failed" : "sent", error, at: Date.now(), attempts: attempts + 1 });
        if (error) failed++; else sent++;
      }
    } finally { running = false; }
    if (sent || failed) broadcast("reminders");
    return { sent, failed };
  }

  return { rules, mount, assertDayOpen, runReminders };
}

module.exports = { createOps, METHODS };
