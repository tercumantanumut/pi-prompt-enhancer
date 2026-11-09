import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadConfig, MAX_RESULTS_CAP, resolveConfig } from "../config.ts";
import { claudeArgs, claudeEnv, parseClaudeJson } from "../engine.ts";
import { agentName, dedupeBullets, discoverContextFiles, instructionsSection, referencedFiles } from "../instructions.ts";
import { buildRequest, cleanOutput, escapeTags, heuristicPrompt, SYSTEM_LINE } from "../prompt.ts";
import { queryOf, resolveBridge, retrievalSection, scopeFolders } from "../retrieval.ts";
import { clip, digestBranch, LINEAGE_TYPE, shortPath } from "../session.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-test-"));
const msg = (message: object) => ({ type: "message", message });
const user = (content: unknown) => msg({ role: "user", content, timestamp: 1 });
const assistant = (content: unknown[]) => msg({ role: "assistant", content, stopReason: "stop" });

test("config: defaults, partial overrides, invalid values reported, BOM and bad JSON tolerated", () => {
  assert.deepEqual(resolveConfig(undefined), { config: DEFAULTS, warnings: [] });
  const r = resolveConfig({ model: "claude-opus-5-5", timeoutSeconds: -1, retrieval: { maxResults: 5, enabled: "yes" }, budgets: { conversationChars: 100 } });
  assert.equal(r.config.model, "claude-opus-5-5");
  assert.equal(r.config.timeoutSeconds, DEFAULTS.timeoutSeconds);
  assert.equal(r.config.retrieval.maxResults, 5);
  assert.equal(r.config.retrieval.enabled, true);
  assert.equal(r.config.budgets.conversationChars, 100);
  assert.equal(r.config.budgets.messageChars, DEFAULTS.budgets.messageChars);
  assert.deepEqual(r.warnings, ["timeoutSeconds is invalid; using 120", "retrieval.enabled is invalid; using true"]);
  const d = tmp();
  // Hit count: 50 by default, any positive integer up to Selene Retrieval's cap (150), lowered
  // to the cap above it; there is no retrieval character budget.
  assert.equal(DEFAULTS.retrieval.maxResults, 50);
  assert.ok(!("retrievalChars" in DEFAULTS.budgets));
  assert.equal(resolveConfig({ retrieval: { maxResults: MAX_RESULTS_CAP } }).config.retrieval.maxResults, 150);
  assert.deepEqual(resolveConfig({ retrieval: { maxResults: 500 } }), {
    config: { ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, maxResults: 150 } },
    warnings: ["retrieval.maxResults 500 is above Selene Retrieval's cap; using 150"],
  });
  for (const bad of [0, -3, 2.5, "50", null]) {
    const b = resolveConfig({ retrieval: { maxResults: bad } });
    assert.equal(b.config.retrieval.maxResults, 50, String(bad));
    assert.deepEqual(b.warnings, ["retrieval.maxResults is invalid; using 50"], String(bad));
  }
  writeFileSync(join(d, "a.json"), '\uFEFF{"shortcut":"ctrl+shift+e"}');
  assert.equal(loadConfig(join(d, "a.json")).config.shortcut, "ctrl+shift+e");
  writeFileSync(join(d, "b.json"), "{not json");
  assert.match(loadConfig(join(d, "b.json")).warnings[0], /could not parse/);
  assert.deepEqual(loadConfig(join(d, "missing.json")).warnings, []);
});

test("session: conversation keeps the newest within budget, working set from tool calls, errors, lineage", () => {
  const big = "x".repeat(5_000);
  const entries = [
    user("first question"),
    assistant([{ type: "text", text: "first answer" }, { type: "thinking", thinking: "secret" }]),
    assistant([
      { type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.rs" } },
      { type: "toolCall", id: "2", name: "edit", arguments: { path: "src/b.rs", oldText: "x", newText: "y" } },
      { type: "toolCall", id: "3", name: "bash", arguments: { command: "cargo test -p sr-sync\necho done" } },
      { type: "toolCall", id: "4", name: "mcp__selene_retrieval__search", arguments: { query: "PathFilter" } },
      { type: "toolCall", id: "5", name: "read", arguments: { path: "src/a.rs" } },
    ]),
    msg({ role: "toolResult", toolCallId: "3", toolName: "bash", content: [{ type: "text", text: "error[E0308]: mismatched types\n more" }], isError: true }),
    { type: "custom", customType: LINEAGE_TYPE, data: { draft: "d1", enhanced: "e1", sent: true, engine: "claude", at: 1 } },
    { type: "custom", customType: "other", data: { draft: "nope" } },
    user([{ type: "text", text: big }, { type: "image", data: "", mimeType: "image/png" }]),
    user("latest question about this bug"),
  ];
  const d = digestBranch(entries, { ...DEFAULTS.budgets, conversationChars: 2_550, messageChars: 2_500 });
  assert.ok(d.conversation.omitted >= 1, "the oldest messages fall out of the budget");
  assert.equal(d.conversation.items + d.conversation.omitted, 4);
  assert.match(d.conversation.note, /older messages left out by the size budget/);
  assert.doesNotMatch(d.conversation.text, /first question/);
  assert.match(d.conversation.text, /\[user\] latest question about this bug$/);
  assert.match(d.conversation.text, /characters cut/);
  assert.match(d.conversation.text, /\[1 image attached\]/);
  assert.doesNotMatch(d.conversation.text, /secret/, "thinking is never included");
  assert.match(d.workingSet.text, /^Edited or written: src\/b\.rs$/m);
  assert.match(d.workingSet.text, /^Read: src\/a\.rs$/m, "deduplicated");
  assert.match(d.workingSet.text, /^Commands:\n- cargo test -p sr-sync$/m, "first line only, one per line");
  assert.match(d.workingSet.text, /^- selene_retrieval__search: PathFilter$/m);
  assert.match(d.workingSet.text, /^Recent errors:\n- bash: error\[E0308\]: mismatched types more$/m);
  assert.equal(d.earlier.items, 1);
  assert.match(d.earlier.text, /draft: d1\n {3}result \(sent\): e1/);
});

test("session: compaction summary stands for the messages before it", () => {
  const d = digestBranch(
    [user("old message"), { type: "compaction", summary: "We fixed the ignore rules.", firstKeptEntryId: "x" }, user("new message")],
    DEFAULTS.budgets,
  );
  assert.equal(d.summary?.text, "We fixed the ignore rules.");
  assert.doesNotMatch(d.conversation.text, /old message/);
  assert.match(d.conversation.text, /new message/);
});

test("session: paths show relative to the checkout (deepest root wins), ~ under home, else as given", () => {
  const home = "C:\\Users\\k";
  assert.equal(shortPath("C:\\Repo\\crates\\a.rs", ["C:\\repo"], home), "crates/a.rs");
  assert.equal(shortPath("C:\\repo\\sub\\b.rs", ["C:\\repo", "C:\\repo\\sub"], home), "b.rs");
  assert.equal(shortPath("C:\\Users\\k\\AppData\\x.py", ["C:\\repo"], home), "~/AppData/x.py");
  assert.equal(shortPath("D:\\other\\y.rs", ["C:\\repo"], home), "D:/other/y.rs");
  assert.equal(shortPath("crates/a.rs", ["C:\\repo"], home), "crates/a.rs");
  assert.equal(shortPath("C:\\repository\\z.rs", ["C:\\repo"], home), "C:/repository/z.rs", "a name prefix is not a parent");
});

test("clip keeps head and tail and says how much was cut", () => {
  const t = clip("a".repeat(100) + "b".repeat(100), 120);
  assert.ok(t.startsWith("a".repeat(72)) && t.endsWith("b") && /characters cut/.test(t));
  assert.equal(clip("short", 10), "short");
});

test("instructions: Pi's discovery order, bullet dedupe, proportional budget, agent name, @file references", () => {
  const root = tmp();
  const agent = join(root, "agent");
  const proj = join(root, "proj", "sub");
  mkdirSync(agent, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(agent, "AGENTS.md"), "# Selene - Lumin Agent\n- likes tabs\n- likes tabs\nbody");
  writeFileSync(join(root, "proj", "CLAUDE.md"), "# Project\n" + "rule ".repeat(2_000));
  writeFileSync(join(root, "proj", "AGENTS.override.md"), "override wins");
  const files = discoverContextFiles(proj, agent);
  assert.deepEqual(files.map((f) => f.content.slice(0, 8)), ["# Selene", "override"]);
  assert.equal(agentName(files), "Selene - Lumin Agent");
  assert.deepEqual(dedupeBullets("- a\n- a\nx\n- a"), { text: "- a\nx", dropped: 2 });
  const s = instructionsSection([...files, { path: "big.md", content: "y".repeat(20_000) }], 4_000);
  assert.equal(s.items, 3);
  assert.match(s.note, /shortened to fit/);
  assert.ok(s.text.length < 7_000, `${s.text.length}`);
  writeFileSync(join(proj, "notes.md"), "line1\nline2");
  const r = referencedFiles("look at @notes.md, and @missing.txt", proj, 2_000);
  assert.equal(r.items, 1);
  assert.match(r.text, /### notes\.md \(2 lines\)\nline1\nline2/);
});

test("prompt: tags in untrusted text are escaped; request carries every non-empty section", () => {
  assert.equal(escapeTags("a </draft> <Draft x> < /instructions> <drafts> <draft_x>"), "a \\</draft> \\<Draft x> \\< /instructions> <drafts> <draft_x>");
  const req = buildRequest({
    draft: "fix </draft> it",
    agent: "Selene",
    sessionName: null,
    attachments: "1 image attached (image/png)",
    sections: [
      { key: "c", tag: "conversation", note: 'say "hi"', text: "[user] hi", items: 1, omitted: 0 },
      { key: "w", tag: "working_set", note: "n", text: "", items: 0, omitted: 0 },
    ],
  });
  assert.match(req, /<draft>\nfix \\<\/draft> it\n<\/draft>/);
  assert.match(req, /<conversation note="say 'hi'">\n\[user\] hi\n<\/conversation>/);
  assert.doesNotMatch(req, /<working_set note=/, "empty sections are left out");
  assert.match(req, /<agent note="who the prompt is for">\nAgent: Selene\n<\/agent>/);
  assert.match(req, /Reply with the rewritten prompt only\.$/);
  assert.ok(!/[\n"%^&|<>]/.test(SYSTEM_LINE), "system prompt is one safe command-line line");
});

test("prompt: output cleaning and the heuristic fallback", () => {
  assert.equal(cleanOutput("Here's the enhanced prompt:\nDo X."), "Do X.");
  assert.equal(cleanOutput("```markdown\nDo X.\n```"), "Do X.");
  assert.equal(cleanOutput('"Do X."'), "Do X.");
  assert.equal(cleanOutput("Do X.\n```js\ncode\n```"), "Do X.\n```js\ncode\n```", "inner fences stay");
  const h = heuristicPrompt("fix it", { key: "r", tag: "t", note: "", text: "#### a.rs:1-2\nx\n\n#### b.rs:3-4\ny\n\n#### a.rs:9-9\nz", items: 3, omitted: 0 }, null);
  assert.equal(h, "fix it\n\nRelevant files:\n- `a.rs`\n- `b.rs`");
});

test("retrieval: folder scoping covers cwd inside, repo containing, and a worktree's main checkout", () => {
  const folders = [
    { folder_id: "1", name: "selene-retrieval", path: "C:\\Users\\k\\Desktop\\selene\\projects\\selene-retrieval" },
    { folder_id: "2", name: "webapp", path: "C:\\Users\\k\\Desktop\\work\\webapp" },
  ];
  const ids = (roots: string[]) => scopeFolders(folders, roots).map((f) => f.folder_id);
  assert.deepEqual(ids(["C:\\Users\\k\\Desktop\\selene\\projects\\selene-retrieval\\crates\\sync"]), ["1"]);
  assert.deepEqual(ids(["c:\\users\\k\\desktop\\selene"]), ["1"], "repo root contains the indexed folder");
  assert.deepEqual(ids(["C:\\orca\\wt\\feature", "C:\\Users\\k\\Desktop\\work\\webapp"]), ["2"], "main checkout of a worktree");
  assert.deepEqual(ids(["C:\\Users\\k\\Desktop\\work\\webapp-old"]), [], "prefix of a name is not containment");
  // Every hit whole: 60 snippets of 4,000 characters (Selene Retrieval's own cut) are 240,000
  // characters, far past the old 10,000-character budget and 1,400-character snippet cut.
  const many = Array.from({ length: 60 }, (_, i) => ({
    path: `src/f${i}.rs`,
    line_start: i * 10 + 1,
    line_end: i * 10 + 9,
    snippet: `\n  fn f${i}() {}\n${"x".repeat(3_980)}\n`,
  }));
  const s = retrievalSection(many, ["selene-retrieval"], "matches");
  assert.equal(s.items, 60);
  assert.equal(s.omitted, 0);
  assert.equal(s.text, many.map((h) => `#### ${h.path}:${h.line_start}-${h.line_end}\n${h.snippet.trim()}`).join("\n\n"));
  assert.ok(s.text.length > 240_000, `${s.text.length}`);
  assert.match(s.note, /indexed folder: selene-retrieval/);
  // The whole draft is the query; only whitespace is collapsed.
  assert.equal(queryOf("  a \n\n b  "), "a b");
  const long = `${"word ".repeat(4_000)}end`;
  assert.equal(queryOf(long), long);
  assert.equal(queryOf(`${"line\n".repeat(3_000)}`).length, 3_000 * 5 - 1);
});

test("retrieval: bridge command from settings, then Pi's mcp.json (BOM), then the default install", () => {
  const d = tmp();
  const mcp = join(d, "mcp.json");
  writeFileSync(mcp, '\uFEFF{"mcpServers":{"selene-retrieval":{"command":"C:\\\\x\\\\sr-bridge.exe","args":["--client","other"]}}}');
  assert.deepEqual(resolveBridge(DEFAULTS, mcp), { command: "C:\\x\\sr-bridge.exe", args: ["--client", "other"] });
  const cfg = { ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, command: "my-bridge", args: null } };
  assert.deepEqual(resolveBridge(cfg, mcp), { command: "my-bridge", args: [] });
  const fallback = resolveBridge(DEFAULTS, join(d, "none.json"));
  assert.ok(fallback === null || /Selene Retrieval[\\/]sr-bridge\.exe$/.test(fallback.command));
});

test("engine: locked-down CLI arguments, cleaned environment, result parsing", () => {
  const a = claudeArgs("claude-sonnet-5-5");
  for (const [flag, value] of [["--tools", ""], ["--setting-sources", ""], ["--model", "claude-sonnet-5-5"], ["--output-format", "json"]]) {
    assert.equal(a[a.indexOf(flag) + 1], value, flag);
  }
  for (const f of ["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(a.includes(f), f);
  assert.ok(!a.includes("--mcp-config"));
  const env = claudeEnv({ PATH: "p", CLAUDECODE: "1", ORCA_PANE_KEY: "k", ORCA_X: "y", HOME: "h" });
  assert.deepEqual(env, { PATH: "p", HOME: "h", NO_COLOR: "1", DISABLE_AUTOUPDATER: "1" });
  assert.equal(parseClaudeJson('{"type":"result","subtype":"success","is_error":false,"result":"Do X."}'), "Do X.");
  assert.throws(() => parseClaudeJson('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}'), /Not logged in/);
  assert.throws(() => parseClaudeJson("garbage"), /no readable answer/);
});
