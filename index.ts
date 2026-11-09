// Prompt Enhancer: Selene's composer "Enhance" button for Pi, in a terminal (Pi's editor) and in
// Orca's chat (Pi RPC). Each enhancement uses this session's live context and remembers the
// earlier enhancements of the session. Settings: ~/.pi/agent/prompt-enhancer.json.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { Cancelled, enhance, type EnhanceResult } from "./enhance.ts";
import type { ContextFile } from "./instructions.ts";
import { LINEAGE_TYPE, type LineageRecord } from "./session.ts";
import { lostPastes, withLoader } from "./terminal.ts";

const MIN_CHARS = 3;
const ENHANCE_ANYWAY = "Enhance anyway";

type Key = Parameters<ExtensionAPI["registerShortcut"]>[0];

export default function promptEnhancer(pi: ExtensionAPI) {
  const { config: cfg, warnings } = loadConfig();
  let contextFiles: ContextFile[] | null = null;
  let pendingImages: { mimeType: string }[] = [];
  let last: { draft: string; enhanced: string } | null = null;
  let busy = false;

  const help = [
    `${cfg.shortcut}: enhance the draft in the editor (terminal).`,
    "/enhance <draft>: enhance that text (terminal and Orca chat; in chat the result opens for editing, submit sends it).",
    `/enhance undo (or ${cfg.undoShortcut}): bring back the draft from before the last enhancement.`,
    "Context used: this session's recent conversation, the files and commands the agent touched, earlier enhancements,",
    "your AGENTS.md/CLAUDE.md, git and Orca workspace state, @file references, and Selene Retrieval matches.",
    "Settings: ~/.pi/agent/prompt-enhancer.json.",
  ].join("\n");

  pi.on("session_start", async (_event, ctx) => {
    const records = ctx.sessionManager
      .getBranch()
      .filter((e: any) => e?.type === "custom" && e.customType === LINEAGE_TYPE && typeof e.data?.draft === "string");
    const rec = records.length ? (records[records.length - 1] as any).data : null;
    last = rec ? { draft: rec.draft, enhanced: rec.enhanced } : null;
    if (warnings.length && ctx.hasUI) ctx.ui.notify(`Prompt Enhancer settings: ${warnings.join("; ")}`, "warning");
  });

  // Pi's own context files, refreshed by every run (a shortcut has no other way to read them).
  pi.on("before_agent_start", async (event) => {
    const files = event.systemPromptOptions?.contextFiles;
    if (Array.isArray(files)) contextFiles = files.map((f) => ({ path: f.path, content: f.content }));
  });

  // Images attached to an `/enhance` message (commands themselves receive text only).
  pi.on("input", async (event) => {
    if (/^\/enhance(?:\s|$)/.test(event.text.trimStart())) pendingImages = (event.images ?? []).map((i) => ({ mimeType: i.mimeType }));
    return { action: "continue" };
  });

  function record(draft: string, r: EnhanceResult, sent: boolean | null) {
    const rec: LineageRecord = { draft, enhanced: r.prompt, sent, engine: r.engine, at: Date.now() };
    pi.appendEntry(LINEAGE_TYPE, rec);
    last = { draft, enhanced: r.prompt };
  }

  async function run(ctx: ExtensionContext, draft: string, files: ContextFile[] | null): Promise<EnhanceResult | null> {
    const images = pendingImages;
    pendingImages = [];
    const req = {
      draft,
      cwd: ctx.cwd,
      entries: ctx.sessionManager.getBranch() as Record<string, any>[],
      contextFiles: files ?? contextFiles,
      sessionName: pi.getSessionName() ?? null,
      images,
      cfg,
    };
    if (ctx.mode !== "tui") return enhance(req); // Orca chat drops progress UI; the dialog follows
    return withLoader(
      ctx.ui,
      (tui, theme, message) => new BorderedLoader(tui, theme, message),
      `Enhancing with this session's context (${cfg.model}). Esc cancels.`,
      (signal) =>
        enhance({ ...req, signal }).catch((e) => {
          if (e instanceof Cancelled) return null;
          throw e;
        }),
    );
  }

  /** Tells the user something in whichever surface is showing (Orca chat only renders dialogs). */
  async function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.mode === "tui") ctx.ui.notify(message, level);
    else if (ctx.hasUI) await ctx.ui.select(message, ["OK"]);
  }

  async function guarded(ctx: ExtensionContext, fn: () => Promise<void>) {
    if (busy) return tell(ctx, "An enhancement is already running.", "warning");
    busy = true;
    try {
      await fn();
    } catch (e) {
      await tell(ctx, `Prompt enhancement failed: ${(e as Error).message}. Your draft is unchanged.`, "error");
    } finally {
      busy = false;
    }
  }

  /**
   * A paste label still in the draft has lost its text (`lostPastes`), so the model, and the agent
   * after it, would get only the label. Asks first; the first option cancels.
   */
  async function pastesIntact(ctx: ExtensionContext, draft: string): Promise<boolean> {
    const lost = lostPastes(draft);
    if (!lost.length) return true;
    const labels = lost.length === 1 ? lost[0] : `${lost.slice(0, -1).join(", ")} and ${lost[lost.length - 1]}`;
    const choice = await ctx.ui.select(
      `Pi no longer has the text behind ${labels}, so the enhancer and the agent would get only ${lost.length === 1 ? "that label" : "those labels"}.`,
      ["Cancel and paste it again", ENHANCE_ANYWAY],
    );
    return choice === ENHANCE_ANYWAY;
  }

  /** Terminal: replace the editor text in place (Selene's button). */
  async function enhanceInEditor(ctx: ExtensionContext, draft: string, fromEditor: boolean, files: ContextFile[] | null) {
    if (!(await pastesIntact(ctx, draft))) return;
    const r = await run(ctx, draft, files);
    if (!r) return ctx.ui.notify("Enhancement cancelled; your draft is unchanged.", "info");
    if (fromEditor && ctx.ui.getEditorText().trim() !== draft) {
      record(draft, r, false);
      return ctx.ui.notify("The editor changed while enhancing, so your text was kept. Enhance again to use the new text.", "warning");
    }
    ctx.ui.setEditorText(r.prompt);
    record(draft, r, null);
    ctx.ui.notify(`Enhanced (${r.summary}). ${cfg.undoShortcut} or /enhance undo brings back your draft.`, "info");
  }

  /** Orca chat: show the result for editing; submitting sends it to the agent. */
  async function enhanceInDialog(ctx: ExtensionContext, draft: string, files: ContextFile[] | null) {
    const r = await run(ctx, draft, files);
    if (!r) return;
    const edited = await ctx.ui.editor(
      `Enhanced prompt (${r.summary}). Edit it if needed, then submit to send it to the agent. Cancel sends nothing.`,
      r.prompt,
    );
    const text = typeof edited === "string" ? edited.trim() : "";
    const send = text.length >= MIN_CHARS;
    record(draft, r, send);
    if (send) pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  async function undo(ctx: ExtensionContext) {
    if (!last) return tell(ctx, "There is no enhancement to undo in this session.");
    if (ctx.mode === "tui") {
      ctx.ui.setEditorText(last.draft);
      return ctx.ui.notify("Your draft from before the last enhancement is back in the editor.", "info");
    }
    const edited = await ctx.ui.editor("Your draft from before the last enhancement. Submit to send it, cancel to keep nothing.", last.draft);
    const text = typeof edited === "string" ? edited.trim() : "";
    if (text.length >= MIN_CHARS) pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  pi.registerCommand("enhance", {
    description: `Enhance a draft prompt with this session's context (${cfg.shortcut} enhances the editor text)`,
    getArgumentCompletions: (prefix: string) =>
      ["undo", "help"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const a = args.trim();
      if (a === "help") return tell(ctx, help);
      if (a === "undo") return undo(ctx);
      await guarded(ctx, async () => {
        let draft = a;
        if (draft.length < MIN_CHARS) {
          const typed = await ctx.ui.editor("Type or paste the draft to enhance, then submit.", "");
          draft = typeof typed === "string" ? typed.trim() : "";
          if (draft.length < MIN_CHARS) return;
        }
        const files = ctx.getSystemPromptOptions().contextFiles ?? null;
        if (ctx.mode === "tui") await enhanceInEditor(ctx, draft, false, files);
        else await enhanceInDialog(ctx, draft, files);
      });
    },
  });

  pi.registerShortcut(cfg.shortcut as Key, {
    description: "Enhance the prompt in the editor with this session's context",
    handler: async (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") return;
      const draft = ctx.ui.getEditorText().trim();
      if (draft.length < MIN_CHARS) {
        return ctx.ui.notify(`Type a draft of at least ${MIN_CHARS} characters, then press ${cfg.shortcut}.`, "info");
      }
      await guarded(ctx, () => enhanceInEditor(ctx, draft, true, null));
    },
  });

  pi.registerShortcut(cfg.undoShortcut as Key, {
    description: "Bring back the draft from before the last prompt enhancement",
    handler: async (ctx: ExtensionContext) => {
      if (ctx.mode === "tui") await undo(ctx);
    },
  });
}
