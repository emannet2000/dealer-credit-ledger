"use strict";
// Daily operations through the real API: cash close, collectors, checks, reminders,
// proof of payment and purchasing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { createApp } = require("../lib/app");
const { today } = require("../lib/credit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ops-"));
let h, server, base;
const day = (n) => { const d = new Date(today() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function client() {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(base + url, { method, headers: { ...(raw ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ? body : body && JSON.stringify(body) });
    const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
}
const owner = client(), editor = client(), staff = client(), coll = client(), viewer = client(), portal = client(), other = client();
const doc = async (c, id, who = owner) => (await who("GET", `/api/c/${c}`)).data.find((d) => d.id === id)?.data;
const balance = (dealerId) => dealerBal(dealerId);
async function dealerBal(id) {
  const { settle } = require("../lib/credit");
  return settle((await owner("GET", "/api/c/txns")).data.filter((t) => t.data.dealerId === id).map((t) => ({ ...t.data, _id: t.id }))).balance;
}
const sale = (id, dealerId, amount, date = day(-40), dueDate = day(-10)) => owner("PUT", "/api/c/txns/" + id, { data: { type: "sale", opening: true, dealerId, date, dueDate, amount } });
const pay = (who, id, dealerId, amount, extra = {}) => who("PUT", "/api/c/txns/" + id, { data: { type: "payment", dealerId, date: today(), amount, method: "Cash", ...extra } });
let collectorId;

test.before(async () => {
  h = createApp({ dataDir: dir, logger: { error() {} } });
  server = h.app.listen(0); await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await owner("POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" });
  for (const [name, username, role] of [["Edna", "edna", "editor"], ["Sam", "sam", "staff"], ["Cora", "cora", "staff"], ["Val", "val", "viewer"]])
    await owner("POST", "/api/users", { name, username, password: "password1", role });
  for (const id of ["d1", "d2", "d3", "d4", "d5"]) await owner("PUT", "/api/c/dealers/" + id, { data: { name: `Dealer ${id}`, phone: "0917 000 000" + id[1], terms: 30, creditLimit: 900000 } });
  await owner("POST", "/api/users", { name: "D One", username: "done", password: "password1", role: "dealer", dealerId: "d1" });
  await owner("POST", "/api/users", { name: "D Two", username: "dtwo", password: "password1", role: "dealer", dealerId: "d2" });
  await editor("POST", "/api/login", { username: "edna", password: "password1" });
  await staff("POST", "/api/login", { username: "sam", password: "password1" });
  await viewer("POST", "/api/login", { username: "val", password: "password1" });
  await portal("POST", "/api/login", { username: "done", password: "password1" });
  await other("POST", "/api/login", { username: "dtwo", password: "password1" });
  collectorId = (await owner("GET", "/api/users")).data.find((u) => u.username === "cora").id;
  assert.equal((await owner("PATCH", "/api/users/" + collectorId, { collector: true })).status, 200);
  await coll("POST", "/api/login", { username: "cora", password: "password1" });
});
test.after(() => { server.closeAllConnections(); server.close(); h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("post-dated checks wait, then clear or bounce (FR-072)", async () => {
  await sale("c-s1", "d3", 1000);
  const check = (no, date) => ({ method: "Check", check: { bank: "BDO", number: no, date } });
  assert.equal((await pay(staff, "c-bad", "d3", 100, { method: "Check", check: { bank: "", number: "", date: "" } })).status, 400);
  assert.equal((await pay(staff, "c-cash", "d3", 100, { check: { bank: "BDO", number: "1", date: today() } })).status, 400, "check details only go on check payments");

  assert.equal((await pay(staff, "c-p1", "d3", 400, check("111", day(10)))).status, 200);
  assert.equal(await balance("d3"), 1000, "a post-dated check doesn't reduce the balance");
  assert.equal((await doc("txns", "c-p1")).check.status, "pending");
  assert.equal((await staff("POST", "/api/checks/c-p1/clear", {})).status, 200);
  assert.equal(await balance("d3"), 600, "clearing counts it straight away");
  assert.equal((await staff("POST", "/api/checks/c-p1/clear", {})).status, 409);

  assert.equal((await pay(staff, "c-p2", "d3", 200, check("222", today()))).status, 200);
  assert.equal(await balance("d3"), 400, "a check dated today counts");
  const bad = await staff("POST", "/api/checks/c-p2/bounce", { fee: 150, reason: "Insufficient funds" });
  assert.equal(bad.status, 200);
  assert.equal(await balance("d3"), 750, "the payment is reversed and the fee added");
  const t = await doc("txns", "c-p2");
  assert.equal(t.check.status, "bounced"); assert.equal(t.voided, true);
  assert.equal((await staff("POST", "/api/checks/c-p2/bounce", {})).status, 409);
  assert.ok((await owner("GET", "/api/audit")).data.some((a) => a.action === "check_bounced"));

  // A status can't be set by editing the payment.
  await pay(staff, "c-p3", "d3", 50, check("333", day(5)));
  const p3 = await doc("txns", "c-p3");
  await owner("PUT", "/api/c/txns/c-p3", { data: { ...p3, check: { ...p3.check, status: "cleared" } } });
  assert.equal((await doc("txns", "c-p3")).check.status, "pending");
});

test("a bounced check in closed books is reversed by a new debit", async () => {
  await sale("c-s2", "d4", 500);
  await pay(owner, "c-p4", "d4", 300, { date: day(-3), method: "Check", check: { bank: "BPI", number: "9", date: day(-3) } });
  await owner("POST", "/api/periods/close", { through: day(-2) });
  assert.equal((await staff("POST", "/api/checks/c-p4/bounce", {})).status, 200);
  const t = await doc("txns", "c-p4");
  assert.ok(!t.voided, "the closed period isn't rewritten");
  assert.equal(await balance("d4"), 500, "the dealer owes it again through a debit dated today");
  assert.equal((await owner("POST", "/api/periods/reopen", { reason: "test done" })).status, 200);
});

test("daily cash close compares counts and locks the day (FR-079)", async () => {
  const d = day(-1);
  await sale("k-s1", "d5", 2000);
  await pay(staff, "k-p1", "d5", 300, { date: d });
  await pay(staff, "k-p2", "d5", 200, { date: d, method: "GCash" });
  const dayInfo = await staff("GET", "/api/cash/day/" + d);
  assert.equal(dayInfo.data.expected.Cash, 300);
  assert.equal(dayInfo.data.expected.GCash, 200);
  assert.equal((await viewer("GET", "/api/cash/day/" + d)).status, 403);

  assert.equal((await staff("POST", "/api/cash/close", { date: d, counted: { Cash: 250, GCash: 200 } })).data.code, "note_required");
  const close = await staff("POST", "/api/cash/close", { date: d, counted: { Cash: 250, GCash: 200 }, note: "Short ₱50, change given" });
  assert.equal(close.status, 200);
  assert.equal(close.data.diff, -50);
  assert.equal(close.data.rows.Cash.diff, -50);
  assert.equal((await staff("POST", "/api/cash/close", { date: d, counted: {} })).data.code, "day_closed");

  assert.equal((await pay(owner, "k-p3", "d5", 10, { date: d })).data.code, "day_closed", "not even the owner, until the day is reopened");
  const p1 = await doc("txns", "k-p1");
  assert.equal((await owner("PUT", "/api/c/txns/k-p1", { data: { ...p1, voided: true } })).data.code, "day_closed");
  assert.equal((await owner("POST", "/api/cash/reopen", { date: d, reason: "" })).status, 400);
  assert.equal((await editor("POST", "/api/cash/reopen", { date: d, reason: "x" })).status, 403);
  assert.equal((await owner("POST", "/api/cash/reopen", { date: d, reason: "Found receipt" })).status, 200);
  assert.equal((await pay(owner, "k-p3", "d5", 10, { date: d })).status, 200);
  assert.equal((await doc("cashcloses", d)).log[0].reason, "Found receipt");
});

test("collectors are tagged, and differences need approval (FR-077)", async () => {
  await sale("r-s1", "d5", 3000);
  assert.equal((await pay(coll, "r-p1", "d5", 500)).status, 200);
  assert.equal((await doc("txns", "r-p1")).collectorId, collectorId);
  await pay(coll, "r-p2", "d5", 100, { method: "Check", check: { bank: "BDO", number: "7", date: today() } });
  await pay(coll, "r-p3", "d5", 70, { method: "GCash" });
  await pay(staff, "r-p4", "d5", 999);
  assert.equal((await doc("txns", "r-p4")).collectorId, undefined);
  assert.equal((await pay(owner, "r-p5", "d5", 1, { collectorId: "someone" })).status, 200);
  assert.equal((await doc("txns", "r-p5")).collectorId, undefined, "a collector can't be claimed by the client");

  assert.equal((await staff("POST", "/api/remittances", { date: today(), cash: 1, checks: 0 })).status, 403);
  const short = await coll("POST", "/api/remittances", { date: today(), cash: 480, checks: 100, note: "Lost ₱20" });
  assert.equal(short.data.data.status, "pending");
  assert.equal(short.data.data.diff, -20);
  assert.equal(short.data.data.expectedCash, 500);
  const id = short.data.id;
  assert.equal((await staff("POST", `/api/remittances/${id}/decide`, { note: "ok" })).status, 403);
  assert.equal((await owner("POST", `/api/remittances/${id}/decide`, {})).status, 400);
  assert.equal((await owner("POST", `/api/remittances/${id}/decide`, { note: "Deducted from salary" })).status, 200);
  assert.equal((await coll("POST", "/api/remittances", { date: today(), cash: 500, checks: 100 })).status, 409, "an approved remittance is final");
  assert.equal((await doc("remittances", id)).decisionNote, "Deducted from salary");
});

test("a matching remittance needs no approval", async () => {
  await sale("r-s2", "d2", 100);
  const d = day(-2);
  await pay(owner, "r-p9", "d2", 1, { date: d }); // not this collector's
  const r = await coll("POST", "/api/remittances", { date: d, cash: 0, checks: 0 });
  assert.equal(r.data.data.status, "matched");
});

test("dealers send proof of payment; staff approve or reject (FR-076)", async () => {
  await sale("q-s1", "d1", 800);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const up = await portal("POST", "/api/portal/proofs/photo", png, { "Content-Type": "image/png" });
  assert.equal(up.status, 200);
  assert.equal((await staff("POST", "/api/portal/proofs/photo", png, { "Content-Type": "image/png" })).status, 403);
  assert.equal((await portal("POST", "/api/portal/proofs/photo", png, { "Content-Type": "text/html" })).status, 415);
  const photo = up.data.id;

  assert.equal((await portal("GET", "/_blob/" + photo)).status, 200);
  assert.equal((await staff("GET", "/_blob/" + photo)).status, 200);
  assert.equal((await other("GET", "/_blob/" + photo)).status, 404, "another dealer can't open it");
  assert.equal((await viewer("GET", "/_blob/" + photo)).status, 404);

  const send = (who, extra = {}) => who("POST", "/api/portal/proofs", { amount: 300, method: "GCash", ref: "GC123", date: today(), photos: [photo], ...extra });
  assert.equal((await send(other)).status, 400, "another dealer's photo can't be used");
  assert.equal((await send(portal, { photos: [] })).status, 400);
  const first = await send(portal);
  assert.equal(first.status, 200);
  assert.equal(await balance("d1"), 800, "a submission doesn't change the balance");
  assert.equal(first.data.data.refUsedOn, null);
  assert.equal((await send(portal)).data.data.refUsedOn, "another submission");

  assert.equal((await other("GET", "/api/c/proofs")).data.length, 0, "dealers see only their own");
  assert.equal((await portal("GET", "/api/c/proofs")).data.length, 2);
  assert.equal((await viewer("GET", "/api/c/proofs")).data.length, 0);
  assert.equal((await portal("POST", `/api/proofs/${first.data.id}/approve`, {})).status, 403);
  assert.equal((await staff("PUT", "/api/c/proofs/x", { data: { status: "approved" } })).status, 403);

  const ok = await staff("POST", `/api/proofs/${first.data.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.match(ok.data.no, /^OR-/);
  assert.equal(await balance("d1"), 500);
  assert.equal((await staff("POST", `/api/proofs/${first.data.id}/approve`, {})).status, 409, "approving twice can't pay twice");

  const second = (await portal("GET", "/api/c/proofs")).data.find((p) => p.data.status === "pending");
  assert.equal((await staff("POST", `/api/proofs/${second.id}/reject`, {})).status, 400);
  assert.equal((await staff("POST", `/api/proofs/${second.id}/reject`, { reason: "Duplicate" })).status, 200);
  assert.equal((await portal("GET", "/api/c/proofs")).data.find((p) => p.id === second.id).data.reason, "Duplicate");
  assert.equal((await send(portal, { ref: "OTHER" })).data.data.refUsedOn, null);
  assert.equal(h.cleanupAssets(-1000).includes(photo), false, "attached receipts are kept");
});

test("reminders follow the schedule, skip paid and opted-out dealers, and log failures (FR-071)", async () => {
  const seen = [];
  let fail = false;
  const gw = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.statusCode = fail ? 500 : 200; res.end(); }); });
  gw.listen(0); await new Promise((r) => gw.once("listening", r));
  const store = (await doc("settings", "store")) || {};
  await owner("PUT", "/api/c/settings/store", { data: { ...store, storeName: "Test Store", phone: "02 1234", reminders: { enabled: true, days: [-3, 0, 7, "x"] } } });
  assert.deepEqual((await doc("settings", "store")).reminders.days, [-3, 0, 7]);

  for (const [id, data] of [["m1", { name: "Rem One", phone: "0917" }], ["m2", { name: "Rem Two", phone: "0918", noReminders: true }], ["m3", { name: "Rem Three", email: "t@example.com" }], ["m4", { name: "Rem Four" }], ["m5", { name: "Rem Five", phone: "0919" }]])
    await owner("PUT", "/api/c/dealers/" + id, { data: { ...data, terms: 30, creditLimit: 9000 } });
  await sale("m-s1", "m1", 100, day(-20), day(3));
  await sale("m-s2", "m2", 100, day(-20), day(3));
  await sale("m-s3", "m3", 100, day(-20), day(-7));
  await sale("m-s4", "m4", 100, day(-20), day(0));
  await sale("m-s5", "m5", 100, day(-20), day(3));
  await pay(owner, "m-p5", "m5", 100);
  await sale("m-s6", "m1", 100, day(-20), day(2)); // not a scheduled day

  const before = process.env.REMINDER_WEBHOOK_URL;
  try {
    delete process.env.REMINDER_WEBHOOK_URL;
    const noProvider = await h.runReminders();
    assert.ok(noProvider.failed >= 3);
    assert.match((await doc("reminders", `m1.${day(3)}.-3`)).error, /provider/);

    process.env.REMINDER_WEBHOOK_URL = `http://127.0.0.1:${gw.address().port}/send`;
    process.env.REMINDER_WEBHOOK_TOKEN = "tok";
    assert.equal((await staff("POST", "/api/reminders/run", {})).status, 403);
    const run = await owner("POST", "/api/reminders/run", {});
    assert.equal(run.status, 200);
    const to = seen.map((s) => s.to);
    assert.ok(to.includes("0917") && to.includes("t@example.com"));
    assert.ok(!to.includes("0918"), "opted out");
    assert.ok(!to.includes("0919"), "fully paid");
    const m = seen.find((s) => s.to === "0917");
    assert.equal(m.channel, "sms"); assert.equal(m.auth, "Bearer tok");
    assert.match(m.message, /Hi Rem, .*Test Store.*₱100\.00.*02 1234/);
    assert.equal(seen.find((s) => s.to === "t@example.com").channel, "email");
    assert.equal((await doc("reminders", `m4.${day(0)}.0`)).status, "failed", "no contact details is a visible failure");

    const n = seen.length;
    await h.runReminders();
    assert.equal(seen.filter((s) => s.to === "0917").length, 1, "a sent reminder is not repeated");
    assert.ok(seen.length === n);
    assert.equal((await viewer("GET", "/api/c/reminders")).data.length, 0);
  } finally {
    if (before === undefined) delete process.env.REMINDER_WEBHOOK_URL; else process.env.REMINDER_WEBHOOK_URL = before;
    delete process.env.REMINDER_WEBHOOK_TOKEN;
    gw.closeAllConnections(); gw.close();
  }
});

test("suppliers, purchase orders and goods received (FR-019 to FR-021)", async () => {
  await owner("PUT", "/api/c/products/g1", { data: { name: "Lotion", dealerPrice: 80, srp: 100, cost: 40, stock: 5, active: true } });
  await owner("PUT", "/api/c/products/g2", { data: { name: "Soap", dealerPrice: 20, srp: 30, cost: 10, stock: 0, active: true } });
  assert.equal((await staff("PUT", "/api/c/suppliers/s1", { data: { name: "ACME" } })).status, 403);
  assert.equal((await owner("PUT", "/api/c/suppliers/s0", { data: { name: " " } })).status, 400);
  assert.equal((await owner("PUT", "/api/c/suppliers/s1", { data: { name: "ACME", contact: "Rey", terms: 30 } })).status, 200);
  assert.equal((await viewer("GET", "/api/c/suppliers")).data.length, 0);

  const po = { supplierId: "s1", date: today(), status: "ordered", lines: [{ productId: "g1", qty: 10, cost: 45 }, { productId: "g2", qty: 4, cost: 12 }] };
  assert.equal((await owner("PUT", "/api/c/purchases/x", { data: { ...po, supplierId: "nope" } })).status, 400);
  assert.equal((await staff("PUT", "/api/c/purchases/p1", { data: po })).status, 403);
  const made = await owner("PUT", "/api/c/purchases/p1", { data: po });
  assert.equal(made.status, 200);
  assert.equal(made.data.data.no, "SPO-00001");
  assert.equal(made.data.data.total, 498);
  assert.equal((await owner("PUT", "/api/c/purchases/p2", { data: { ...po, status: "draft" } })).data.data.no, "SPO-00002");

  const seenByStaff = (await staff("GET", "/api/c/purchases")).data.find((p) => p.id === "p1").data;
  assert.equal(seenByStaff.lines[0].cost, undefined, "staff don't see cost prices");
  assert.equal(seenByStaff.total, undefined);

  assert.equal((await staff("POST", "/api/purchases/p2/receive", { lines: [{ productId: "g1", qty: 1 }] })).status, 409, "a draft can't be received");
  assert.equal((await staff("POST", "/api/purchases/p1/receive", { lines: [{ productId: "g1", qty: 11 }] })).status, 400, "no more than was ordered");
  assert.equal((await staff("POST", "/api/purchases/p1/receive", { lines: [] })).status, 400);
  const part = await staff("POST", "/api/purchases/p1/receive", { date: today(), ref: "DN-1", lines: [{ productId: "g1", qty: 6, cost: 1 }], invoice: { no: "INV-9", amount: 270, dueDate: day(30) } });
  assert.equal(part.status, 200);
  assert.equal(part.data.status, "partial");
  assert.equal((await doc("products", "g1")).stock, 11);
  assert.equal((await doc("products", "g1")).cost, 45, "staff can't change the cost; the order's cost is used");
  assert.equal((await doc("products", "g2")).stock, 0);
  assert.equal((await doc("purchases", "p1")).receipts[0].invoice.no, "INV-9");
  assert.ok((await owner("GET", "/api/c/moves")).data.some((m) => m.data.reason === "Purchase received" && m.data.qty === 6));
  assert.equal((await owner("PUT", "/api/c/purchases/p1", { data: { ...po, status: "cancelled" } })).status, 409, "received goods can't be cancelled away");

  const rest = await owner("POST", "/api/purchases/p1/receive", { lines: [{ productId: "g1", qty: 4, cost: 50 }, { productId: "g2", qty: 4 }] });
  assert.equal(rest.data.status, "received");
  assert.equal((await doc("products", "g1")).cost, 50, "an owner can record the new cost");
  assert.equal((await staff("POST", "/api/purchases/p1/receive", { lines: [{ productId: "g1", qty: 1 }] })).status, 409);
  assert.equal((await owner("DELETE", "/api/c/suppliers/s1")).status, 409, "suppliers on a purchase order can't be deleted");
  assert.equal((await owner("DELETE", "/api/c/purchases/p2")).status, 200, "a draft can be deleted");
  assert.equal((await owner("DELETE", "/api/c/purchases/p1")).status, 409);
});

test("a full backup keeps collectors and receipt owners", async () => {
  const b = await owner("GET", "/api/backup/full");
  assert.equal(b.data.users.find((u) => u.username === "cora").collector, 1);
  assert.ok(b.data.assets.some((a) => a.dealer_id === "d1"));
  assert.ok(Object.keys(b.data.collections.purchases).length);
});

test("every stock change leaves a trail of who, when and how many (FR-013)", async () => {
  const before = Date.now();
  const trail = async (id) => (await owner("GET", "/api/c/moves")).data.filter((m) => m.data.productId === id).map((m) => m.data).sort((a, b) => a.createdAt - b.createdAt);
  const last = async (id) => (await trail(id)).at(-1);

  await staff("PUT", "/api/c/products/t1", { data: { name: "Trail Soap", dealerPrice: 75, srp: 100, stock: 10 } });
  assert.deepEqual([(await last("t1")).reason, (await last("t1")).qty, (await last("t1")).after], ["Starting stock", 10, 10]);

  // Stock in: who, date and time come from the server.
  await staff("POST", "/api/stock", { deltas: { t1: 5 }, reason: "Received stock", date: day(-2), note: "DR 88", createdBy: "someone-else" });
  const inn = await last("t1");
  assert.equal(inn.reason, "Received stock");
  assert.equal(inn.date, day(-2));
  assert.equal(inn.note, "DR 88");
  assert.equal(inn.after, 15);
  assert.equal(inn.byName, "Sam");
  // Stock history shows usernames, so everyone on the team can look them up.
  const seen = (await viewer("GET", "/api/users")).data;
  assert.ok(seen.find((u) => u.id === inn.createdBy).username);
  assert.ok(seen.filter((u) => u.role === "dealer").every((u) => !("username" in u)), "dealer sign-ins stay hidden from non-admins");
  assert.ok(inn.createdAt >= before && inn.createdAt <= Date.now());
  assert.notEqual(inn.createdBy, "someone-else");

  // Stock out.
  await staff("POST", "/api/stock", { deltas: { t1: -1 }, reason: "Damaged / lost" });
  assert.deepEqual([(await last("t1")).reason, (await last("t1")).qty, (await last("t1")).after, (await last("t1")).date], ["Damaged / lost", -1, 14, today()]);
  await staff("POST", "/api/stock", { deltas: { t1: 1 }, reason: "Free text" });
  assert.equal((await last("t1")).reason, "Stock adjustment", "an unknown reason can't be written into the trail");

  // Sales, returns and voids are recorded with the record they came from.
  const items = [{ productId: "t1", name: "Trail Soap", qty: 3, price: 100, pct: 25 }];
  const sold = await staff("PUT", "/api/c/txns/ts1", { data: { type: "sale", dealerId: "d1", date: today(), dueDate: day(30), items, amount: 225 } });
  assert.equal(sold.status, 200);
  const out = await last("t1");
  assert.deepEqual([out.reason, out.qty, out.after, out.note, out.txnId], ["Sale", -3, 12, sold.data.data.no, "ts1"]);
  await staff("PUT", "/api/c/txns/tr1", { data: { type: "return", dealerId: "d1", saleId: "ts1", date: today(), restock: true, items: [{ ...items[0], qty: 1 }], amount: 75 } });
  assert.deepEqual([(await last("t1")).reason, (await last("t1")).qty, (await last("t1")).after], ["Return", 1, 13]);
  await staff("PATCH", "/api/c/txns/tr1", { data: { voided: true, voidReason: "Mistake" } });
  assert.deepEqual([(await last("t1")).reason, (await last("t1")).qty, (await last("t1")).after], ["Return voided", -1, 12]);

  // A count where nothing changed is still recorded.
  await staff("POST", "/api/stock", { deltas: {}, reason: "Stock count", note: "All matched", matched: "t1" });
  assert.deepEqual([(await last("t1")).reason, (await last("t1")).qty], ["Stock count", 0]);

  // A refused change leaves no record.
  const n = (await trail("t1")).length;
  assert.equal((await staff("POST", "/api/stock", { deltas: { t1: -999 } })).status, 409);
  assert.equal((await trail("t1")).length, n);

  // Nobody can write or change the trail directly.
  const id = (await owner("GET", "/api/c/moves")).data.find((m) => m.data.productId === "t1").id;
  for (const who of [owner, staff]) {
    assert.equal((await who("PUT", "/api/c/moves/fake", { data: { productId: "t1", qty: 50, reason: "Received stock", date: today() } })).status, 403);
    assert.equal((await who("PATCH", "/api/c/moves/" + id, { data: { qty: 50 } })).status, 403);
    assert.equal((await who("DELETE", "/api/c/moves/" + id)).status, 403);
  }

  // The trail outlives the product, and says where the stock went.
  await owner("PUT", "/api/c/products/t2", { data: { name: "Gone Soap", dealerPrice: 10, srp: 20, stock: 4 } });
  assert.equal((await owner("DELETE", "/api/c/products/t2")).status, 200);
  const gone = await trail("t2");
  assert.deepEqual(gone.map((m) => [m.reason, m.qty, m.productName]), [["Starting stock", 4, "Gone Soap"], ["Product deleted", -4, "Gone Soap"]]);

  // Example records leave no trace and can still be cleared.
  await owner("PUT", "/api/c/products/t3", { data: { name: "Sample Soap", dealerPrice: 10, srp: 20, stock: 4, sample: true } });
  assert.deepEqual(await trail("t3"), []);
  assert.equal((await owner("PUT", "/api/c/moves/s1", { data: { productId: "t3", qty: 4, reason: "Starting stock", date: today(), sample: true } })).status, 200);
  assert.equal((await owner("DELETE", "/api/c/moves/s1")).status, 200);

  // Dealers never see it.
  assert.deepEqual((await portal("GET", "/api/c/moves")).data, []);
});
