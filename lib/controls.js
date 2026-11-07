"use strict";
// Monthly period locks, cashier shift handovers, and duplicate transaction review.
const crypto = require("node:crypto");
const { today, r2 } = require("./credit");
const { validDate, cents } = require("./ledger");

const ID = /^[A-Za-z0-9_\-.:~]{1,80}$/;
const MONTH = /^\d{4}-\d{2}$/;
const text = (v, max = 1000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const digest = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const money = (v) => v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && cents(v) <= 1e12;

function monthEnd(month) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
function dayDiff(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}
function rangeLabel(a, b) {
  return a === b ? a : `${a} to ${b}`;
}

function createControls({ getDoc, listDocs, put, audit, fail, once, isAdmin, canWrite, broadcast, assertOpen }) {
  /* ---------- monthly period locks ---------- */
  function lockedMonth(month) {
    return listDocs("periodLocks").find((r) => r.data.month === month && r.data.status === "closed") || null;
  }
  function monthSummary(month) {
    if (!MONTH.test(String(month)) || month > today().slice(0, 7)) {
      fail(400, "Choose a valid month that has already started.");
    }
    const from = `${month}-01`, to = monthEnd(month);
    const txns = listDocs("txns").filter((r) => !r.data.voided && r.data.date >= from && r.data.date <= to);
    const expenses = listDocs("expenses").filter((r) => !r.data.voided && r.data.date >= from && r.data.date <= to);
    const moves = listDocs("moves").filter((r) => !r.data.voided && r.data.date >= from && r.data.date <= to);
    const totals = { sales: 0, payments: 0, returns: 0, refunds: 0 };
    for (const r of txns) {
      if (Object.hasOwn(totals, r.data.type)) totals[r.data.type] += cents(r.data.amount);
    }
    return {
      month, from, to, locked: !!lockedMonth(month),
      transactions: txns.length,
      sales: r2(totals.sales / 100),
      payments: r2(totals.payments / 100),
      returns: r2(totals.returns / 100),
      refunds: r2(totals.refunds / 100),
      expenses: r2(expenses.reduce((n, r) => n + cents(r.data.amount), 0) / 100),
      expenseCount: expenses.length,
      stockMoves: moves.length,
    };
  }

  /* ---------- cashier shift handover ---------- */
  function cashTotals(from, to) {
    let cashIn = 0, cashOut = 0;
    for (const r of listDocs("txns")) {
      if (r.data.voided || r.data.method !== "Cash") continue;
      const at = Number(r.data.createdAt);
      if (!(at >= from && at <= to)) continue;
      if (r.data.type === "payment") cashIn += cents(r.data.amount);
      else if (r.data.type === "refund") cashOut += cents(r.data.amount);
    }
    for (const r of listDocs("expenses")) {
      if (r.data.voided || r.data.method !== "Cash") continue;
      const at = Number(r.data.createdAt);
      if (at >= from && at <= to) cashOut += cents(r.data.amount);
    }
    for (const purchase of listDocs("purchases")) {
      for (const event of purchase.data.payments || []) {
        if (event.voided || event.method !== "Cash") continue;
        const at = Number(event.at);
        if (at >= from && at <= to) cashOut += cents(event.amount);
      }
      for (const event of purchase.data.refunds || []) {
        if (event.voided || event.method !== "Cash") continue;
        const at = Number(event.at);
        if (at >= from && at <= to) cashIn += cents(event.amount);
      }
    }
    return { cashIn: r2(cashIn / 100), cashOut: r2(cashOut / 100) };
  }
  function varianceType(value) {
    const amount = cents(value);
    return amount > 0 ? "overage" : amount < 0 ? "shortage" : "balanced";
  }

  /* ---------- duplicate transaction detection ---------- */
  const KIND_LABEL = { payment: "Payment", invoice: "Credit sale / invoice", expense: "Expense" };
  function dealerName(id) {
    return getDoc("dealers", id)?.data?.name || "Unknown dealer";
  }
  function recordView(kind, row) {
    const d = row.data;
    const label = kind === "expense" ? [d.category || "Expense", d.payee].filter(Boolean).join(" · ") : dealerName(d.dealerId);
    return {
      id: row.id,
      no: d.no || d.ref || "",
      date: d.date,
      amount: r2(d.amount),
      label,
      detail: [d.method, d.payee, d.note].filter(Boolean).join(" · ").slice(0, 300),
    };
  }
  function groupsOf(rows, keyFn) {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  }
  // Greedy clusters keep every flagged record within the review window of the next one.
  function clustersOf(rows, days) {
    const sorted = [...rows].sort((a, b) => (a.data.date || "").localeCompare(b.data.date || "") || (Number(a.data.createdAt) || 0) - (Number(b.data.createdAt) || 0));
    const clusters = [];
    let current = [];
    for (const row of sorted) {
      if (!current.length || dayDiff(current[current.length - 1].data.date, row.data.date) <= days) {
        current.push(row);
      } else {
        if (current.length > 1) clusters.push(current);
        current = [row];
      }
    }
    if (current.length > 1) clusters.push(current);
    return clusters;
  }
  function reasonFor(kind, records, days) {
    const first = records[0].data;
    const amount = `PHP ${r2(first.amount).toFixed(2)}`;
    const span = rangeLabel(records[0].data.date, records[records.length - 1].data.date);
    if (kind === "payment") return `${records.length} payments of ${amount} for ${dealerName(first.dealerId)} within ${days} days (${span}).`;
    if (kind === "invoice") return `${records.length} credit sales of ${amount} with the same items for ${dealerName(first.dealerId)} within ${days} days (${span}).`;
    return `${records.length} expenses of ${amount} for ${first.category || "the same category"}${first.payee ? " / " + first.payee : ""} within ${days} days (${span}).`;
  }
  function buildFlags(kind, rows, keyFn, days) {
    const flags = [];
    for (const group of groupsOf(rows, keyFn).values()) {
      for (const cluster of clustersOf(group, days)) {
        const ids = cluster.map((r) => r.id).sort();
        flags.push({
          id: digest([kind, ...ids]),
          kind,
          kindLabel: KIND_LABEL[kind],
          reason: reasonFor(kind, cluster, days),
          sameDate: cluster.every((r) => r.data.date === cluster[0].data.date),
          amount: r2(cluster[0].data.amount),
          earliest: cluster[0].data.date,
          latest: cluster[cluster.length - 1].data.date,
          records: cluster.map((r) => recordView(kind, r)),
        });
      }
    }
    return flags;
  }
  function scanDuplicates(days = 7) {
    days = Math.min(90, Math.max(1, Number(days) || 7));
    const live = (c) => listDocs(c).filter((r) => !r.data.voided && validDate(r.data.date));
    const payments = buildFlags(
      "payment",
      live("txns").filter((r) => r.data.type === "payment"),
      (r) => String([r.data.dealerId, r.data.method || "Other", cents(r.data.amount)].join("|")),
      days,
    );
    const invoices = buildFlags(
      "invoice",
      live("txns").filter((r) => r.data.type === "sale" && !r.data.opening),
      (r) => String([
        r.data.dealerId,
        cents(r.data.amount),
        (r.data.items || []).map((i) => `${i.productId}:${i.qty}:${cents(i.price)}:${i.pct ?? ""}`).sort().join(","),
      ].join("|")),
      days,
    );
    const expenseRows = live("expenses").map((r) => ({ ...r, data: { ...r.data, createdAt: r.data.createdAt } }));
    const expenses = buildFlags(
      "expense",
      expenseRows,
      (r) => String([text(r.data.category, 160).toLowerCase(), text(r.data.payee, 160).toLowerCase(), r.data.method || "Other", cents(r.data.amount)].join("|")),
      days,
    );
    const reviews = new Map(listDocs("duplicateReviews").map((r) => [r.data.flagId || r.id, r.data]));
    const groups = [...payments, ...invoices, ...expenses].map((g) => {
      const review = reviews.get(g.id) || null;
      return { ...g, status: review?.status || "open", review };
    }).sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.latest.localeCompare(a.latest) || a.kind.localeCompare(b.kind));
    return { days, scannedAt: Date.now(), groups };
  }

  function register(app, needUser, needAdmin, needOwner) {
    app.post("/api/periods/preview", needUser, needAdmin, (req, res) => res.json(monthSummary(String(req.body?.month || ""))));
    app.post("/api/periods/:month/close", needUser, needAdmin, (req, res) => {
      const month = String(req.params.month || "");
      const out = once(req.user, req.get("Idempotency-Key"), { route: "period_close", month, body: req.body }, () => {
        const summary = monthSummary(month);
        if (summary.locked) fail(409, "This month is already finalized.");
        const why = text(req.body?.reason, 1000);
        if (!why) fail(400, "Enter the reason for finalizing this month.");
        const id = "period-" + month, old = getDoc("periodLocks", id);
        const data = {
          month, from: summary.from, to: summary.to, status: "closed",
          closedAt: Date.now(), closedBy: req.user.id, reason: why,
          summary: { transactions: summary.transactions, sales: summary.sales, payments: summary.payments, returns: summary.returns, refunds: summary.refunds, expenses: summary.expenses, expenseCount: summary.expenseCount, stockMoves: summary.stockMoves },
          history: [...(old?.data.history || []), ...(old ? [{ status: old.data.status, at: old.data.reopenedAt || old.data.closedAt, by: old.data.reopenedBy || old.data.closedBy, reason: old.data.reopenReason || old.data.reason }] : [])],
        };
        put("periodLocks", id, data);
        audit(req.user, "period_close", "periodLocks", id, { month, reason: why });
        return getDoc("periodLocks", id);
      });
      broadcast("periodLocks");
      res.json(out);
    });
    app.post("/api/periods/:month/reopen", needUser, needOwner, (req, res) => {
      const month = String(req.params.month || "");
      const out = once(req.user, req.get("Idempotency-Key"), { route: "period_reopen", month, body: req.body }, () => {
        const lock = lockedMonth(month);
        if (!lock) fail(409, "This month is not finalized.");
        const why = text(req.body?.reason, 1000);
        if (!why) fail(400, "Enter the reason for reopening this month.");
        const data = { ...lock.data, status: "reopened", reopenedAt: Date.now(), reopenedBy: req.user.id, reopenReason: why };
        put("periodLocks", lock.id, data);
        audit(req.user, "period_reopen", "periodLocks", lock.id, { month, reason: why });
        return getDoc("periodLocks", lock.id);
      });
      broadcast("periodLocks");
      res.json(out);
    });

    app.post("/api/shifts/open", needUser, (req, res) => {
      if (!canWrite(req.user)) fail(403, "Your account can only view cashier shifts.");
      const out = once(req.user, req.get("Idempotency-Key"), { route: "shift_open", body: req.body }, () => {
        const b = req.body || {}, date = b.date || today();
        if (!validDate(date) || date > today()) fail(400, "Choose today or an earlier business date.");
        if (!money(b.openingCash)) fail(400, "Enter a valid nonnegative opening cash amount.");
        assertOpen(date);
        if (listDocs("cashierShifts").some((r) => r.data.cashierId === req.user.id && r.data.status === "open")) {
          fail(409, "Close your current shift before starting another.");
        }
        const id = crypto.randomUUID();
        const data = {
          date, cashierId: req.user.id, cashierName: req.user.name,
          register: text(b.register, 80), openingCash: r2(Number(b.openingCash)),
          openedAt: Date.now(), status: "open", note: text(b.note, 1000),
          createdAt: Date.now(), createdBy: req.user.id,
        };
        put("cashierShifts", id, data);
        audit(req.user, "shift_open", "cashierShifts", id, data);
        return getDoc("cashierShifts", id);
      });
      broadcast("cashierShifts");
      res.json(out);
    });
    app.post("/api/shifts/:id/close", needUser, (req, res) => {
      if (!canWrite(req.user)) fail(403, "Your account can only view cashier shifts.");
      const out = once(req.user, req.get("Idempotency-Key"), { route: "shift_close", id: req.params.id, body: req.body }, () => {
        if (!ID.test(req.params.id)) fail(400, "Invalid shift reference.");
        const shift = getDoc("cashierShifts", req.params.id);
        if (!shift || shift.data.status !== "open") fail(409, "This shift is not open.");
        if (shift.data.cashierId !== req.user.id && !isAdmin(req.user)) fail(403, "Only the cashier or an owner/editor can close this shift.");
        const b = req.body || {};
        if (!money(b.closingCash)) fail(400, "Enter a valid nonnegative closing cash amount.");
        const closedAt = Date.now(), totals = cashTotals(Number(shift.data.openedAt), closedAt);
        const expectedCash = r2((cents(shift.data.openingCash) + cents(totals.cashIn) - cents(totals.cashOut)) / 100);
        const variance = r2(Number(b.closingCash) - expectedCash);
        const closeNote = text(b.note, 1000);
        if (cents(variance) !== 0 && !closeNote) fail(400, "Explain the cash shortage or overage before closing the shift.");
        const data = {
          ...shift.data, status: "closed", closedAt, closedBy: req.user.id,
          closingCash: r2(Number(b.closingCash)), cashIn: totals.cashIn, cashOut: totals.cashOut,
          expectedCash, variance, varianceType: varianceType(variance), closeNote,
        };
        put("cashierShifts", shift.id, data);
        audit(req.user, "shift_close", "cashierShifts", shift.id, { variance, expectedCash, closingCash: data.closingCash });
        return getDoc("cashierShifts", shift.id);
      });
      broadcast("cashierShifts");
      res.json(out);
    });

    app.get("/api/duplicates", needUser, needAdmin, (req, res) => {
      res.json(scanDuplicates(req.query.days));
    });
    app.post("/api/duplicates/:id/review", needUser, needAdmin, (req, res) => {
      const out = once(req.user, req.get("Idempotency-Key"), { route: "duplicate_review", id: req.params.id, body: req.body }, () => {
        const b = req.body || {}, days = Math.min(90, Math.max(1, Number(b.days) || 7));
        if (!["reviewed", "ignored"].includes(b.status)) fail(400, "Choose whether this is a confirmed duplicate or a false alarm.");
        const why = text(b.reason, 1000);
        if (!why) fail(400, "Explain the duplicate review decision.");
        const group = scanDuplicates(days).groups.find((g) => g.id === req.params.id);
        if (!group) fail(404, "This duplicate group no longer exists. Scan again.");
        const data = {
          flagId: group.id, kind: group.kind, recordIds: group.records.map((r) => r.id),
          status: b.status, reason: why, reviewedBy: req.user.id, reviewedAt: Date.now(),
        };
        put("duplicateReviews", group.id, data);
        audit(req.user, "duplicate_review", "duplicateReviews", group.id, { kind: group.kind, status: b.status, recordIds: data.recordIds, reason: why });
        return { ...group, status: b.status, review: data };
      });
      broadcast("duplicateReviews");
      res.json(out);
    });
  }

  return { register, scanDuplicates, monthSummary, cashTotals };
}

module.exports = { createControls };
