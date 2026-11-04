"use strict";
// Functional tests of payment plans, late fees, costing, batches, delivery, tax documents,
// credit applications and disputes, through the real API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../lib/app");
const { today, dealerStatus, settle } = require("../lib/credit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-fin-"));
const h = createApp({ dataDir: dir, logger: { error() {} } });
let server, base;
const day = (n) => { const d = new Date(today() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function client() {
  let cookie = "";
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
}
const owner = client(), staff = client(), viewer = client(), portal = client(), other = client();
const all = async (c, who = owner) => (await who("GET", "/api/c/" + c)).data;
const doc = async (c, id, who = owner) => (await all(c, who)).find((d) => d.id === id)?.data;
const txnsOf = async (id) => (await all("txns")).filter((t) => t.data.dealerId === id).map((t) => ({ ...t.data, _id: t.id }));
const status = async (id) => dealerStatus(await txnsOf(id));
const dealer = (id, extra = {}) => owner("PUT", "/api/c/dealers/" + id, { data: { name: `Dealer ${id}`, terms: 30, creditLimit: 900000, ...extra } });
const product = (id, extra = {}) => owner("PUT", "/api/c/products/" + id, { data: { name: `Item ${id}`, dealerPrice: 75, srp: 100, cost: 40, stock: 100, active: true, ...extra } });
const debt = (id, dealerId, amount, due = day(-10)) => owner("PUT", "/api/c/txns/" + id, { data: { type: "sale", opening: true, dealerId, date: day(-40), dueDate: due, amount } });
const pay = (id, dealerId, amount) => owner("PUT", "/api/c/txns/" + id, { data: { type: "payment", dealerId, date: today(), amount, method: "Cash" } });
const store = async (patch) => owner("PUT", "/api/c/settings/store", { data: { ...(await doc("settings", "store")), ...patch } });
const sale = (who, id, dealerId, productId, qty = 1, extra = {}) => who("PUT", "/api/c/txns/" + id, { data: { type: "sale", dealerId, date: today(), dueDate: day(30), items: [{ productId, name: "x", qty, price: 100, pct: 25 }], ...extra } });

test.before(async () => {
  server = h.app.listen(0); await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await owner("POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" });
  await owner("POST", "/api/users", { name: "Sam", username: "sam", password: "password1", role: "staff" });
  await owner("POST", "/api/users", { name: "Val", username: "val", password: "password1", role: "viewer" });
  await staff("POST", "/api/login", { username: "sam", password: "password1" });
  await viewer("POST", "/api/login", { username: "val", password: "password1" });
  await owner("PUT", "/api/c/settings/store", { data: { storeName: "Test", discountPct: 25 } });
  await dealer("pd"); await dealer("xd");
  await owner("POST", "/api/users", { name: "PD", username: "pdealer", password: "password1", role: "dealer", dealerId: "pd" });
  await owner("POST", "/api/users", { name: "XD", username: "xdealer", password: "password1", role: "dealer", dealerId: "xd" });
  await portal("POST", "/api/login", { username: "pdealer", password: "password1" });
  await other("POST", "/api/login", { username: "xdealer", password: "password1" });
});
test.after(() => { server.closeAllConnections(); server.close(); h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("a payment plan replaces the due date, and only missed installments are late (FR-010)", async () => {
  await dealer("a1"); await debt("a-s", "a1", 900, day(-100));
  assert.ok((await status("a1")).maxLate >= 100, "late before the plan");
  const plan = (body, who = owner) => who("POST", "/api/plans", { txnId: "a-s", frequency: "monthly", ...body });
  assert.equal((await plan({ count: 3, start: day(5) }, staff)).status, 403);
  assert.equal((await plan({ count: 1, start: day(5) })).status, 400);
  assert.equal((await plan({ count: 61, start: day(5) })).status, 400);
  assert.equal((await plan({ count: 3, start: "soon" })).status, 400);
  assert.equal((await plan({ count: 3, start: day(5), frequency: "yearly" })).status, 400);
  assert.equal((await plan({ count: 3, start: day(5) })).status, 200);
  assert.equal((await plan({ count: 3, start: day(5) })).status, 409, "one plan per charge");
  assert.deepEqual(await status("a1"), { balance: 900, overdue: 0, maxLate: 0 }, "nothing is late yet");
  const t = await doc("txns", "a-s");
  assert.equal(t.plan.schedule.reduce((a, i) => a + i.amount, 0), 900);

  // A plan that started in the past has missed installments, and only those count.
  await dealer("a2"); await debt("a2-s", "a2", 900, day(-100));
  await owner("POST", "/api/plans", { txnId: "a2-s", count: 3, frequency: "weekly", start: day(-8) });
  const st = await status("a2");
  assert.equal(st.overdue, 600, "two weekly installments are past due");
  assert.equal(st.maxLate, 8);
  await pay("a2-p", "a2", 300);
  assert.equal((await status("a2")).overdue, 300, "a payment clears the oldest installment first");
  assert.equal((await status("a2")).maxLate, 1);

  const data = await doc("txns", "a2-s");
  await owner("PUT", "/api/c/txns/a2-s", { data: { ...data, plan: null, note: "edited" } });
  assert.ok((await doc("txns", "a2-s")).plan, "an edit can't remove the plan");
  assert.equal((await owner("POST", "/api/plans/a2-s/cancel", {})).status, 200);
  assert.ok((await status("a2")).maxLate >= 100, "cancelling restores the original due date");
  assert.equal((await owner("POST", "/api/plans/a2-s/cancel", {})).status, 404);
});

test("a paid or voided charge can't go on a plan", async () => {
  await dealer("a3"); await debt("a3-s", "a3", 100); await pay("a3-p", "a3", 100);
  assert.equal((await owner("POST", "/api/plans", { txnId: "a3-s", count: 2, frequency: "weekly", start: day(1) })).status, 409);
  assert.equal((await owner("POST", "/api/plans", { txnId: "nope", count: 2, frequency: "weekly", start: day(1) })).status, 404);
});

test("late fees are previewed, charged once, and follow the policy (FR-011)", async () => {
  await dealer("b1"); await debt("b-s", "b1", 1000, day(-45));
  assert.deepEqual((await owner("GET", "/api/latefees")).data, [], "no policy, no fees");
  await store({ lateFee: { ratePct: 2, graceDays: 15, compounding: "simple" } });
  const preview = (await owner("GET", "/api/latefees")).data.find((f) => f.txnId === "b-s");
  assert.equal(preview.fee, 20, "30 days after grace is one month at 2%");
  assert.equal(await (await txnsOf("b1")).length, 1, "a preview charges nothing");
  assert.equal((await staff("GET", "/api/latefees")).status, 403);
  assert.equal((await staff("POST", "/api/latefees/post", { txnIds: ["b-s"] })).status, 403);
  const r = await owner("POST", "/api/latefees/post", { txnIds: ["b-s"] });
  assert.equal(r.data.posted.length, 1);
  const fee = (await txnsOf("b1")).find((t) => t.lateFeeFor === "b-s");
  assert.equal(fee.type, "adjustment"); assert.equal(fee.direction, "debit"); assert.equal(fee.amount, 20);
  assert.equal((await status("b1")).balance, 1020);
  assert.equal((await owner("GET", "/api/latefees")).data.some((f) => f.txnId === "b-s"), false, "not charged twice");
  assert.equal((await owner("GET", "/api/latefees")).data.some((f) => f.txnId === fee._id), false, "no fee on a fee");
  assert.deepEqual((await owner("POST", "/api/latefees/post", { txnIds: ["b-s"] })).data.posted, []);
  await store({ lateFee: { ratePct: 2, graceDays: 15, compounding: "monthly" } });
  await dealer("b2"); await debt("b2-s", "b2", 1000, day(-75));
  assert.equal((await owner("GET", "/api/latefees")).data.find((f) => f.txnId === "b2-s").fee, 40.4, "compounded over two months");
  await store({ lateFee: { ratePct: 0, graceDays: 0, compounding: "simple" } });
});

test("disputed amounts don't count as overdue, and resolving follows the decision (FR-080)", async () => {
  await debt("c-s", "pd", 500, day(-90));
  const start = (body, who = portal) => who("POST", "/api/disputes", { txnId: "c-s", reason: "wrong price", amount: 200, ...body });
  assert.equal((await start({ reason: "because" })).status, 400);
  assert.equal((await start({ amount: 0 })).status, 400);
  assert.equal((await start({ amount: 501 })).status, 400);
  assert.equal((await start({}, other)).status, 403, "another dealer's charge");
  assert.equal((await start({}, viewer)).status, 403);
  const d = await start({ note: "Agreed ₱300" });
  assert.equal(d.status, 200);
  assert.equal((await start({})).status, 409, "one open dispute per charge");
  const st = await status("pd");
  assert.equal(st.balance, 500, "the balance itself doesn't change");
  assert.equal(st.overdue, 300, "the disputed part isn't overdue");
  assert.equal((await all("disputes", other)).length, 0);
  assert.equal((await all("disputes", viewer)).length, 0);
  assert.equal((await staff("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "accepted", note: "ok" })).status, 403, "only the owner gives credit");
  assert.equal((await owner("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "accepted" })).status, 400);
  const yes = await owner("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "accepted", note: "Price was ₱300" });
  assert.match(yes.data.credit.no, /^ADJ-/);
  assert.equal((await status("pd")).balance, 300);
  assert.equal((await doc("txns", "c-s")).disputed, undefined);
  assert.equal((await owner("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "rejected", note: "x" })).status, 409, "resolved once");
  assert.equal((await doc("disputes", d.data.id, portal)).resolution, "Price was ₱300");

  const again = await start({ amount: 300 }, staff.bind ? staff : staff);
  assert.equal(again.status, 400, "staff name the dealer");
  const open = await staff("POST", "/api/disputes", { dealerId: "pd", txnId: "c-s", reason: "other", amount: 300 });
  assert.equal(open.status, 200, "staff can open one for a dealer");
  assert.equal((await status("pd")).overdue, 0, "a fully disputed charge isn't overdue");
  assert.equal((await status("pd")).maxLate, 0, "and doesn't cause a credit hold");
  assert.equal((await staff("POST", `/api/disputes/${open.data.id}/resolve`, { outcome: "rejected", note: "Checked delivery" })).status, 200);
  assert.ok((await status("pd")).maxLate > 80, "a rejected dispute counts again");
});

test("a dispute doesn't get a late fee, and a disputed charge can't be hidden by editing", async () => {
  await store({ lateFee: { ratePct: 2, graceDays: 0, compounding: "simple" } });
  await dealer("c2"); await debt("c2-s", "c2", 100, day(-40));
  const d = await staff("POST", "/api/disputes", { dealerId: "c2", txnId: "c2-s", reason: "other", amount: 100 });
  assert.equal((await owner("GET", "/api/latefees")).data.some((f) => f.txnId === "c2-s"), false);
  const t = await doc("txns", "c2-s");
  await owner("PUT", "/api/c/txns/c2-s", { data: { ...t, disputed: 1 } });
  assert.equal((await doc("txns", "c2-s")).disputed, 100);
  await staff("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "rejected", note: "No" });
  await store({ lateFee: { ratePct: 0, graceDays: 0, compounding: "simple" } });
});

test("credit applications set the limit and log the change (FR-074)", async () => {
  const apply = (who, body) => who("POST", "/api/creditapps", { limit: 20000, references: "Ana, 0917", ...body });
  assert.equal((await apply(portal, { limit: 0 })).status, 400);
  assert.equal((await apply(viewer, { dealerId: "pd" })).status, 403);
  const a = await apply(portal, {});
  assert.equal(a.status, 200);
  assert.equal((await apply(portal, {})).status, 409, "one at a time");
  assert.equal((await all("creditapps", other)).length, 0);
  assert.equal((await staff("POST", `/api/creditapps/${a.data.id}/approve`, {})).status, 403);
  assert.equal((await owner("POST", `/api/creditapps/${a.data.id}/approve`, { limit: 15000, nextReview: day(180) })).status, 200);
  const d = await doc("dealers", "pd");
  assert.equal(d.creditLimit, 15000);
  assert.equal(d.nextReview, day(180));
  assert.equal(d.limitHistory.at(-1).to, 15000);
  assert.equal(d.limitHistory.at(-1).from, 900000);
  assert.equal((await owner("POST", `/api/creditapps/${a.data.id}/approve`, {})).status, 409);
  const b = await apply(portal, {});
  assert.equal((await owner("POST", `/api/creditapps/${b.data.id}/reject`, {})).status, 400);
  assert.equal((await owner("POST", `/api/creditapps/${b.data.id}/reject`, { reason: "Too soon" })).status, 200);
  assert.equal((await doc("dealers", "pd")).creditLimit, 15000);
  assert.equal((await owner("POST", "/api/dealers/pd/review", { limit: 18000, nextReview: "x" })).status, 400);
  assert.equal((await staff("POST", "/api/dealers/pd/review", { limit: 18000, nextReview: day(90) })).status, 403);
  assert.equal((await owner("POST", "/api/dealers/pd/review", { limit: 18000, nextReview: day(90) })).status, 200);
  assert.equal((await doc("dealers", "pd")).limitHistory.at(-1).reason, "Limit review");
});

test("delivery is separate from payment and visible to the dealer (FR-033)", async () => {
  await product("d-p");
  const made = await portal("PUT", "/api/c/orders/o1", { data: { items: [{ productId: "d-p", qty: 1 }] } });
  assert.equal(made.status, 200);
  const send = (body, who = staff) => who("POST", "/api/orders/o1/delivery", { driver: "Rey", vehicle: "ABC 123", date: today(), status: "out", ...body });
  assert.equal((await send({})).status, 409, "only after release");
  const o = await doc("orders", "o1");
  await staff("PUT", "/api/c/orders/o1", { data: { ...o, status: "released" } });
  assert.equal((await send({ driver: "" })).status, 400);
  assert.equal((await send({ status: "lost" })).status, 400);
  assert.equal((await send({ date: "x" })).status, 400);
  assert.equal((await send({}, viewer)).status, 403);
  assert.equal((await send({})).status, 200);
  assert.equal((await send({ status: "delivered", remarks: "Signed by Ana" })).status, 200);
  const seen = await doc("orders", "o1", portal);
  assert.equal(seen.delivery.status, "delivered");
  assert.equal(seen.deliveryLog.length, 2);
  assert.equal(seen.status, "released", "the order status is unchanged");
  await staff("PUT", "/api/c/orders/o1", { data: { ...seen, delivery: null } });
  assert.equal((await doc("orders", "o1")).delivery.status, "delivered", "an order edit can't erase it");
});

test("weighted-average costing blends each receipt (FR-023)", async () => {
  await store({ costing: "average" });
  await owner("PUT", "/api/c/suppliers/s1", { data: { name: "Acme" } });
  await product("e1", { stock: 10, cost: 40 });
  await owner("PUT", "/api/c/purchases/e-po", { data: { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "e1", qty: 10, cost: 60 }] } });
  await owner("POST", "/api/purchases/e-po/receive", { lines: [{ productId: "e1", qty: 10 }] });
  assert.equal((await doc("products", "e1")).cost, 50);
  await dealer("e-d");
  await sale(owner, "e-s", "e-d", "e1", 1);
  assert.equal((await doc("txns", "e-s")).items[0].cost, 50, "sales use the average");
});

test("FIFO costing uses the oldest cost first, and a void puts it back (FR-023)", async () => {
  await store({ costing: "fifo" });
  await product("f1", { stock: 0, cost: 0 });
  await owner("PUT", "/api/c/purchases/f-a", { data: { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "f1", qty: 5, cost: 10 }] } });
  await owner("POST", "/api/purchases/f-a/receive", { lines: [{ productId: "f1", qty: 5 }] });
  await owner("PUT", "/api/c/purchases/f-b", { data: { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "f1", qty: 5, cost: 20 }] } });
  await owner("POST", "/api/purchases/f-b/receive", { lines: [{ productId: "f1", qty: 5 }] });
  await dealer("f-d");
  await sale(owner, "f-s1", "f-d", "f1", 3);
  assert.equal((await doc("txns", "f-s1")).items[0].cost, 10);
  await sale(owner, "f-s2", "f-d", "f1", 4);
  assert.equal((await doc("txns", "f-s2")).items[0].cost, 15, "2 at ₱10 and 2 at ₱20");
  assert.deepEqual((await doc("products", "f1")).layers.map((l) => [l.qty, l.cost]), [[3, 20]]);
  assert.equal((await doc("products", "f1", staff)).layers, undefined, "cost layers stay private");
  const t = await doc("txns", "f-s2");
  await owner("PUT", "/api/c/txns/f-s2", { data: { ...t, voided: true } });
  assert.equal((await doc("products", "f1")).layers.reduce((a, l) => a + l.qty, 0), 7, "layers match the stock again");
  assert.equal((await doc("products", "f1")).stock, 7);
  await store({ costing: "latest" });
});

test("lots are recorded on receipt and sold by earliest expiry (FR-024)", async () => {
  await product("g1", { stock: 0, batchTracked: true });
  await owner("PUT", "/api/c/purchases/g-a", { data: { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "g1", qty: 20, cost: 10 }] } });
  const rc = (qty, lot, expiry) => owner("POST", "/api/purchases/g-a/receive", { lines: [{ productId: "g1", qty, lot, expiry }] });
  assert.equal((await rc(5, "", day(10))).status, 400, "a lot number is required");
  assert.equal((await rc(5, "L1", "")).status, 400, "an expiry date is required");
  assert.equal((await doc("products", "g1")).stock, 0, "a refused receipt adds no stock");
  assert.equal((await rc(5, "LATE", day(300))).status, 200);
  assert.equal((await rc(5, "SOON", day(20))).status, 200);
  await dealer("g-d");
  await sale(owner, "g-s", "g-d", "g1", 6);
  assert.deepEqual((await doc("products", "g1")).batches.map((b) => [b.lot, b.qty]), [["LATE", 4]], "the earliest expiry goes first");
  const t = await doc("txns", "g-s");
  await owner("PUT", "/api/c/txns/g-s", { data: { ...t, voided: true } });
  const back = (await doc("products", "g1")).batches;
  assert.deepEqual(back.find((b) => b.lot === "RETURNED").qty, 6, "stock that comes back is listed for checking");
  const p = await doc("products", "g1");
  await staff("PUT", "/api/c/products/g1", { data: { ...p, batches: [], batchTracked: false } });
  assert.equal((await doc("products", "g1")).batchTracked, true, "staff can't change tracking");
  assert.equal((await doc("products", "g1")).batches.length, 2, "lots can't be edited");
});

test("VAT is worked out on sales, and invoice numbers have no gaps (FR-069)", async () => {
  await dealer("h-d");
  await product("h1"); await product("h2", { taxClass: "exempt" }); await product("h3", { taxClass: "zero" });
  await sale(owner, "h-0", "h-d", "h1");
  assert.equal((await doc("txns", "h-0")).tax, undefined, "no VAT until registered");
  await store({ tax: { tin: "123-456", vatRegistered: true, permit: "P1", series: { prefix: "si", from: 95, to: 97, atp: "ATP-1" } } });
  assert.equal((await doc("settings", "store")).tax.series.prefix, "SI");
  await sale(staff, "h-a", "h-d", "h1", 1);
  const a = await doc("txns", "h-a");
  assert.equal(a.amount, 75);
  assert.deepEqual(a.tax, { vatable: 66.96, vat: 8.04, exempt: 0, zero: 0 });
  assert.equal(a.invoiceNo, "SI-000095");
  const mixed = await owner("PUT", "/api/c/txns/h-b", { data: { type: "sale", dealerId: "h-d", date: today(), dueDate: day(30), items: ["h1", "h2", "h3"].map((p) => ({ productId: p, name: p, qty: 1, price: 100, pct: 25 })) } });
  const t = mixed.data.data;
  assert.equal(t.tax.exempt, 75); assert.equal(t.tax.zero, 75);
  assert.equal(r2sum(t.tax), t.amount, "the parts add up to the total");
  assert.equal(t.invoiceNo, "SI-000096");

  // A refused sale uses no number.
  assert.equal((await sale(owner, "h-c", "h-d", "h1", 5000)).status, 409);
  assert.equal((await doc("settings", "store")).tax.lastInvoice, 96, "the failed sale didn't use a number");

  // A void keeps its number; a client can't choose one or edit it.
  await owner("PUT", "/api/c/txns/h-a", { data: { ...a, voided: true } });
  assert.equal((await doc("txns", "h-a")).invoiceNo, "SI-000095");
  const pick = await sale(owner, "h-e", "h-d", "h1", 1, { invoiceNo: "SI-000500" });
  assert.equal(pick.data.data.invoiceNo, "SI-000097");
  assert.equal((await sale(owner, "h-f", "h-d", "h1")).data.code, "series_full");

  // Saving other settings can't move the counter or swap the series.
  await store({ storeName: "Renamed", tax: { tin: "999", vatRegistered: true, series: { prefix: "XX", from: 1, to: 9 } } });
  const x = (await doc("settings", "store")).tax;
  assert.equal(x.lastInvoice, 97); assert.equal(x.series.prefix, "SI"); assert.equal(x.tin, "999");
  await owner("PUT", "/api/c/settings/store", { data: { storeName: "No tax field" } });
  assert.equal((await doc("settings", "store")).tax.lastInvoice, 97, "a partial save keeps the counter");
  await store({ tax: { tin: "", vatRegistered: false } });
});
const r2sum = (t) => Math.round((t.vatable + t.vat + t.exempt + t.zero) * 100) / 100;

test("a full backup keeps every new record", async () => {
  const b = await owner("GET", "/api/backup/full");
  for (const c of ["disputes", "creditapps"]) assert.ok(b.data.collections[c].length, c);
});

test("personal-data export includes disputes and applications", async () => {
  const ex = await owner("GET", "/api/dealers/pd/export");
  assert.ok(ex.data.disputes.length >= 2);
  assert.ok(ex.data.creditApplications.length >= 2);
  assert.ok(Array.isArray(ex.data.proofsOfPayment));
  assert.ok(Array.isArray(ex.data.reminders));
});
