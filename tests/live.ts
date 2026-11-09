// Manual live run (not part of `node --test`): the real pipeline (git, Selene Retrieval, Claude
// Code CLI) over a real Pi session file. Usage:
//   node tests/live.ts <session.jsonl> <cwd> "<draft>" [--no-model]
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { enhance } from "../enhance.ts";

const [file, cwd, draft, flag] = process.argv.slice(2);
const all = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byId = new Map(all.filter((e) => e.id).map((e) => [e.id, e]));
// The branch Pi sees: from the newest entry back to the root.
const branch: any[] = [];
for (let e = all[all.length - 1]; e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.unshift(e);
const { config, warnings } = loadConfig();
const t0 = Date.now();
const r = await enhance({
  draft,
  cwd,
  entries: branch,
  contextFiles: null,
  sessionName: null,
  images: [],
  cfg: config,
  rewrite: flag === "--no-model" ? async () => "(model skipped)" : undefined,
});
console.log(`warnings: ${warnings.join("; ") || "none"}`);
console.log(`branch entries: ${branch.length}; request: ${r.request.length} chars; ${Date.now() - t0} ms; engine: ${r.engine}`);
console.log(`summary: ${r.summary}`);
for (const d of r.details) console.log(`  - ${d}`);
console.log("----- enhanced prompt -----");
console.log(r.prompt);
if (flag === "--show-request" || flag === "--no-model") {
  console.log("----- request -----");
  console.log(r.request);
}
