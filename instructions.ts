// Standing instructions and memories: the AGENTS.md / CLAUDE.md files Pi loaded for this session,
// plus files the draft references with `@path`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { clip, type Section } from "./session.ts";

export interface ContextFile {
  path: string;
  content: string;
}

const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function firstIn(dir: string): string | null {
  for (const n of NAMES) {
    const p = join(dir, n);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Pi's discovery rule (docs/configuration.md "Context files"): the agent directory, then the
 * working directory and its parents, `AGENTS.override.md` winning within one directory. Used when
 * no run has reported Pi's own list yet (a shortcut pressed before the first prompt).
 */
export function discoverContextFiles(cwd: string, agentDir = join(homedir(), ".pi", "agent")): ContextFile[] {
  const out: ContextFile[] = [];
  const add = (p: string | null) => {
    if (!p || out.some((f) => f.path.toLowerCase() === p.toLowerCase())) return;
    try {
      out.push({ path: p, content: readFileSync(p, "utf8") });
    } catch {}
  };
  add(firstIn(agentDir));
  const dirs: string[] = [];
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.unshift(d);
    if (dirname(d) === d) break;
  }
  for (const d of dirs) add(firstIn(d));
  return out;
}

/** Selene's memory normalizer: repeated `- ` bullet lines are dropped, everything else kept. */
export function dedupeBullets(markdown: string): { text: string; dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (/^-\s+/.test(t)) {
      if (seen.has(t)) {
        dropped++;
        continue;
      }
      seen.add(t);
    }
    out.push(line);
  }
  return { text: out.join("\n").trim(), dropped };
}

/** The agent's name: the first `# heading` of the first context file that has one. */
export function agentName(files: ContextFile[]): string | null {
  for (const f of files) {
    const m = /^#\s+(.+)$/m.exec(f.content);
    if (m) return m[1].trim();
  }
  return null;
}

/** All context files within `budget` characters; each file keeps a share proportional to its size. */
export function instructionsSection(files: ContextFile[], budget: number): Section {
  const cleaned = files
    .map((f) => ({ path: f.path, ...dedupeBullets(f.content) }))
    .filter((f) => f.text.length > 0);
  const total = cleaned.reduce((n, f) => n + f.text.length, 0);
  let cut = 0;
  const parts = cleaned.map((f) => {
    const share = total <= budget ? f.text.length : Math.max(1_500, Math.floor((budget * f.text.length) / total));
    if (f.text.length > share) cut++;
    return `### ${f.path}\n${clip(f.text, share)}`;
  });
  return {
    key: "instructions",
    tag: "instructions",
    note: cut
      ? `the user's standing instructions and memories (${cut} file${cut > 1 ? "s" : ""} shortened to fit)`
      : "the user's standing instructions and memories",
    text: parts.join("\n\n"),
    items: parts.length,
    omitted: 0,
  };
}

/** `@path` references in the draft that name existing files under cwd (first lines of each). */
export function referencedFiles(draft: string, cwd: string, budget: number): Section {
  const refs = [...new Set([...draft.matchAll(/(?:^|\s)@([^\s"'`]+)/g)].map((m) => m[1].replace(/[),.;:]+$/, "")))];
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const r of refs) {
    const p = isAbsolute(r) ? r : join(cwd, r);
    let body: string;
    try {
      if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 2_000_000) continue;
      body = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (body.includes("\u0000")) continue;
    const room = budget - used;
    if (room < 400) {
      omitted++;
      continue;
    }
    const lines = body.split("\n");
    const excerpt = lines.slice(0, 80).join("\n");
    const text = `### ${r} (${lines.length} lines${lines.length > 80 ? ", first 80 shown" : ""})\n${clip(excerpt, room - 60)}`;
    parts.push(text);
    used += text.length;
  }
  return {
    key: "referencedFiles",
    tag: "referenced_files",
    note: "files the draft points to with @path",
    text: parts.join("\n\n"),
    items: parts.length,
    omitted,
  };
}
