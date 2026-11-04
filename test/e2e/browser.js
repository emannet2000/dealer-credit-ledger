"use strict";
// Small headless-Chrome driver over the DevTools protocol (no extra dependencies).
// Used by test/e2e/*.e2e.js. Finds Chrome by itself, or set CHROME_PATH.
const fs = require("fs"), os = require("os"), path = require("path"), { spawn } = require("child_process");
const { createApp } = require("../../lib/app");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };

// CHROME_PATH, then the usual install locations, then a copy downloaded by Puppeteer.
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const usual = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((f) => fs.existsSync(f));
  if (usual) return usual;
  const root = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (!fs.existsSync(root)) return null;
  for (const v of fs.readdirSync(root).sort().reverse()) {
    const f = path.join(root, v, "chrome-linux64", "chrome");
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-e2e-"));
  const h = createApp({ dataDir: dir, logger: { error() {} } });
  let server = h.app.listen(0); await new Promise((r) => server.once("listening", r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const jar = {};
  const api = async (who, method, url, body) => {
    const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body && JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) jar[who] = set.split(";")[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: r.status, data };
  };
  return {
    base, api, jar,
    stop: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
    restart: async () => { server = h.app.listen(port); await new Promise((r) => server.once("listening", r)); },
    close: () => { try { server.closeAllConnections(); server.close(); } catch {} h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function startBrowser() {
  const CHROME = findChrome();
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-chrome-"));
  const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let ws;
  for (let i = 0; i < 100 && !ws; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} }
  if (!ws) throw new Error("Chrome didn't start");
  await new Promise((r) => ws.addEventListener("open", r));
  let n = 0; const pend = new Map(), errors = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed"); return r.result.result.value; };
  await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1100, deviceScaleFactor: 1, mobile: false });
  const b = {
    errors, cdp, ev,
    waitFor: async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(`(()=>{ try { return !!(${expr}); } catch(e) { return false; } })()`)) return true; await sleep(100); } throw new Error(`Timed out waiting for: ${expr}`); },
    click: async (sel) => { await b.waitFor(`document.querySelector(${JSON.stringify(sel)})`); await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); },
    fill: async (sel, v) => { await b.waitFor(`document.querySelector(${JSON.stringify(sel)})`); await ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); })()`); },
    text: (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText || ""`),
    signIn: async (base, cookie) => { await cdp("Network.setCookie", { url: base, name: "sid", value: cookie.split("=")[1] }); await cdp("Page.navigate", { url: base + "/" }); await b.waitFor("/updates live/.test(document.querySelector('#sync')?.textContent||'')", 15000); },
    close: () => { ch.kill(); ws.close(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} },
  };
  return b;
}

module.exports = { startApp, startBrowser, findChrome, sleep, day };
