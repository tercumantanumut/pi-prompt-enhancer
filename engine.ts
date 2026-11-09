// The rewrite: Claude Code CLI in print mode, locked down the way Selene Retrieval runs it (no
// tools, no MCP, no settings or hooks, no slash commands, no transcript), on the user's sign-in.
// Pi's default `claude-bridge` provider cannot serve this call: it only answers requests whose
// system prompt matches the session's own.
import { spawn } from "node:child_process";
import type { EnhancerConfig } from "./config.ts";
import { SYSTEM_LINE, cleanOutput } from "./prompt.ts";
import { killTree } from "./retrieval.ts";

export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM_LINE,
  ];
}

/** The child's environment: no nested-Claude marker, no Orca pane identity, no colors/updates. */
export function claudeEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "CLAUDECODE" || k.startsWith("ORCA_")) continue;
    env[k] = v;
  }
  env.NO_COLOR = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

export class EngineError extends Error {}

/** Parses `claude -p --output-format json` stdout into the result text. */
export function parseClaudeJson(stdout: string): string {
  let d: any;
  try {
    d = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
  } catch {
    throw new EngineError("Claude Code returned no readable answer");
  }
  if (d?.is_error || d?.subtype !== "success" || typeof d?.result !== "string") {
    const why = typeof d?.result === "string" && d.result ? d.result : d?.subtype ?? "unknown error";
    throw new EngineError(`Claude Code: ${String(why).slice(0, 300)}`);
  }
  return d.result;
}

export async function runClaude(input: string, cfg: EnhancerConfig, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new EngineError("cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.claudePath ?? "claude", claudeArgs(cfg.model), {
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      killTree(child);
      finish(() => reject(new EngineError("cancelled")));
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new EngineError(`Claude Code did not answer within ${cfg.timeoutSeconds} s`)));
    }, cfg.timeoutSeconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(() => reject(new EngineError(e.code === "ENOENT" ? "Claude Code (claude) is not installed or not on PATH" : e.message))),
    );
    child.on("close", (code) =>
      finish(() => {
        try {
          const text = cleanOutput(parseClaudeJson(out));
          if (text.length < 3) throw new EngineError("Claude Code returned an empty prompt");
          resolve(text);
        } catch (e) {
          const tail = err.trim().split("\n").slice(-2).join(" ").slice(0, 300);
          reject(e instanceof EngineError && code === 0 ? e : new EngineError(`${(e as Error).message}${tail ? ` (${tail})` : ""}`));
        }
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
