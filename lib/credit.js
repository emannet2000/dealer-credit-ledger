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
  const result=require("../public/allocations").compute(txns.map((t,i)=>({id:t._ledgerId||String(i),data:t})),"9999-12-31");
  let overdue=0,maxLate=0;
  for(const s of result.sales)if(s.remaining>0&&s.dueDate&&s.dueDate<asOf){overdue+=s.remaining;maxLate=Math.max(maxLate,daysBetween(s.dueDate,asOf));}
  return {balance:result.balance,overdue:r2(overdue),maxLate};
}

module.exports = { today, dayOf, daysBetween, dealerStatus, r2, TZ };
