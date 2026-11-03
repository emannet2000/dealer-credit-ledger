"use strict";
// Loads named top-level functions and constants from the inline script in
// public/index.html into a sandbox, so the business logic the browser runs can be
// tested directly in Node (PR-07).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "index.html"), "utf8");
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
const starts = /^(?:async function |function |const |let |\/\*|\/\/)/;

// The source of one top-level declaration: from its first line to the next one.
function grab(name) {
  const lines = script.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`const ${name}=`) || l.startsWith(`async function ${name}(`));
  if (i < 0) throw new Error(`index.html has no top-level ${name}`);
  let j = i + 1;
  while (j < lines.length && !starts.test(lines[j])) j++;
  return lines.slice(i, j).join("\n");
}

// Builds a sandbox with the given declarations, a fresh S state and stand-ins for
// browser-only helpers. Returns the sandbox; declared names are on it.
function load(names, { txns = {}, dealers = {}, settings = {}, today = "2026-11-03" } = {}) {
  const S = { txns: new Map(Object.entries(txns)), dealers: new Map(Object.entries(dealers)), settings, _ver: 1, interactions: new Map() };
  const base = ["r2", "isLive", "isCharge", "txnEffect", "pad", "ymd", "DAY_NUM", "dayNum", "daysBetween", "TX_INDEX", "dealerTxns", "settle"];
  const code = [...new Set([...base, ...names])].map(grab).join("\n");
  const exportsList = [...new Set([...base, ...names])].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const ctx = { S, console, Intl, Map, Set, Math, Date, Number, String, JSON, Array, Object, Infinity };
  vm.createContext(ctx);
  vm.runInContext(`const today=()=>${JSON.stringify(today)}; const esc=s=>String(s??""); const P=n=>"₱"+(Number(n)||0).toFixed(2);
    const fmtDate=s=>s||"—"; const holdDays=()=>Number(S.settings.holdDays??60)||60;\n${code}\n;this.__exports={${exportsList.join(",")}};`, ctx);
  return Object.assign(ctx.__exports, { S, bump: () => { S._ver++; } });
}

module.exports = { load, grab };
