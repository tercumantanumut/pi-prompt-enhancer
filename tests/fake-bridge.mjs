// Stand-in for sr-bridge.exe in tests: MCP over stdio (newline-delimited JSON-RPC) with one indexed
// folder at argv[3]. Records the `context_search` arguments to argv[2] and answers with `maxResults` hits
// (50 when not asked) whose snippets are 3,000 characters each.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [record, root] = process.argv.slice(2);
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ok = (id, structuredContent) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }], structuredContent } });

// Must match `snippetFor` in retrieval.test.ts.
function snippetFor(i) {
  return `fn f${i}() {}\n${"// body ".repeat(375)}`;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return; // notifications
  if (m.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-bridge", version: "0" } },
    });
  }
  if (m.method === "tools/call" && m.params?.name === "list_folders") {
    return ok(m.id, { folders: [{ folder_id: "F1", name: "fake-folder", path: root }] });
  }
  if (m.method === "tools/call" && m.params?.name === "context_search") {
    const a = m.params.arguments ?? {};
    writeFileSync(record, JSON.stringify(a));
    const hits = Array.from({ length: a.maxResults ?? 50 }, (_, i) => ({
      path: `src/f${i}.rs`,
      line_start: i * 10 + 1,
      line_end: i * 10 + 9,
      snippet: snippetFor(i),
    }));
    return ok(m.id, { hits });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
});
