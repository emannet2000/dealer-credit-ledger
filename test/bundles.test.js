"use strict";
// Bundles: "buy N at the unit price, take M at a special price" (M free when
// the take price is 0).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { takeUnits } = require("../lib/pricing");

const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-bundle-"));
const { app, close } = createApp({ dataDir: dir, logger: { error() {} } });
let server, base, cookie = "";

async function call(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, data };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call("POST", "/api/setup", { name: "Owner", username: "owner", password: "OwnerSecret123!" })).status, 200);
});
test.after(() => {
  server.close();
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("take units repeat only for complete sets and respect the promo dates", () => {
  const promo = { bundle: { buy: 2, take: 1, takePrice: 162 }, from: "2026-01-01", to: "2026-12-31" };
  assert.equal(takeUnits(2, promo, "2026-06-01"), 0);
  assert.equal(takeUnits(3, promo, "2026-06-01"), 1);
  assert.equal(takeUnits(5, promo, "2026-06-01"), 1);
  assert.equal(takeUnits(6, promo, "2026-06-01"), 2);
  assert.equal(takeUnits(9, promo, "2026-06-01"), 3);
  assert.equal(takeUnits(3, promo, "2027-01-01"), 0, "outside the promo window");

  const legacy = { bundle: { buy: 4, free: 1 }, from: "2026-01-01", to: "2026-12-31" };
  assert.equal(takeUnits(5, legacy, "2026-06-01"), 1, "old free bundles still work");
  assert.equal(takeUnits(10, legacy, "2026-06-01"), 2);

  assert.equal(takeUnits(3, { bundle: { buy: 0, take: 1, takePrice: 1 } }, "2026-06-01"), 0, "invalid bundle");
  assert.equal(takeUnits(3, { bundle: { buy: 2, take: 1, takePrice: -1 } }, "2026-06-01"), 0, "invalid take price");
});

test("the server prices TBC 1000ml 2+1 automatically (3 units for ₱583.50)", async () => {
  assert.equal((await call("PUT", "/api/c/dealers/d1", { data: { name: "Bundle Dealer", discountPct: 0, creditLimit: 100000 } })).status, 200);
  assert.equal((await call("PUT", "/api/c/products/tbc", {
    data: {
      name: "TBC 1000ml", srp: 290, dealerPrice: 210.75, discountPct: 0, stock: 100,
      promo: { price: 210.75, bundle: { buy: 2, take: 1, takePrice: 162 }, from: day(-1), to: day(5), noDiscount: true },
    },
  })).status, 200);

  const three = await call("PUT", "/api/c/orders/o3", { data: { dealerId: "d1", status: "new", items: [{ productId: "tbc", qty: 3 }] } });
  assert.equal(three.status, 200);
  assert.deepEqual(
    [three.data.data.items[0].qty, three.data.data.items[0].takeQty, three.data.data.items[0].takePrice, three.data.data.bundleDiscount, three.data.data.amount],
    [3, 1, 162, 48.75, 583.5],
  );

  const six = await call("PUT", "/api/c/orders/o6", { data: { dealerId: "d1", status: "new", items: [{ productId: "tbc", qty: 6 }] } });
  assert.equal(six.status, 200);
  assert.deepEqual([six.data.data.items[0].takeQty, six.data.data.bundleDiscount, six.data.data.amount], [2, 97.5, 1167]);

  const two = await call("PUT", "/api/c/orders/o2", { data: { dealerId: "d1", status: "new", items: [{ productId: "tbc", qty: 2 }] } });
  assert.equal(two.status, 200);
  assert.deepEqual([two.data.data.items[0].takeQty, two.data.data.amount], [0, 421.5], "no bundle without a complete set");

  // "Buy 2 at cost price, take 1 at ₱162": no promo price is needed; the
  // normal dealer price (₱210.75) is the price of the two buy units.
  assert.equal((await call("PUT", "/api/c/products/tbc-cp", {
    data: { name: "TBC 1000ml at cost", srp: 290, dealerPrice: 210.75, stock: 50, promo: { bundle: { buy: 2, take: 1, takePrice: 162 }, from: day(-1), to: day(5) } },
  })).status, 200);
  const cp = await call("PUT", "/api/c/orders/ocp", { data: { dealerId: "d1", status: "new", items: [{ productId: "tbc-cp", qty: 3 }] } });
  assert.equal(cp.status, 200);
  assert.deepEqual([cp.data.data.items[0].price, cp.data.data.items[0].takeQty, cp.data.data.amount], [210.75, 1, 583.5]);
});

test("a sale accepts bundle units and removes the full quantity from stock", async () => {
  const sale = await call("PUT", "/api/c/txns/s1", {
    data: {
      type: "sale", dealerId: "d1", date: day(0), dueDate: day(30),
      items: [{ productId: "tbc", qty: 3, takeQty: 1, takePrice: 162, price: 210.75, pct: 0 }],
      subtotal: 632.25, bundleDiscount: 48.75, pctDiscount: 0, discount: 0, amount: 583.5,
    },
  });
  assert.equal(sale.status, 200);
  assert.equal(sale.data.data.bundleDiscount, 48.75);
  const product = (await call("GET", "/api/c/products")).data.find((p) => p.id === "tbc");
  assert.equal(product.data.stock, 97, "all three units leave stock, including the bundle unit");
});

test("the dealer discount is taken only from the units bought at the unit price", async () => {
  assert.equal((await call("PUT", "/api/c/dealers/d2", { data: { name: "Discount Dealer", discountPct: 10, creditLimit: 100000 } })).status, 200);
  assert.equal((await call("PUT", "/api/c/products/tbc2", {
    data: {
      name: "TBC 1000ml discounted", srp: 290, dealerPrice: 210.75, stock: 100,
      promo: { price: 210.75, bundle: { buy: 2, take: 1, takePrice: 162 }, from: day(-1), to: day(5), noDiscount: false },
    },
  })).status, 200);
  const order = await call("PUT", "/api/c/orders/o10", {
    data: { dealerId: "d2", status: "new", items: [{ productId: "tbc2", qty: 3 }] },
  });
  assert.equal(order.status, 200);
  // 2 paid units x ₱210.75 x 10% = ₱42.15; the ₱162 unit is not discounted.
  assert.deepEqual(
    [order.data.data.items[0].pct, order.data.data.bundleDiscount, order.data.data.pctDiscount, order.data.data.amount],
    [10, 48.75, 42.15, 541.35],
  );
});

test("bad bundle data and incorrect amounts are rejected", async () => {
  const badCount = await call("PUT", "/api/c/products/bad1", {
    data: { name: "Bad quantity", dealerPrice: 100, stock: 1, promo: { bundle: { buy: 0, take: 1, takePrice: 10 } } },
  });
  assert.equal(badCount.status, 400);

  const badPrice = await call("PUT", "/api/c/products/bad2", {
    data: { name: "Bad price", dealerPrice: 100, stock: 1, promo: { price: 100, bundle: { buy: 2, take: 1, takePrice: 150 } } },
  });
  assert.equal(badPrice.status, 400, "the take price can't beat the unit price");

  const badAmount = await call("PUT", "/api/c/txns/s2", {
    data: {
      type: "sale", dealerId: "d1", date: day(0), dueDate: day(30),
      items: [{ productId: "tbc", qty: 3, takeQty: 1, takePrice: 162, price: 210.75, pct: 0 }],
      subtotal: 632.25, bundleDiscount: 48.75, pctDiscount: 0, discount: 0, amount: 632.25,
    },
  });
  assert.equal(badAmount.status, 400, "the amount must match the bundle price");

  const tooMany = await call("PUT", "/api/c/txns/s3", {
    data: {
      type: "sale", dealerId: "d1", date: day(0), dueDate: day(30),
      items: [{ productId: "tbc", qty: 3, takeQty: 4, takePrice: 162, price: 210.75, pct: 0 }],
      subtotal: 632.25, bundleDiscount: 48.75, pctDiscount: 0, discount: 0, amount: 583.5,
    },
  });
  assert.equal(tooMany.status, 400);

  const freeOnReturn = await call("PUT", "/api/c/txns/r1", {
    data: {
      type: "return", dealerId: "d1", date: day(0),
      items: [{ productId: "tbc", qty: 3, takeQty: 1, takePrice: 162, price: 210.75, pct: 0 }],
      subtotal: 632.25, bundleDiscount: 48.75, pctDiscount: 0, discount: 0, amount: 583.5,
    },
  });
  assert.equal(freeOnReturn.status, 400);
});
