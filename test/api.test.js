"use strict";
// End-to-end API tests: run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { txnEffect } = require("../lib/credit");
const Database = require("better-sqlite3");
const { openDb } = require("../lib/db");

test("upgrading an older database keeps accounts and sessions", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-mig-"));
  const old = new Database(path.join(d, "ledger.db"));
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','editor','staff','viewer')), password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE assets (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, action TEXT NOT NULL, collection TEXT, doc_id TEXT, detail TEXT);
    INSERT INTO users VALUES ('u1','ana','Ana','owner','x',1,1); INSERT INTO sessions VALUES ('tok','u1',1,9999999999999);
    PRAGMA user_version = 1;`);
  old.close();
  const db = openDb(d);
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1, "sessions survive the upgrade");
  db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id) VALUES ('u2','m','M','dealer','x',1,1,'d1')").run();
  db.close(); fs.rmSync(d, { recursive: true, force: true });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
const { app, close, backupNow, cleanupAssets } = createApp({ dataDir: dir, logger: { error() {} } });
let server, base;

function client() {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && !isBuf ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}
const owner = client(), staff = client(), viewer = client(), anon = client();
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("first run creates the owner, then setup is closed", async () => {
  assert.equal((await anon("GET", "/api/setup")).data.needsSetup, true);
  assert.equal((await owner("POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" })).status, 200);
  assert.equal((await anon("POST", "/api/setup", { name: "X", username: "x", password: "secret123" })).status, 409);
  assert.equal((await owner("GET", "/api/me")).data.role, "owner");
});

test("signed-out visitors get nothing", async () => {
  assert.equal((await anon("GET", "/api/c/dealers")).status, 401);
  assert.equal((await anon("GET", "/")).status, 302);
});

test("owner adds staff and viewer accounts; wrong passwords are rejected", async () => {
  assert.equal((await owner("POST", "/api/users", { name: "Ben", username: "ben", password: "staffpass1", role: "staff" })).status, 200);
  assert.equal((await owner("POST", "/api/users", { name: "Acct", username: "acct", password: "viewpass1", role: "viewer" })).status, 200);
  assert.equal((await staff("POST", "/api/login", { username: "ben", password: "nope" })).status, 401);
  assert.equal((await staff("POST", "/api/login", { username: "ben", password: "staffpass1" })).status, 200);
  assert.equal((await viewer("POST", "/api/login", { username: "acct", password: "viewpass1" })).status, 200);
  assert.equal((await staff("POST", "/api/users", { name: "Z", username: "zed", password: "zzzzzzzz", role: "editor" })).status, 403);
});

test("credit sales get sequential DR numbers and stock moves atomically", async () => {
  await owner("PUT", "/api/c/settings/store", { data: { holdDays: 60, discountPct: 25 } });
  await owner("PUT", "/api/c/dealers/d1", { data: { name: "Maria", creditLimit: 5000, terms: 30 } });
  await owner("PUT", "/api/c/products/p1", { data: { name: "Soap", dealerPrice: 75, srp: 100, stock: 50 } });
  const a = await staff("PUT", "/api/c/txns/s1", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [{ productId: "p1", name: "Soap", qty: 4, price: 100 }], subtotal: 400, discountPct: 25, pctDiscount: 100, amount: 300 } });
  const b = await staff("PUT", "/api/c/txns/s2", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [{ productId: "p1", name: "Soap", qty: 1, price: 100, pct: 25 }], amount: 75, no: "DR-00001" } });
  assert.equal(a.data.data.no, "DR-00001");
  assert.equal(b.data.data.no, "DR-00002", "duplicate numbers are replaced");
  // The sale itself moved the stock (PR-03): 50 - 4 - 1.
  assert.equal((await owner("GET", "/api/c/products")).data.find((p) => p.id === "p1").data.stock, 45);
  const s = await staff("POST", "/api/stock", { deltas: { p1: 1 } });
  assert.equal(s.data.stock.p1, 46);
  // a product edit can't overwrite stock
  await owner("PUT", "/api/c/products/p1", { data: { name: "Soap 135g", dealerPrice: 75, srp: 100, stock: 999 } });
  assert.equal((await owner("GET", "/api/c/products")).data[0].data.stock, 46);
});

test("staff can't change credit limits, prices or settings, or delete", async () => {
  await staff("PUT", "/api/c/dealers/d1", { data: { name: "Maria S.", creditLimit: 999999, terms: 90 } });
  const d = (await owner("GET", "/api/c/dealers")).data.find((x) => x.id === "d1").data;
  assert.equal(d.name, "Maria S.");
  assert.equal(d.creditLimit, 5000);
  assert.equal(d.terms, 30);
  await staff("PUT", "/api/c/products/p1", { data: { name: "Soap 135g", dealerPrice: 1, srp: 1 } });
  assert.equal((await owner("GET", "/api/c/products")).data[0].data.dealerPrice, 75);
  assert.equal((await staff("PUT", "/api/c/settings/store", { data: { holdDays: 999 } })).status, 403);
  assert.equal((await staff("DELETE", "/api/c/txns/s1")).status, 403);
  assert.equal((await viewer("PUT", "/api/c/dealers/v1", { data: { name: "V" } })).status, 403);
  assert.equal((await viewer("GET", "/api/c/dealers")).status, 200);
});

test("staff can edit their own records today, but not other people's", async () => {
  const own = await staff("PATCH", "/api/c/txns/s1", { data: { note: "fixed" } });
  assert.equal(own.status, 200);
  assert.equal(own.data.data.no, "DR-00001");
  await owner("PUT", "/api/c/txns/o1", { data: { type: "payment", dealerId: "d1", date: day(0), amount: 50, method: "Cash" } });
  assert.equal((await staff("PATCH", "/api/c/txns/o1", { data: { voided: true } })).status, 403);
});

test("credit hold blocks staff releases to late dealers; the owner can still release", async () => {
  await owner("PUT", "/api/c/dealers/late", { data: { name: "Late Larry", creditLimit: 10000, terms: 15 } });
  await owner("PUT", "/api/c/txns/old", { data: { type: "sale", opening: true, dealerId: "late", date: day(-100), dueDate: day(-85), items: [], amount: 800 } });
  const line = (qty) => [{ productId: "p1", name: "Soap", qty, price: 100, pct: 25 }];
  const blocked = await staff("PUT", "/api/c/txns/new1", { data: { type: "sale", dealerId: "late", date: day(0), dueDate: day(15), items: line(1), amount: 75 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "credit_hold");
  const over = await staff("PUT", "/api/c/txns/new2", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: line(80), amount: 6000 } });
  assert.equal(over.status, 409, "over the credit limit");
  assert.equal((await owner("PUT", "/api/c/txns/new3", { data: { type: "sale", dealerId: "late", date: day(0), dueDate: day(15), items: [], amount: 100, override: { by: "owner" } } })).status, 200);
});

test("photos upload, serve to signed-in users only, and reject non-images", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082", "hex");
  const up = await staff("POST", "/api/assets", png, { "Content-Type": "image/png" });
  assert.equal(up.status, 200);
  assert.equal((await staff("GET", up.data.url)).status, 200);
  assert.equal((await anon("GET", up.data.url)).status, 401);
  assert.equal((await staff("POST", "/api/assets", Buffer.from("<script>"), { "Content-Type": "text/html" })).status, 415);
});

test("every change is in the activity log, readable by admins only", async () => {
  const log = await owner("GET", "/api/audit?limit=200");
  assert.ok(log.data.some((a) => a.action === "create" && a.collection === "txns"));
  assert.equal((await staff("GET", "/api/audit")).status, 403);
});

test("disabling an account signs that person out", async () => {
  const users = (await owner("GET", "/api/users")).data;
  const ben = users.find((u) => u.username === "ben");
  await owner("PATCH", "/api/users/" + ben.id, { active: false });
  assert.equal((await staff("GET", "/api/c/dealers")).status, 401);
});

test("dealer portal accounts see only their own records and can't write", async () => {
  const portal = client();
  assert.equal((await owner("POST", "/api/users", { name: "Maria", username: "maria", password: "dealerpass1", role: "dealer" })).status, 400, "needs a dealer");
  assert.equal((await owner("POST", "/api/users", { name: "Maria", username: "maria", password: "dealerpass1", role: "dealer", dealerId: "d1" })).status, 200);
  assert.equal((await portal("POST", "/api/login", { username: "maria", password: "dealerpass1" })).status, 200);
  const dealers = (await portal("GET", "/api/c/dealers")).data;
  assert.deepEqual(dealers.map((d) => d.id), ["d1"]);
  const txns = (await portal("GET", "/api/c/txns")).data;
  assert.ok(txns.length > 0 && txns.every((t) => t.data.dealerId === "d1"), "only own transactions");
  assert.ok(txns.every((t) => t.data.createdBy === undefined), "staff ids hidden");
  const prods = (await portal("GET", "/api/c/products")).data;
  assert.ok(prods.every((p) => p.data.dealerPrice === undefined && p.data.stock === undefined), "no cost or stock numbers");
  assert.deepEqual((await portal("GET", "/api/c/moves")).data, []);
  assert.deepEqual((await portal("GET", "/api/users")).data, []);
  assert.equal((await portal("PUT", "/api/c/txns/x", { data: { type: "payment", dealerId: "d1", amount: 1 } })).status, 403);
  assert.equal((await portal("POST", "/api/stock", { deltas: { p1: 5 } })).status, 403);
  assert.equal((await portal("GET", "/api/audit")).status, 403);
  const page = await portal("GET", "/");
  assert.match(String(page.data), /Dealer Portal/);
});

test("online orders: dealer orders are priced by the server and follow status rules", async () => {
  const portal = client();
  await portal("POST", "/api/login", { username: "maria", password: "dealerpass1" });
  const r = await portal("PUT", "/api/c/orders/o1", { data: { dealerId: "late", status: "released", items: [{ productId: "p1", qty: 3, price: 1 }, { productId: "p1", qty: 1 }], pickupDate: day(1), note: "after lunch" } });
  assert.equal(r.status, 200);
  const o = r.data.data;
  assert.equal(o.dealerId, "d1", "always the dealer's own account");
  assert.equal(o.status, "new", "dealers can't set the status");
  assert.equal(o.no, "PO-00001");
  assert.equal(o.items.length, 1, "same product merged");
  assert.equal(o.items[0].qty, 4);
  assert.equal(o.items[0].price, 100, "SRP from the catalog, not from the request");
  assert.equal(o.amount, 300, "SRP 400 less 25%");
  assert.equal((await portal("PUT", "/api/c/orders/o2", { data: { items: [{ productId: "nope", qty: 1 }] } })).status, 400);
  assert.equal((await portal("PUT", "/api/c/orders/o3", { data: { items: [{ productId: "p1", qty: 1 }], pickupDate: day(-3) } })).status, 400, "no past pickup dates");
  // store moves it along; dealer can no longer cancel
  const st = await owner("PATCH", "/api/c/orders/o1", { data: { status: "preparing" } });
  assert.equal(st.data.data.statusHistory.length, 2);
  assert.equal((await portal("PATCH", "/api/c/orders/o1", { data: { status: "cancelled" } })).status, 409);
  // a new order can be cancelled by the dealer
  await portal("PUT", "/api/c/orders/o4", { data: { items: [{ productId: "p1", qty: 1 }] } });
  assert.equal((await portal("PATCH", "/api/c/orders/o4", { data: { status: "cancelled" } })).data.data.status, "cancelled");
  assert.equal((await portal("PATCH", "/api/c/orders/o4", { data: { status: "new" } })).status, 409);
  // dealers only see their own orders
  await owner("PUT", "/api/c/orders/o5", { data: { dealerId: "late", status: "new", items: [{ productId: "p1", qty: 1 }] } });
  const mine = (await portal("GET", "/api/c/orders")).data;
  assert.ok(mine.every((x) => x.data.dealerId === "d1"));
  assert.equal((await portal("PATCH", "/api/c/orders/o5", { data: { status: "cancelled" } })).status, 403);
  assert.equal((await owner("GET", "/api/c/orders")).data.length, 3, "the two rejected orders were not saved");
});

test("promos and per-product discounts price online orders; staff can't change them", async () => {
  await owner("PUT", "/api/c/products/p2", { data: { name: "Fabcon", dealerPrice: 135, srp: 180, stock: 10, promo: { price: 150, from: day(-1), to: day(5), noDiscount: false } } });
  await owner("PUT", "/api/c/products/p3", { data: { name: "Net item", dealerPrice: 50, srp: 50, stock: 10, discountPct: 0 } });
  await owner("PUT", "/api/c/products/p4", { data: { name: "Final promo", dealerPrice: 90, srp: 120, stock: 10, promo: { price: 99, from: day(-1), to: day(5), noDiscount: true } } });
  await owner("PUT", "/api/c/products/p5", { data: { name: "Ended promo", dealerPrice: 75, srp: 100, stock: 10, promo: { price: 60, from: day(-30), to: day(-1) } } });
  const portal = client();
  await portal("POST", "/api/login", { username: "maria", password: "dealerpass1" });
  const r = await portal("PUT", "/api/c/orders/pr1", { data: { items: ["p2", "p3", "p4", "p5"].map((productId) => ({ productId, qty: 1 })) } });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.data.items.map((i) => [i.productId, i]));
  assert.deepEqual([by.p2.price, by.p2.pct, !!by.p2.promo], [150, 25, true], "promo price, dealer discount still applies");
  assert.deepEqual([by.p3.price, by.p3.pct], [50, 0], "net-priced item");
  assert.deepEqual([by.p4.price, by.p4.pct], [99, 0], "final promo price");
  assert.deepEqual([by.p5.price, !!by.p5.promo], [100, false], "ended promo is ignored");
  assert.equal(r.data.data.discountPct, null, "mixed discounts");
  assert.equal(r.data.data.amount, 150 * 0.75 + 50 + 99 + 100 * 0.75);
  await staff("POST", "/api/login", { username: "ben", password: "staffpass1" });
  await owner("PATCH", "/api/users/" + (await owner("GET", "/api/users")).data.find((u) => u.username === "ben").id, { active: true });
  await staff("POST", "/api/login", { username: "ben", password: "staffpass1" });
  await staff("PUT", "/api/c/products/p2", { data: { name: "Fabcon", srp: 1, promo: { price: 1 }, discountPct: 99 } });
  const p2 = (await owner("GET", "/api/c/products")).data.find((p) => p.id === "p2").data;
  assert.deepEqual([p2.srp, p2.promo.price, p2.discountPct], [180, 150, null]);
});

test("automatic backup writes a database copy", async () => {
  const f = await backupNow();
  assert.ok(fs.statSync(f).size > 0);
});

test("adjustments and write-offs change the balance and are admin-only", async () => {
  await owner("PUT", "/api/c/dealers/ad1", { data: { name: "Adjust Dealer", creditLimit: 10000, terms: 30 } });
  await owner("PUT", "/api/c/txns/ads1", { data: { type: "sale", dealerId: "ad1", date: day(0), dueDate: day(30), items: [], amount: 1000 } });
  assert.equal((await staff("PUT", "/api/c/txns/ada1", { data: { type: "adjustment", dealerId: "ad1", direction: "debit", amount: 10, reason: "test" } })).status, 403);
  assert.equal((await staff("PUT", "/api/c/txns/adw1", { data: { type: "writeoff", dealerId: "ad1", amount: 10, reason: "test" } })).status, 403);
  const debit = await owner("PUT", "/api/c/txns/ada1", { data: { type: "adjustment", dealerId: "ad1", direction: "debit", amount: 200, reason: "Freight" } });
  assert.equal(debit.status, 200);
  assert.equal(debit.data.data.no, "ADJ-00001");
  const credit = await owner("PUT", "/api/c/txns/ada2", { data: { type: "adjustment", dealerId: "ad1", direction: "credit", amount: 50, reason: "Goodwill" } });
  assert.equal(credit.status, 200);
  assert.equal(credit.data.data.no, "ADJ-00002");
  const wo = await owner("PUT", "/api/c/txns/adw1", { data: { type: "writeoff", dealerId: "ad1", amount: 300, reason: "Unreachable" } });
  assert.equal(wo.status, 200);
  assert.equal(wo.data.data.no, "WO-00001");
  assert.equal((await owner("PUT", "/api/c/txns/adx1", { data: { type: "adjustment", dealerId: "ad1", amount: 5, reason: "no direction" } })).status, 400);
  assert.equal((await owner("PUT", "/api/c/txns/adx2", { data: { type: "writeoff", dealerId: "ad1", amount: 5 } })).status, 400);
  const tx = (await owner("GET", "/api/c/txns")).data.filter((t) => t.data.dealerId === "ad1").map((t) => t.data);
  assert.equal(tx.reduce((a, t) => a + txnEffect(t), 0), 850, "sale 1000 + debit 200 − credit 50 − write-off 300");
  const voided = { ...wo.data.data, voided: true };
  assert.equal(txnEffect(voided), 0, "voided records do not affect the balance");
});

test("product cost is admin-only and is kept for profit reports", async () => {
  await owner("PUT", "/api/c/products/p6", { data: { name: "Costed item", dealerPrice: 100, srp: 150, cost: 40, stock: 10 } });
  await staff("PUT", "/api/c/products/p6", { data: { name: "Costed item", dealerPrice: 100, srp: 150, cost: 1 } });
  const p6 = (await owner("GET", "/api/c/products")).data.find((p) => p.id === "p6").data;
  assert.equal(p6.cost, 40, "staff cannot change the cost price");
  await staff("PUT", "/api/c/products/p6", { data: { name: "Costed item", dealerPrice: 100, srp: 150 } });
  assert.equal((await owner("GET", "/api/c/products")).data.find((p) => p.id === "p6").data.cost, 40, "cost survives a staff edit");
  assert.equal((await owner("PUT", "/api/c/products/p6", { data: { name: "Costed item", dealerPrice: 100, srp: 150, cost: 55 } })).data.data.cost, 55, "admins can set cost");
  assert.equal((await owner("PUT", "/api/c/products/p6", { data: { name: "Costed item", dealerPrice: 100, srp: 150, cost: "" } })).data.data.cost, null, "blank cost is cleared");
});

test("stock cannot go below zero unless backorders are allowed", async () => {
  await owner("PUT", "/api/c/products/p7", { data: { name: "Scarce item", dealerPrice: 10, srp: 20, stock: 2 } });
  const denied = await staff("POST", "/api/stock", { deltas: { p7: -3 } });
  assert.equal(denied.status, 409);
  assert.equal(denied.data.code, "insufficient_stock");
  assert.equal((await owner("GET", "/api/c/products")).data.find((p) => p.id === "p7").data.stock, 2);
  const settings = (await owner("GET", "/api/c/settings")).data.find((s) => s.id === "store").data;
  await owner("PUT", "/api/c/settings/store", { data: { ...settings, allowNegativeStock: true } });
  assert.equal((await staff("POST", "/api/stock", { deltas: { p7: -3 } })).data.stock.p7, -1);
  await owner("PUT", "/api/c/settings/store", { data: { ...settings, allowNegativeStock: false } });
});

test("online orders reserve stock and flag backorders, credit holds and over-limit orders", async () => {
  await owner("PUT", "/api/c/dealers/ob1", { data: { name: "Order Dealer", creditLimit: 1000, terms: 30 } });
  await owner("PUT", "/api/c/products/p8", { data: { name: "Reserved item", dealerPrice: 50, srp: 100, stock: 5 } });
  await owner("PUT", "/api/c/products/p9", { data: { name: "Big item", dealerPrice: 1000, srp: 1000, stock: 0 } });
  const first = await owner("PUT", "/api/c/orders/bko1", { data: { dealerId: "ob1", status: "new", items: [{ productId: "p8", qty: 4 }] } });
  assert.equal(first.status, 200);
  assert.equal(first.data.data.backorder, false);
  assert.deepEqual(first.data.data.shortItems, []);
  const second = await owner("PUT", "/api/c/orders/bko2", { data: { dealerId: "ob1", status: "new", items: [{ productId: "p8", qty: 4 }] } });
  assert.equal(second.data.data.backorder, true, "4 more cannot fit in the 1 unit left");
  assert.deepEqual(second.data.data.shortItems, [{ productId: "p8", name: "Reserved item", qty: 4, available: 1 }]);
  const over = await owner("PUT", "/api/c/orders/bko3", { data: { dealerId: "ob1", status: "new", items: [{ productId: "p9", qty: 2 }] } });
  assert.equal(over.data.data.overLimit, true);
  const held = await owner("PUT", "/api/c/orders/bko4", { data: { dealerId: "late", status: "new", items: [{ productId: "p8", qty: 1 }] } });
  assert.equal(held.data.data.creditHold, true, "late dealer is over the hold threshold");
  const portal = client();
  await portal("POST", "/api/login", { username: "maria", password: "dealerpass1" });
  const reservedProduct = (await portal("GET", "/api/c/products")).data.find((p) => p.id === "p8");
  assert.equal(reservedProduct.data.available, false, "dealer sees stock held by open orders as unavailable");
  assert.equal(reservedProduct.data.stock, undefined, "stock numbers stay hidden from dealers");
});

test("returns linked to a delivery cannot exceed what was delivered", async () => {
  await owner("PUT", "/api/c/txns/rs1", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [{ productId: "p1", name: "Soap", qty: 5, price: 100 }], subtotal: 500, amount: 500 } });
  const one = await owner("PUT", "/api/c/txns/rr1", { data: { type: "return", dealerId: "d1", saleId: "rs1", date: day(0), restock: true, items: [{ productId: "p1", name: "Soap", qty: 3, price: 100 }], amount: 300 } });
  assert.equal(one.status, 200);
  assert.equal(one.data.data.saleId, "rs1");
  const tooMany = await owner("PUT", "/api/c/txns/rr2", { data: { type: "return", dealerId: "d1", saleId: "rs1", date: day(0), restock: true, items: [{ productId: "p1", name: "Soap", qty: 3, price: 100 }], amount: 300 } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.message, /Only 2/);
  const rest = await owner("PUT", "/api/c/txns/rr2", { data: { type: "return", dealerId: "d1", saleId: "rs1", date: day(0), restock: true, items: [{ productId: "p1", name: "Soap", qty: 2, price: 100 }], amount: 200 } });
  assert.equal(rest.status, 200);
  assert.equal((await owner("PATCH", "/api/c/txns/rr2", { data: { items: [{ productId: "p1", name: "Soap", qty: 3, price: 100 }], amount: 300 } })).status, 400, "edits are capped too");
  assert.equal((await owner("PUT", "/api/c/txns/rr3", { data: { type: "return", dealerId: "late", saleId: "rs1", date: day(0), items: [{ productId: "p1", name: "Soap", qty: 1, price: 100 }], amount: 100 } })).status, 400, "wrong dealer");
});

test("full backups include accounts and photos and restore in one request", async () => {
  await owner("PUT", "/api/c/dealers/bk1", { data: { name: "Backup Dealer", creditLimit: 100, terms: 30 } });
  const full = await owner("GET", "/api/backup/full");
  assert.equal(full.status, 200);
  assert.equal(full.data.app, "dealer-credit-ledger");
  assert.ok(full.data.collections.dealers.some((d) => d.id === "bk1"));
  assert.ok(full.data.users.some((u) => u.password_hash), "account hashes are included");
  assert.ok(full.data.assets.every((a) => typeof a.data === "string"), "photos are embedded");
  assert.equal((await staff("GET", "/api/backup/full")).status, 403);
  assert.equal((await owner("DELETE", "/api/c/dealers/bk1")).status, 200);
  assert.ok(!(await owner("GET", "/api/c/dealers")).data.some((d) => d.id === "bk1"));
  const restored = await owner("POST", "/api/backup/restore", { backup: full.data, replace: true });
  assert.equal(restored.status, 200);
  assert.ok(restored.data.docs > 0);
  assert.ok((await owner("GET", "/api/c/dealers")).data.some((d) => d.id === "bk1"), "deleted record is back");
  assert.equal((await owner("POST", "/api/backup/restore", { backup: { app: "nope" } })).status, 400);
});

test("the offsite backup hook receives the finished backup file", async () => {
  const marker = path.join(dir, "offsite-copy.db");
  process.env.BACKUP_SYNC_CMD = `cp "$BACKUP_FILE" "${marker}"`;
  try {
    const f = await backupNow();
    assert.ok(fs.existsSync(marker), "sync command ran");
    assert.ok(fs.statSync(marker).size > 0);
    assert.ok(fs.statSync(f).size > 0);
  } finally {
    delete process.env.BACKUP_SYNC_CMD;
  }
});

test("dealer CRM: stages, contact log and follow-ups", async () => {
  // New dealers default to the "dealer" stage; unknown stages and bad emails are rejected.
  assert.equal((await owner("PUT", "/api/c/dealers/crm0", { data: { name: "Old Style" } })).data.data.stage, "dealer");
  assert.equal((await owner("PUT", "/api/c/dealers/crm1", { data: { name: "Paula Prospect", stage: "maybe" } })).status, 400);
  assert.equal((await owner("PUT", "/api/c/dealers/crm1", { data: { name: "Paula Prospect", stage: "lead", email: "nope" } })).status, 400);
  const lead = await staff("PUT", "/api/c/dealers/crm1", { data: { name: "Paula Prospect", stage: "lead", tags: [" VIP ", "VIP", ""], email: "paula@example.com" } });
  assert.equal(lead.status, 200);
  assert.deepEqual(lead.data.data.tags, ["VIP"]);
  assert.equal(lead.data.data.stageHistory.at(-1).to, "lead");

  // Contact log entries need a real dealer, a known kind and a date.
  assert.equal((await staff("PUT", "/api/c/interactions/i0", { data: { dealerId: "ghost", kind: "call", date: day(0) } })).status, 400);
  assert.equal((await staff("PUT", "/api/c/interactions/i0", { data: { dealerId: "crm1", kind: "smoke", date: day(0) } })).status, 400);
  assert.equal((await staff("PUT", "/api/c/interactions/i0", { data: { dealerId: "crm1", kind: "call" } })).status, 400);
  const call = await owner("PUT", "/api/c/interactions/i1", { data: { dealerId: "crm1", kind: "call", date: day(0), outcome: "Interested", note: "Call back", followUp: day(2) } });
  assert.equal(call.status, 200);
  assert.equal(call.data.data.followUpDone, false);
  assert.equal((await viewer("PUT", "/api/c/interactions/i2", { data: { dealerId: "crm1", kind: "note", date: day(0) } })).status, 403);

  // Staff can tick off someone else's follow-up but not rewrite their notes.
  const done = await staff("PATCH", "/api/c/interactions/i1", { data: { followUpDone: true, note: "rewritten" } });
  assert.equal(done.status, 200);
  assert.equal(done.data.data.followUpDone, true);
  assert.equal(done.data.data.note, "Call back");
  assert.equal((await staff("DELETE", "/api/c/interactions/i1")).status, 403);

  // Dealer portal accounts never see CRM data.
  const portal = client();
  await portal("POST", "/api/login", { username: "maria", password: "dealerpass1" });
  assert.deepEqual((await portal("GET", "/api/c/interactions")).data, []);
  const own = (await portal("GET", "/api/c/dealers")).data[0].data;
  assert.equal(own.stage, undefined);
  assert.equal(own.tags, undefined);

  // The first credit sale turns a prospect into a dealer.
  const sale = await owner("PUT", "/api/c/txns/crm-s1", { data: { type: "sale", dealerId: "crm1", date: day(0), dueDate: day(30), amount: 100, items: [] } });
  assert.equal(sale.status, 200);
  const d = (await owner("GET", "/api/c/dealers")).data.find((x) => x.id === "crm1").data;
  assert.equal(d.stage, "dealer");
  assert.equal(d.stageHistory.at(-1).reason, "first sale");

  // CRM records are part of the full backup.
  const full = (await owner("GET", "/api/backup/full")).data;
  assert.ok(full.collections.interactions.some((r) => r.id === "i1"));
});

test("product pictures can be downloaded from an internet link, safely", async () => {
  const { isBlockedAddress, pageImage, unwrap } = require("../lib/fetch-image");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "142.250.72.14", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  assert.equal(pageImage('<meta content="/img/a.jpg?x=1&amp;y=2" property="og:image">', "https://shop.example/p/1"), "https://shop.example/img/a.jpg?x=1&y=2");
  assert.equal(unwrap("https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.example%2Fa.png&tbnid=x"), "https://cdn.example/a.png");

  // Private, local and non-web links are refused (the default).
  for (const url of ["http://127.0.0.1/a.png", "http://localhost/a.png", "http://10.0.0.5/a.png", "http://[::1]/a.png", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/a.png", "https://user:pw@example.com/a.png", "https://example.com:8443/a.png", "not a link"]) {
    const r = await owner("POST", "/api/assets/fetch", { url });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await viewer("POST", "/api/assets/fetch", { url: "https://example.com/a.png" })).status, 403);

  // A local test site stands in for the internet.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const http = require("http");
  const site = http.createServer((req, res) => {
    if (req.url === "/a.png") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(png); }
    if (req.url === "/moved") { res.writeHead(302, { Location: "/a.png" }); return res.end(); }
    if (req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end('<html><head><meta property="og:image" content="/a.png"></head></html>'); }
    if (req.url === "/bare") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>no picture</html>"); }
    if (req.url === "/fake.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<svg onload=alert(1)>"); }
    if (req.url === "/huge") { res.writeHead(200, { "Content-Type": "image/jpeg" }); const chunk = Buffer.alloc(1024 * 1024, 0xff); let n = 0; const w = () => { while (n < 10 && res.write(chunk)) n++; if (n >= 10) res.end(); else { n++; res.once("drain", w); } }; return w(); }
    res.writeHead(404); res.end();
  });
  site.listen(0); await new Promise((r) => site.once("listening", r));
  const at = `http://127.0.0.1:${site.address().port}`;
  process.env.IMAGE_FETCH_ALLOW_PRIVATE = "1";
  try {
    const direct = await owner("POST", "/api/assets/fetch", { url: at + "/a.png" });
    assert.equal(direct.status, 200);
    assert.equal(direct.data.contentType, "image/png", "type comes from the file, not the header");
    const blob = await owner("GET", "/_blob/" + direct.data.id);
    assert.equal(blob.status, 200);
    assert.equal((await staff("POST", "/api/assets/fetch", { url: at + "/moved" })).data.source, at + "/a.png", "redirects are followed");
    assert.equal((await owner("POST", "/api/assets/fetch", { url: at + "/page" })).data.source, at + "/a.png", "product page picture is used");
    assert.equal((await owner("POST", "/api/assets/fetch", { url: at + "/bare" })).status, 415);
    assert.equal((await owner("POST", "/api/assets/fetch", { url: at + "/fake.png" })).status, 415, "non-images are refused");
    assert.equal((await owner("POST", "/api/assets/fetch", { url: at + "/missing" })).status, 502);
    assert.equal((await owner("POST", "/api/assets/fetch", { url: at + "/huge" })).status, 413);
    const log = (await owner("GET", "/api/audit")).data;
    assert.ok(JSON.stringify(log).includes(at + "/a.png"), "the source link is in the activity log");
  } finally {
    delete process.env.IMAGE_FETCH_ALLOW_PRIVATE;
    site.close();
  }
});

test("payments recorded offline sync once, and conflicts are held for review", async () => {
  await owner("PUT", "/api/c/dealers/off1", { data: { name: "Field Dealer", terms: 30 } });
  const pay = (key, extra = {}) => ({ data: { type: "payment", dealerId: "off1", date: day(-1), amount: 250, method: "Cash", no: "OR-OFF", offline: { key, recordedAt: Date.now() - 3600e3 }, ...extra } });
  const first = await staff("PUT", "/api/c/txns/offk1", pay("offk1"));
  assert.equal(first.status, 200);
  assert.equal(first.data.data.offline.key, "offk1");
  assert.ok(first.data.data.offline.syncedAt >= first.data.data.offline.recordedAt);
  // The phone lost the reply and sends it again: nothing new is recorded.
  const again = await staff("PUT", "/api/c/txns/offk1", pay("offk1"));
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  const txns = (await owner("GET", "/api/c/txns")).data.filter((t) => t.data.dealerId === "off1");
  assert.equal(txns.length, 1, "recorded exactly once");
  assert.equal(txns[0].version, 1);
  // Viewers can't probe records through the duplicate shortcut.
  assert.equal((await viewer("PUT", "/api/c/txns/offk1", pay("offk1"))).status, 403);
  // Only new payments can carry an offline key.
  assert.equal((await staff("PUT", "/api/c/txns/offk2", pay("offk2", { type: "sale", dueDate: day(20), items: [] }))).status, 400);
  assert.equal((await staff("PUT", "/api/c/txns/offk3", pay("bad key!"))).status, 400);
  // The dealer was archived while the collector was offline: held until an owner or editor confirms.
  await owner("PATCH", "/api/c/dealers/off1", { data: { active: false } });
  const held = await staff("PUT", "/api/c/txns/offk4", pay("offk4"));
  assert.equal(held.status, 409);
  assert.equal(held.data.code, "needs_review");
  assert.equal((await staff("PUT", "/api/c/txns/offk4", pay("offk4", { offline: { key: "offk4", recordedAt: Date.now(), confirmed: true } }))).status, 409, "staff can't confirm");
  const ok = await owner("PUT", "/api/c/txns/offk4", pay("offk4", { offline: { key: "offk4", recordedAt: Date.now(), confirmed: true } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.data.offline.confirmed, true);
  // The installable app shell is served.
  assert.equal((await anon("GET", "/manifest.webmanifest")).data.start_url, "/");
  assert.match(String((await anon("GET", "/sw.js")).data), /dcl-shell/);
});

test("a payment can be applied to the deliveries the dealer chose", async () => {
  const { settle } = require("../lib/credit");
  await owner("PUT", "/api/c/dealers/al1", { data: { name: "Allocating Dealer", terms: 30 } });
  const sale = (id, date, amount, no) => owner("PUT", "/api/c/txns/" + id, { data: { type: "sale", opening: true, dealerId: "al1", date, dueDate: date, amount, items: [], no } });
  await sale("al-a", day(-60), 100, "DR-A1");
  await sale("al-b", day(-30), 200, "DR-B1");
  await sale("al-c", day(-10), 300, "DR-C1");
  const pay = (id, amount, alloc, extra = {}) => staff("PUT", "/api/c/txns/" + id, { data: { type: "payment", dealerId: "al1", date: day(0), amount, method: "Cash", ...(alloc ? { alloc } : {}), ...extra } });

  // Rejected: unknown delivery, more than is unpaid, more than the payment, non-payments.
  assert.equal((await pay("al-p0", 50, [{ id: "nope", amount: 50 }])).status, 400);
  assert.equal((await pay("al-p0", 500, [{ id: "al-b", amount: 250 }])).status, 400);
  assert.equal((await pay("al-p0", 100, [{ id: "al-b", amount: 150 }])).status, 400);
  assert.equal((await pay("al-p0", 100, [{ id: "al-b", amount: 50 }, { id: "al-b", amount: 50 }])).status, 400, "no repeats");
  assert.equal((await owner("PUT", "/api/c/txns/al-x", { data: { type: "adjustment", direction: "credit", dealerId: "al1", date: day(0), amount: 10, alloc: [{ id: "al-b", amount: 10 }] } })).status, 400);

  // 250 paid: 200 for DR-B1 as chosen, the other 50 goes to the oldest (DR-A1).
  const p1 = await pay("al-p1", 250, [{ id: "al-b", amount: 200 }]);
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.data.data.alloc, [{ id: "al-b", no: "DR-B1", amount: 200 }]);
  const docs = () => owner("GET", "/api/c/txns").then((r) => r.data.filter((d) => d.data.dealerId === "al1").map((d) => ({ ...d.data, _id: d.id })));
  let st = settle(await docs());
  assert.deepEqual(st.open.map((o) => [o.id, o.rem]), [["al-a", 50], ["al-c", 300]]);

  // DR-B1 is now paid, so it can't be chosen again.
  assert.equal((await pay("al-p2", 10, [{ id: "al-b", amount: 10 }])).status, 400);

  // Voiding the payment releases its allocation.
  await owner("PATCH", "/api/c/txns/al-p1", { data: { voided: true, voidReason: "test" } });
  st = settle(await docs());
  assert.deepEqual(st.open.map((o) => [o.id, o.rem]), [["al-a", 100], ["al-b", 200], ["al-c", 300]]);
});

test("blocked staff sales go to the owner as approval requests", async () => {
  await owner("PUT", "/api/c/dealers/ap1", { data: { name: "Hold Harriet", creditLimit: 1000, terms: 15 } });
  await owner("PUT", "/api/c/txns/ap-old", { data: { type: "sale", opening: true, dealerId: "ap1", date: day(-120), dueDate: day(-100), amount: 300, items: [], no: "DR-AP0" } });
  await owner("PUT", "/api/c/products/ap-p", { data: { name: "Approval Soap", dealerPrice: 50, srp: 70, stock: 20 } });
  const stock = async () => (await owner("GET", "/api/c/products")).data.find((p) => p.id === "ap-p").data.stock;
  const before = await stock();
  const sale = { type: "sale", dealerId: "ap1", date: day(0), dueDate: day(15), amount: 105, items: [{ productId: "ap-p", name: "Approval Soap", qty: 2, price: 70, pct: 25 }], no: "DR-FAKE", override: { by: "me" } };

  // Staff are blocked, then send the sale for approval with a reason.
  const blocked = await staff("PUT", "/api/c/txns/ap-s1", { data: sale });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "credit_hold");
  assert.equal((await staff("POST", "/api/approvals", { sale, reason: "" })).status, 400, "reason required");
  assert.equal((await viewer("POST", "/api/approvals", { sale, reason: "please" })).status, 403);
  const req1 = await staff("POST", "/api/approvals", { sale, reason: "Dealer promised to pay Friday" });
  assert.equal(req1.status, 200);
  assert.equal(req1.data.data.status, "pending");
  assert.equal(req1.data.data.block.hold, true);
  assert.equal(req1.data.data.sale.override, undefined, "staff can't pre-approve");
  assert.equal(await stock(), before, "pending requests don't touch stock");
  assert.ok(!(await owner("GET", "/api/c/txns")).data.some((t) => t.data.dealerId === "ap1" && !t.data.opening), "or the balance");

  // Requests can't be edited directly, and staff can't decide them.
  assert.equal((await staff("PATCH", "/api/c/approvals/" + req1.data.id, { data: { status: "approved" } })).status, 403);
  assert.equal((await staff("POST", `/api/approvals/${req1.data.id}/approve`, {})).status, 403);

  // The owner approves: the sale is recorded as requested, stock moves, credited to the requester.
  const ok = await owner("POST", `/api/approvals/${req1.data.id}/approve`, { note: "OK this once" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.data.status, "approved");
  const t = (await owner("GET", "/api/c/txns")).data.find((x) => x.id === ok.data.data.txnId).data;
  assert.equal(t.amount, 105);
  assert.notEqual(t.no, "DR-FAKE");
  assert.equal(t.override.requestId, req1.data.id);
  assert.equal(t.createdBy, (await staff("GET", "/api/me")).data.id);
  assert.equal(await stock(), before - 2);
  assert.equal((await owner("POST", `/api/approvals/${req1.data.id}/approve`, {})).status, 409, "decided once");

  // Rejection needs a reason; withdrawing is for the requester.
  const req2 = await staff("POST", "/api/approvals", { sale, reason: "Another try" });
  assert.equal((await owner("POST", `/api/approvals/${req2.data.id}/reject`, { note: "" })).status, 400);
  const no = await owner("POST", `/api/approvals/${req2.data.id}/reject`, { note: "Collect first" });
  assert.equal(no.data.data.status, "rejected");
  const req3 = await staff("POST", "/api/approvals", { sale, reason: "Third" });
  assert.equal((await staff("POST", `/api/approvals/${req3.data.id}/withdraw`)).data.data.status, "withdrawn");

  // Requests expire.
  await owner("PUT", "/api/c/settings/store", { data: { ...(await owner("GET", "/api/c/settings")).data.find((x) => x.id === "store").data, approvalHours: 1 } });
  const req4 = await staff("POST", "/api/approvals", { sale, reason: "Fourth" });
  assert.ok(req4.data.data.expiresAt - req4.data.data.requestedAt <= 3600e3 + 5);
  const db = new Database(path.join(dir, "ledger.db"));
  const row = db.prepare("SELECT data FROM docs WHERE collection='approvals' AND id=?").get(req4.data.id);
  db.prepare("UPDATE docs SET data=? WHERE collection='approvals' AND id=?").run(JSON.stringify({ ...JSON.parse(row.data), expiresAt: Date.now() - 1000 }), req4.data.id);
  db.close();
  assert.equal((await owner("POST", `/api/approvals/${req4.data.id}/approve`, {})).status, 409);
  assert.equal((await owner("GET", "/api/c/approvals")).data.find((x) => x.id === req4.data.id).data.status, "expired");

  // A sale that isn't blocked is recorded normally instead.
  await owner("PUT", "/api/c/dealers/ap2", { data: { name: "Good Payer" } });
  assert.equal((await staff("POST", "/api/approvals", { sale: { ...sale, dealerId: "ap2" }, reason: "x y z" })).status, 400);
});

test("the server prices credit sales and saves each sale with its stock change (PR-03, PR-04)", async () => {
  await owner("PUT", "/api/c/dealers/pr1", { data: { name: "Pricing Dealer", terms: 30 } });
  await owner("PUT", "/api/c/products/pr-p", { data: { name: "Lotion", dealerPrice: 150, srp: 200, cost: 90, stock: 10 } });
  const stock = async () => (await owner("GET", "/api/c/products")).data.find((p) => p.id === "pr-p").data.stock;
  const line = (extra = {}) => ({ productId: "pr-p", name: "Lotion", qty: 2, price: 200, pct: 25, ...extra });
  const sale = (id, items, extra = {}, who = staff) => who("PUT", "/api/c/txns/" + id, { data: { type: "sale", dealerId: "pr1", date: day(0), dueDate: day(30), items, amount: 1, subtotal: 1, pctDiscount: 0, ...extra } });

  // Totals and cost come from the server, whatever the browser sends.
  const ok = await sale("pr-s1", [line({ cost: 0 })]);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.data.amount, 300);
  assert.equal(ok.data.data.subtotal, 400);
  assert.equal(ok.data.data.items[0].cost, 90);
  assert.equal(ok.data.data.manualPrice, undefined);
  assert.equal(await stock(), 8, "stock moved with the sale");

  // A changed price or extra discount needs a reason from staff; owners can just do it.
  const cheap = await sale("pr-s2", [line({ price: 1 })]);
  assert.equal(cheap.status, 400);
  assert.equal(cheap.data.code, "price_reason");
  assert.equal((await sale("pr-s2", [line({ pct: 90 })])).data.code, "price_reason");
  assert.equal((await sale("pr-s2", [line()], { discount: 50 })).data.code, "price_reason");
  assert.equal(await stock(), 8, "refused sales take no stock");
  const why = await sale("pr-s2", [line({ price: 180 })], { priceReason: "Damaged box" });
  assert.equal(why.status, 200);
  assert.equal(why.data.data.manualPrice, true);
  assert.equal(why.data.data.items[0].manual, true);
  assert.equal(why.data.data.priceReason, "Damaged box");
  assert.equal(why.data.data.amount, 270);
  assert.equal((await sale("pr-s3", [line({ price: 150, qty: 1 })], {}, owner)).data.data.manualPrice, true);
  assert.equal(await stock(), 5);

  // Not enough stock: nothing is saved at all.
  const big = await sale("pr-s4", [line({ qty: 50 })]);
  assert.equal(big.status, 409);
  assert.equal(big.data.code, "insufficient_stock");
  assert.ok(!(await owner("GET", "/api/c/txns")).data.some((t) => t.id === "pr-s4"));
  assert.equal(await stock(), 5);

  // Voiding gives the stock back, restoring takes it again, deleting gives it back.
  await staff("PATCH", "/api/c/txns/pr-s1", { data: { voided: true, voidReason: "test" } });
  assert.equal(await stock(), 7);
  await staff("PATCH", "/api/c/txns/pr-s1", { data: { voided: false } });
  assert.equal(await stock(), 5);
  // A restocked return of that sale must use the sale's price, and adds stock.
  const ret = (price) => staff("PUT", "/api/c/txns/pr-r1", { data: { type: "return", dealerId: "pr1", date: day(0), saleId: "pr-s1", restock: true, items: [{ productId: "pr-p", name: "Lotion", qty: 1, price, pct: 25 }], amount: 1 } });
  assert.equal((await ret(500)).data.code, "price_reason");
  const r = await ret(200);
  assert.equal(r.status, 200);
  assert.equal(r.data.data.amount, 150);
  assert.equal(await stock(), 6);
  await owner("DELETE", "/api/c/txns/pr-s3");
  assert.equal(await stock(), 7);
});

test("behind HTTPS: redirects, HSTS and page security policy (PR-05)", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-https-"));
  process.env.COOKIE_SECURE = "true";
  const h = createApp({ dataDir: d, logger: { error() {} } });
  delete process.env.COOKIE_SECURE;
  const srv = h.app.listen(0); await new Promise((r) => srv.once("listening", r));
  const port = srv.address().port;
  // fetch() can't set Host, so use http.request.
  const req = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const r = require("http").request({ host: "127.0.0.1", port, method, path: p, headers: { Host: "ledger.example.com", ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers })); });
    r.on("error", reject); r.end(body);
  });
  try {
    const plain = await req("GET", "/login");
    assert.equal(plain.status, 308);
    assert.equal(plain.headers.location, "https://ledger.example.com/login");
    assert.equal((await req("POST", "/api/login", {}, "{}")).status, 403);
    assert.equal((await req("GET", "/healthz")).status, 200, "health checks stay on HTTP");
    const secure = await req("GET", "/login", { "X-Forwarded-Proto": "https" });
    assert.equal(secure.status, 200);
    assert.match(secure.headers["strict-transport-security"], /max-age=31536000/);
    const csp = secure.headers["content-security-policy"];
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match((await req("GET", "/api/setup", { "X-Forwarded-Proto": "https" })).headers["content-security-policy"], /default-src 'none'/);
  } finally { srv.close(); h.close(); fs.rmSync(d, { recursive: true, force: true }); }
  // The server refuses to start in production without secure cookies.
  const { spawnSync } = require("child_process");
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, NODE_ENV: "production", COOKIE_SECURE: "false", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ledger-prod-")) }, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /COOKIE_SECURE=true/);
});

test("pictures never saved on a record are cleaned up after a day (PR-11)", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const up = async () => (await owner("POST", "/api/assets", png, { "Content-Type": "image/png" })).data.id;
  const orphan = await up(), used = await up(), fresh = await up();
  await owner("PUT", "/api/c/products/pic-p", { data: { name: "Pictured", dealerPrice: 10, imageId: used } });
  const db = new Database(path.join(dir, "ledger.db"));
  db.prepare("UPDATE assets SET created_at = ? WHERE id IN (?, ?)").run(Date.now() - 2 * 864e5, orphan, used);
  db.close();
  const removed = cleanupAssets();
  assert.deepEqual(removed, [orphan]);
  assert.equal((await owner("GET", "/_blob/" + orphan)).status, 404);
  assert.equal((await owner("GET", "/_blob/" + used)).status, 200, "pictures in use are kept");
  assert.equal((await owner("GET", "/_blob/" + fresh)).status, 200, "recent uploads are kept");
  assert.ok(JSON.stringify((await owner("GET", "/api/audit")).data).includes("asset_cleanup"));
});

test("backups are verified, failures alert, and a backup restores (PR-08)", async () => {
  const alertFile = path.join(dir, "alert.txt");
  process.env.BACKUP_SYNC_CMD = "echo offsite down >&2; exit 3";
  process.env.ALERT_CMD = `printf '%s' "$ALERT_MESSAGE" > "${alertFile}"`;
  let file;
  try { file = await backupNow(); } finally { delete process.env.BACKUP_SYNC_CMD; delete process.env.ALERT_CMD; }
  for (let i = 0; i < 40 && !fs.existsSync(alertFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(fs.readFileSync(alertFile, "utf8"), /Offsite backup copy failed: offsite down/);
  assert.equal((await staff("GET", "/api/backup/status")).status, 403);
  let st = (await owner("GET", "/api/backup/status")).data;
  assert.ok(st.lastSuccessAt > Date.now() - 60000);
  assert.ok(st.lastDocs > 0 && st.lastUsers > 0);
  assert.equal(st.offsite.lastError, "offsite down", "the failed offsite copy is shown");
  const run = await owner("POST", "/api/backup/run");
  assert.equal(run.status, 200);
  assert.equal(run.data.lastFile, path.basename(file));
  assert.equal(run.data.offsite, null, "no offsite command set now");

  // Restore the backup into a fresh data folder with the restore script.
  const { spawnSync } = require("child_process");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-restore-"));
  const script = path.join(__dirname, "..", "scripts", "restore-db.js");
  const ok = spawnSync(process.execPath, [script, file], { env: { ...process.env, DATA_DIR: target }, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Restored .* records/);
  const restored = new Database(path.join(target, "ledger.db"), { readonly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM docs").get().n, st.lastDocs);
  restored.close();
  // A damaged file is refused and the live database is left alone.
  const bad = path.join(target, "broken.db"); fs.writeFileSync(bad, "not a database");
  const no = spawnSync(process.execPath, [script, bad], { env: { ...process.env, DATA_DIR: target }, encoding: "utf8" });
  assert.equal(no.status, 1);
  assert.ok(fs.readdirSync(target).filter((f) => f.startsWith("ledger.before-restore")).length === 0, "nothing replaced");
  fs.rmSync(target, { recursive: true, force: true });
});

test("two-step sign-in, shorter staff sessions and remote sign-out (PR-10)", async () => {
  const totp = require("../lib/totp");
  await owner("POST", "/api/users", { name: "Eve Editor", username: "eve", password: "editorpass1", role: "editor" });
  const eve = client();
  assert.equal((await eve("POST", "/api/login", { username: "eve", password: "editorpass1" })).status, 200);

  // Set up: scan the QR, confirm a code, get recovery codes.
  const setup = await eve("POST", "/api/me/2fa/setup");
  assert.match(setup.data.otpauth, /^otpauth:\/\/totp\//);
  assert.match(setup.data.qr, /^data:image\/png;base64,/);
  const secret = setup.data.secret.replace(/\s/g, "");
  assert.equal((await eve("POST", "/api/me/2fa/enable", { code: "000000" })).status, 400);
  const firstCode = totp.codeAt(secret, totp.counterAt());
  const on = await eve("POST", "/api/me/2fa/enable", { code: firstCode });
  assert.equal(on.status, 200);
  assert.equal(on.data.recoveryCodes.length, 8);
  assert.equal((await eve("GET", "/api/me")).data.twoStep, true, "current session kept");
  assert.equal((await owner("GET", "/api/users")).data.find((u) => u.username === "eve").twoStep, true);

  // Signing in now needs a fresh code; a used code or a wrong one is refused.
  const dev = client();
  assert.equal((await dev("POST", "/api/login", { username: "eve", password: "editorpass1" })).data.code, "totp_required");
  assert.equal((await dev("POST", "/api/login", { username: "eve", password: "editorpass1", code: "123456" })).data.code, "totp_invalid");
  assert.equal((await dev("POST", "/api/login", { username: "eve", password: "editorpass1", code: firstCode })).data.code, "totp_invalid", "same code can't be used twice");
  const rec = on.data.recoveryCodes[0];
  assert.equal((await dev("POST", "/api/login", { username: "eve", password: "editorpass1", code: rec })).status, 200, "recovery code works once");
  assert.equal((await client()("POST", "/api/login", { username: "eve", password: "editorpass1", code: rec })).status, 401);

  // The owner signs Eve out everywhere: her devices are told to wipe offline data.
  assert.equal((await staff("POST", "/api/users/x/signout")).status, 403);
  const eveId = (await owner("GET", "/api/users")).data.find((u) => u.username === "eve").id;
  assert.equal((await owner("POST", `/api/users/${eveId}/signout`)).status, 200);
  const gone = await dev("GET", "/api/c/dealers");
  assert.equal(gone.status, 401);
  assert.equal(gone.data.code, "revoked");
  assert.equal((await dev("GET", "/")).status, 302);
  // The owner resets her two-step sign-in (lost phone): password alone works again.
  await owner("PATCH", `/api/users/${eveId}`, { resetTwoStep: true });
  assert.equal((await client()("POST", "/api/login", { username: "eve", password: "editorpass1" })).status, 200);

  // Staff sessions last 7 days, owners' and editors' 30.
  const cookieDays = async (username, password) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    return Math.round(Number(/Max-Age=(\d+)/.exec(r.headers.get("set-cookie"))[1]) / 86400);
  };
  assert.equal(await cookieDays("ben", "staffpass1"), 7);
  assert.equal(await cookieDays("eve", "editorpass1"), 30);
});
