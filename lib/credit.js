// Business-day helpers and the dealer balance rules. This one file runs on the server
// and in the browser (served as /credit.js, read as window.Credit), so the API, the
// staff app and the dealer portal can never disagree about a balance.
// Payments, returns, credit adjustments and write-offs settle the oldest credit
// sales first (FIFO), unless a payment names the deliveries it is for.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Credit = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const TZ = (typeof process !== "undefined" && process.env && process.env.TZ) || "Asia/Manila";

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
// Does this record count towards balances yet? A post-dated check waits for its check
// date unless it is marked cleared (FR-072).
function counts(t, asOf) {
  if (!t || t.voided) return false;
  if (!t.check || t.check.status !== "pending") return true;
  return t.check.date <= (asOf || today());
}
function txnEffect(t) {
  if (!counts(t)) return 0;
  if (isCharge(t)) return r2(Number(t.amount) || 0);
  return -r2(Number(t.amount) || 0);
}

// Settles live transactions in date order, given as [id, transaction] pairs. A payment
// with `alloc` ([{ id, amount }]) pays the chosen deliveries first (FR-085); everything
// else pays the oldest unpaid delivery first.
function settleEntries(entries) {
  const open = [], settled = []; let pool = 0;
  for (const [id, t] of entries) {
    if (isCharge(t)) {
      let rem = r2(t.amount);
      if (pool > 0.004) { const ap = Math.min(pool, rem); pool = r2(pool - ap); rem = r2(rem - ap); }
      if (rem > 0.004) open.push({ id, t, rem }); else settled.push({ id, t, paid: t.date });
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
  return { open, settled, credit: pool };
}
const byDate = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0);
// Takes unsorted transactions, each with `_id`, and leaves out voided ones.
function settle(txns) {
  const live = txns.filter((t) => counts(t)).sort(byDate);
  return { ...settleEntries(live.map((t) => [t._id, t])), balance: r2(live.reduce((a, t) => a + txnEffect(t), 0)) };
}

function dealerStatus(txns, asOf = today()) {
  const st = settle(txns);
  let overdue = 0, maxLate = 0;
  for (const o of st.open) {
    if (o.t.dueDate && o.t.dueDate < asOf) { overdue += o.rem; maxLate = Math.max(maxLate, daysBetween(o.t.dueDate, asOf)); }
  }
  return { balance: st.balance, overdue: r2(overdue), maxLate };
}

// Splits a display name into first, middle and last names. Single names stay as first
// names. Filipino family names such as "Dela Cruz" stay together, and suffixes stay with
// the surname. Works backwards so "Maria Dela Cruz Santos" keeps "Dela Cruz" as the
// middle name instead of treating the first particle as the surname.
const NAME_PARTICLES = new Set(["de", "del", "dela", "delas", "delos", "di", "da", "das", "do", "dos", "du", "la", "las", "lo", "los", "van", "von", "der", "den", "san", "santa", "santo", "sto", "stos"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function splitName(name) {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return { firstName: "", middleName: "", lastName: "" };
  let suffix = "";
  if (p.length > 2 && NAME_SUFFIXES.has(p[p.length - 1].toLowerCase().replace(/\.$/, ""))) suffix = p.pop();
  if (p.length === 1) return { firstName: p[0], middleName: "", lastName: suffix };
  let cut = p.length - 1;
  while (cut > 1 && NAME_PARTICLES.has(p[cut - 1].toLowerCase().replace(/\.$/, ""))) cut--;
  return { firstName: p[0], middleName: p.slice(1, cut).join(" "), lastName: [...p.slice(cut), suffix].filter(Boolean).join(" ") };
}

// Whole years between a YYYY-MM-DD birthday and a date, or null if unknown or impossible.
// Age is always worked out, never stored, so it can't go out of date.
function ageOn(birthday, asOf) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || "")), n = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOf || ""));
  if (!m || !n) return null;
  const age = Number(n[1]) - Number(m[1]) - (n[2] + n[3] < m[2] + m[3] ? 1 : 0);
  return age >= 0 && age <= 130 ? age : null;
}

// What makes two dealers or products the same record. Text ignores case, accents,
// punctuation and word order; 0917 123 4567 and +63 917 123 4567 are one number; "1 L"
// and "1L" are one size. A blank value never matches anything.
function normText(s) { return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function phoneKey(v) { const d = String(v ?? "").replace(/\D/g, "").slice(-10); return d.length >= 7 ? d : ""; }
function productWords(s) { const t = normText(s).replace(/(\d)\s+(?=[a-z])/g, "$1"); return t ? t.split(" ") : []; }
const wordsKey = (words) => [...new Set(words)].sort().join(" ");
const dealerKeys = (d) => ({ name: wordsKey(normText(d.name).split(" ").filter(Boolean)), "mobile number": phoneKey(d.phone), email: String(d.email || "").trim().toLowerCase() });
const productKeys = (p) => ({ name: wordsKey(productWords(p.name)), code: normText(p.code).replace(/ /g, ""), barcode: normText(p.barcode).replace(/ /g, "") });

return { normText, phoneKey, productWords, dealerKeys, productKeys, today, dayOf, daysBetween, dealerStatus, settle, settleEntries, counts, txnEffect, isCharge, r2, splitName, ageOn, TZ };
});
