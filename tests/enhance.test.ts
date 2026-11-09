import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULTS } from "../config.ts";
import { Cancelled, enhance } from "../enhance.ts";
import { EngineError } from "../engine.ts";
import { LINEAGE_TYPE } from "../session.ts";
import type { Run } from "../workspace.ts";

const noBridge = { ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, command: "C:\\definitely\\missing\\sr-bridge.exe", args: [] } };
const offline = { ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, enabled: false } };

const fakeGit: Run = async (cmd, args) => {
  if (cmd !== "git") return null;
  const a = args.join(" ");
  if (a === "rev-parse --show-toplevel") return "C:/repo\n";
  if (a === "rev-parse --abbrev-ref HEAD") return "feature/x\n";
  if (a.startsWith("rev-parse --path-format")) return "C:/repo/.git\n";
  if (a.startsWith("status")) return " M crates/sync/src/filter.rs\n?? notes.md\n";
  if (a.startsWith("log")) return "abc123 fix ignore rules\n";
  return null;
};

const entries = [
  { type: "message", message: { role: "user", content: "the build dir is ignored", timestamp: 1 } },
  {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "It is DEFAULT_IGNORED_DIRS." }, { type: "toolCall", id: "1", name: "edit", arguments: { path: "crates/sync/src/filter.rs" } }] },
  },
  { type: "custom", customType: LINEAGE_TYPE, data: { draft: "fix build dirs", enhanced: "Fix the build dir rule in filter.rs.", sent: true, engine: "claude", at: 1 } },
];

test("enhance: every source reaches the request and the summary reports them", async () => {
  let seen = "";
  const r = await enhance({
    draft: "now do the same for env dirs",
    cwd: process.cwd(),
    entries,
    contextFiles: [{ path: "AGENTS.md", content: "# Selene - Lumin Agent\n- never deploy without asking" }],
    sessionName: "ignore rules",
    images: [{ mimeType: "image/png" }],
    cfg: offline,
    exec: fakeGit,
    rewrite: async (input) => {
      seen = input;
      return "Apply the Cargo-source exception to `env` directories in `crates/sync/src/filter.rs`.";
    },
  });
  assert.equal(r.engine, "claude");
  assert.match(r.prompt, /env/);
  for (const needle of [
    "<draft>\nnow do the same for env dirs\n</draft>",
    "Agent: Selene - Lumin Agent\nSession: ignore rules",
    "1 image attached (image/png)",
    "[user] the build dir is ignored",
    "Edited or written: crates/sync/src/filter.rs",
    "result (sent): Fix the build dir rule in filter.rs.",
    "git repo: C:/repo (branch feature/x)",
    "changed files (2): M crates/sync/src/filter.rs, ?? notes.md",
    "abc123 fix ignore rules",
    "- never deploy without asking",
  ]) {
    assert.ok(seen.includes(needle), `request lacks: ${needle}`);
  }
  assert.ok(!seen.includes("<retrieved_context"), "retrieval off");
  assert.match(r.summary, /^2 messages · 1 working-set item · 1 earlier enhancement · claude-sonnet-5-5$/);
  assert.ok(r.details.includes("retrieval: none (retrieval is turned off)"));
});

test("enhance: model failure falls back to the labeled heuristic", async () => {
  const r = await enhance({
    draft: "explain the watcher",
    cwd: process.cwd(),
    entries: [],
    contextFiles: [],
    sessionName: null,
    images: [],
    cfg: noBridge,
    exec: fakeGit,
    rewrite: async () => {
      throw new EngineError("Claude Code (claude) is not installed or not on PATH");
    },
  });
  assert.equal(r.engine, "heuristic");
  assert.equal(r.prompt, "explain the watcher");
  assert.match(r.summary, /no model \(heuristic fallback\)$/);
  assert.ok(r.details.some((d) => d.startsWith("model: Claude Code (claude) is not installed")));
  assert.ok(!r.details.some((d) => d.startsWith("fallback: ")), "no Selene Retrieval fallback any more");
});

test("enhance: a cancelled rewrite is reported as cancelled, never as a fallback", async () => {
  const ac = new AbortController();
  await assert.rejects(
    enhance({
      draft: "abc def",
      cwd: process.cwd(),
      entries: [],
      contextFiles: [],
      sessionName: null,
      images: [],
      cfg: offline,
      exec: fakeGit,
      signal: ac.signal,
      rewrite: async () => {
        ac.abort();
        throw new EngineError("cancelled");
      },
    }),
    Cancelled,
  );
});
