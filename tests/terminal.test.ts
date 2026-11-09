import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lostPastes, withLoader, type MakeLoader } from "../terminal.ts";

/**
 * Pi's editor and `ui.custom` as far as pastes go (Pi 1.4.0 and 1.5.0):
 * - a paste over 10 lines or 1,000 characters is kept aside and shown as `[paste #N +L lines]`
 *   or `[paste #N C chars]` (pi-tui `Editor.handlePaste`);
 * - `getEditorText` returns the text with every kept paste back in place (`getExpandedText`);
 * - `setEditorText` replaces the text and drops the kept pastes (`Editor.setText`);
 * - `custom` without `overlay` saves `getText()` (labels, not the pasted text) and puts it back
 *   with `setText` when the component closes; with `overlay` it only hides the overlay
 *   (`InteractiveMode.showExtensionCustom`).
 */
function fakeUi() {
  let text = "";
  const pastes = new Map<number, string>();
  const expand = (t: string) => {
    let out = t;
    for (const [id, content] of pastes) out = out.replace(new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g"), () => content);
    return out;
  };
  const ui = {
    shown: [] as { overlay: boolean; component: any }[],
    type(s: string) {
      text += s;
    },
    paste(content: string) {
      const lines = content.split("\n").length;
      if (lines <= 10 && content.length <= 1000) return void (text += content);
      const id = pastes.size + 1;
      pastes.set(id, content);
      text += lines > 10 ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${content.length} chars]`;
    },
    getEditorText: () => expand(text),
    setEditorText(t: string) {
      pastes.clear();
      text = t;
    },
    custom<T>(factory: any, options?: { overlay?: boolean }): Promise<T> {
      const saved = text;
      return new Promise<T>((resolve) => {
        let closed = false;
        const done = (r: T) => {
          if (closed) return;
          closed = true;
          if (!options?.overlay) ui.setEditorText(saved);
          resolve(r);
        };
        ui.shown.push({ overlay: !!options?.overlay, component: factory({}, {}, {}, done) });
      });
    },
  };
  return ui;
}

/** Pi's `BorderedLoader` as `withLoader` uses it: Esc aborts its signal and calls `onAbort`. */
const fakeLoader: MakeLoader = (_tui, _theme, message) => {
  const ac = new AbortController();
  const loader: any = {
    signal: ac.signal,
    render: () => [message],
    invalidate() {},
    handleInput(data: string) {
      if (data !== "\x1b") return;
      ac.abort();
      loader.onAbort?.();
    },
  };
  return loader;
};

const REVIEW = Array.from({ length: 52 }, (_, i) => `review line ${i + 1}`).join("\n");

test("loader: a collapsed paste keeps its text while the loader is up", async () => {
  const ui = fakeUi();
  ui.type("Check this review: ");
  ui.paste(REVIEW);
  const draft = ui.getEditorText();
  assert.ok(draft.endsWith("review line 52"));
  const r = await withLoader(ui, fakeLoader, "Enhancing", async () => "rewritten");
  assert.equal(r, "rewritten");
  assert.equal(ui.getEditorText(), draft, "the editor kept [paste #1 +52 lines] but lost the text behind it");
  assert.equal(ui.shown.length, 1);
});

test("loader: Esc cancels, and the work failing afterwards is not reported", async () => {
  const ui = fakeUi();
  ui.type("fix it");
  const p = withLoader(ui, fakeLoader, "Enhancing", (signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  ui.shown[0].component.handleInput("\x1b");
  assert.equal(await p, null);
  assert.equal(ui.getEditorText(), "fix it");
});

test("loader: the work's error is rethrown once the loader is gone", async () => {
  const ui = fakeUi();
  ui.type("fix it");
  await assert.rejects(
    withLoader(ui, fakeLoader, "Enhancing", async () => {
      throw new Error("Claude Code: overloaded");
    }),
    /overloaded/,
  );
  assert.equal(ui.getEditorText(), "fix it");
});

test("lostPastes: paste labels left in a draft, each once, in order", () => {
  assert.deepEqual(lostPastes("[paste #1 +52 lines]"), ["[paste #1 +52 lines]"]);
  assert.deepEqual(lostPastes("see [paste #2 1234 chars], then [paste #1 +52 lines] and [paste #2 1234 chars] again"), [
    "[paste #2 1234 chars]",
    "[paste #1 +52 lines]",
  ]);
  assert.deepEqual(lostPastes("brackets [paste], [paste #x +1 lines], [paste #3] and [paste #4 +lines] are not labels"), []);
  assert.deepEqual(lostPastes(`Check this review: ${REVIEW}`), []);
});
