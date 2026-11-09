// What the current Pi session holds that a rewrite needs: the recent conversation, the agent's
// working set (files it read or changed, commands it ran, errors it hit), the latest compaction
// summary, and earlier enhancements of this session. Pure functions over branch entries.
import type { Budgets } from "./config.ts";

/** Custom entry type this extension appends after every enhancement (not sent to the model). */
export const LINEAGE_TYPE = "prompt-enhancer";

export interface LineageRecord {
  draft: string;
  enhanced: string;
  /** true = sent as the user's message (chat), false = discarded, null = left in the editor. */
  sent: boolean | null;
  engine: string;
  at: number;
}

export interface Section {
  key: string;
  /** Tag name in the request. */
  tag: string;
  note: string;
  text: string;
  /** How many items the section holds and how many were left out by its budget. */
  items: number;
  omitted: number;
}

type Entry = Record<string, any>;

/** Middle-cut a long text, saying how much was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = Math.max(0, max - head - 40);
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters cut ...]\n${text.slice(text.length - tail)}`;
}

function textOf(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let images = 0;
  const parts: string[] = [];
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "image") images++;
  }
  return { text: parts.join("\n"), images };
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"];

function pathArg(args: Record<string, any> | undefined): string | null {
  if (!args) return null;
  for (const k of PATH_KEYS) if (typeof args[k] === "string" && args[k].trim()) return args[k].trim();
  return null;
}

export interface Digest {
  conversation: Section;
  workingSet: Section;
  summary: Section | null;
  earlier: Section;
  /** Turns (user + assistant messages with text) included. */
  turns: number;
  lineage: LineageRecord[];
}

/**
 * A path as the prompt should show it: relative (with `/`) under one of `roots` (the checkout),
 * `~/...` under the home directory, as given otherwise.
 */
export function shortPath(p: string, roots: string[], home = process.env.USERPROFILE ?? process.env.HOME ?? ""): string {
  const unix = p.replace(/\\/g, "/");
  const low = unix.toLowerCase();
  for (const r of [...roots].sort((a, b) => b.length - a.length)) {
    const root = r.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && low.startsWith(`${root.toLowerCase()}/`)) return unix.slice(root.length + 1);
  }
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (h && low.startsWith(`${h.toLowerCase()}/`)) return `~/${unix.slice(h.length + 1)}`;
  return unix;
}

/** Digest of `ctx.sessionManager.getBranch()` within the budgets; paths shortened against `roots`. */
export function digestBranch(entries: Entry[], budgets: Budgets, roots: string[] = []): Digest {
  // The latest compaction summary stands for everything before it.
  let summaryText: string | null = null;
  let start = 0;
  entries.forEach((e, i) => {
    if (e?.type === "compaction" && typeof e.summary === "string") {
      summaryText = e.summary;
      start = i + 1;
    }
  });
  const msgs: { role: string; text: string }[] = [];
  const edited: string[] = [];
  const read: string[] = [];
  const commands: string[] = [];
  const searches: string[] = [];
  const errors: string[] = [];
  const lineage: LineageRecord[] = [];
  const push = (list: string[], v: string) => {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    list.push(v);
  };
  entries.forEach((e, i) => {
    if (e?.type === "custom" && e.customType === LINEAGE_TYPE && e.data && typeof e.data.draft === "string") {
      lineage.push(e.data as LineageRecord);
      return;
    }
    if (e?.type !== "message" || !e.message) return;
    const m = e.message;
    if (m.role === "user") {
      if (i < start) return;
      const { text, images } = textOf(m.content);
      const t = text.trim();
      if (t || images) msgs.push({ role: "user", text: t + (images ? `\n[${images} image${images > 1 ? "s" : ""} attached]` : "") });
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type === "toolCall" && typeof c.name === "string") {
          const a = c.arguments ?? {};
          const name: string = c.name;
          const raw = pathArg(a);
          const p = raw ? shortPath(raw, roots) : null;
          if (/^(edit|write|multi_?edit|apply_patch)$/i.test(name) && p) push(edited, p);
          else if (/^(read|view|cat)$/i.test(name) && p) push(read, p);
          else if (/^bash$/i.test(name) && typeof a.command === "string") push(commands, oneLine(a.command.split("\n")[0], 140));
          else if (/grep|search|find/i.test(name)) {
            const q = a.query ?? a.pattern ?? a.regex;
            if (typeof q === "string") push(searches, `${name.replace(/^mcp__/, "")}: ${oneLine(q, 100)}`);
          }
        }
      }
      if (i >= start) {
        const t = parts.join("\n").trim();
        if (t) msgs.push({ role: "assistant", text: t });
      }
    } else if (m.role === "toolResult" && m.isError) {
      const { text } = textOf(m.content);
      push(errors, `${m.toolName ?? "tool"}: ${oneLine(text, 200)}`);
    }
  });

  // Conversation: newest kept first, oldest dropped first, each message capped.
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = `[${msgs[i].role}] ${clip(msgs[i].text, budgets.messageChars)}`;
    if (used + line.length > budgets.conversationChars && kept.length > 0) {
      omitted = i + 1;
      break;
    }
    kept.unshift(line);
    used += line.length;
  }
  const conversation: Section = {
    key: "conversation",
    tag: "conversation",
    note: omitted ? `oldest first; ${omitted} older messages left out by the size budget` : "oldest first",
    text: kept.join("\n\n"),
    items: kept.length,
    omitted,
  };

  // Working set: most recent last in each list; the budget keeps the newest.
  const n = budgets.workingSetItems;
  const take = (list: string[]) => list.slice(-n);
  const ws: string[] = [];
  const lines: [string, string[]][] = [
    ["Edited or written", take(edited)],
    ["Read", take(read)],
    ["Commands", take(commands).slice(-Math.ceil(n / 2))],
    ["Searches", take(searches).slice(-Math.ceil(n / 3))],
    ["Recent errors", take(errors).slice(-5)],
  ];
  let wsItems = 0;
  for (const [label, list] of lines) {
    if (!list.length) continue;
    wsItems += list.length;
    // File lists read well inline; commands and errors contain `|` and `,`, so one per line.
    ws.push(label === "Edited or written" || label === "Read" ? `${label}: ${list.join(", ")}` : `${label}:\n${list.map((x) => `- ${x}`).join("\n")}`);
  }
  const wsTotal = edited.length + read.length + commands.length + searches.length + errors.length;
  const workingSet: Section = {
    key: "workingSet",
    tag: "working_set",
    note: "what the agent touched in this session, most recent last",
    text: ws.join("\n"),
    items: wsItems,
    omitted: Math.max(0, wsTotal - wsItems),
  };

  const summary: Section | null = summaryText
    ? { key: "summary", tag: "session_summary", note: "summary of the earlier part of this session", text: clip(summaryText, 4_000), items: 1, omitted: 0 }
    : null;

  const recent = lineage.slice(-budgets.earlierEnhancements);
  const earlier: Section = {
    key: "earlier",
    tag: "earlier_enhancements",
    note: "earlier enhancements in this session, oldest first; build on them instead of starting over",
    text: recent
      .map((r, i) => {
        const fate = r.sent === true ? "sent" : r.sent === false ? "discarded" : "left in the editor";
        return `${i + 1}. draft: ${clip(r.draft, 600)}\n   result (${fate}): ${clip(r.enhanced, 900)}`;
      })
      .join("\n"),
    items: recent.length,
    omitted: lineage.length - recent.length,
  };
  return { conversation, workingSet, summary, earlier, turns: kept.length, lineage };
}
