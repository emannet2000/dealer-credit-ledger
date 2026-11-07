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
// Keep credit sources, including advances, so allocations can be explained later.
function allocations(rows, asOf = today()) {
  const sales = [], credits = [], byCredit = {};
  let charged = 0, paid = 0, saleIndex = 0, creditIndex = 0;
  function settle() {
    while (creditIndex < credits.length && saleIndex < sales.length) {
      const credit = credits[creditIndex], sale = sales[saleIndex];
      const amount = Math.min(credit.left, sale.left);
      credit.left -= amount; sale.left -= amount;
      if (amount) byCredit[credit.id].lines.push({ id: sale.id, no: sale.no, amount: amount / 100, left: sale.left / 100 });
      if (!credit.left) creditIndex++;
      if (!sale.left) saleIndex++;
    }
  }
  for (const {id, data:t} of sorted(rows, asOf)) {
    const amount = cents(t.amount);
    if (t.type === "sale") { charged += amount; sales.push({ id, no:t.no, date:t.date, dueDate:t.dueDate, amount:amount/100, left:amount }); }
    else { paid += amount; credits.push({ id, left:amount }); byCredit[id] = { lines:[], extra:0 }; }
    settle();
  }
  for (const credit of credits) byCredit[credit.id].extra = credit.left/100;
  return { balance:(charged-paid)/100, sales:sales.map(s => ({...s, remaining:s.left/100, paid:r2(s.amount-s.left/100), left:undefined})), byCredit };
}
function statement(rows, from, to) {
  const live = sorted(rows, to);
  let balance = live.filter(r=>r.data.date < from).reduce((s,r)=>s+(r.data.type === "sale"?1:-1)*cents(r.data.amount),0);
  const opening = balance/100;
  const entries = live.filter(r=>r.data.date >= from).map(({id,data:t})=>{
    const debit = t.type === "sale" ? cents(t.amount) : 0, credit = t.type === "sale" ? 0 : cents(t.amount);
    balance += debit-credit;
    return { id, no:t.no, date:t.date, type:t.type, debit:debit/100, credit:credit/100, balance:balance/100, note:t.note || "" };
  });
  return { from, to, opening, closing:balance/100, entries, allocations:allocations(rows,to) };
}
module.exports = { METHODS, validDate, allocations, statement, cents };
