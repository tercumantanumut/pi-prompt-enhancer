// End-to-end check of the extension over Pi RPC, the protocol Orca chat uses (not part of
// `node --test`). Usage: node tests/rpc-e2e.mjs <path to index.ts> <cwd> <submit|cancel> "<draft>"
// submit: answers the result dialog with a harmless prompt and expects the agent run it starts
//         (aborted at once); cancel: answers with cancel and expects no run. The draft is sent
//         only after get_commands lists /enhance, and any unexpected run is aborted.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [ext, cwd, mode, draft] = process.argv.slice(2);
const HARMLESS = "Reply with exactly the word OK. Do not use any tools.";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));
const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", JSON.stringify(ext)], { cwd, env, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)}ms`;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let done = false;
let answered = false;
const finish = (code, why) => {
  if (done) return;
  done = true;
  console.log(`[${ms()}] RESULT ${code === 0 ? "PASS" : "FAIL"}: ${why}`);
  try { send({ type: "abort" }); } catch {}
  child.stdin.end();
  setTimeout(() => {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    setTimeout(() => process.exit(code), 800);
  }, 300);
};
createInterface({ input: child.stderr }).on("line", (l) => l.trim() && console.log(`[${ms()}] stderr: ${l.slice(0, 300)}`));
let polls = 0;
let promptSent = false;
const poller = setInterval(() => {
  if (promptSent || done) return;
  if (++polls > 160) return finish(3, "command never registered; no prompt sent");
  send({ id: `cmds-${polls}`, type: "get_commands" });
}, 1500);
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === "agent_start") {
    if (mode === "submit" && answered) return finish(0, "submitting the dialog started an agent run with the edited prompt (aborted)");
    return finish(4, "an agent run started unexpectedly (aborted)");
  }
  if (m.type === "message_start" && m.message?.role === "user") {
    console.log(`[${ms()}] user message: ${JSON.stringify(m.message.content).slice(0, 200)}`);
  }
  if (m.type === "response" && m.command === "get_commands") {
    const names = (m.data?.commands ?? []).map((c) => c.name);
    if (names.includes("enhance") && !promptSent) {
      promptSent = true;
      clearInterval(poller);
      console.log(`[${ms()}] /enhance registered; sending the draft`);
      send({ id: "p1", type: "prompt", message: `/enhance ${draft}` });
    }
    return;
  }
  if (m.type === "response" && m.command === "prompt") {
    console.log(`[${ms()}] prompt response: ${JSON.stringify(m.data)}`);
    if (mode === "cancel" && answered) setTimeout(() => finish(0, "cancel sent nothing"), 4000);
    return;
  }
  if (m.type === "extension_ui_request") {
    if (m.method === "editor") {
      console.log(`[${ms()}] editor dialog\n  title: ${m.title}\n  prefill:\n${String(m.prefill).split("\n").map((l) => `    ${l}`).join("\n")}`);
      answered = true;
      if (mode === "submit") send({ type: "extension_ui_response", id: m.id, value: HARMLESS });
      else {
        send({ type: "extension_ui_response", id: m.id, cancelled: true });
        setTimeout(() => finish(0, "cancel sent nothing"), 6000);
      }
    } else if (m.method === "select") {
      console.log(`[${ms()}] select dialog: ${m.title}`);
      send({ type: "extension_ui_response", id: m.id, cancelled: true });
      finish(5, `unexpected dialog: ${m.title}`);
    } else if (["confirm", "input"].includes(m.method)) send({ type: "extension_ui_response", id: m.id, cancelled: true });
  }
});
child.on("exit", (code) => finish(code ?? 1, "pi exited"));
setTimeout(() => finish(2, "timeout"), 300000);
