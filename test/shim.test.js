"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/shim.js"), "utf8");

async function loadShim(fetch) {
  const timers = new Map();
  const window = {};
  vm.runInNewContext(source, {
    window, fetch, AbortController, console, crypto: require("node:crypto").webcrypto,
    document: { visibilityState: "visible" }, location: {},
    setInterval() {},
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { db: await window.claude.use("db"), timers };
}
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("failed initial loads report errors, reject reads, and recover on retry", async () => {
  let online = false;
  const { db } = await loadShim(async () => online
    ? response([{ id: "d1", data: { name: "Maria" } }])
    : response({ code: "unavailable", message: "Database unavailable" }, 503));
  const snapshots = [], errors = [];
  db.collection("dealers").onSnapshot(s => snapshots.push(s), e => errors.push(e));
  await tick();
  assert.equal(errors.length, 1);
  assert.equal(snapshots.length, 0);
  await assert.rejects(db.collection("dealers").get(), e => e.message === "Database unavailable");
  online = true;
  const result = await db.collection("dealers").get();
  assert.equal(result.docs[0].data().name, "Maria");
  assert.equal(snapshots.length, 1);
});

test("refresh errors after a successful load are visible instead of emitting stale data", async () => {
  let healthy = true;
  const { db } = await loadShim(async () => healthy
    ? response([{ id: "store", data: { name: "Store" } }])
    : response({ code: "too_many_requests", message: "Please slow down" }, 429));
  let collections = 0, documents = 0;
  const errors = [];
  db.collection("settings").onSnapshot(() => collections++, e => errors.push(e));
  await tick();
  db.doc("settings/store").onSnapshot(() => documents++, e => errors.push(e));
  healthy = false;
  await assert.rejects(db.doc("settings/store").get(), e => e.code === "too_many_requests");
  assert.equal(collections, 1);
  assert.equal(errors.length, 2);
  healthy = true;
  await db.doc("settings/store").get();
  assert.equal(collections, 2);
  assert.equal(documents, 1);
});

test("stalled responses time out and release the collection for a retry", async () => {
  let stalled = true;
  const { db, timers } = await loadShim(async (_url, { signal }) => {
    if (!stalled) return response([]);
    return { ok: true, status: 200, json: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
  });
  const read = db.collection("products").get();
  await tick();
  const timeout = [...timers.values()].find(t => t.ms === 30000);
  assert.ok(timeout, "request has a deadline even while reading its response body");
  timeout.fn();
  await assert.rejects(read, e => e.code === "unavailable" && /too long/.test(e.message));
  assert.equal(timers.size, 0);
  stalled = false;
  assert.equal((await db.collection("products").get()).empty, true);
});

test("invalid JSON is an error instead of an empty successful response", async () => {
  const { db } = await loadShim(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Invalid JSON"); } }));
  await assert.rejects(db.collection("dealers").get(), /Invalid JSON/);
});


test("a lost write response reuses its retry key despite a refreshed record version", async () => {
  const writes=[];
  const {db}=await loadShim(async (_url,options)=>{
    if(options.method==="GET")return response([]);
    writes.push(options.headers);
    if(writes.length===1)throw new Error("Response lost");
    return response({id:"d1",data:{name:"Maria"},version:1});
  });
  const ref=db.doc("dealers/d1"),data={name:"Maria"};
  await assert.rejects(ref.set(data,{version:1}),/Response lost/);
  await ref.set(data,{version:2});
  assert.equal(writes[0]["Idempotency-Key"],writes[1]["Idempotency-Key"]);
  assert.equal(writes[0]["If-Match"],"1");assert.equal(writes[1]["If-Match"],"2");
  await ref.set(data,{version:2});
  assert.notEqual(writes[1]["Idempotency-Key"],writes[2]["Idempotency-Key"],"a new operation after success receives a fresh key");
});
