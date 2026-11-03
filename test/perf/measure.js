#!/usr/bin/env node
"use strict";
// Measures server and page speed on a seeded ledger (see seed.js).
// Usage: DATA_DIR=/tmp/ledger-perf CHROME_PATH=/path/to/chrome node test/perf/measure.js
// Without CHROME_PATH only the server timings run. Target: normal pages under 1 s.
const fs = require("fs"), os = require("os"), path = require("path"), { spawn } = require("child_process");
const { createApp } = require("../../lib/app");
const dataDir = path.resolve(process.env.DATA_DIR || "/tmp/ledger-perf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

(async () => {
  const { app, close } = createApp({ dataDir, logger: { error() {} } });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const api = async (m, u, b) => { const t = performance.now(); const r = await fetch(base + u, { method: m, headers: { "Content-Type": "application/json", Cookie: cookie }, body: b && JSON.stringify(b) });
    const s = r.headers.get("set-cookie"); if (s) cookie = s.split(";")[0]; const txt = await r.text(); return { ms: performance.now() - t, bytes: txt.length, status: r.status, txt }; };
  await api("POST", "/api/login", { username: "owner", password: "perfpass1" });
  const rows = [];
  const time = async (label, fn, n = 5) => { const ms = []; let last; for (let i = 0; i < n; i++) { last = await fn(i); ms.push(last.ms); } ms.sort((a, b) => a - b); rows.push([label, ms[Math.floor(n / 2)], last.bytes, last.status]); };
  await time("GET /api/c/txns", () => api("GET", "/api/c/txns"));
  await time("GET /api/c/dealers", () => api("GET", "/api/c/dealers"));
  await time("GET /api/c/txns?ids= (2 records)", () => api("GET", "/api/c/txns?ids=t1,t2"));
  await time("PUT credit sale", (i) => api("PUT", `/api/c/txns/perf-s${Date.now()}${i}`, { data: { type: "sale", dealerId: "d7", date: day(0), dueDate: day(30), items: [{ productId: "p3", name: "Product 3", qty: 1, price: 130, pct: 25 }], amount: 97.5 } }));
  await time("PUT payment", (i) => api("PUT", `/api/c/txns/perf-p${Date.now()}${i}`, { data: { type: "payment", dealerId: "d7", date: day(0), amount: 50, method: "Cash" } }));
  console.log("Server (median of 5):");
  for (const [l, ms, b, st] of rows) console.log(`  ${l.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms  ${(b / 1024).toFixed(0).padStart(6)} KB  ${st}`);

  const CHROME = process.env.CHROME_PATH;
  if (CHROME && fs.existsSync(CHROME)) {
    const port = 9300 + Math.floor(Math.random() * 500);
    const ch = spawn(CHROME, [`--remote-debugging-port=${port}`, "--no-sandbox", `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "perf-prof-"))}`, "about:blank"], { stdio: "ignore" });
    let ws; for (let i = 0; i < 100 && !ws; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} }
    await new Promise((r) => ws.addEventListener("open", r));
    let n = 0; const pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.result?.value;
    await cdp("Runtime.enable"); await cdp("Page.enable");
    await cdp("Network.setCookie", { url: base, name: "sid", value: cookie.split("=")[1] });
    await cdp("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU_SLOWDOWN) || 1 });
    const t0 = Date.now();
    await cdp("Page.navigate", { url: base + "/" });
    for (let i = 0; i < 600; i++) { await sleep(50); if (await ev("/updates live/.test(document.querySelector('#sync')?.textContent||'') && !!document.querySelector('#main .kpis')")) break; }
    const page = [["First load to Overview (nothing saved yet)", Date.now() - t0]];
    await sleep(4000); // let the device copy be saved
    await ev("window.__old = 1");
    const tw = Date.now(); await cdp("Page.reload");
    for (let i = 0; i < 600; i++) { await sleep(25); if (await ev("!window.__old && !!document.querySelector('#main .kpis')")) break; }
    page.push(["Next visit to Overview (saved copy)", Date.now() - tw]);
    for (let i = 0; i < 600; i++) { await sleep(50); if (await ev("/updates live/.test(document.querySelector('#sync')?.textContent||'')")) break; }
    const measure = async (label, expr) => { const ms = await ev(`(async()=>{ const t=performance.now(); ${expr}; await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0))); return performance.now()-t; })()`); page.push([label, ms]); };
    if (process.env.PROFILE) {
      await ev("document.querySelector('.tab[data-view=activity]').click()");
      await cdp("Profiler.enable"); await cdp("Profiler.setSamplingInterval", { interval: 200 }); await cdp("Profiler.start");
      await ev("document.querySelector('.tab[data-view=activity]').click()");
      await ev(`document.querySelector('.tab[data-view=${process.env.PROFILE}]').click()`);
      const prof = (await cdp("Profiler.stop")).result.profile, self = new Map(), byId = new Map(prof.nodes.map((n) => [n.id, n]));
      const dt = prof.timeDeltas; prof.samples.forEach((id, i) => { const f = byId.get(id).callFrame; const k = `${f.functionName || "(anon)"}:${f.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); });
      console.log("Top self time (ms) for tab", process.env.PROFILE); [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log("  ", v.toFixed(0).padStart(6), k));
      await ev("document.querySelector('.tab[data-view=overview]').click()");
    }
    for (const v of ["dealers", "collect", "activity", "reports", "overview"]) await measure(`Tab: ${v}`, `document.querySelector('.tab[data-view=${v}]').click()`);
    await ev("document.querySelector('.tab[data-view=dealers]').click()");
    await measure("Open a dealer", "document.querySelector('#main [data-dealer]').click()");
    await ev("document.querySelector('[data-close]')?.click()");
    // Another device records a payment: how long until this screen shows it?
    await ev("document.querySelector('.tab[data-view=activity]').click()");
    const t1 = Date.now();
    await api("PUT", `/api/c/txns/perf-live${Date.now()}`, { data: { type: "payment", dealerId: "d1", date: day(0), amount: 12345, method: "Cash" } });
    for (let i = 0; i < 400; i++) { await sleep(25); if (await ev("document.querySelector('#main').innerText.includes('12,345')")) break; }
    page.push(["Live update after another device's payment", Date.now() - t1]);
    console.log(`Page (CPU slowdown ${Number(process.env.CPU_SLOWDOWN) || 1}x):`);
    for (const [l, ms] of page) console.log(`  ${l.padEnd(44)} ${Number(ms).toFixed(0).padStart(6)} ms`);
    ch.kill(); ws.close();
  }
  server.close(); close();
})().catch((e) => { console.error(e); process.exit(1); });
