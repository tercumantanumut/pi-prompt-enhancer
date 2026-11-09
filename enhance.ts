// One enhancement: gather every context source, build the request, run the rewrite, fall back
// when the model is unavailable, and report what grounded the result.
import type { EnhancerConfig } from "./config.ts";
import { EngineError, runClaude } from "./engine.ts";
import { agentName, discoverContextFiles, instructionsSection, referencedFiles, type ContextFile } from "./instructions.ts";
import { buildRequest, heuristicPrompt } from "./prompt.ts";
import { ground } from "./retrieval.ts";
import { digestBranch, type Section } from "./session.ts";
import { collectWorkspace, type Run } from "./workspace.ts";

export interface EnhanceRequest {
  draft: string;
  cwd: string;
  /** `ctx.sessionManager.getBranch()`. */
  entries: Record<string, any>[];
  /** Pi's own context files when known; discovered from disk otherwise. */
  contextFiles: ContextFile[] | null;
  sessionName: string | null;
  /** Images attached to the `/enhance` input (described, not sent). */
  images: { mimeType: string }[];
  cfg: EnhancerConfig;
  signal?: AbortSignal;
  /** Test seams. */
  exec?: Run;
  rewrite?: (input: string) => Promise<string>;
}

export type EngineName = "claude" | "heuristic";

export interface EnhanceResult {
  prompt: string;
  engine: EngineName;
  /** One line: what grounded the result. */
  summary: string;
  /** Per-source lines, including what was left out and why. */
  details: string[];
  request: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class Cancelled extends Error {}

export async function enhance(req: EnhanceRequest): Promise<EnhanceResult> {
  const { cfg, draft, cwd } = req;
  const files = req.contextFiles ?? discoverContextFiles(cwd);
  const instructions = instructionsSection(files, cfg.budgets.instructionsChars);
  const referenced = referencedFiles(draft, cwd, cfg.budgets.referencedFileChars);
  const ws = await collectWorkspace(cwd, req.exec);
  if (req.signal?.aborted) throw new Cancelled();
  const d = digestBranch(req.entries, cfg.budgets, ws.roots);
  const g = await ground(cfg, draft, ws.roots, req.signal);
  if (req.signal?.aborted) throw new Cancelled();

  const sections: Section[] = [d.conversation];
  if (d.summary) sections.push(d.summary);
  sections.push(d.workingSet, d.earlier, ws.section, referenced);
  if (g.section) sections.push(g.section);
  sections.push(instructions);
  const attachments = req.images.length
    ? `${plural(req.images.length, "image")} attached (${[...new Set(req.images.map((i) => i.mimeType))].join(", ")}); their content is not shown here`
    : null;
  const request = buildRequest({ draft, agent: agentName(files), sessionName: req.sessionName, sections, attachments });

  const details: string[] = [];
  const line = (label: string, s: Section | null, unit: string, extra = "") => {
    if (!s) return;
    details.push(`${label}: ${plural(s.items, unit)}${s.omitted ? ` (${s.omitted} left out by the size budget)` : ""}${extra}`);
  };
  line("conversation", d.conversation, "message");
  if (d.summary) details.push("session summary: included (the session was compacted)");
  line("working set", d.workingSet, "item");
  line("earlier enhancements", d.earlier, "enhancement");
  line("instructions", instructions, "file", instructions.note.includes("shortened") ? " (shortened to fit)" : "");
  line("referenced files", referenced, "file");
  details.push(g.section ? `retrieval: ${plural(g.section.items, "snippet")}` : `retrieval: none (${g.error})`);

  let engine: EngineName = "claude";
  let prompt: string;
  try {
    prompt = req.rewrite ? await req.rewrite(request) : await runClaude(request, cfg, req.signal);
  } catch (e) {
    if (req.signal?.aborted || (e instanceof EngineError && e.message === "cancelled")) throw new Cancelled();
    details.push(`model: ${(e as Error).message}`);
    engine = "heuristic";
    prompt = heuristicPrompt(draft, g.section, d.workingSet);
  }
  const parts = [plural(d.turns, "message"), plural(d.workingSet.items, "working-set item")];
  if (g.section) parts.push(plural(g.section.items, "snippet"));
  if (d.earlier.items) parts.push(plural(d.earlier.items, "earlier enhancement"));
  const via = engine === "claude" ? cfg.model : "no model (heuristic fallback)";
  return { prompt, engine, summary: `${parts.join(" · ")} · ${via}`, details, request };
}
