"use strict";
// Business-day helpers and the dealer balance rules, shared by the API.
// Payments and returns settle the oldest credit sales first (FIFO), the same
// way the browser app computes balances.

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

function dealerStatus(txns, asOf = today()) {
  const live = txns.filter((t) => !t.voided).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
  let charged = 0, credit = 0;
  for (const t of live) {
    if (t.type === "sale") charged += Number(t.amount) || 0;
    else credit += Number(t.amount) || 0;
  }
  let pool = credit, overdue = 0, maxLate = 0;
  for (const s of live.filter((t) => t.type === "sale")) {
    const amt = Number(s.amount) || 0;
    const applied = Math.min(pool, amt);
    pool -= applied;
    const rem = r2(amt - applied);
    if (rem > 0.004 && s.dueDate && s.dueDate < asOf) {
      overdue += rem;
      maxLate = Math.max(maxLate, daysBetween(s.dueDate, asOf));
    }
  }
  return { balance: r2(charged - credit), overdue: r2(overdue), maxLate };
}

module.exports = { today, dayOf, daysBetween, dealerStatus, r2, TZ };
