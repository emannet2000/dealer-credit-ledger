"use strict";
// Tests the business logic in public/app.js (the code the browser runs) and
// checks it agrees with the server's rules in lib/credit.js (PR-07).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers/page-logic");
const credit = require("../lib/credit");
const fs = require("fs");
const path = require("path");
// Values made inside the sandbox have the sandbox's Array/Object prototypes; compare plain copies.
const same = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), msg);

const sale = (date, due, amount, extra = {}) => ({ type: "sale", dealerId: "d1", date, dueDate: due, amount, no: extra.no, ...extra });
const pay = (date, amount, extra = {}) => ({ type: "payment", dealerId: "d1", date, amount, ...extra });

test("settle pays the oldest delivery first and keeps extra as credit", () => {
  const L = load([], { txns: { a: sale("2026-06-01", "2026-07-01", 1000), b: sale("2026-09-01", "2026-10-01", 500), p: pay("2026-10-05", 1200) } });
  const r = L.settle(L.dealerTxns("d1"));
  same(r.open.map((o) => [o.id, o.rem]), [["b", 300]]);
  same(r.settled.map((s) => [s.id, s.paid]), [["a", "2026-10-05"]]);
  assert.equal(r.credit, 0);
  const extra = load([], { txns: { a: sale("2026-06-01", "2026-07-01", 100), p: pay("2026-06-02", 150) } });
  assert.equal(extra.settle(extra.dealerTxns("d1")).credit, 50);
});

test("a payment for chosen deliveries pays them first, the rest oldest-first; voids release it", () => {
  const txns = { a: sale("2026-01-01", "2026-02-01", 100), b: sale("2026-02-01", "2026-03-01", 200), c: sale("2026-03-01", "2026-04-01", 300),
    p: pay("2026-04-02", 250, { alloc: [{ id: "c", amount: 200 }] }) };
  const L = load([], { txns });
  // 200 to the chosen DR-3, the other 50 to the oldest (DR-1).
  same(L.settle(L.dealerTxns("d1")).open.map((o) => [o.id, o.rem]), [["a", 50], ["b", 200], ["c", 100]]);
  txns.p.voided = true; L.bump();
  same(L.settle(L.dealerTxns("d1")).open.map((o) => [o.id, o.rem]), [["a", 100], ["b", 200], ["c", 300]]);
});

test("the browser and the server settle any ledger the same way", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 300; run++) {
    const txns = {}, ids = [];
    for (let i = 0; i < 2 + Math.floor(rnd() * 25); i++) {
      const date = `2026-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`, id = `t${i}`;
      const k = rnd();
      if (k < 0.5) { txns[id] = sale(date, date, Math.round(rnd() * 100000) / 100, { createdAt: i }); ids.push(id); }
      else if (k < 0.85) txns[id] = pay(date, Math.round(rnd() * 80000) / 100, { createdAt: i, ...(rnd() < 0.4 && ids.length ? { alloc: [{ id: ids[Math.floor(rnd() * ids.length)], amount: Math.round(rnd() * 30000) / 100 }] } : {}) });
      else txns[id] = { type: rnd() < 0.5 ? "return" : "adjustment", direction: rnd() < 0.5 ? "debit" : "credit", dealerId: "d1", date, amount: Math.round(rnd() * 20000) / 100, createdAt: i, voided: rnd() < 0.1 };
    }
    const L = load([], { txns });
    const browser = L.settle(L.dealerTxns("d1"));
    const server = credit.settle(Object.entries(txns).map(([id, t]) => ({ ...t, _id: id })));
    same(browser.open.map((o) => [o.id, o.rem]), server.open.map((o) => [o.id, o.rem]), `run ${run}`);
    assert.equal(browser.credit, server.credit, `run ${run} credit`);
  }
});

test("aging puts each unpaid charge in one bucket and reconciles to the balance", () => {
  const txns = { a: sale("2026-06-01", "2026-07-01", 1000), b: sale("2026-09-01", "2026-10-01", 500), c: sale("2026-10-20", "2026-11-20", 300),
    p: pay("2026-10-05", 400), adj: { type: "adjustment", direction: "debit", dealerId: "d1", date: "2026-08-01", dueDate: "2026-08-10", amount: 50 },
    v: sale("2026-10-01", "2026-10-02", 999, { voided: true }), later: sale("2026-12-01", "2026-12-31", 70),
    adv: { type: "payment", dealerId: "d2", date: "2026-10-01", amount: 200 } };
  const L = load(["AGE_B", "ageKey", "agingFor", "agingReport"], { txns, dealers: { d1: { name: "Ana" }, d2: { name: "Ben" }, d3: { name: "Cy" } } });
  const R = L.agingReport("2026-11-03", "");
  const ana = R.rows.find((r) => r.id === "d1"), ben = R.rows.find((r) => r.id === "d2");
  same({ ...ana.b }, { current: 300, d30: 0, d60: 500, d90: 50, d90p: 600, disputed: 0 });
  assert.equal(ana.balance, 1450);
  assert.equal(ben.credit, 200);
  assert.equal(ben.balance, -200);
  assert.ok(!R.rows.some((r) => r.id === "d3"), "nothing owed, not listed");
  assert.equal(R.ok, true, "buckets − credit = balance for every dealer");
});

test("a statement for a period carries the balance forward and lists what is unpaid", () => {
  const txns = { a: sale("2026-06-01", "2026-07-01", 1000, { no: "DR-1" }), b: sale("2026-09-04", "2026-09-24", 500, { no: "DR-2" }),
    c: sale("2026-10-29", "2026-11-28", 300, { no: "DR-3" }), p: pay("2026-10-31", 400, { no: "OR-1" }) };
  const L = load(["AGE_B", "ageKey", "agingFor", "periodStatement"], { txns, dealers: { d1: { name: "Ana" } } });
  const st = L.periodStatement("d1", "2026-08-25", "2026-11-03");
  assert.equal(st.opening, 1000);
  same(st.rows.map((r) => [r.tid, r.run]), [["b", 1500], ["c", 1800], ["p", 1400]]);
  assert.equal(st.charges, 800);
  assert.equal(st.credits, 400);
  assert.equal(st.closing, 1400);
  assert.equal(st.overdue, 1100);
  same(st.ag.open.map((o) => o.tid), ["a", "b", "c"]);
});

test("dealer names keep first, middle and last parts, including compound surnames", () => {
  const L = load(["nameParts", "fullName"]);
  same(L.nameParts({ name: "Juana Dela Cruz" }), { first: "Juana", middle: "", last: "Dela Cruz" });
  same(L.nameParts({ name: "Juana Santos Dela Cruz" }), { first: "Juana", middle: "Santos", last: "Dela Cruz" });
  same(L.nameParts({ name: "Maria S. Dela Cruz" }), { first: "Maria", middle: "S.", last: "Dela Cruz" });
  same(L.nameParts({ name: "Maria Dela Cruz Santos" }), { first: "Maria", middle: "Dela Cruz", last: "Santos" });
  same(L.nameParts({ name: "Pedro Santos Jr." }), { first: "Pedro", middle: "", last: "Santos Jr." });
  same(L.nameParts({ name: "Madonna" }), { first: "Madonna", middle: "", last: "" });
  same(L.nameParts({ firstName: "Ana", lastName: "Reyes", name: "Old Name" }), { first: "Ana", middle: "", last: "Reyes" });
  assert.equal(L.fullName("  Ana ", "S.", "Reyes"), "Ana S. Reyes");
});

test("deep links open the right dealer, product or document", () => {
  const L = load(["VIEWS", "DEEP_KINDS", "hashTarget"]);
  same(L.hashTarget("#dealers"), { view: "dealers" });
  same(L.hashTarget("#dealer/d1"), { kind: "dealer", id: "d1" });
  same(L.hashTarget("#product/p%201"), { kind: "product", id: "p 1" });
  same(L.hashTarget("#receipt/tx_9"), { kind: "receipt", id: "tx_9" });
  same(L.hashTarget("#statement/d1"), { kind: "statement", id: "d1" });
  same(L.hashTarget("#aging"), { kind: "aging" });
  same(L.hashTarget("#aging/d1"), { kind: "aging", id: "d1" });
  same(L.hashTarget("#summary"), { kind: "summary" });
  assert.equal(L.hashTarget("#nonsense/x"), null);
  assert.equal(L.hashTarget(""), null);
});

test("the payment form's allocation preview matches the chosen deliveries", () => {
  const L = load(["allocate"]);
  const open = [{ id: "a", t: { no: "DR-1" }, rem: 100 }, { id: "b", t: { no: "DR-2" }, rem: 200 }, { id: "c", t: { no: "DR-3" }, rem: 300 }];
  const plain = L.allocate(open, 250);
  same(plain.lines.map((l) => [l.id, l.amount, l.left]), [["a", 100, 0], ["b", 150, 50]]);
  const chosen = L.allocate(open, 250, new Map([["c", 200]]));
  same(chosen.lines.map((l) => [l.id, l.amount, l.chosen]), [["a", 50, false], ["c", 200, true]]);
  assert.equal(L.allocate(open, 700).extra, 100, "more than owed is kept as credit");
});

test("the dealer form finds existing dealers by mobile, email and name", () => {
  const L = load(["normText", "phoneKey", "sameWords", "oneEditApart", "nearText", "rankMatches", "findDealerMatches"]);
  const dealers = new Map(Object.entries({
    a: { name: "Juana Santos Dela Cruz", phone: "+63 917 123 4567", email: "Juana@Example.com" },
    b: { name: "Peña Reyes", phone: "", active: false },
    c: { name: "Removed person", phone: "0917 999 0000", anonymised: { at: 1 } },
  }));
  const find = (form, except) => L.findDealerMatches(dealers, form, except).map((m) => [m.id, m.strong, m.why.map((y) => y.what).join()]);
  same(find({ phone: "0917-123-4567" }), [["a", true, "mobile number"]]);
  same(find({ email: " juana@example.COM " }), [["a", true, "email"]]);
  same(find({ name: "JUANA santos dela cruz" }), [["a", true, "name"]]);
  same(find({ name: "Dela Cruz, Juana Santos" }), [["a", true, "name"]], "word order doesn't matter");
  same(find({ name: "Pena Reyes" }), [["b", true, "name"]], "accents don't matter");
  same(find({ name: "Juana Dela Cruz" }), [["a", false, "name"]], "missing middle name is only similar");
  same(find({ name: "Juana Santos Dela Cruzz" }), [["a", false, "name"]], "one typo is only similar");
  same(find({ name: "Pedro Dela Cruz", phone: "123" }), [], "other people and short numbers don't match");
  same(find({ phone: "0917 999 0000" }), [], "anonymised records are skipped");
  same(find({ name: "Juana Santos Dela Cruz" }, "a"), [], "a record doesn't match itself");
});

test("the product form finds existing products by code and name, without mixing up sizes", () => {
  const L = load(["normText", "sameWords", "oneEditApart", "nearText", "rankMatches", "productWords", "findProductMatches"]);
  const products = new Map(Object.entries({
    a: { name: "Dishwashing Liquid 1L", code: "DW-100" },
    b: { name: "Hand Soap", code: "" },
  }));
  const find = (form, except) => L.findProductMatches(products, form, except).map((m) => [m.id, m.strong]);
  same(find({ code: "dw 100" }), [["a", true]]);
  same(find({ name: "dishwashing liquid 1 l" }), [["a", true]], "1 L is the same size as 1L");
  same(find({ name: "Dishwashing Liquid" }), [["a", false]], "a name without the size is only similar");
  same(find({ name: "Dishwashng Liquid 1L" }), [["a", false]], "one typo is only similar");
  same(find({ name: "Dishwashing Liquid 2L" }), [], "another size is a different product");
  same(find({ name: "Soap" }), [], "one shared word isn't enough");
  same(find({ code: "" }), [], "blank codes never match");
  same(find({ name: "Dishwashing Liquid 1L" }, "a"), [], "a record doesn't match itself");
});

test("age is worked out from the birthday and turns on the day", () => {
  const { ageOn } = require("../lib/credit");
  assert.equal(ageOn("1990-05-05", "2026-05-04"), 35);
  assert.equal(ageOn("1990-05-05", "2026-05-05"), 36);
  assert.equal(ageOn("", "2026-05-05"), null);
  assert.equal(ageOn("2030-01-01", "2026-05-05"), null);
});

test("the dealer portal uses the shared balance rules, with no copy of its own", () => {
  const portal = fs.readFileSync(path.join(__dirname, "..", "public", "portal.html"), "utf8");
  assert.match(portal, /<script src="\/credit\.js">/);
  assert.match(portal, /Credit\.settleEntries\(/);
  assert.doesNotMatch(portal, /while\(c>0\.004/, "the portal must not settle balances by itself");
});
