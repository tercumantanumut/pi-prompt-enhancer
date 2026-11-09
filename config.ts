// Settings: one JSON file next to Pi's own settings (`~/.pi/agent/prompt-enhancer.json`).
// Every field is optional; a missing or invalid value falls back to its default and is reported.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Budgets {
  /** Recent conversation, newest kept first. */
  conversationChars: number;
  /** Cap for one message inside the conversation section. */
  messageChars: number;
  /** Files, commands and errors in the working set. */
  workingSetItems: number;
  /** Earlier enhancements of this session. */
  earlierEnhancements: number;
  /** AGENTS.md / CLAUDE.md content. */
  instructionsChars: number;
  /** Files referenced with `@path` in the draft. */
  referencedFileChars: number;
}

export interface EnhancerConfig {
  /** Claude model for the rewrite (Claude Code CLI, your sign-in). */
  model: string;
  /** Path to the `claude` executable; null = find it on PATH. */
  claudePath: string | null;
  shortcut: string;
  undoShortcut: string;
  timeoutSeconds: number;
  retrieval: {
    enabled: boolean;
    /** Hits per search, each one indexed chunk (1 to {@link MAX_RESULTS_CAP}). */
    maxResults: number;
    timeoutSeconds: number;
    /** Bridge command; null = take the `selene-retrieval` server from Pi's mcp.json. */
    command: string | null;
    args: string[] | null;
  };
  budgets: Budgets;
}

/** Selene Retrieval's most hits per search (`MAX_RESULTS_CAP` in its MCP server). */
export const MAX_RESULTS_CAP = 150;

export const DEFAULTS: EnhancerConfig = {
  model: "claude-sonnet-5-5",
  claudePath: null,
  shortcut: "alt+e",
  undoShortcut: "alt+shift+e",
  timeoutSeconds: 120,
  retrieval: { enabled: true, maxResults: 50, timeoutSeconds: 20, command: null, args: null },
  budgets: {
    conversationChars: 14_000,
    messageChars: 2_500,
    workingSetItems: 24,
    earlierEnhancements: 3,
    instructionsChars: 12_000,
    referencedFileChars: 6_000,
  },
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "prompt-enhancer.json");

type Json = Record<string, unknown>;

function pick<T>(src: Json, key: string, def: T, ok: (v: unknown) => boolean, warnings: string[], where: string): T {
  if (!(key in src)) return def;
  const v = src[key];
  if (ok(v)) return v as T;
  warnings.push(`${where}${key} is invalid; using ${JSON.stringify(def)}`);
  return def;
}

const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
const isStr = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isBool = (v: unknown) => typeof v === "boolean";
const isStrArrOrNull = (v: unknown) => v === null || (Array.isArray(v) && v.every((x) => typeof x === "string"));

/** `retrieval.maxResults`: a positive integer; above Selene Retrieval's cap it is lowered to it. */
function pickMaxResults(src: Json, def: number, warnings: string[]): number {
  if (!("maxResults" in src)) return def;
  const v = src.maxResults;
  if (!isPosInt(v)) {
    warnings.push(`retrieval.maxResults is invalid; using ${def}`);
    return def;
  }
  if ((v as number) > MAX_RESULTS_CAP) {
    warnings.push(`retrieval.maxResults ${v} is above Selene Retrieval's cap; using ${MAX_RESULTS_CAP}`);
    return MAX_RESULTS_CAP;
  }
  return v as number;
}

/** Merges a parsed settings object over the defaults; invalid fields are reported, not fatal. */
export function resolveConfig(raw: unknown): { config: EnhancerConfig; warnings: string[] } {
  const warnings: string[] = [];
  const src: Json = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : {};
  if (raw !== undefined && src !== raw) warnings.push("settings file is not a JSON object; using defaults");
  const r: Json = src.retrieval && typeof src.retrieval === "object" ? (src.retrieval as Json) : {};
  const b: Json = src.budgets && typeof src.budgets === "object" ? (src.budgets as Json) : {};
  const d = DEFAULTS;
  const budgets = {} as Budgets;
  for (const k of Object.keys(d.budgets) as (keyof Budgets)[]) {
    budgets[k] = pick(b, k, d.budgets[k], isPosInt, warnings, "budgets.");
  }
  return {
    warnings,
    config: {
      model: pick(src, "model", d.model, isStr, warnings, ""),
      claudePath: pick(src, "claudePath", d.claudePath, isStrOrNull, warnings, ""),
      shortcut: pick(src, "shortcut", d.shortcut, isStr, warnings, ""),
      undoShortcut: pick(src, "undoShortcut", d.undoShortcut, isStr, warnings, ""),
      timeoutSeconds: pick(src, "timeoutSeconds", d.timeoutSeconds, isPosInt, warnings, ""),
      retrieval: {
        enabled: pick(r, "enabled", d.retrieval.enabled, isBool, warnings, "retrieval."),
        maxResults: pickMaxResults(r, d.retrieval.maxResults, warnings),
        timeoutSeconds: pick(r, "timeoutSeconds", d.retrieval.timeoutSeconds, isPosInt, warnings, "retrieval."),
        command: pick(r, "command", d.retrieval.command, isStrOrNull, warnings, "retrieval."),
        args: pick(r, "args", d.retrieval.args, isStrArrOrNull, warnings, "retrieval."),
      },
      budgets,
    },
  };
}

/** Reads `~/.pi/agent/prompt-enhancer.json` (BOM tolerated). A missing file is not a warning. */
export function loadConfig(path = CONFIG_PATH): { config: EnhancerConfig; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return resolveConfig(undefined);
  }
  try {
    return resolveConfig(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (e) {
    const r = resolveConfig(undefined);
    r.warnings.push(`could not parse ${path}: ${(e as Error).message}; using defaults`);
    return r;
  }
}
