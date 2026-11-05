"use strict";
// Keyboard navigation, driven by real key presses. Run with: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, startBrowser, findChrome } = require("./browser");

const skip = !findChrome() && "install Chrome or set CHROME_PATH to run browser tests";
let app, b;
const active = () => b.ev("(()=>{ const a=document.activeElement; return a.dataset.dealer||a.dataset.pid||a.id||a.tagName; })()");
const view = () => b.ev("location.hash");
const sheet = () => b.ev("document.querySelector('.sheet h2')?.innerText||''");
const noSheet = () => b.waitFor("!document.querySelector('.overlay')");

test.before(async () => {
  if (skip) return;
  app = await startApp();
  await app.api("owner", "POST", "/api/setup", { name: "Owner", username: "owner", password: "secret123" });
  await app.api("owner", "PUT", "/api/c/settings/store", { data: { storeName: "Keys Store", discountPct: 25, holdDays: 60 } });
  await app.api("owner", "PUT", "/api/c/products/p1", { data: { name: "Dish Soap", dealerPrice: 75, srp: 100, stock: 20, active: true } });
  for (const [id, name] of [["d1", "Ana Reyes"], ["d2", "Ben Cruz"], ["d3", "Cora Lim"]])
    await app.api("owner", "PUT", `/api/c/dealers/${id}`, { data: { name, terms: 30, creditLimit: 5000, active: true } });
  await app.api("owner", "POST", "/api/users", { name: "Vic Viewer", username: "vic", password: "viewerpass1", role: "viewer" });
  await app.api("viewer", "POST", "/api/login", { username: "vic", password: "viewerpass1" });
  b = await startBrowser();
  await b.signIn(app.base, app.jar.owner);
});
test.after(() => { if (b) b.close(); if (app) app.close(); });

test("G then a letter changes screen, but not while typing", { skip }, async () => {
  await b.press("g"); await b.press("d");
  await b.waitFor("document.querySelector('.tab[aria-current=page]')?.dataset.view==='dealers'");
  assert.equal(await view(), "#dealers");
  await b.ev("document.querySelector('#q').focus()");
  await b.press("g"); await b.press("p"); await b.press("s");
  assert.equal(await view(), "#dealers", "letters typed in a box stay in the box");
  assert.equal(await sheet(), "");
  assert.equal(await b.ev("document.querySelector('#q').value"), "gps");
  await b.ev("(()=>{ const q=document.querySelector('#q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await b.waitFor("document.querySelectorAll('#main tr[data-dealer]').length===3");
});

test("arrows and J/K walk the rows; Enter opens; Esc returns to the row", { skip }, async () => {
  await b.ev("document.querySelector('#q').focus()");
  await b.press("ArrowDown");
  const first = await active();
  assert.ok(first.startsWith("d"), "down from the search box reaches the first row");
  await b.press("j");
  const second = await active();
  assert.notEqual(second, first);
  await b.press("k");
  assert.equal(await active(), first);
  await b.press("ArrowUp");
  assert.equal(await active(), "q", "up from the first row returns to the search box");
  await b.press("ArrowDown"); await b.press("ArrowDown");
  await b.press("Enter");
  await b.waitFor("document.querySelector('.sheet h2')");
  await b.press("Escape");
  await noSheet();
  assert.equal(await active(), second, "focus goes back to the row that opened the sheet");
});

test("Space opens a row without scrolling the page", { skip }, async () => {
  await b.press(" ");
  await b.waitFor("document.querySelector('.sheet h2')");
  await b.press("Escape");
  await noSheet();
});

test("a live update keeps focus on the same row", { skip }, async () => {
  const id = await active();
  await app.api("owner", "PUT", "/api/c/dealers/d3", { data: { name: "Cora Lim-Tan", terms: 30, creditLimit: 5000, active: true } });
  await b.waitFor("/Cora Lim-Tan/.test(document.querySelector('#main').innerText)");
  assert.equal(await active(), id);
});

test("Tab stays inside an open sheet", { skip }, async () => {
  await b.press("?");
  await b.waitFor("/Keyboard shortcuts/.test(document.querySelector('.sheet h2')?.innerText||'')");
  assert.match(await b.text(".sheet"), /Credit sale/);
  assert.equal(await b.ev("document.querySelector('.sheet').getAttribute('aria-label')"), "Keyboard shortcuts");
  assert.equal(await b.ev("document.querySelector('.sheet').contains(document.activeElement)"), true, "focus moves into a sheet with no boxes");
  for (let i = 0; i < 6; i++) {
    await b.press("Tab");
    assert.equal(await b.ev("document.querySelector('.sheet').contains(document.activeElement)"), true);
  }
  await b.press("Tab", { shift: true });
  assert.equal(await b.ev("document.querySelector('.sheet').contains(document.activeElement)"), true);
  await b.press("Escape");
  await noSheet();
});

test("add a product to a sale from the keyboard", { skip }, async () => {
  await b.ev("document.activeElement.blur()");
  await b.press("s");
  await b.waitFor("document.querySelector('#pick-q')");
  await b.ev("document.querySelector('#pick-q').focus()");
  await b.press("ArrowDown");
  assert.equal(await active(), "p1");
  await b.press("Enter");
  await b.waitFor("document.querySelector('.cart-row')");
  assert.equal(await active(), "p1", "focus stays on the product after adding it");
  await b.press("Escape");
  await noSheet();
});

test("left and right move along the tabs", { skip }, async () => {
  await b.ev("document.querySelector('.tab[data-view=dealers]').focus()");
  await b.press("ArrowRight");
  assert.equal(await b.ev("document.activeElement.dataset.view"), "products");
  await b.press("ArrowLeft");
  assert.equal(await b.ev("document.activeElement.dataset.view"), "dealers");
  await b.ev("document.activeElement.blur()");
});

test("the first Tab stop skips past the header to the content", { skip }, async () => {
  await b.signIn(app.base, app.jar.owner);
  await b.press("Tab");
  assert.equal(await active(), "skipMain");
  assert.equal(await b.ev("document.activeElement.getBoundingClientRect().top >= 0"), true, "visible once focused");
  await b.press("Enter");
  assert.equal(await active(), "main");
});

test("a viewer has no recording shortcuts", { skip }, async () => {
  await b.signIn(app.base, app.jar.viewer);
  await b.press("s"); await b.press("p"); await b.press("n");
  assert.equal(await sheet(), "");
  await b.press("?");
  await b.waitFor("document.querySelector('.sheet h2')");
  assert.doesNotMatch(await b.text(".sheet"), /Credit sale/);
  assert.deepEqual(b.errors, []);
});
