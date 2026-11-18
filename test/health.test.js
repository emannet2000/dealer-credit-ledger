"use strict";
// Health, metrics and response-counting checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createApp } = require("../lib/app");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-health-"));
const { app, close } = createApp({ dataDir: dir, logger: { error() {} } });
let server, base, cookie = "";

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("metrics require an administrator", async () => {
  assert.equal((await fetch(base + "/metrics")).status, 401);
});

test("health check reports database and disk status", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.checks.database, true);
  assert.ok(body.uptime >= 0);
});

test("page scripts are served compressed when the browser accepts it", async () => {
  const original = fs.readFileSync(path.join(__dirname, "..", "public", "index.js"));
  const request = (encoding) => new Promise((resolve, reject) => {
    http.get(`${base}/index.js`, { headers: { "Accept-Encoding": encoding } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });

  const gzip = await request("gzip");
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(gzip.headers.vary, "Accept-Encoding");
  assert.ok(zlib.gunzipSync(gzip.body).equals(original));
  assert.ok(gzip.body.length < original.length, "compressed script should be smaller");

  const plain = await request("identity");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(plain.body.equals(original));
});

test("each request is counted once in metrics", async () => {
  const setup = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Owner", username: "owner", password: "OwnerSecret123!" }),
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie").split(";")[0];

  const read = async () => {
    const r = await fetch(base + "/metrics", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const text = await r.text();
    return {
      total: Number(text.match(/^http_requests_total (\d+)$/m)[1]),
      ok: Number(text.match(/^http_requests_by_status\{status="200"\} (\d+)$/m)[1]),
      text,
    };
  };

  const before = await read();
  // Two JSON responses. A JSON response must not also count its inner send().
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const after = await read();

  // The metrics response itself is counted when it starts, but only counted in
  // byStatus once it finishes, so both totals should grow by the same amount.
  assert.equal(after.total - before.total, 3);
  assert.equal(after.ok - before.ok, 3);
  assert.match(before.text, /^http_errors_total 0$/m);
});
