// The retrieval step end to end through the real MCP client and a spawned stand-in bridge
// (tests/fake-bridge.mjs): what the extension asks Selene Retrieval for, and what it keeps.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULTS, type EnhancerConfig } from "../config.ts";
import { ground } from "../retrieval.ts";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "fake-bridge.mjs");
const snippetFor = (i: number) => `fn f${i}() {}\n${"// body ".repeat(375)}`;

function setup(maxResults: number) {
  const root = mkdtempSync(join(tmpdir(), "pe-bridge-"));
  const record = join(root, "search-args.json");
  const cfg: EnhancerConfig = {
    ...DEFAULTS,
    retrieval: { ...DEFAULTS.retrieval, maxResults, command: process.execPath, args: [bridge, record, root] },
  };
  return { root, record, cfg };
}

test("ground: the whole draft is the query, 50 hits are asked for, every hit is kept whole", async () => {
  const { root, record, cfg } = setup(DEFAULTS.retrieval.maxResults);
  // 9,606 characters: longer than the old 500-character query cut and than Selene Retrieval's
  // 8,192-byte query limit, which the stand-in does not enforce.
  const draft = `${"explain the watcher rescan rule ".repeat(300)}please`;
  const g = await ground(cfg, draft, [root]);
  assert.equal(g.error, null);
  const asked = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(asked.query, draft);
  assert.equal(asked.maxResults, 50);
  assert.deepEqual(asked.folderIds, ["F1"]);
  assert.deepEqual(g.folderIds, ["F1"]);
  assert.equal(g.section?.items, 50);
  assert.equal(g.section?.omitted, 0);
  for (let i = 0; i < 50; i++) {
    const want = `#### src/f${i}.rs:${i * 10 + 1}-${i * 10 + 9}\n${snippetFor(i).trim()}`;
    assert.ok(g.section?.text.includes(want), `hit ${i} is missing or cut`);
  }
  // 50 snippets of about 3,000 characters: no 10,000-character total, no 1,400-character cut.
  assert.ok((g.section?.text.length ?? 0) > 150_000, `${g.section?.text.length}`);
});

test("ground: the configured hit count reaches the search, up to the cap of 150", async () => {
  const { root, record, cfg } = setup(150);
  const g = await ground(cfg, "list the crates", [root]);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).maxResults, 150);
  assert.equal(g.section?.items, 150);
});

test("ground: a checkout outside every indexed folder searches nothing", async () => {
  const { record, cfg } = setup(50);
  const g = await ground(cfg, "list the crates", [join(tmpdir(), "elsewhere-not-indexed")]);
  assert.equal(g.section, null);
  assert.equal(g.error, "this checkout is not in an indexed folder");
  assert.throws(() => readFileSync(record, "utf8"), "no search was made");
});
