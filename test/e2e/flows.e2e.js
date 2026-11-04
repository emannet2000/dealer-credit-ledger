"use strict";
// Browser tests of the main flows. Run with: npm run test:e2e (set CHROME_PATH if Chrome is not found)
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, startBrowser, findChrome, day } = require("./browser");

const skip = !findChrome() && "install Chrome or set CHROME_PATH to run browser tests";
let app, b;

test.before(async () => {
  if (skip) return;
  app = await startApp();
  await app.api("owner", "POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" });
  await app.api("owner", "PUT", "/api/c/settings/store", { data: { storeName: "E2E Store", discountPct: 25, holdDays: 60 } });
  await app.api("owner", "PUT", "/api/c/products/p1", { data: { name: "Dish Soap", dealerPrice: 75, srp: 100, stock: 20, active: true } });
  await app.api("owner", "PUT", "/api/c/dealers/d1", { data: { name: "Ana Reyes", phone: "0918", terms: 30, creditLimit: 5000, active: true } });
  await app.api("owner", "PUT", "/api/c/dealers/late", { data: { name: "Late Larry", terms: 15, creditLimit: 5000, active: true } });
  await app.api("owner", "PUT", "/api/c/txns/old", { data: { type: "sale", opening: true, dealerId: "late", date: day(-120), dueDate: day(-100), amount: 800, items: [], no: "DR-00001" } });
  await app.api("owner", "POST", "/api/users", { name: "Sam Staff", username: "sam", password: "staffpass1", role: "staff" });
  await app.api("staff", "POST", "/api/login", { username: "sam", password: "staffpass1" });
  b = await startBrowser();
});
test.after(() => { if (b) b.close(); if (app) app.close(); });
const stock = async () => (await app.api("owner", "GET", "/api/c/products")).data.find((p) => p.id === "p1").data.stock;
const txns = async () => (await app.api("owner", "GET", "/api/c/txns")).data;

test("record a credit sale from the sale form", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click("[data-act=new-sale]");
  await b.fill("#s-dealer", "d1");
  await b.click(".pick-list tr.pick");
  await b.click("#f button[type=submit]");
  await b.waitFor("/Receipt DR-/.test(document.querySelector('.sheet h2')?.innerText||'')");
  const sale = (await txns()).find((t) => t.data.type === "sale" && t.data.dealerId === "d1");
  assert.equal(sale.data.amount, 75, "priced by the server: SRP 100 less 25%");
  assert.equal(await stock(), 19, "stock moved with the sale");
  await b.click("[data-close]");
});

test("record a payment and see the balance drop", { skip }, async () => {
  await b.click("[data-act=new-pay]");
  await b.fill("#y-dealer", "d1");
  await b.fill("#y-amt", "50");
  await b.click("#y-go");
  await b.waitFor("/Receipt OR-/.test(document.querySelector('.sheet h2')?.innerText||'')");
  assert.match(await b.text(".sheet"), /Balance after this:\s*₱25\.00/);
  await b.click("[data-close]");
});

test("record a payment offline; it syncs once when back online", { skip }, async () => {
  await b.waitFor("(()=>new Promise(r=>{ const q=indexedDB.open('dcl-offline',1); q.onsuccess=()=>{ const g=q.result.transaction('kv').objectStore('kv').get('col:txns'); g.onsuccess=()=>r(!!g.result); }; q.onerror=()=>r(false); }))()", 15000).catch(() => {});
  await app.stop();
  await b.click("[data-act=new-pay]");
  await b.fill("#y-dealer", "d1");
  await b.fill("#y-amt", "10");
  await b.click("#y-go");
  await b.waitFor("/NOT YET SYNCED/.test(document.querySelector('.sheet')?.innerText||'')");
  await b.click("[data-close]");
  await app.restart();
  await b.ev("dispatchEvent(new Event('online'))");
  await b.waitFor("window.APP.offline().pending===0", 15000);
  const pays = (await txns()).filter((t) => t.data.type === "payment" && t.data.amount === 10);
  assert.equal(pays.length, 1);
  assert.ok(pays[0].data.offline && pays[0].data.offline.key);
});

test("a blocked staff sale is sent for approval and the owner approves it", { skip }, async () => {
  await b.signIn(app.base, app.jar.staff);
  await b.click("[data-act=new-sale]");
  await b.fill("#s-dealer", "late");
  await b.click(".pick-list tr.pick");
  await b.click("#f button[type=submit]");
  await b.fill("#ap-why", "Dealer will pay Friday");
  await b.click("#apf button[type=submit]");
  await b.waitFor("[...document.querySelectorAll('.notice')].some(n=>/waiting for approval/.test(n.innerText))");
  const before = await stock();
  await b.signIn(app.base, app.jar.owner);
  await b.click("[data-act=approvals]");
  await b.click("[data-approve]");
  await b.waitFor("[...document.querySelectorAll('.toast')].some(t=>/Approved/.test(t.innerText))");
  const sale = (await txns()).find((t) => t.data.dealerId === "late" && !t.data.opening);
  assert.ok(sale.data.override && sale.data.override.requestId);
  assert.equal(await stock(), before - 1);
  assert.deepEqual(b.errors, []);
});

test("adding a dealer or product shows the existing record and can open it", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  const count = async (c) => (await app.api("owner", "GET", `/api/c/${c}`)).data.length;

  const dealers = await count("dealers");
  await b.click(".tab[data-view=dealers]");
  await b.click("[data-act=new-dealer]");
  await b.fill("#d-first", "ana");
  await b.fill("#d-last", "REYES");
  await b.waitFor("document.querySelector('#d-dup-name .dup-row')");
  assert.match(await b.text("#d-dup-name"), /Already in your list[\s\S]*Ana Reyes[\s\S]*Same name/);
  await b.click("#f button[type=submit]");
  await b.waitFor("/already has this name/.test(document.querySelector('#d-err')?.innerText||'')");
  assert.equal(await count("dealers"), dealers, "the first press doesn't save");
  await b.click("#d-dup-name [data-dup-open]");
  await b.waitFor("!document.querySelector('#d-first') && /Ana Reyes/.test(document.querySelector('.sheet')?.innerText||'')");
  await b.click("[data-close]");

  const products = await count("products");
  await b.click(".tab[data-view=products]");
  await b.click("[data-act=new-product]");
  await b.fill("#p-name", "DISH  soap");
  await b.waitFor("document.querySelector('#p-dup .dup-row')");
  assert.match(await b.text("#p-dup"), /Dish Soap[\s\S]*Same name[\s\S]*on hand/);
  await b.fill("#p-dp", "10");
  await b.click("#f button[type=submit]");
  await b.waitFor("/already has this name/.test(document.querySelector('#p-err')?.innerText||'')");
  assert.equal(await count("products"), products, "the first press doesn't save");
  await b.click("#f button[type=submit]");
  await b.waitFor("!document.querySelector('#p-name')");
  assert.equal(await count("products"), products + 1, "the second press saves anyway");
});

test("the owner gives a dealer portal access and the dealer signs in", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=store]");
  await b.click("[data-act=new-portal]");
  await b.fill("#u-dealer", "d1"); await b.fill("#u-user", "ana"); await b.fill("#u-pw", "anapass123");
  await b.click("#f button[type=submit]");
  await b.waitFor("[...document.querySelectorAll('.panel')].some(p=>p.querySelector('h2')?.innerText==='Dealer portal' && /ana/.test(p.innerText))");
  await b.click("#acct [data-act=logout]");
  await b.waitFor("location.pathname==='/login' && document.querySelector('#nameRow').hidden && document.querySelector('#codeRow').hidden");
  await b.fill("#username", "ana"); await b.fill("#password", "anapass123"); await b.click("#go");
  await b.waitFor("/Hi, Ana/.test(document.body.innerText)", 15000).catch(async (e) => { throw new Error(e.message + " | page: " + (await b.ev("location.pathname + ' ' + document.body.innerText.slice(0,300)"))); });
  assert.match(await b.text("body"), /YOUR BALANCE/i);
});
