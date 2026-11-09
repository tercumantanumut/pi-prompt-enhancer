// Where the work happens: git branch, changed files and recent commits, and the Orca workspace
// (name, comment, linked issue) when Pi runs inside Orca. Every probe has a short timeout and
// failing probes are simply left out.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { Section } from "./session.ts";

export type Run = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<string | null>;

/** Default runner: no shell, hidden window, stdout or null on any failure. */
export const run: Run = (cmd, args, cwd, timeoutMs) =>
  new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      done(err ? null : String(stdout)),
    );
  });

export interface Workspace {
  section: Section;
  /** Directories that identify this checkout for retrieval scoping (cwd, git top level, main checkout). */
  roots: string[];
}

function orcaCli(): string | null {
  return process.env.ORCA_CLI_COMMAND || (process.env.ORCA_PANE_KEY || process.env.ORCA_AGENT_SESSION_ID ? "orca" : null);
}

export async function collectWorkspace(cwd: string, exec: Run = run): Promise<Workspace> {
  const git = (args: string[]) => exec("git", args, cwd, 6_000);
  const orca = orcaCli();
  const [top, branch, common, status, log, wt] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    // Tracked changes only: scanning untracked trees (build output, nested projects) is slow.
    git(["status", "--porcelain=v1", "--untracked-files=no"]),
    git(["log", "--oneline", "-5", "--no-decorate"]),
    orca ? exec(orca, ["worktree", "current", "--json"], cwd, 6_000) : Promise.resolve(null),
  ]);
  const lines: string[] = [`cwd: ${cwd}`];
  const roots = [resolve(cwd)];
  if (top?.trim()) {
    lines.push(`git repo: ${top.trim()}${branch?.trim() ? ` (branch ${branch.trim()})` : ""}`);
    roots.push(resolve(top.trim()));
  }
  if (common?.trim()) {
    // `<main checkout>/.git` for a linked worktree: the main checkout is what may be indexed.
    const c = resolve(common.trim());
    if (/[\\/]\.git$/i.test(c)) roots.push(dirname(c));
  }
  const changed = (status ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 3);
  if (changed.length) {
    const shown = changed.slice(0, 30).map((l) => `${l.slice(0, 2).trim() || "?"} ${l.slice(3)}`);
    lines.push(`changed files (${changed.length}): ${shown.join(", ")}${changed.length > 30 ? ", ..." : ""}`);
  }
  if (log?.trim()) lines.push(`recent commits:\n${log.trim().split("\n").map((l) => `  ${l.trim()}`).join("\n")}`);
  try {
    const w = wt ? JSON.parse(wt)?.result?.worktree : null;
    if (w) {
      const linked = [w.linkedIssue, w.linkedPR, w.linkedLinearIssue, w.linkedWorkItem]
        .filter(Boolean)
        .map((x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)));
      const parts = [`Orca workspace: ${w.displayName ?? "?"}`];
      if (w.workspaceStatus) parts.push(`status ${w.workspaceStatus}`);
      if (typeof w.comment === "string" && w.comment.trim()) parts.push(`comment "${w.comment.trim()}"`);
      if (linked.length) parts.push(`linked ${linked.join(", ")}`);
      lines.push(parts.join(", "));
    }
  } catch {}
  return {
    roots: [...new Set(roots.map((r) => r.toLowerCase()))].map((l) => roots.find((r) => r.toLowerCase() === l)!),
    section: { key: "workspace", tag: "workspace", note: "where the work happens", text: lines.join("\n"), items: lines.length, omitted: 0 },
  };
}
