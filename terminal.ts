// The terminal (Pi TUI) side of an enhancement: the loader shown while it runs, and paste labels
// that have lost their text.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Ui = Pick<ExtensionContext["ui"], "custom">;
type Factory = Parameters<Ui["custom"]>[0];
type Component = ReturnType<Factory> extends infer C ? Awaited<C> : never;

/** What the loader must offer (Pi's `BorderedLoader` does). */
export type LoaderComponent = Component & { readonly signal: AbortSignal; onAbort?: () => void };
export type MakeLoader = (tui: Parameters<Factory>[0], theme: Parameters<Factory>[1], message: string) => LoaderComponent;

/**
 * Runs `work` while a cancellable loader is on screen. Resolves to null when the user cancels
 * (Esc); `work`'s error is rethrown once the loader is gone, and ignored after a cancel.
 *
 * The loader is an overlay. A component shown in the editor's place makes Pi put the editor back
 * with `setText(getText())` when it closes (`showExtensionCustom`, Pi 1.4.0 and 1.5.0), and
 * `setText` drops the pastes Pi keeps aside: `[paste #1 +52 lines]` would stay on screen with no
 * text behind it, and Enter would send just that label. An overlay leaves the editor untouched,
 * takes the keyboard while it shows (Esc reaches the loader, keys never reach the draft) and
 * gives it back to the editor when it closes.
 */
export async function withLoader<T>(ui: Ui, makeLoader: MakeLoader, message: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  let failed = false;
  let failure: unknown;
  let cancelled = false;
  const result = await ui.custom<T | null>((tui, theme, _kb, done) => {
    const loader = makeLoader(tui, theme, message);
    loader.onAbort = () => {
      cancelled = true;
      done(null);
    };
    work(loader.signal).then(done, (e) => {
      if (!cancelled) [failed, failure] = [true, e];
      done(null);
    });
    return loader;
  }, { overlay: true });
  if (failed) throw failure;
  return result;
}

/** The labels Pi's editor shows for collapsed pastes: `[paste #1 +52 lines]`, `[paste #2 1234 chars]`. */
const PASTE_LABEL = /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]/g;

/**
 * Paste labels still in a draft, each once. Pi puts the pasted text back in place of every label
 * whose text it still has, both when the draft is read (`getEditorText`) and when a message is
 * sent, so a label that is still there has lost its text (unless the user pasted text that
 * itself contains such a label).
 */
export function lostPastes(draft: string): string[] {
  return [...new Set(draft.match(PASTE_LABEL) ?? [])];
}
