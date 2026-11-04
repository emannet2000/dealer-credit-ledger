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
  await b.click("#f button[type=submit]");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await count("dealers"), dealers, "pressing again doesn't save either");
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
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await count("products"), products, "pressing again doesn't save either");
  await b.fill("#p-name", "Dish Soap 2L");
  await b.click("#f button[type=submit]");
  await b.waitFor("!document.querySelector('#p-name')");
  assert.equal(await count("products"), products + 1, "a different product saves");
});

test("dealer name boxes line up, and age follows the birthday", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=dealers]");
  await b.click("[data-act=new-dealer]");
  await b.waitFor("document.querySelector('#d-first')");
  const tops = await b.ev("['#d-first','#d-middle','#d-last'].map(s=>Math.round(document.querySelector(s).getBoundingClientRect().top))");
  assert.equal(new Set(tops).size, 1, `name boxes at ${tops}`);
  const heights = await b.ev("['#d-gender','#d-bday'].map(s=>Math.round(document.querySelector(s).getBoundingClientRect().height))");
  assert.equal(new Set(heights).size, 1, `field heights ${heights}`);
  await b.fill("#d-bday", "1990-05-05");
  assert.match(await b.text("#d-age-hint"), /^Age \d+$/);
  await b.click("[data-back]");
});

test("close the day from the Cash tab", { skip }, async () => {
  const date = day(-1);
  await app.api("owner", "PUT", "/api/c/txns/e2e-pay", { data: { type: "payment", dealerId: "late", date, amount: 120, method: "Cash" } });
  await b.signIn(app.base, app.jar.owner);
  await b.waitFor("/not closed yet/.test(document.querySelector('#main').innerText)");
  await b.click(".tab[data-view=cash]");
  await b.click(`[data-act=ops-close][data-id="${date}"]`);
  await b.waitFor("document.querySelector('#c-Cash')");
  await b.fill("#c-Cash", "100");
  assert.match(await b.text("#c-total"), /Overall difference/);
  await b.fill("#c-note", "Gave change");
  await b.click("#f button[type=submit]");
  await b.waitFor("[...document.querySelectorAll('#main td')].some(td=>/Gave change/.test(td.innerText))");
  assert.deepEqual(b.errors, []);
  const closed = (await app.api("owner", "GET", "/api/c/cashcloses")).data.find((c) => c.id === date);
  assert.equal(closed.data.diff, -20);
});

test("a post-dated check is held, then bounced from the Cash tab", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click("[data-act=new-pay]");
  await b.fill("#y-dealer", "late");
  await b.waitFor("document.querySelector('#y-check')?.hidden===true");
  await b.fill("#y-method", "Check");
  await b.waitFor("document.querySelector('#y-check')?.hidden===false");
  await b.fill("#y-amt", "100"); await b.fill("#y-bank", "BDO"); await b.fill("#y-chkno", "555"); await b.fill("#y-chkdate", day(14));
  await b.click("#f button[type=submit]");
  const find = async () => (await txns()).find((t) => t.data.check && t.data.check.number === "555");
  for (let i = 0; i < 50 && !(await find()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await find()).data.check.status, "pending");
  await b.ev("document.querySelector('[data-close]')?.click()");
  await b.click(".tab[data-view=cash]");
  await b.click("[data-act=ops-check-bad]");
  await b.fill("#r-why", "No funds"); await b.fill("#b-fee", "50");
  await b.click("#f button[type=submit]");
  await b.waitFor("/No checks waiting/.test(document.querySelector('#main').innerText)");
  assert.equal((await find()).data.check.status, "bounced");
  assert.deepEqual(b.errors, []);
});

test("order from a supplier and receive it from the Buying tab", { skip }, async () => {
  await app.api("owner", "PUT", "/api/c/suppliers/sup1", { data: { name: "Acme Trading", terms: 30 } });
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=buying]");
  await b.click("[data-act=ops-po]");
  await b.fill("#o-sup", "sup1");
  await b.fill("[data-l=p]", "p1"); await b.fill("[data-l=q]", "5"); await b.fill("[data-l=c]", "40");
  assert.match(await b.text("#o-total"), /200/);
  await b.click("#f button[value=ordered]");
  await b.waitFor("document.querySelector('[data-act=ops-receive]')");
  const before = await stock();
  await b.click("[data-act=ops-receive]");
  await b.fill("#g-inv", "INV-1"); await b.fill("#g-amt", "200");
  await b.click("#f button[type=submit]");
  await b.waitFor("[...document.querySelectorAll('#main h2')].some(h=>h.innerText.startsWith('Supplier invoices'))");
  assert.equal(await stock(), before + 5);
  assert.deepEqual(b.errors, []);
});

test("close the books from the Store tab", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=store]");
  await b.click("[data-act=ops-books-close]");
  await b.fill("#b-date", day(-200));
  await b.click("#f button[type=submit]");
  await b.waitFor("/Closed through/.test(document.querySelector('#main').innerText)");
  await b.click("[data-act=ops-books-open]");
  await b.fill("#r-why", "Test finished");
  await b.click("#f button[type=submit]");
  await b.waitFor("/No period is closed|Reopened/.test(document.querySelector('#main').innerText)");
  assert.deepEqual(b.errors, []);
});

test("put a charge on a payment plan and post a dispute from the Cash tab", { skip }, async () => {
  await app.api("owner", "PUT", "/api/c/dealers/plan", { data: { name: "Plan Paula", terms: 30, creditLimit: 5000, active: true } });
  await app.api("owner", "PUT", "/api/c/txns/plan-s", { data: { type: "sale", opening: true, dealerId: "plan", date: day(-40), dueDate: day(-10), amount: 900, no: "DR-07777" } });
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=cash]");
  await b.click("[data-act=ops-plan]");
  await b.fill("#n-t", "plan-s"); await b.fill("#n-c", "3"); await b.fill("#n-s", day(10));
  await b.click("#f button[type=submit]");
  await b.waitFor("/3 × Monthly/.test(document.querySelector('#main').innerText)");
  await b.click("[data-act=ops-dsp-new]");
  await b.fill("#q-t", "plan-s"); await b.fill("#q-a", "100");
  await b.click("#f button[type=submit]");
  await b.waitFor("document.querySelector('[data-act=ops-dsp-yes]')");
  await b.click("[data-act=ops-dsp-yes]");
  await b.fill("#r-why", "Price corrected");
  await b.click("#f button[type=submit]");
  await b.waitFor("/No charges are being disputed/.test(document.querySelector('#main').innerText)");
  assert.deepEqual(b.errors, []);
});

test("set tax details and print a VAT breakdown on the receipt", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.click(".tab[data-view=store]");
  await b.fill("#fn-tin", "123-456-789"); await b.ev("document.querySelector('#fn-vat').click()");
  await b.ev("document.querySelector('#finForm').requestSubmit()");
  for (let i = 0; i < 50; i++) { const s = (await app.api("owner", "GET", "/api/c/settings")).data.find((d) => d.id === "store"); if (s.data.tax && s.data.tax.vatRegistered) break; await new Promise((r) => setTimeout(r, 100)); }
  await app.api("owner", "PUT", "/api/c/txns/tax-s", { data: { type: "sale", dealerId: "d1", date: day(0), dueDate: day(30), items: [{ productId: "p1", name: "Dish Soap", qty: 1, price: 100, pct: 25 }] } });
  await b.signIn(app.base, app.jar.owner);
  await b.ev("location.hash='#receipt/tax-s'");
  await b.ev("location.reload()");
  await b.waitFor("/VATable sales/.test(document.querySelector('#rcpt')?.innerText||'')", 15000);
  assert.match(await b.text("#rcpt"), /TIN 123-456-789[\s\S]*not an official receipt/i);
  await app.api("owner", "PUT", "/api/c/settings/store", { data: { storeName: "E2E Store", discountPct: 25, holdDays: 60 } });
  await b.ev("document.querySelector('[data-close]')?.click()");
  assert.deepEqual(b.errors, []);
});

test("every screen opens without an error, as owner and as staff", { skip }, async () => {
  for (const who of ["owner", "staff"]) {
    await b.signIn(app.base, app.jar[who]);
    for (const v of ["overview", "orders", "collect", "cash", "dealers", "products", "buying", "activity", "reports", "store"]) {
      await b.click(`.tab[data-view=${v}]`);
      await b.waitFor(`document.querySelector('.tab[data-view=${v}]').getAttribute('aria-current')==='page' && document.querySelector('#main').children.length>0`);
    }
  }
  assert.deepEqual(b.errors, []);
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
  await b.click("[data-tab=proof]");
  await b.waitFor("document.querySelector('#proofForm')");
  await b.fill("#pf-amt", "50"); await b.fill("#pf-ref", "GC-77");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await b.ev(`(()=>{ const bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0)), dt=new DataTransfer(); dt.items.add(new File([bytes],"r.png",{type:"image/png"})); document.querySelector("#pf-file").files=dt.files; })()`);
  await b.click("#pf-send");
  await b.waitFor("/Waiting for the store/.test(document.body.innerText)");
  assert.deepEqual(b.errors, []);
});
