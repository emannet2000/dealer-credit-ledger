"use strict";
// Merging, supplier payments, expenses, stock locations, staff limits, password recovery,
// notifications, monitoring, rate limits and cost privacy, through the real API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../lib/app");
const { today, settle } = require("../lib/credit");
const totp = require("../lib/totp");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-extra-"));
const pushed = [];
let goneEndpoint = null;
const h = createApp({ dataDir: dir, logger: { error() {} }, pushSender: async (sub, payload) => {
  if (sub.endpoint === goneEndpoint) throw Object.assign(new Error("gone"), { statusCode: 410 });
  pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
} });
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
const owner = client(), staff = client(), viewer = client(), portal = client();
const all = async (c, who = owner) => (await who("GET", "/api/c/" + c)).data;
const doc = async (c, id, who = owner) => (await all(c, who)).find((d) => d.id === id)?.data;
const bal = async (id) => settle((await all("txns")).filter((t) => t.data.dealerId === id).map((t) => ({ ...t.data, _id: t.id }))).balance;
const dealer = (id, name, extra = {}) => owner("PUT", "/api/c/dealers/" + id, { data: { name, terms: 30, creditLimit: 900000, ...extra } });
const product = (id, name, extra = {}) => owner("PUT", "/api/c/products/" + id, { data: { name, dealerPrice: 75, srp: 100, cost: 40, stock: 10, active: true, ...extra } });
const debt = (id, dealerId, amount) => owner("PUT", "/api/c/txns/" + id, { data: { type: "sale", opening: true, dealerId, date: day(-20), dueDate: day(10), amount } });

test.before(async () => {
  server = h.app.listen(0); await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await owner("POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" });
  await owner("POST", "/api/users", { name: "Sam", username: "sam", password: "password1", role: "staff" });
  await owner("POST", "/api/users", { name: "Val", username: "val", password: "password1", role: "viewer" });
  await staff("POST", "/api/login", { username: "sam", password: "password1" });
  await viewer("POST", "/api/login", { username: "val", password: "password1" });
  await owner("PUT", "/api/c/settings/store", { data: { storeName: "Test", discountPct: 25 } });
});
test.after(() => { server.closeAllConnections(); server.close(); h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("merging dealers moves everything and adds up the balances", async () => {
  await dealer("a1", "Rosa Lim", { phone: "0917 100 0001" });
  await dealer("a2", "Rosa L. Lim", { email: "rosa@example.com", tags: ["VIP"] });
  await debt("a-s1", "a1", 300); await debt("a-s2", "a2", 200);
  await owner("PUT", "/api/c/interactions/a-i", { data: { dealerId: "a2", kind: "call", date: today(), note: "x" } });
  await owner("POST", "/api/users", { name: "Rosa", username: "rosa", password: "password1", role: "dealer", dealerId: "a2" });
  assert.equal((await staff("POST", "/api/merge/dealers", { keepId: "a1", mergeId: "a2" })).status, 403);
  assert.equal((await owner("POST", "/api/merge/dealers", { keepId: "a1", mergeId: "a1" })).status, 400);
  const r = await owner("POST", "/api/merge/dealers", { keepId: "a1", mergeId: "a2" });
  assert.equal(r.status, 200);
  assert.equal(await bal("a1"), 500);
  assert.equal(await bal("a2"), 0);
  assert.equal((await doc("interactions", "a-i")).dealerId, "a1");
  const keep = await doc("dealers", "a1");
  assert.equal(keep.email, "rosa@example.com", "blanks are filled from the merged record");
  assert.equal(keep.phone, "0917 100 0001");
  assert.deepEqual(keep.tags, ["VIP"]);
  assert.equal((await doc("dealers", "a2")).mergedInto, "a1");
  assert.equal((await owner("POST", "/api/merge/dealers", { keepId: "a1", mergeId: "a2" })).status, 409, "can't merge twice");
  await portal("POST", "/api/login", { username: "rosa", password: "password1" });
  assert.equal((await all("txns", portal)).length, 2, "the portal account moved too");
  assert.equal((await dealer("a3", "Rosa L. Lim")).status, 200, "a merged record no longer blocks its name");
});

test("merging products adds the stock and keeps sales history", async () => {
  await product("b1", "Lotion Big", { stock: 5 }); await product("b2", "Lotion Large", { stock: 7, code: "LX" });
  await dealer("b-d", "Bea Cruz");
  await owner("PUT", "/api/c/txns/b-s", { data: { type: "sale", dealerId: "b-d", date: today(), dueDate: day(30), items: [{ productId: "b2", name: "Lotion Large", qty: 2, price: 100, pct: 25 }] } });
  const r = await owner("POST", "/api/merge/products", { keepId: "b1", mergeId: "b2" });
  assert.equal(r.status, 200);
  assert.equal((await doc("products", "b1")).stock, 10);
  assert.equal((await doc("products", "b1")).code, "LX");
  assert.equal((await doc("products", "b2")).stock, 0);
  assert.equal((await doc("txns", "b-s")).items[0].productId, "b1");
});

test("supplier invoices can be paid in parts and show in the cash count", async () => {
  await product("c1", "Soap");
  await owner("PUT", "/api/c/suppliers/s1", { data: { name: "Acme" } });
  await owner("PUT", "/api/c/purchases/p1", { data: { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "c1", qty: 2, cost: 50 }] } });
  await owner("POST", "/api/purchases/p1/receive", { lines: [{ productId: "c1", qty: 2 }], invoice: { no: "I-1", amount: 100, dueDate: day(10) } });
  const pay = (who, amount) => who("POST", "/api/purchases/p1/pay", { receipt: 0, amount, method: "Cash" });
  assert.equal((await pay(staff, 10)).status, 403);
  assert.equal((await pay(owner, 101)).status, 400);
  assert.equal((await pay(owner, 60)).data.left, 40);
  assert.equal((await pay(owner, 41)).status, 400);
  assert.equal((await pay(owner, 40)).data.left, 0);
  assert.equal((await owner("GET", "/api/cash/day/" + today())).data.expected.Cash, -100, "cash paid out lowers what should be in the till");
});

test("expenses are voided, not deleted, and respect closed days", async () => {
  const save = (who, id, data) => who("PUT", "/api/c/expenses/" + id, { data });
  const e = { date: day(-2), category: "Fuel", amount: 250, method: "Cash", payee: "Shell" };
  assert.equal((await save(staff, "e1", { ...e, amount: 0 })).status, 400);
  assert.equal((await save(staff, "e1", { ...e, category: "" })).status, 400);
  assert.equal((await save(staff, "e1", { ...e, date: day(1) })).status, 400);
  assert.equal((await save(staff, "e1", e)).status, 200);
  assert.equal((await staff("DELETE", "/api/c/expenses/e1")).data.code, "use_void");
  assert.equal((await owner("DELETE", "/api/c/expenses/e1")).data.code, "use_void");
  assert.equal((await owner("GET", "/api/cash/day/" + day(-2))).data.expected.Cash, -250);
  await owner("POST", "/api/cash/close", { date: day(-2), counted: { Cash: -250 } });
  assert.equal((await save(owner, "e1", { ...e, voided: true })).data.code, "day_closed");
  await owner("POST", "/api/cash/reopen", { date: day(-2), reason: "fix" });
  assert.equal((await save(owner, "e1", { ...e, voided: true })).status, 200);
  assert.equal((await owner("GET", "/api/cash/day/" + day(-2))).data.expected.Cash, 0);
});

test("stock moves between locations and sales come from the chosen one", async () => {
  await product("l1", "Shampoo", { stock: 10 });
  await dealer("l-d", "Lita Tan");
  assert.equal((await staff("PUT", "/api/c/locations/van", { data: { name: "Van 1" } })).status, 403);
  await owner("PUT", "/api/c/locations/van", { data: { name: "Van 1" } });
  const move = (qty, from, to) => staff("POST", "/api/stock/transfer", { productId: "l1", from, to, qty });
  assert.equal((await move(11, "", "van")).data.code, "insufficient_stock");
  assert.equal((await move(4, "", "van")).status, 200);
  assert.equal((await doc("products", "l1")).stock, 10, "the total doesn't change");
  assert.deepEqual((await doc("products", "l1")).stockAt, { van: 4 });
  assert.ok((await all("moves")).some((m) => m.data.reason === "Transfer"));
  assert.equal((await owner("DELETE", "/api/c/locations/van")).status, 409);

  const sale = (id, qty, locationId) => owner("PUT", "/api/c/txns/" + id, { data: { type: "sale", dealerId: "l-d", date: today(), dueDate: day(30), locationId, items: [{ productId: "l1", name: "Shampoo", qty, price: 100, pct: 25 }] } });
  assert.equal((await sale("l-s0", 5, "van")).data.code, "insufficient_stock");
  const s = await sale("l-s1", 3, "van");
  assert.equal(s.status, 200);
  assert.deepEqual((await doc("products", "l1")).stockAt, { van: 1 });
  assert.equal((await sale("l-s2", 7)).data.code, "insufficient_stock", "only 6 of the 7 left are at the main store");
  assert.equal((await sale("l-s2", 6)).status, 200);
});

test("main-store sales can't take stock that sits at another location", async () => {
  await product("l2", "Comb", { stock: 5 });
  await owner("POST", "/api/stock/transfer", { productId: "l2", from: "", to: "van", qty: 4 });
  await dealer("l-e", "Lena Go");
  const r = await owner("PUT", "/api/c/txns/l-s3", { data: { type: "sale", dealerId: "l-e", date: today(), dueDate: day(30), items: [{ productId: "l2", name: "Comb", qty: 2, price: 100, pct: 25 }] } });
  assert.equal(r.data.code, "insufficient_stock");
  assert.match(r.data.message, /other locations/);
  const p = await doc("products", "l2");
  await staff("PUT", "/api/c/products/l2", { data: { ...p, stockAt: {} } });
  assert.deepEqual((await doc("products", "l2")).stockAt, { van: 4 }, "stock locations can't be edited directly");
});

test("large voids and discounts by staff need the owner", async () => {
  await dealer("v-d", "Vic Sy");
  await product("v1", "Gift Set", { stock: 50, dealerPrice: 750, srp: 1000 });
  const line = (price, qty = 2) => [{ productId: "v1", name: "Gift Set", qty, price, pct: 25 }];
  const sale = (id, items, extra = {}) => staff("PUT", "/api/c/txns/" + id, { data: { type: "sale", dealerId: "v-d", date: today(), dueDate: day(30), items, ...extra } });
  const big = await sale("v-s1", line(1000));
  assert.equal(big.status, 200);
  const data = await doc("txns", "v-s1");
  const v = await staff("PUT", "/api/c/txns/v-s1", { data: { ...data, voided: true } });
  assert.equal(v.data.code, "needs_approval");
  assert.equal((await staff("POST", "/api/signoffs", { txnId: "v-s1", reason: "x" })).status, 400);
  const ask = await staff("POST", "/api/signoffs", { txnId: "v-s1", reason: "Wrong dealer" });
  assert.equal(ask.status, 200);
  assert.equal((await staff("POST", "/api/signoffs", { txnId: "v-s1", reason: "Again please" })).status, 409);
  assert.equal((await staff("POST", `/api/signoffs/${ask.data.id}/approve`, {})).status, 403);
  const stock = (await doc("products", "v1")).stock;
  assert.equal((await owner("POST", `/api/signoffs/${ask.data.id}/approve`, {})).status, 200);
  assert.equal((await doc("txns", "v-s1")).voided, true);
  assert.equal((await doc("products", "v1")).stock, stock + 2, "stock comes back");
  assert.equal((await owner("POST", `/api/signoffs/${ask.data.id}/approve`, {})).status, 409);

  // Within the limit: a reason is enough.
  assert.equal((await sale("v-s2", line(1000, 1), { discount: 50 })).data.code, "price_reason");
  assert.equal((await sale("v-s2", line(1000, 1), { discount: 50, priceReason: "Damaged" })).status, 200);
  // Over the limit: it goes to the owner, even with a reason.
  const over = await sale("v-s3", line(1000, 1), { discount: 100, priceReason: "Damaged" });
  assert.equal(over.data.code, "needs_approval");
  const sent = { type: "sale", dealerId: "v-d", date: today(), dueDate: day(30), amount: 650, discount: 100, items: line(1000, 1) };
  const req = await staff("POST", "/api/approvals", { sale: sent, reason: "Damaged box" });
  assert.equal(req.status, 200);
  assert.match(req.data.data ? req.data.data.block.discount : (await doc("approvals", req.data.id)).block.discount, /below the price list/);
  assert.equal((await owner("POST", `/api/approvals/${req.data.id}/approve`, {})).status, 200);
  await owner("PUT", "/api/c/settings/store", { data: { ...(await doc("settings", "store")), controls: { voidOver: "", discountOverPct: "" } } });
  assert.equal((await doc("settings", "store")).controls.voidOver, null, "a blank limit means no limit");
  assert.equal((await sale("v-s4", line(1000, 1), { discount: 300, priceReason: "Damaged" })).status, 200);
  await owner("PUT", "/api/c/settings/store", { data: { ...(await doc("settings", "store")), controls: { voidOver: 1000, discountOverPct: 10 } } });
});

test("password help: the owner is told, and recovery codes work", async () => {
  const anon = client();
  const n = pushed.length;
  await owner("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/owner", keys: { p256dh: "a", auth: "b" } } });
  assert.equal((await anon("POST", "/api/password/forgot", { username: "nobody" })).status, 200, "the same answer for unknown names");
  assert.equal((await anon("POST", "/api/password/forgot", { username: "sam" })).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(pushed.slice(n).some((p) => p.title === "Password help needed"));
  assert.equal((await staff("GET", "/api/password/requests")).status, 403);
  const list = (await owner("GET", "/api/password/requests")).data;
  assert.deepEqual(list.map((r) => r.username), ["sam"]);
  await owner("PATCH", "/api/users/" + list[0].id, { password: "password2" });
  assert.equal((await owner("GET", "/api/password/requests")).data.length, 0, "setting a password clears the request");
  await staff("POST", "/api/login", { username: "sam", password: "password2" });

  // A dedicated account, because recovering signs that person out everywhere.
  const rec = client();
  await owner("POST", "/api/users", { name: "Rex", username: "rex", password: "password1", role: "editor" });
  await rec("POST", "/api/login", { username: "rex", password: "password1" });
  const setup = await rec("POST", "/api/me/2fa/setup", {});
  const on = await rec("POST", "/api/me/2fa/enable", { code: totp.codeAt(setup.data.secret, totp.counterAt()) });
  assert.equal(on.status, 200);
  const rc = on.data.recoveryCodes[0];
  assert.equal((await anon("POST", "/api/password/recover", { username: "rex", code: "wrongcode1", password: "newsecret1" })).status, 401);
  assert.equal((await anon("POST", "/api/password/recover", { username: "rex", code: rc, password: "short" })).status, 400);
  assert.equal((await anon("POST", "/api/password/recover", { username: "rex", code: rc, password: "newsecret1" })).status, 200);
  assert.equal((await anon("POST", "/api/password/recover", { username: "rex", code: rc, password: "newsecret2" })).status, 401, "each code works once");
  assert.equal((await anon("POST", "/api/login", { username: "rex", password: "newsecret1" })).data.code, "totp_required", "two-step stays on");
  assert.equal((await rec("GET", "/api/me")).status, 401, "old sessions are signed out");
});

test("notifications go to the right people and drop dead devices", async () => {
  const before = pushed.length;
  await staff("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/staff", keys: { p256dh: "a", auth: "b" } } });
  assert.equal((await staff("POST", "/api/push/subscribe", { subscription: { endpoint: "http://insecure", keys: { p256dh: "a", auth: "b" } } })).status, 400);
  assert.equal((await viewer("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/v", keys: { p256dh: "a", auth: "b" } } })).status, 403);
  await dealer("n-d", "Nora Uy"); await debt("n-s", "n-d", 5000);
  const ask = await staff("POST", "/api/signoffs", { txnId: "n-s", reason: "Testing" });
  await new Promise((r) => setTimeout(r, 20));
  const got = pushed.slice(before).filter((p) => p.title === "Approval needed");
  assert.deepEqual(got.map((p) => p.endpoint), ["https://push.example/owner"], "voids go to owners and editors only");
  assert.doesNotMatch(JSON.stringify(got), /Nora|5000/, "no names or amounts on a lock screen");
  await owner("POST", `/api/signoffs/${ask.data.id}/reject`, { reason: "No" });

  const live = () => h.db.prepare("SELECT COUNT(*) n FROM push_subs WHERE endpoint = 'https://push.example/owner'").get().n;
  goneEndpoint = "https://push.example/owner";
  await staff("POST", "/api/signoffs", { txnId: "n-s", reason: "Second try" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(live(), 0, "a device the push service says is gone is forgotten");
});

test("staff never receive cost prices", async () => {
  await product("k1", "Secret Cost", { cost: 33 });
  await dealer("k-d", "Kit Ong");
  assert.equal((await doc("products", "k1", staff)).cost, undefined);
  const s = await staff("PUT", "/api/c/txns/k-s", { data: { type: "sale", dealerId: "k-d", date: today(), dueDate: day(30), items: [{ productId: "k1", name: "Secret Cost", qty: 1, price: 100, pct: 25 }] } });
  assert.equal(s.status, 200);
  assert.equal((await doc("txns", "k-s", staff)).items[0].cost, undefined);
  const p = await doc("products", "k1", staff);
  const put = await staff("PUT", "/api/c/products/k1", { data: { ...p, category: "New" } });
  assert.equal(put.data.data.cost, undefined, "not even in the save response");
  assert.equal((await doc("products", "k1")).cost, 33, "a staff edit keeps the cost");
  assert.equal((await doc("txns", "k-s")).items[0].cost, 33);
  assert.equal((await doc("products", "k1", viewer)).cost, 33, "viewers are accountants and keep seeing it");
});

test("restoring one record can't get around closed books", async () => {
  await dealer("r-d", "Ria Yu");
  await owner("PUT", "/api/c/txns/r-p", { data: { type: "payment", dealerId: "r-d", date: day(-30), amount: 10, method: "Cash" } });
  assert.equal((await owner("POST", "/api/periods/close", { through: day(-20) })).status, 200);
  const put = (id, data, headers) => fetch(base + "/api/c/" + id, { method: "PUT", headers: { "Content-Type": "application/json", "X-Restore": "1", ...headers }, body: JSON.stringify({ data }) });
  const cookie = (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "editor0", password: "x" }) })).status;
  assert.equal(cookie, 401);
  await owner("POST", "/api/users", { name: "Eve", username: "eve", password: "password1", role: "editor" }).catch(() => {});
  const ed = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "eve", password: "password1" }) });
  const c = { Cookie: ed.headers.get("set-cookie").split(";")[0] };
  const r = await put("txns/r-p", { type: "payment", dealerId: "r-d", date: day(-30), amount: 999, method: "Cash" }, c);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "period_closed");
  await put("settings/store", { storeName: "Hack", closedThrough: null, periodLog: [] }, c);
  assert.equal((await doc("settings", "store")).closedThrough, day(-20));
  await fetch(base + "/api/periods/reopen", { method: "POST", headers: { "Content-Type": "application/json", ...c }, body: JSON.stringify({ reason: "test done" }) });
});

test("system status is for admins, and errors are recorded", async () => {
  assert.equal((await staff("GET", "/api/status")).status, 403);
  h.recordError("Test failure");
  const s = await owner("GET", "/api/status");
  assert.equal(s.status, 200);
  assert.equal(s.data.errors[0].message, "Test failure");
  assert.equal(s.data.errorsToday, 1);
  assert.ok(s.data.dbBytes > 0);
  assert.ok(s.data.disk.free > 0);
  assert.equal((await viewer("GET", "/api/status")).status, 403);
  assert.equal((await client()("GET", "/healthz")).status, 200);
});

test("the API limit stops a runaway client without touching other people", async () => {
  process.env.API_RATE_LIMIT = "400";
  try {
    const flood = await Promise.all(Array.from({ length: 450 }, () => viewer("GET", "/api/me")));
    const limited = flood.filter((r) => r.status === 429);
    assert.ok(limited.length >= 5);
    assert.equal(limited[0].data.code, "rate_limited");
    assert.equal((await staff("GET", "/api/me")).status, 200, "another person isn't affected");
  } finally { delete process.env.API_RATE_LIMIT; }
});

test("a sale or return recorded offline syncs once", async () => {
  await product("o1", "Offline Item", { stock: 9 });
  await dealer("o-d", "Olive Ng");
  const data = { type: "sale", dealerId: "o-d", date: today(), dueDate: day(30), items: [{ productId: "o1", name: "Offline Item", qty: 1, price: 100, pct: 25 }], offline: { key: "ok1", recordedAt: Date.now() } };
  assert.equal((await staff("PUT", "/api/c/txns/ok1", { data })).status, 200);
  assert.equal((await staff("PUT", "/api/c/txns/ok1", { data })).status, 200, "sending it again is harmless");
  assert.equal((await doc("products", "o1")).stock, 8, "stock moved once");
  assert.equal((await staff("PUT", "/api/c/txns/ok2", { data: { ...data, type: "adjustment", direction: "debit", amount: 5, offline: { key: "ok2" } } })).status, 403);
});

test("barcodes are unique", async () => {
  await product("g1", "With Barcode", { barcode: "4800 016" });
  const r = await product("g2", "Other", { barcode: "4800016" });
  assert.equal(r.data.code, "duplicate");
  assert.match(r.data.message, /barcode/);
});
