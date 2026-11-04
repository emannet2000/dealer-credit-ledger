"use strict";
// Property-based tests: instead of a few examples, fast-check tries many random inputs against
// rules that must always hold, and shrinks any failure to the smallest example.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const fc = require("fast-check");
const C = require("../lib/credit");
const F = require("../lib/finance");
const { createApp } = require("../lib/app");

const RUNS = Number(process.env.PROPERTY_RUNS) || 500;
const opts = { numRuns: RUNS };
const money = fc.integer({ min: 1, max: 10_000_000 }).map((c) => c / 100);
const date = fc.integer({ min: 0, max: 900 }).map((n) => new Date(Date.UTC(2025, 0, 1) + n * 864e5).toISOString().slice(0, 10));
const sum = (a) => C.r2(a.reduce((x, y) => x + y, 0));
const near = (a, b) => Math.abs(a - b) < 0.0051;

const txn = fc.oneof(
  fc.record({ type: fc.constant("sale"), amount: money, date, dueDate: date }),
  fc.record({ type: fc.constantFrom("payment", "return", "writeoff"), amount: money, date }),
  fc.record({ type: fc.constant("adjustment"), direction: fc.constantFrom("debit", "credit"), amount: money, date, dueDate: date }),
  fc.record({ type: fc.constant("sale"), amount: money, date, dueDate: date, voided: fc.constant(true) }),
);
const ledger = fc.array(txn, { maxLength: 40 }).map((l) => l.map((t, i) => ({ ...t, _id: "t" + i, createdAt: i })));

test("what's unpaid minus unapplied credit always equals the balance", () => {
  fc.assert(fc.property(ledger, (tx) => {
    const r = C.settle(tx);
    assert.ok(near(sum(r.open.map((o) => o.rem)) - r.credit, r.balance));
  }), opts);
});

test("the balance never depends on the order records arrive in", () => {
  fc.assert(fc.property(ledger, fc.infiniteStream(fc.integer()), (tx, s) => {
    const shuffled = [...tx].sort(() => (s.next().value % 2 ? 1 : -1));
    assert.equal(C.settle(shuffled).balance, C.settle(tx).balance);
  }), opts);
});

test("every calendar day is valid, and nothing past the month's end is", () => {
  fc.assert(fc.property(fc.integer({ min: 2000, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 40 }), (y, m, d) => {
    const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(), v = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    assert.equal(C.validDay(v), d <= inMonth, v);
  }), opts);
});

test("a voided record changes nothing", () => {
  fc.assert(fc.property(ledger, txn, (tx, extra) => {
    assert.equal(C.settle([...tx, { ...extra, _id: "x", voided: true }]).balance, C.settle(tx).balance);
  }), opts);
});

test("a charge is never more than fully paid, and an open charge never exceeds its amount", () => {
  fc.assert(fc.property(ledger, (tx) => {
    for (const o of C.settle(tx).open) { assert.ok(o.rem > 0); assert.ok(o.rem <= C.r2(o.t.amount) + 0.004); }
    assert.ok(C.settle(tx).credit >= 0);
  }), opts);
});

test("late figures: overdue never exceeds what's unpaid", () => {
  fc.assert(fc.property(ledger, date, (tx, asOf) => {
    const r = C.settle(tx), s = C.dueSummary(r.open, asOf);
    assert.ok(s.overdue <= sum(r.open.map((o) => o.rem)) + 0.01);
    assert.ok(s.maxLate >= 0);
    assert.equal(s.overdue > 0, s.maxLate > 0);
  }), opts);
});

test("installments always add up exactly to the amount, in date order", () => {
  fc.assert(fc.property(money, fc.integer({ min: 2, max: 60 }), fc.constantFrom("weekly", "biweekly", "monthly"), date, (amount, n, freq, start) => {
    const s = F.schedule(amount, n, freq, start);
    assert.equal(s.length, n);
    assert.equal(sum(s.map((i) => i.amount)), C.r2(amount));
    assert.ok(s.every((i) => i.amount >= 0));
    assert.ok(s.every((i, k) => k === 0 || i.due > s[k - 1].due));
  }), opts);
});

test("what's due on a plan always equals what's unpaid and not disputed", () => {
  fc.assert(fc.property(money, fc.integer({ min: 2, max: 24 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (amount, n, paidShare, disputeShare) => {
    const schedule = F.schedule(amount, n, "monthly", "2026-01-01"), rem = C.r2(amount * (1 - paidShare)), disputed = C.r2(rem * disputeShare);
    const parts = C.dueParts({ amount, plan: { base: 0, schedule }, disputed }, rem);
    assert.ok(near(sum(parts.map((p) => p.amount)), Math.max(0, C.r2(rem - disputed))));
    assert.ok(parts.every((p) => p.amount > 0));
  }), opts);
});

test("late fees: none in the grace period, never negative, never falling as days pass", () => {
  fc.assert(fc.property(money, fc.integer({ min: 0, max: 800 }), fc.integer({ min: 1, max: 300 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 600 }), fc.constantFrom("simple", "monthly"), (amount, days, more, grace, rate, compounding) => {
    const p = { ratePct: rate / 100, graceDays: grace, compounding };
    const a = F.lateFee(amount, days, p), b = F.lateFee(amount, days + more, p);
    assert.ok(a >= 0); assert.ok(b >= a);
    if (days <= grace) assert.equal(a, 0);
  }), opts);
});

test("compounding is never cheaper than simple interest", () => {
  fc.assert(fc.property(money, fc.integer({ min: 1, max: 800 }), fc.integer({ min: 1, max: 600 }), (amount, days, rate) => {
    assert.ok(F.lateFee(amount, days, { ratePct: rate / 100, compounding: "monthly" }) + 0.01 >= F.lateFee(amount, days, { ratePct: rate / 100, compounding: "simple" }));
  }), opts);
});

test("VAT parts always add up exactly to the amount and are never negative", () => {
  const line = fc.record({ productId: fc.constantFrom("v", "e", "z"), qty: fc.integer({ min: 1, max: 500 }), price: money, pct: fc.integer({ min: 0, max: 60 }) });
  fc.assert(fc.property(fc.array(line, { minLength: 1, maxLength: 15 }), fc.double({ min: 0.5, max: 1, noNaN: true }), (items, share) => {
    const gross = items.reduce((a, i) => a + i.qty * i.price * (1 - i.pct / 100), 0), amount = C.r2(gross * share);
    fc.pre(amount > 0);
    const t = F.taxFor({ amount, items }, (p) => ({ v: "vat", e: "exempt", z: "zero" }[p]));
    assert.equal(sum([t.vatable, t.vat, t.exempt, t.zero]), amount);
    for (const v of Object.values(t)) assert.ok(v >= -0.01, JSON.stringify(t));
  }), opts);
});

test("cost layers: stock out takes exactly that quantity, and cost stays within the layers", () => {
  const layer = fc.record({ qty: fc.integer({ min: 1, max: 100 }), cost: fc.integer({ min: 1, max: 100000 }).map((c) => c / 100) });
  fc.assert(fc.property(fc.array(layer, { minLength: 1, maxLength: 10 }), fc.integer({ min: 1, max: 1000 }), (layers, want) => {
    const total = layers.reduce((a, l) => a + l.qty, 0), qty = Math.min(want, total), p = { layers };
    const cost = F.issueCost(p, qty, "fifo"), costs = layers.map((l) => l.cost);
    assert.ok(cost >= Math.min(...costs) - 0.01 && cost <= Math.max(...costs) + 0.01);
    F.stockMoved(p, -qty, {});
    assert.equal(p.layers.reduce((a, l) => a + l.qty, 0), total - qty);
    assert.ok(layers.every((l) => l.qty > 0), "the original layers aren't altered");
  }), opts);
});

test("lots: selling takes exactly that quantity, earliest expiry first", () => {
  const lot = fc.record({ expiry: date, qty: fc.integer({ min: 1, max: 50 }), receivedAt: fc.nat() });
  fc.assert(fc.property(fc.array(lot, { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 300 }), (raw, want) => {
    const batches = raw.map((b, i) => ({ ...b, lot: "L" + i })), total = batches.reduce((a, b) => a + b.qty, 0), qty = Math.min(want, total), p = { batches };
    F.stockMoved(p, -qty, {});
    assert.equal(p.batches.reduce((a, b) => a + b.qty, 0), total - qty);
    const left = new Set(p.batches.map((b) => b.lot)), soonest = p.batches.map((b) => b.expiry).sort()[0];
    for (const b of batches) if (!left.has(b.lot) && soonest) assert.ok(b.expiry <= soonest, "a later lot was sold before an earlier one");
  }), opts);
});

test("the weighted average always lies between the old cost and the new one", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 1000 }), money, money, (had, got, oldCost, newCost) => {
    const c = F.received({ stock: had + got, cost: oldCost }, got, newCost, "average").cost;
    assert.ok(c >= Math.min(oldCost, newCost) - 0.01 && c <= Math.max(oldCost, newCost) + 0.01);
  }), opts);
});

const word = fc.stringMatching(/^[A-Za-z]{1,12}$/);
test("the same name in any case, spacing or order is one duplicate key", () => {
  fc.assert(fc.property(fc.array(word, { minLength: 1, maxLength: 5 }), (w) => {
    const base = C.dealerKeys({ name: w.join(" ") }).name;
    assert.equal(C.dealerKeys({ name: w.join("   ").toUpperCase() }).name, base);
    assert.equal(C.dealerKeys({ name: [...w].reverse().join(", ").toLowerCase() }).name, base);
    assert.equal(C.productKeys({ name: `  ${w.join(" ")}  ` }).name, C.productKeys({ name: w.join(" ").toLowerCase() }).name);
  }), opts);
});

test("a mobile number matches in every common format", () => {
  fc.assert(fc.property(fc.stringMatching(/^9[0-9]{9}$/), (n) => {
    const k = C.phoneKey("0" + n);
    for (const v of [`+63${n}`, `63 ${n}`, `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`, `(0${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`]) assert.equal(C.phoneKey(v), k);
  }), opts);
});

test("splitting a name never loses or invents a word", () => {
  fc.assert(fc.property(fc.array(fc.oneof(word, fc.constantFrom("Dela", "de", "Santos", "Jr.", "III")), { minLength: 1, maxLength: 7 }), (w) => {
    const p = C.splitName(w.join(" "));
    assert.equal([p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").split(" ").sort().join(" "), [...w].sort().join(" "));
  }), opts);
});

test("age goes up by exactly one a year", () => {
  fc.assert(fc.property(fc.integer({ min: 1950, max: 2015 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), fc.integer({ min: 2020, max: 2060 }), (y, m, d, on) => {
    const md = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    assert.equal(C.ageOn(`${y}-${md}`, `${on}-${md}`), on - y > 130 ? null : on - y);
  }), opts);
});

// Random sequences of real actions through the real server, checked against a simple model.
test("any sequence of sales, payments, returns and voids keeps balance and stock correct", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-prop-"));
  const h = createApp({ dataDir: dir, logger: { error() {} } }), server = h.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`; let cookie = "";
  const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: b && JSON.stringify(b) }); const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0]; return { status: r.status, data: await r.json().catch(() => null) }; };
  const today = C.today(); let run = 0;
  await api("POST", "/api/setup", { name: "O", username: "owner", password: "secret123" });
  await api("PUT", "/api/c/settings/store", { data: { storeName: "P", discountPct: 0 } });
  const op = fc.oneof(
    fc.record({ k: fc.constant("sale"), qty: fc.integer({ min: 1, max: 12 }) }),
    fc.record({ k: fc.constant("pay"), amount: fc.integer({ min: 1, max: 900 }) }),
    fc.record({ k: fc.constant("return"), qty: fc.integer({ min: 1, max: 3 }) }),
    fc.record({ k: fc.constant("void"), pick: fc.nat() }),
  );
  try {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
      const n = ++run, d = "d" + n, p = "p" + n, live = [], item = (qty) => [{ productId: p, name: p, qty, price: 100, pct: 0 }];
      await api("PUT", `/api/c/dealers/${d}`, { data: { name: "Prop Dealer " + n, terms: 30, creditLimit: 100000000 } });
      await api("PUT", `/api/c/products/${p}`, { data: { name: "Prop Item " + n, dealerPrice: 100, srp: 100, stock: 50, active: true } });
      let stock = 50, balance = 0, i = 0;
      for (const o of ops) {
        const id = `${d}-${++i}`;
        if (o.k === "sale") { const r = await api("PUT", `/api/c/txns/${id}`, { data: { type: "sale", dealerId: d, date: today, dueDate: today, items: item(o.qty) } }); if (r.status === 200) { stock -= o.qty; balance += 100 * o.qty; live.push({ id, data: r.data.data, stock: -o.qty, money: 100 * o.qty }); } else assert.ok(o.qty > stock, `sale refused: ${JSON.stringify(r.data)}`); }
        if (o.k === "pay") { const r = await api("PUT", `/api/c/txns/${id}`, { data: { type: "payment", dealerId: d, date: today, amount: o.amount, method: "Cash" } }); assert.equal(r.status, 200); balance -= o.amount; live.push({ id, data: r.data.data, stock: 0, money: -o.amount }); }
        if (o.k === "return") { const r = await api("PUT", `/api/c/txns/${id}`, { data: { type: "return", dealerId: d, date: today, restock: true, items: item(o.qty) } }); assert.equal(r.status, 200); stock += o.qty; balance -= 100 * o.qty; live.push({ id, data: r.data.data, stock: o.qty, money: -100 * o.qty }); }
        if (o.k === "void" && live.length) { const [t] = live.splice(o.pick % live.length, 1); const r = await api("PUT", `/api/c/txns/${t.id}`, { data: { ...t.data, voided: true } }); if (r.status === 200) { stock -= t.stock; balance -= t.money; } else { assert.equal(r.data.code, "insufficient_stock"); live.push(t); } }
      }
      const products = (await api("GET", "/api/c/products")).data, txns = (await api("GET", "/api/c/txns")).data.filter((t) => t.data.dealerId === d);
      assert.equal(products.find((x) => x.id === p).data.stock, stock, "stock matches the model");
      assert.equal(C.settle(txns.map((t) => ({ ...t.data, _id: t.id }))).balance, balance, "balance matches the model");
    }), { numRuns: Math.min(40, RUNS) });
  } finally { server.closeAllConnections(); server.close(); h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
