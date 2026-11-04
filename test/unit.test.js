"use strict";
// Unit tests: pure functions, with no server or database.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/credit");
const F = require("../lib/finance");

const sale = (id, date, amount, extra = {}) => ({ _id: id, type: "sale", date, dueDate: date, amount, ...extra });
const pay = (id, date, amount, extra = {}) => ({ _id: id, type: "payment", date, amount, ...extra });

test("r2 rounds to centavos and survives bad input", () => {
  assert.equal(C.r2(0.1 + 0.2), 0.3);
  assert.equal(C.r2(100.5), 100.5);
  assert.equal(C.r2("12.34"), 12.34);
  for (const bad of [null, undefined, "abc", NaN, {}]) assert.equal(C.r2(bad), 0);
});

test("r2 never gives negative zero", () => {
  assert.ok(Object.is(C.r2(-0.001), 0));
  assert.ok(Object.is(C.r2(0.3 - 0.1 - 0.1 - 0.1), 0));
});

test("validDay accepts only real calendar days", () => {
  for (const ok of ["2026-02-28", "2024-02-29", "2026-12-31"]) assert.equal(C.validDay(ok), true, ok);
  for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-1", "soon", "", null, 5, {}, "2026-02-28T00:00:00Z"]) assert.equal(C.validDay(bad), false, String(bad));
});

test("charges add to the balance; everything else reduces it", () => {
  assert.equal(C.txnEffect({ type: "sale", amount: 100 }), 100);
  assert.equal(C.txnEffect({ type: "adjustment", direction: "debit", amount: 100 }), 100);
  for (const t of [{ type: "payment" }, { type: "return" }, { type: "writeoff" }, { type: "adjustment", direction: "credit" }]) assert.equal(C.txnEffect({ ...t, amount: 100 }), -100);
  assert.equal(C.txnEffect({ type: "sale", amount: 100, voided: true }), 0);
  assert.equal(C.txnEffect(null), 0);
});

test("a post-dated check counts only from its date or once cleared", () => {
  const t = { type: "payment", amount: 5, check: { status: "pending", date: "2026-06-10" } };
  assert.equal(C.counts(t, "2026-06-09"), false);
  assert.equal(C.counts(t, "2026-06-10"), true);
  assert.equal(C.counts({ ...t, check: { ...t.check, status: "cleared" } }, "2026-01-01"), true);
  assert.equal(C.counts({ ...t, voided: true }, "2027-01-01"), false);
  assert.equal(C.counts(null), false);
});

test("payments settle the oldest delivery first and extra becomes credit", () => {
  const r = C.settle([sale("b", "2026-02-01", 100), pay("p", "2026-03-01", 130), sale("a", "2026-01-01", 100)]);
  assert.deepEqual(r.open.map((o) => [o.id, o.rem]), [["b", 70]]);
  assert.equal(r.balance, 70);
  const more = C.settle([sale("a", "2026-01-01", 100), pay("p", "2026-01-02", 150)]);
  assert.equal(more.credit, 50);
  assert.equal(more.balance, -50);
});

test("a chosen delivery is paid first", () => {
  const r = C.settle([sale("a", "2026-01-01", 100), sale("b", "2026-02-01", 100), pay("p", "2026-03-01", 100, { alloc: [{ id: "b", amount: 100 }] })]);
  assert.deepEqual(r.open.map((o) => o.id), ["a"]);
});

test("dueParts: plain, disputed and fully disputed charges", () => {
  const t = { amount: 100, dueDate: "2026-01-01" };
  assert.deepEqual(C.dueParts(t, 100), [{ due: "2026-01-01", amount: 100 }]);
  assert.deepEqual(C.dueParts({ ...t, disputed: 40 }, 100), [{ due: "2026-01-01", amount: 60 }]);
  assert.deepEqual(C.dueParts({ ...t, disputed: 100 }, 100), []);
  assert.deepEqual(C.dueParts({ ...t, disputed: 500 }, 100), []);
});

test("dueParts: a plan drops installments as they are paid", () => {
  const plan = { base: 0, schedule: [{ due: "2026-01-01", amount: 100 }, { due: "2026-02-01", amount: 100 }, { due: "2026-03-01", amount: 100 }] };
  const t = { amount: 300, plan };
  assert.equal(C.dueParts(t, 300).length, 3);
  assert.deepEqual(C.dueParts(t, 150), [{ due: "2026-02-01", amount: 50 }, { due: "2026-03-01", amount: 100 }]);
  assert.deepEqual(C.dueParts(t, 0), []);
  assert.deepEqual(C.dueParts({ ...t, plan: { ...plan, base: 60 }, amount: 360 }, 300).map((p) => p.amount), [100, 100, 100], "what was paid before the plan doesn't count");
});

test("dueSummary splits overdue from what's coming", () => {
  const open = [{ t: { dueDate: "2026-01-01" }, rem: 10 }, { t: { dueDate: "2026-03-01" }, rem: 20 }, { t: { dueDate: "2026-02-20" }, rem: 5 }];
  assert.deepEqual(C.dueSummary(open, "2026-02-10"), { overdue: 10, maxLate: 40, nextDue: "2026-02-20" });
  assert.deepEqual(C.dueSummary([], "2026-02-10"), { overdue: 0, maxLate: 0, nextDue: null });
});

test("splitName keeps Filipino surnames and suffixes", () => {
  const s = (n) => Object.values(C.splitName(n));
  assert.deepEqual(s("Juana Dela Cruz"), ["Juana", "", "Dela Cruz"]);
  assert.deepEqual(s("Juana Santos Dela Cruz"), ["Juana", "Santos", "Dela Cruz"]);
  assert.deepEqual(s("Maria Dela Cruz Santos"), ["Maria", "Dela Cruz", "Santos"]);
  assert.deepEqual(s("Pedro Santos Jr."), ["Pedro", "", "Santos Jr."]);
  assert.deepEqual(s("Ana Maria De Los Santos"), ["Ana", "Maria", "De Los Santos"]);
  assert.deepEqual(s("Madonna"), ["Madonna", "", ""]);
  assert.deepEqual(s(""), ["", "", ""]);
  assert.deepEqual(s(null), ["", "", ""]);
});

test("ageOn turns over on the birthday, including 29 February", () => {
  assert.equal(C.ageOn("2000-02-29", "2024-02-28"), 23);
  assert.equal(C.ageOn("2000-02-29", "2024-02-29"), 24);
  assert.equal(C.ageOn("2000-02-29", "2023-03-01"), 23);
  assert.equal(C.ageOn("2030-01-01", "2026-01-01"), null);
  assert.equal(C.ageOn("not a date", "2026-01-01"), null);
});

test("duplicate keys ignore format but not meaning", () => {
  const d = C.dealerKeys, p = C.productKeys;
  assert.equal(d({ name: "Peña  REYES" }).name, d({ name: "reyes, pena" }).name);
  assert.equal(d({ phone: "+63 917 123 4567" })["mobile number"], d({ phone: "0917-123-4567" })["mobile number"]);
  assert.equal(C.phoneKey("123"), "", "too short to be a number");
  assert.equal(d({ email: " A@B.com " }).email, "a@b.com");
  assert.equal(p({ name: "Liquid 1 L" }).name, p({ name: "liquid 1l" }).name);
  assert.notEqual(p({ name: "Liquid 1L" }).name, p({ name: "Liquid 2L" }).name);
  assert.equal(p({ code: "DW-100" }).code, p({ code: "dw 100" }).code);
  assert.equal(p({ barcode: "" }).barcode, "");
});

test("installments add up exactly and cover month ends", () => {
  const s = F.schedule(100, 3, "monthly", "2026-01-31");
  assert.deepEqual(s.map((i) => i.due), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.deepEqual(s.map((i) => i.amount), [33.33, 33.33, 33.34]);
  assert.deepEqual(F.schedule(10, 2, "weekly", "2026-12-28").map((i) => i.due), ["2026-12-28", "2027-01-04"]);
  assert.deepEqual(F.schedule(10, 2, "biweekly", "2026-02-20").map((i) => i.due), ["2026-02-20", "2026-03-06"]);
  assert.equal(F.schedule(100, 2, "monthly", "2024-01-31")[1].due, "2024-02-29", "leap year");
});

test("late fees wait for the grace period, then charge per started month", () => {
  const simple = { ratePct: 2, graceDays: 15, compounding: "simple" };
  assert.equal(F.lateFee(1000, 15, simple), 0);
  assert.equal(F.lateFee(1000, 16, simple), 20);
  assert.equal(F.lateFee(1000, 45, simple), 20);
  assert.equal(F.lateFee(1000, 46, simple), 40);
  assert.equal(F.lateFee(1000, 75, { ...simple, compounding: "monthly" }), 40.4);
  assert.equal(F.lateFee(1000, 100, { ratePct: 0, graceDays: 0 }), 0);
  assert.equal(F.lateFee(1000, 100, {}), 0);
});

test("issueCost: latest and FIFO, with and without layers", () => {
  assert.equal(F.issueCost({ cost: 40 }, 3, "latest"), 40);
  assert.equal(F.issueCost({ cost: null }, 3, "latest"), null);
  const p = { cost: 99, layers: [{ qty: 2, cost: 10 }, { qty: 2, cost: 20 }] };
  assert.equal(F.issueCost(p, 2, "fifo"), 10);
  assert.equal(F.issueCost(p, 4, "fifo"), 15);
  assert.equal(F.issueCost(p, 5, "fifo"), 31.8, "anything beyond the layers uses the product cost");
  assert.equal(F.issueCost({ cost: 7, layers: [] }, 5, "fifo"), 7);
});

test("receiving: latest, average and FIFO", () => {
  assert.equal(F.received({ stock: 10, cost: 40 }, 10, 60, "latest").cost, 60);
  assert.equal(F.received({ stock: 20, cost: 40 }, 10, 70, "average").cost, 55, "stock already includes what arrived");
  assert.equal(F.received({ stock: 5, cost: 0 }, 5, 30, "average").cost, 30, "the first receipt sets the average");
  assert.deepEqual(F.received({ stock: 5, cost: 1 }, 5, 30, "fifo").layers.map((l) => [l.qty, l.cost]), [[5, 30]]);
  assert.deepEqual(F.received({ stock: 1 }, 1, 1, "latest", { lot: "L", expiry: "2027-01-01" }).batches.map((b) => b.lot), ["L"]);
});

test("stockMoved: layers and lots follow the stock", () => {
  const p = { layers: [{ qty: 2, cost: 1 }, { qty: 2, cost: 2 }], batches: [{ lot: "B", expiry: "2027-06-01", qty: 3, receivedAt: 1 }, { lot: "A", expiry: "2027-01-01", qty: 3, receivedAt: 2 }] };
  F.stockMoved(p, -3, {});
  assert.deepEqual(p.layers.map((l) => l.qty), [1]);
  assert.deepEqual(p.batches.map((b) => [b.lot, b.qty]), [["B", 3]], "earliest expiry first");
  const q = { batches: [{ lot: "B", expiry: "2027-06-01", qty: 3, receivedAt: 1 }, { lot: "A", expiry: "2027-01-01", qty: 3, receivedAt: 2 }] };
  F.stockMoved(q, -3, { batchRule: "fifo" });
  assert.deepEqual(q.batches.map((b) => b.lot), ["A"], "oldest received first");
  const r = { cost: 5, batchTracked: true };
  F.stockMoved(r, 2, { costing: "fifo" });
  assert.deepEqual(r.layers, [{ qty: 2, cost: 5 }]);
  assert.equal(r.batches[0].lot, "RETURNED");
  const plain = {}; F.stockMoved(plain, -1, {}); F.stockMoved(plain, 1, {});
  assert.deepEqual(plain, {}, "untracked products are left alone");
});

test("VAT parts always add up, including with a discount", () => {
  const items = [{ productId: "v", qty: 1, price: 100, pct: 0 }, { productId: "e", qty: 1, price: 100, pct: 0 }];
  const cls = (p) => (p === "e" ? "exempt" : "vat");
  assert.deepEqual(F.taxFor({ amount: 200, items }, cls), { vatable: 89.29, vat: 10.71, exempt: 100, zero: 0 });
  assert.deepEqual(F.taxFor({ amount: 100, items }, cls), { vatable: 44.64, vat: 5.36, exempt: 50, zero: 0 }, "a discount is shared");
  assert.deepEqual(F.taxFor({ amount: 0, items: [] }, cls), { vatable: 0, vat: 0, exempt: 0, zero: 0 });
});
