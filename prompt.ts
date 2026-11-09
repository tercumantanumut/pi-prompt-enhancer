// The rewrite request: instructions, the draft, and labeled reference sections.
import type { Section } from "./session.ts";

/**
 * One plain line (it travels as a command-line argument): the real instructions are in the input,
 * the same split Selene Retrieval uses for its Claude CLI provider.
 */
export const SYSTEM_LINE =
  "You rewrite draft prompts for an AI coding agent. You have no tools and no files: everything you need is in the input. Follow the instructions in the input and reply with the rewritten prompt only.";

const INSTRUCTIONS = `## Task
Rewrite the text inside <draft> into a clearer, more actionable prompt for an AI coding agent that is working in this session. Everything outside <draft> is reference material: use it, but never rewrite, summarize, quote back or answer it.

## Rules
1. Keep the author's intent, scope and voice. Do not add requirements they did not ask for; if you must assume something, say so in one short line.
2. Keep the draft's form: a question stays a question, a bug report stays a bug report, a one-line instruction stays short.
3. Resolve vague references ("this", "that bug", "same as before", "the file") from <conversation>, <working_set>, <session_summary> and <earlier_enhancements>.
4. Ground the prompt: name the exact files, symbols, commands, errors and earlier decisions that matter, taken from the reference sections. Never invent a path, name or fact that is not in the input.
5. Respect the author's standing instructions in <instructions> (their preferences and rules apply to the prompt you write).
6. If <earlier_enhancements> exist, build on them: keep what the author kept, and do not repeat work the conversation shows is already done.
7. End with a clear ask (what to do, or what to answer).
8. Be as short as the task allows. Use plain language and short sentences; use a list only when there are several distinct steps.
9. Reply with the rewritten prompt only: no preamble, no explanation, no surrounding quotes or code fence.`;

/** Tags whose opening or closing form must not appear inside untrusted text. */
export const TAGS = [
  "draft",
  "conversation",
  "working_set",
  "session_summary",
  "earlier_enhancements",
  "instructions",
  "workspace",
  "retrieved_context",
  "referenced_files",
  "attachments",
  "agent",
];

/** Puts a backslash before every `<tag`, `</tag` or `< /tag` of `tags` (case-insensitive). */
export function escapeTags(text: string, tags = TAGS): string {
  const re = new RegExp(`<\\s*/?\\s*(?:${tags.join("|")})(?![\\w.-])`, "gi");
  return text.replace(re, (m) => `\\${m}`);
}

export interface RequestInput {
  draft: string;
  agent: string | null;
  sessionName: string | null;
  sections: Section[];
  attachments: string | null;
}

export function buildRequest(r: RequestInput): string {
  const out: string[] = [INSTRUCTIONS, ""];
  const who = [r.agent ? `Agent: ${r.agent}` : null, r.sessionName ? `Session: ${r.sessionName}` : null].filter(Boolean);
  if (who.length) out.push(`<agent note="who the prompt is for">\n${escapeTags(who.join("\n"))}\n</agent>`, "");
  out.push(`<draft>\n${escapeTags(r.draft.trim())}\n</draft>`, "");
  if (r.attachments) out.push(`<attachments note="attached to the draft">\n${escapeTags(r.attachments)}\n</attachments>`, "");
  for (const s of r.sections) {
    if (!s.text.trim()) continue;
    out.push(`<${s.tag} note="${s.note.replace(/"/g, "'")}">\n${escapeTags(s.text)}\n</${s.tag}>`, "");
  }
  out.push("Reply with the rewritten prompt only.");
  return out.join("\n");
}

const PREAMBLE = /^(?:sure[,!.]?\s*)?(?:here(?:'s| is)\s+(?:the|a|your)\s+(?:rewritten|enhanced|improved|clearer)\s+(?:prompt|version)|(?:rewritten|enhanced|improved)\s+prompt)\s*[:.]?\s*$/i;

/** Model output → the prompt: preamble line, whole-output fence and wrapping quotes removed. */
export function cleanOutput(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n").trim();
  const lines = t.split("\n");
  if (lines.length > 1 && PREAMBLE.test(lines[0].trim())) t = lines.slice(1).join("\n").trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (t.length > 1 && /^(["“])[\s\S]*(["”])$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

/** Without a model: the draft plus the files and snippets that matched it, clearly labeled. */
export function heuristicPrompt(draft: string, retrieval: Section | null, workingSet: Section | null): string {
  const out = [draft.trim()];
  const files = retrieval?.text ? [...new Set([...retrieval.text.matchAll(/^#### (.+?):\d+-\d+$/gm)].map((m) => m[1]))].slice(0, 8) : [];
  if (files.length) out.push("", "Relevant files:", ...files.map((f) => `- \`${f}\``));
  if (workingSet?.text) out.push("", "Recent work in this session:", workingSet.text);
  return out.join("\n");
}
