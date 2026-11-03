"use strict";
// Business-day helpers and the dealer balance rules, shared by the API.
// Payments, returns, credit adjustments and write-offs settle the oldest credit
// sales first (FIFO), unless a payment names the deliveries it is for. The browser
// app (index.html, portal.html) uses the same rules.

const TZ = process.env.TZ || "Asia/Manila";

function today(tz = TZ) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function dayOf(ms, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A debit adjustment is a charge (increases what the dealer owes). A credit
// adjustment, payment, return and write-off all reduce the balance.
function isCharge(t) {
  return t.type === "sale" || (t.type === "adjustment" && t.direction === "debit");
}
function txnEffect(t) {
  if (!t || t.voided) return 0;
  if (isCharge(t)) return r2(Number(t.amount) || 0);
  return -r2(Number(t.amount) || 0);
}

// Settles one dealer's transactions in date order. A payment with `alloc`
// ([{ id, amount }]) pays the chosen deliveries first (FR-085); everything else pays
// the oldest unpaid delivery first. Each transaction needs `_id` for allocations.
function settle(txns) {
  const live = txns.filter((t) => !t.voided).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
  const open = [], settled = []; let pool = 0;
  for (const t of live) {
    if (isCharge(t)) {
      let rem = r2(t.amount);
      if (pool > 0.004) { const ap = Math.min(pool, rem); pool = r2(pool - ap); rem = r2(rem - ap); }
      if (rem > 0.004) open.push({ id: t._id, t, rem }); else settled.push({ id: t._id, t, paid: t.date });
      continue;
    }
    let c = r2(t.amount);
    const pay = (o, want) => {
      const ap = r2(Math.min(want, o.rem, c)); if (ap <= 0) return;
      o.rem = r2(o.rem - ap); c = r2(c - ap);
      if (o.rem <= 0.004) { open.splice(open.indexOf(o), 1); settled.push({ id: o.id, t: o.t, paid: t.date }); }
    };
    if (t.type === "payment" && Array.isArray(t.alloc)) for (const a of t.alloc) { const o = open.find((x) => x.id && x.id === a.id); if (o) pay(o, Number(a.amount) || 0); }
    while (c > 0.004 && open.length) pay(open[0], c);
    pool = r2(pool + c);
  }
  return { open, settled, credit: pool, balance: r2(live.reduce((a, t) => a + txnEffect(t), 0)) };
}

function dealerStatus(txns, asOf = today()) {
  const st = settle(txns);
  let overdue = 0, maxLate = 0;
  for (const o of st.open) {
    if (o.t.dueDate && o.t.dueDate < asOf) { overdue += o.rem; maxLate = Math.max(maxLate, daysBetween(o.t.dueDate, asOf)); }
  }
  return { balance: st.balance, overdue: r2(overdue), maxLate };
}

module.exports = { today, dayOf, daysBetween, dealerStatus, settle, txnEffect, isCharge, r2, TZ };
