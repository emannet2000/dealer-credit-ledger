"use strict";
// End-to-end API tests: run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
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
  assert.equal(db.pragma("user_version", { simple: true }), 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1, "sessions survive the upgrade");
  db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, dealer_id) VALUES ('u2','m','M','dealer','x',1,1,'d1')").run();
  db.close(); fs.rmSync(d, { recursive: true, force: true });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
const { app, close, backupNow } = createApp({ dataDir: dir, logger: { error() {} } });
let server, base;

function client() {
  let cookie = "";
  const versions = new Map();
  return async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && !isBuf ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(versions.has(url)?{"If-Match":String(versions.get(url))}:{}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (r.ok && data && data.version) versions.set(url, data.version);
    if (r.ok && Array.isArray(data) && url.startsWith("/api/c/")) for (const row of data) versions.set(url+"/"+row.id, row.version);
    return { status: r.status, data };
  };
}
const owner = client(), staff = client(), viewer = client(), anon = client();
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("first run creates the owner, then setup is closed", async () => {
  assert.equal((await anon("GET", "/api/setup")).data.needsSetup, true);
  assert.equal((await owner("POST", "/api/setup", { name: "Owner", username: "owner", password: "OwnerSecret123!" })).status, 200);
  assert.equal((await anon("POST", "/api/setup", { name: "X", username: "x", password: "OwnerSecret123!" })).status, 409);
  assert.equal((await owner("GET", "/api/me")).data.role, "owner");
});

test("signed-out visitors get nothing", async () => {
  assert.equal((await anon("GET", "/api/c/dealers")).status, 401);
  assert.equal((await anon("GET", "/")).status, 302);
});

test("owner adds staff and viewer accounts; wrong passwords are rejected", async () => {
  assert.equal((await owner("POST", "/api/users", { name: "Ben", username: "ben", password: "StaffPassword123!", role: "staff" })).status, 200);
  assert.equal((await owner("POST", "/api/users", { name: "Acct", username: "acct", password: "ViewPassword123!", role: "viewer" })).status, 200);
  assert.equal((await staff("POST", "/api/login", { username: "ben", password: "nope" })).status, 401);
  assert.equal((await staff("POST", "/api/login", { username: "ben", password: "StaffPassword123!" })).status, 200);
  assert.equal((await viewer("POST", "/api/login", { username: "acct", password: "ViewPassword123!" })).status, 200);
  assert.equal((await staff("POST", "/api/users", { name: "Z", username: "zed", password: "zzzzzzzz", role: "editor" })).status, 403);
});

test("credit sales get sequential DR numbers and stock moves atomically", async () => {
  await owner("PUT", "/api/c/settings/store", { data: { holdDays: 60, discountPct: 25 } });
  await owner("PUT", "/api/c/dealers/d1", { data: { name: "Maria", creditLimit: 5000, terms: 30 } });
  await owner("PUT", "/api/c/products/p1", { data: { name: "Soap", dealerPrice: 75, srp: 100, stock: 50, purchaseCost: 50 } });
  const a = await staff("PUT", "/api/c/txns/s1", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [{ productId: "p1", name: "Soap", qty: 4, price: 100 }], subtotal: 400, discountPct: 25, pctDiscount: 100, amount: 300 } });
  const b = await staff("PUT", "/api/c/txns/s2", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [], amount: 100, no: "DR-00001" } });
  assert.equal(a.data.data.no, "DR-00001");
  assert.equal(b.data.data.no, "DR-00002", "duplicate numbers are replaced");
  assert.equal((await staff("GET", "/api/c/products")).data.find(r=>r.id==="p1").data.stock,46,"sale updates stock in the same transaction");
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
  const own = await staff("PATCH", "/api/c/txns/s1", { data: { note: "fixed", correctionReason: "Corrected delivery note" } });
  assert.equal(own.status, 200);
  assert.equal(own.data.data.no, "DR-00001");
  await owner("PUT", "/api/c/txns/o1", { data: { type: "payment", dealerId: "d1", date: day(0), amount: 50, method: "Cash" } });
  assert.equal((await staff("PATCH", "/api/c/txns/o1", { data: { voided: true } })).status, 403);
});

test("credit hold blocks staff releases to late dealers; the owner can still release", async () => {
  await owner("PUT", "/api/c/dealers/late", { data: { name: "Late Larry", creditLimit: 10000, terms: 15 } });
  await owner("PUT", "/api/c/txns/old", { data: { type: "sale", opening: true, dealerId: "late", date: day(-100), dueDate: day(-85), items: [], amount: 800 } });
  const blocked = await staff("PUT", "/api/c/txns/new1", { data: { type: "sale", dealerId: "late", date: day(0), dueDate: day(15), items: [], amount: 100 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "credit_hold");
  const over = await staff("PUT", "/api/c/txns/new2", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [], amount: 6000 } });
  assert.equal(over.status, 409, "over the credit limit");
  assert.equal((await owner("PUT", "/api/c/txns/new3", { data: { type: "sale", dealerId: "late", date: day(0), dueDate: day(15), items: [], amount: 100, override: { reason: "Owner approved an exceptional release" } } })).status, 200);
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
  assert.equal((await owner("POST", "/api/users", { name: "Maria", username: "maria", password: "DealerPassword123!", role: "dealer" })).status, 400, "needs a dealer");
  assert.equal((await owner("POST", "/api/users", { name: "Maria", username: "maria", password: "DealerPassword123!", role: "dealer", dealerId: "d1" })).status, 200);
  assert.equal((await portal("POST", "/api/login", { username: "maria", password: "DealerPassword123!" })).status, 200);
  const dealers = (await portal("GET", "/api/c/dealers")).data;
  assert.deepEqual(dealers.map((d) => d.id), ["d1"]);
  const txns = (await portal("GET", "/api/c/txns")).data;
  assert.ok(txns.length > 0 && txns.every((t) => t.data.dealerId === "d1"), "only own transactions");
  assert.ok(txns.every((t) => t.data.createdBy === undefined), "staff ids hidden");
  assert.ok(txns.every(t=>(t.data.items||[]).every(i=>i.unitCost===undefined)), "purchase cost snapshots hidden from dealers");
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
  await portal("POST", "/api/login", { username: "maria", password: "DealerPassword123!" });
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
  await owner("GET", "/api/c/orders");
  const st = await owner("PATCH", "/api/c/orders/o1", { data: { status: "preparing" } });
  assert.equal(st.data.data.statusHistory.length, 2);
  await portal("GET", "/api/c/orders");
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
  assert.equal((await portal("PATCH", "/api/c/orders/o5", { data: {} })).status, 403, "no-op updates cannot expose another dealer order");
  assert.equal((await owner("GET", "/api/c/orders")).data.length, 3, "the two rejected orders were not saved");
});

test("promos and per-product discounts price online orders; staff can't change them", async () => {
  await owner("PUT", "/api/c/products/p2", { data: { name: "Fabcon", dealerPrice: 135, srp: 180, stock: 10, promo: { price: 150, from: day(-1), to: day(5), noDiscount: false } } });
  await owner("PUT", "/api/c/products/p3", { data: { name: "Net item", dealerPrice: 50, srp: 50, stock: 10, discountPct: 0 } });
  await owner("PUT", "/api/c/products/p4", { data: { name: "Final promo", dealerPrice: 90, srp: 120, stock: 10, promo: { price: 99, from: day(-1), to: day(5), noDiscount: true } } });
  await owner("PUT", "/api/c/products/p5", { data: { name: "Ended promo", dealerPrice: 75, srp: 100, stock: 10, promo: { price: 60, from: day(-30), to: day(-1) } } });
  const portal = client();
  await portal("POST", "/api/login", { username: "maria", password: "DealerPassword123!" });
  const r = await portal("PUT", "/api/c/orders/pr1", { data: { items: ["p2", "p3", "p4", "p5"].map((productId) => ({ productId, qty: 1 })) } });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.data.items.map((i) => [i.productId, i]));
  assert.deepEqual([by.p2.price, by.p2.pct, !!by.p2.promo], [150, 25, true], "promo price, dealer discount still applies");
  assert.deepEqual([by.p3.price, by.p3.pct], [50, 0], "net-priced item");
  assert.deepEqual([by.p4.price, by.p4.pct], [99, 0], "final promo price");
  assert.deepEqual([by.p5.price, !!by.p5.promo], [100, false], "ended promo is ignored");
  assert.equal(r.data.data.discountPct, null, "mixed discounts");
  assert.equal(r.data.data.amount, 150 * 0.75 + 50 + 99 + 100 * 0.75);
  await staff("POST", "/api/login", { username: "ben", password: "StaffPassword123!" });
  await owner("PATCH", "/api/users/" + (await owner("GET", "/api/users")).data.find((u) => u.username === "ben").id, { active: true });
  await staff("POST", "/api/login", { username: "ben", password: "StaffPassword123!" });
  await staff("PUT", "/api/c/products/p2", { data: { name: "Fabcon", srp: 1, promo: { price: 1 }, discountPct: 99 } });
  const p2 = (await owner("GET", "/api/c/products")).data.find((p) => p.id === "p2").data;
  assert.deepEqual([p2.srp, p2.promo.price, p2.discountPct], [180, 150, null]);
});

test("automatic backup writes a database copy", async () => {
  const f = await backupNow();
  assert.ok(fs.statSync(f).size > 0);
});

test("login and logout history records the actor and time and invalidates the session", async () => {
  const person = client();
  const started = Date.now();
  assert.equal((await person("POST", "/api/login", { username: "owner", password: "OwnerSecret123!" })).status, 200);
  assert.equal((await person("POST", "/api/logout")).status, 200);
  assert.equal((await person("GET", "/api/me")).status, 401);
  // Repeated or anonymous logout must not invent an extra history entry.
  assert.equal((await person("POST", "/api/logout")).status, 200);
  const history = await owner("GET", "/api/audit?kind=auth&limit=500");
  assert.equal(history.status, 200);
  assert.ok(history.data.every(a => ["login", "logout"].includes(a.action)));
  const events = history.data.filter(a => a.at >= started && a.user_name === "Owner");
  assert.deepEqual(events.map(a => a.action), ["logout", "login"]);
  assert.equal((await anon("GET", "/api/audit?kind=auth")).status, 401);
  assert.equal((await viewer("GET", "/api/audit?kind=auth")).status, 403);
  const activity = await owner("GET", "/api/audit?limit=500");
  assert.ok(activity.data.some(a => a.action === "logout" && a.user_name === "Owner"));
});
