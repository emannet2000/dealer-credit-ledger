#!/usr/bin/env node
"use strict";
// Preview a backup, then confirm its frozen preview ID after reviewing changes.
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../lib/app");
async function main() {
  const [fileOrFlag, previewId] = process.argv.slice(2);
  if (!fileOrFlag || (fileOrFlag === "--confirm" && !previewId)) throw new Error("Usage: npm run import -- backup.json | npm run import -- --confirm <preview-id>");
  const context = createApp({ dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")) });
  const operator = { id: "command-line", role: "owner" };
  try {
    if (fileOrFlag === "--confirm") {
      const result = await context.workflows.confirmImport(operator, previewId);
      console.log(`Imported ${result.count} records; ${result.failed.length} failed. Safety backup: ${result.safetyBackup}`);
      return;
    }
    const input = JSON.parse(fs.readFileSync(fileOrFlag, "utf8"));
    const preview = context.workflows.previewImport(operator, "backup", input);
    for (const r of preview.records) console.log(`${r.valid ? r.action : "INVALID"}: ${r.collection}/${r.id} (${r.before?.name || r.before?.no || "new"} → ${r.after?.name || r.after?.no || r.id})`);
    for (const e of preview.errors) console.error(`${e.collection}/${e.id}: ${e.message}`);
    console.log(`${preview.counts.create} new; ${preview.counts.overwrite} overwritten. Other records are kept. Photos and accounts are not imported.`);
    if (!preview.canApply) { process.exitCode = 1; return; }
    console.log(`Nothing imported yet. Review the changes, then run within 15 minutes:\nnpm run import -- --confirm ${preview.id}`);
  } finally { context.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
