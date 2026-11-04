"use strict";
// Edge cases: hostile, broken and extreme input. The server must refuse cleanly, never crash
// with a 500, and never let bad values into the ledger.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../lib/app");
const { today, settle } = require("../lib/credit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-edge-"));
const h = createApp({ dataDir: dir, logger: { error() {} } });
let server, base, cookie = "";
const raw = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { Cookie: cookie, ...headers }, body });
const api = async (method, url, body) => { const r = await raw(method, url, body === undefined ? undefined : JSON.stringify(body), { "Content-Type": "application/json" }); const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0]; const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: r.status, data }; };
const noCrash = (r, what) => assert.ok(r.status < 500, `${what} crashed: ${r.status} ${JSON.stringify(r.data)}`);
const day = today();

test.before(async () => {
  server = h.app.listen(0); await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api("POST", "/api/setup", { name: "O", username: "owner", password: "secret123" });
  await api("PUT", "/api/c/settings/store", { data: { storeName: "E" } });
  await api("PUT", "/api/c/dealers/d1", { data: { name: "Edge Dealer", terms: 30, creditLimit: 1e9 } });
  await api("PUT", "/api/c/products/p1", { data: { name: "Edge Item", dealerPrice: 75, srp: 100, stock: 1000, active: true } });
});
test.after(() => { server.closeAllConnections(); server.close(); h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("broken JSON and wrong content are refused, not crashed on", async () => {
  for (const url of ["/api/c/dealers/z", "/api/login", "/api/cash/close"]) {
    const r = await raw("POST", url, "{not json", { "Content-Type": "application/json" });
    assert.ok(r.status >= 400 && r.status < 500, `${url}: ${r.status}`);
  }
  noCrash(await api("PUT", "/api/c/dealers/z", null), "null body");
  noCrash(await api("PUT", "/api/c/dealers/z", []), "array body");
  noCrash(await api("PUT", "/api/c/dealers/z", { data: "text" }), "text data");
  noCrash(await api("PUT", "/api/c/dealers/z", { data: [] }), "array data");
});

test("every action route survives an empty or nonsense body", async () => {
  const routes = ["/api/cash/close", "/api/cash/reopen", "/api/remittances", "/api/checks/x/clear", "/api/checks/x/bounce", "/api/plans", "/api/plans/x/cancel", "/api/latefees/post",
    "/api/disputes", "/api/disputes/x/resolve", "/api/creditapps", "/api/creditapps/x/approve", "/api/creditapps/x/reject", "/api/dealers/x/review", "/api/orders/x/delivery",
    "/api/purchases/x/receive", "/api/purchases/x/pay", "/api/stock/transfer", "/api/stock", "/api/merge/dealers", "/api/merge/products", "/api/signoffs", "/api/signoffs/x/approve", "/api/signoffs/x/reject",
    "/api/proofs/x/approve", "/api/proofs/x/reject", "/api/remittances/x/decide", "/api/periods/close", "/api/periods/reopen", "/api/password/forgot", "/api/password/recover", "/api/push/subscribe", "/api/push/unsubscribe", "/api/approvals"];
  for (const body of [{}, { date: 5, amount: "x", lines: "no", txnId: {}, keepId: [], reason: 7, limit: -1, username: 5, password: {}, counted: "x", items: 3, photos: "x", txnIds: 1, subscription: 1, deltas: 1, productId: [], qty: "x" }]) {
    for (const url of routes) noCrash(await api("POST", url, body), `${url} ${JSON.stringify(body).slice(0, 30)}`);
  }
});

test("impossible amounts never reach the ledger", async () => {
  for (const amount of [0, -5, "abc", null, Infinity, 1e308 * 10, NaN, {}, []]) {
    const r = await api("PUT", "/api/c/txns/bad", { data: { type: "payment", dealerId: "d1", date: day, amount, method: "Cash" } });
    assert.equal(r.status, 400, `amount ${amount}`);
  }
  assert.equal((await api("GET", "/api/c/txns")).data.some((t) => t.id === "bad"), false);
});

test("impossible quantities and prices are refused", async () => {
  for (const line of [{ qty: 0 }, { qty: -1 }, { qty: "x" }, { qty: 1e9 }, { price: -1 }, { price: "x" }, { productId: "../etc/passwd" }, { productId: "missing" }]) {
    const r = await api("PUT", "/api/c/txns/bad2", { data: { type: "sale", dealerId: "d1", date: day, dueDate: day, items: [{ productId: "p1", name: "x", qty: 1, price: 100, pct: 0, ...line }] } });
    assert.equal(r.status, 400, JSON.stringify(line));
  }
  const hundred = await api("PUT", "/api/c/txns/odd", { data: { type: "sale", dealerId: "d1", date: day, dueDate: day, items: [{ productId: "p1", name: "x", qty: 1, price: 100, pct: 500 }] } });
  noCrash(hundred, "a 500% discount");
  assert.notEqual(hundred.status === 200 && hundred.data.data.amount < 0, true, "a sale can't go negative");
});

test("record IDs can't escape the database or the uploads folder", async () => {
  for (const id of ["..%2F..%2Fetc%2Fpasswd", "a%20b", "%00", "a'b", 'a"b', "x".repeat(200)]) {
    const r = await api("PUT", `/api/c/dealers/${id}`, { data: { name: "Id " + id.slice(0, 8) + Math.random() } });
    assert.equal(r.status, 400, id);
    assert.ok((await raw("GET", `/_blob/${id}`)).status >= 400);
  }
  assert.equal((await api("GET", "/api/c/secrets")).status, 404, "unknown collections are refused");
});

test("SQL-looking text is stored as plain text", async () => {
  const name = `Robert'); DROP TABLE docs;-- ${Date.now()}`;
  assert.equal((await api("PUT", "/api/c/dealers/sql", { data: { name } })).status, 200);
  assert.equal((await api("GET", "/api/c/dealers")).data.find((d) => d.id === "sql").data.name, name);
  const r = await api("POST", "/api/login", { username: "' OR 1=1 --", password: "' OR 1=1 --" });
  assert.equal(r.status, 401);
});

test("script tags are never run on the pages", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "ops.js"), "utf8");
  // Every value from a record goes through esc(), P(), or a number in the Cash and Buying screens.
  for (const field of ["s.name", "r.reason", "r.note", "t.no", "inv.no", "e.category", "e.payee", "d.note", "a.references"]) {
    const unsafe = new RegExp("\\$\\{" + field.replace(".", "\\.") + "\\}");
    assert.doesNotMatch(app, unsafe, `${field} must be escaped`);
  }
});

test("very long text is cut or refused, not stored whole", async () => {
  const long = "x".repeat(300000);
  assert.equal((await api("PUT", "/api/c/dealers/long", { data: { name: "Long", notes: long } })).status, 413);
  const r = await api("PUT", "/api/c/expenses/e1", { data: { date: day, category: long.slice(0, 5000), amount: 1, note: long.slice(0, 5000) } });
  assert.equal(r.status, 200);
  assert.equal(r.data.data.category.length, 60);
  assert.equal(r.data.data.note.length, 300);
});

test("names in any language keep their spelling", async () => {
  for (const [id, name] of [["u1", "Niño Peñaflor"], ["u2", "José Ñ. Dela Cruz"], ["u3", "李小龍"], ["u4", "Fátima 🌸 Ali"]]) {
    const r = await api("PUT", "/api/c/dealers/" + id, { data: { name } });
    assert.equal(r.status, 200, name);
    assert.equal(r.data.data.name, name);
  }
});

test("names with no Latin letters can't all count as duplicates of each other", async () => {
  assert.equal((await api("PUT", "/api/c/dealers/u5", { data: { name: "王小明" } })).status, 200);
  assert.equal((await api("PUT", "/api/c/dealers/u6", { data: { name: "陈美丽" } })).status, 200);
});

test("centavo rounding can't lose or create money", async () => {
  await api("PUT", "/api/c/dealers/r1", { data: { name: "Rounding Rina", terms: 30, creditLimit: 1e9 } });
  await api("PUT", "/api/c/txns/r-s", { data: { type: "sale", opening: true, dealerId: "r1", date: day, dueDate: day, amount: 0.3 } });
  for (let i = 0; i < 3; i++) await api("PUT", "/api/c/txns/r-p" + i, { data: { type: "payment", dealerId: "r1", date: day, amount: 0.1, method: "Cash" } });
  const t = (await api("GET", "/api/c/txns")).data.filter((x) => x.data.dealerId === "r1").map((x) => ({ ...x.data, _id: x.id }));
  const r = settle(t);
  assert.equal(r.balance, 0);
  assert.equal(r.open.length, 0);
  assert.equal(r.credit, 0);
});

test("dates: bad, future and leap days", async () => {
  for (const date of ["2026-13-01", "2026-02-30", "soon", "", 5]) {
    noCrash(await api("POST", "/api/cash/close", { date, counted: {} }), `close ${date}`);
    noCrash(await api("POST", "/api/periods/close", { through: date }), `period ${date}`);
  }
  assert.equal((await api("POST", "/api/periods/close", { through: "2026-13-01" })).status, 400);
  assert.equal((await api("POST", "/api/periods/close", { through: "2026-02-30" })).status, 400, "30 February isn't a day");
  for (const date of ["soon", "2026-02-30", "", null, 5]) {
    assert.equal((await api("PUT", "/api/c/txns/bad-date", { data: { type: "payment", dealerId: "d1", date, amount: 1, method: "Cash" } })).status, 400, `date ${date}`);
    assert.equal((await api("PUT", "/api/c/txns/bad-due", { data: { type: "sale", opening: true, dealerId: "d1", date: day, dueDate: date === "" || date === null ? "x" : date, amount: 1 } })).status, 400, `due ${date}`);
  }
  assert.equal((await api("POST", "/api/cash/close", { date: "2999-01-01", counted: {} })).status, 400, "future days can't be closed");
  assert.equal((await api("POST", "/api/periods/close", { through: "2024-02-29" })).status, 200, "a real leap day is fine");
  await api("POST", "/api/periods/reopen", { reason: "test" });
});

test("two payments at once get different receipt numbers", async () => {
  await api("PUT", "/api/c/dealers/c1", { data: { name: "Concurrent Cora", terms: 30 } });
  const r = await Promise.all(Array.from({ length: 12 }, (_, i) => api("PUT", "/api/c/txns/c-p" + i, { data: { type: "payment", dealerId: "c1", date: day, amount: 1, method: "Cash" } })));
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(new Set(r.map((x) => x.data.data.no)).size, 12);
});

test("two people can't take the last item", async () => {
  await api("PUT", "/api/c/products/last", { data: { name: "Last One", dealerPrice: 75, srp: 100, stock: 1, active: true } });
  const sell = (id) => api("PUT", "/api/c/txns/" + id, { data: { type: "sale", dealerId: "d1", date: day, dueDate: day, items: [{ productId: "last", name: "Last One", qty: 1, price: 100, pct: 0 }] } });
  const r = await Promise.all([sell("l1"), sell("l2"), sell("l3")]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409, 409]);
  assert.equal((await api("GET", "/api/c/products")).data.find((p) => p.id === "last").data.stock, 0);
});

test("the same dispute, approval or remittance can't be decided twice at once", async () => {
  await api("PUT", "/api/c/txns/q-s", { data: { type: "sale", opening: true, dealerId: "d1", date: day, dueDate: day, amount: 100 } });
  const d = await api("POST", "/api/disputes", { dealerId: "d1", txnId: "q-s", reason: "other", amount: 50 });
  const r = await Promise.all([1, 2, 3].map(() => api("POST", `/api/disputes/${d.data.id}/resolve`, { outcome: "accepted", note: "ok" })));
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409, 409]);
  const credits = (await api("GET", "/api/c/txns")).data.filter((t) => t.data.disputeId === d.data.id);
  assert.equal(credits.length, 1, "the dealer is credited once");
});

test("signed-out visitors can't reach any new route", async () => {
  const saved = cookie; cookie = "";
  for (const [m, u] of [["GET", "/api/status"], ["GET", "/api/latefees"], ["GET", "/api/cash/day/" + day], ["POST", "/api/plans"], ["POST", "/api/disputes"], ["POST", "/api/creditapps"], ["POST", "/api/merge/dealers"], ["POST", "/api/purchases/x/pay"], ["POST", "/api/stock/transfer"], ["POST", "/api/signoffs"], ["GET", "/api/password/requests"], ["GET", "/api/push/key"]])
    assert.equal((await api(m, u, m === "POST" ? {} : undefined)).status, 401, u);
  cookie = saved;
});

test("a request from another website is blocked", async () => {
  const r = await raw("POST", "/api/stock", JSON.stringify({ deltas: {} }), { "Content-Type": "application/json", Origin: "https://evil.example" });
  assert.equal(r.status, 403);
});
