"use strict";
const { today, r2 } = require("./credit");
const METHODS = ["Cash", "GCash", "Maya", "Bank transfer", "Check", "Other"];
const cents = n => Math.round(Number(n) * 100);
function validDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
}
function sorted(rows, asOf = "9999-12-31") {
  return rows.filter(r => !r.data.voided && r.data.date <= asOf).sort((a,b) => a.data.date.localeCompare(b.data.date) || (a.data.createdAt || 0) - (b.data.createdAt || 0) || a.id.localeCompare(b.id));
}
// One allocation engine is used by statements, credit holds and the browser.
function allocations(rows,asOf=today()) {return require("../public/allocations").compute(rows,asOf);}
function statement(rows, from, to) {
  const live = sorted(rows, to);
  let balance = live.filter(r=>r.data.date < from).reduce((s,r)=>s+(["sale","refund"].includes(r.data.type)?1:-1)*cents(r.data.amount),0);
  const opening = balance/100;
  const entries = live.filter(r=>r.data.date >= from).map(({id,data:t})=>{
    const debit = ["sale","refund"].includes(t.type) ? cents(t.amount) : 0, credit = ["sale","refund"].includes(t.type) ? 0 : cents(t.amount);
    balance += debit-credit;
    return { id, no:t.no, date:t.date, type:t.type, debit:debit/100, credit:credit/100, balance:balance/100, note:t.note || "" };
  });
  return { from, to, opening, closing:balance/100, entries, allocations:allocations(rows,to) };
}
module.exports = { METHODS, validDate, allocations, statement, cents };
