#!/usr/bin/env node
"use strict";
// Fills a data folder with a large, realistic ledger for performance and restore tests.
// Usage: DATA_DIR=/tmp/ledger-perf node test/perf/seed.js [dealers=1000] [txns=50000]
// Signs in as owner / perfpass1.
const path = require("path");
const bcrypt = require("bcryptjs");
const { openDb } = require("../../lib/db");

const dealers = Number(process.argv[2]) || 1000, txns = Number(process.argv[3]) || 50000, products = 300;
const dataDir = path.resolve(process.env.DATA_DIR || "/tmp/ledger-perf");
const db = openDb(dataDir);
const put = db.prepare("INSERT OR REPLACE INTO docs (collection, id, data, version, updated_at) VALUES (?, ?, ?, 1, ?)");
const now = Date.now(), day = (o) => new Date(now + o * 864e5).toISOString().slice(0, 10);
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const started = Date.now();
db.transaction(() => {
  if (!db.prepare("SELECT 1 FROM users WHERE username='owner'").get())
    db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at) VALUES ('u_owner','owner','Owner','owner',?,1,?)").run(bcrypt.hashSync("perfpass1", 8), now);
  put.run("settings", "store", JSON.stringify({ storeName: "Perf Store", discountPct: 25, holdDays: 60 }), now);
  for (let p = 0; p < products; p++) put.run("products", `p${p}`, JSON.stringify({ name: `Product ${p}`, code: `PC-${p}`, srp: 100 + (p % 50) * 10, dealerPrice: 75 + (p % 50) * 7.5, cost: 50 + (p % 50) * 5, stock: 100000, active: true }), now);
  for (let d = 0; d < dealers; d++) put.run("dealers", `d${d}`, JSON.stringify({ name: `Dealer ${String(d).padStart(4, "0")}`, phone: `0917${String(d).padStart(7, "0")}`, area: `Area ${d % 40}`, terms: 30, creditLimit: 20000, active: true, stage: "dealer", createdAt: now }), now);
  const no = { sale: 0, payment: 0 };
  for (let t = 0; t < txns; t++) {
    const d = Math.floor(rnd() * dealers), back = Math.floor(rnd() * 720), sale = rnd() < 0.55;
    const type = sale ? "sale" : "payment", n = ++no[type];
    const doc = sale
      ? (() => { const p = Math.floor(rnd() * products), qty = 1 + Math.floor(rnd() * 5), price = 100 + (p % 50) * 10; const sub = qty * price, pd = Math.round(sub * 25) / 100;
        return { type, dealerId: `d${d}`, date: day(-back), dueDate: day(-back + 30), items: [{ productId: `p${p}`, name: `Product ${p}`, qty, price, pct: 25, cost: 50 + (p % 50) * 5 }], subtotal: sub, discountPct: 25, pctDiscount: pd, amount: Math.round((sub - pd) * 100) / 100, no: `DR-${String(n).padStart(5, "0")}` }; })()
      : { type, dealerId: `d${d}`, date: day(-back), amount: 100 + Math.floor(rnd() * 900), method: "Cash", no: `OR-${String(n).padStart(5, "0")}` };
    put.run("txns", `t${t}`, JSON.stringify({ ...doc, createdAt: now - back * 864e5, createdBy: "u_owner" }), now);
  }
  for (let i = 0; i < dealers * 3; i++) put.run("interactions", `i${i}`, JSON.stringify({ dealerId: `d${i % dealers}`, kind: "call", date: day(-(i % 90)), outcome: "Called", note: "", followUp: i % 7 ? null : day(i % 10), followUpDone: false, createdAt: now }), now);
})();
db.close();
console.log(`Seeded ${dealers} dealers, ${products} products, ${txns} transactions into ${dataDir} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
