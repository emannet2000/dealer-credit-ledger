#!/usr/bin/env node
"use strict";
// Zero-dependency syntax check used by `npm run check` and CI.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const targets = ["server.js", "lib", "public", "scripts", "test"];
const files = [];
function walk(entry) {
  const full = path.join(root, entry);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(path.join(entry, name));
    }
  } else if (entry.endsWith(".js")) files.push(entry);
}

for (const target of targets) walk(target);

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    failed++;
    console.error(`✗ ${file}\n${result.stderr}`);
  }
}
if (failed) {
  console.error(`\n${failed} file${failed === 1 ? "" : "s"} failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} files.`);
