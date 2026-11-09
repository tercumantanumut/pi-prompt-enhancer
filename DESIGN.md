# Prompt Enhancer: design and validation record

Goal: Selene's composer "Enhance" button inside Pi, in both Orca surfaces (terminal/CLI and
chat/UI), with live per-session context, so enhancing three or four times in different places
always uses that session's latest state and remembers earlier enhancements of the session.

## Validated facts (2026-11-05/06, Pi 1.4.0, Orca 1.4.247)

Paths such as `crates/mcp-server/src/tools.rs` refer to the
[Selene Retrieval](https://github.com/tercumantanumut/selene-retrieval) repository. Since its 0.1.0 release
its search tool is `context_search`, and `enhance_prompt` is no longer offered to AI apps, so the enhancer's
old fallback through it was removed.

| # | Question | Finding | How it was checked |
|---|---|---|---|
| V1 | How does Orca's chat run Pi? | Pi's own RPC mode. | Orca bundle `structured-agent-session-host-assembly`: "Pi RPC session"; `extension_ui_request` records go to a dialog handler. |
| V2 | Which extension UI works in Orca chat? | Dialogs (`select`, `confirm`, `input`, `editor`; `editor` = editable multi-line box with the prefill). Dropped: `notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`. | Same bundle (ignore set and dialog presentation). |
| V3 | Does Orca pass `/enhance ...` to Pi unchanged? | Yes: `{type: "prompt", message, images}`; a handled command completes as "command only". | Same bundle (prompt builder, delivery). |
| V4 | Does an extension command over RPC get the text and round-trip a dialog? | Yes: disposition `handled`; editor request with prefill; edited value returned. | `tests/rpc-e2e.mjs` (submit and cancel). |
| V5 | Context available to a command | Branch entries, Pi's context files (`getSystemPromptOptions().contextFiles`), cwd, model, session name; `input` event carries images. | Spike in RPC mode. |
| V6 | Retrieval from an extension | Command handlers cannot call Pi tools (`executeTool` is tool-only); a plain MCP stdio client to `sr-bridge.exe --client other` works (init about 2 s, search about 3 s). | Spike client. |
| V7 | Model for the rewrite | Pi's default `claude-bridge` refuses nested calls with their own system prompt ("prompt-capture: no capture"). Claude Code CLI print mode, locked down as Selene Retrieval does it, works on the user's sign-in. | Model spike; CLI run. |
| V8 | Terminal (Pi TUI) | `alt+e` → loader → in-place replacement; `alt+shift+e` restores the draft; a second enhance reports and builds on the first. Orca's terminal uses the Kitty keyboard protocol, so Pi expects `ESC[101;3u` for Alt+E (legacy `ESC e` only without it). | Live run in a temporary Orca terminal (typed draft, never submitted). |
| V9 | Native Enhance button in Orca's chat composer? | Not possible today: Orca's plugin host API has no composer read/write and never hooks prompts a person submits. | `orca skills get orca-plugin-authoring --reference host-api`. |
| V10 | Selene Retrieval's own search limits (2026-11-06) | At most 150 hits (`MAX_RESULTS_CAP`, `crates/mcp-server/src/tools.rs`); every snippet cut at 4,000 characters plus "…" (`MAX_SNIPPET_CHARS`, `crates/engine/src/handle.rs`); a query over 8,192 bytes refused with "query is too long" (`tools.rs`); the embedder reads 512 tokens (`with_max_length`, `crates/providers/src/local.rs`). Indexed chunks are usually 0.7 to 2.4 KB (p99), but `selene-retrieval` holds 1 MiB chunks from its hostile test fixtures; they arrive cut to 4,000 characters. | Code; read-only catalog query; real 8,549-byte draft refused. |
| V11 | Is the hit count an SR app setting? | `ranking.default_max_results` in `settings.toml` (1 to 150, default 50) is what `search` (now `context_search`) uses when `maxResults` is omitted. It is read when the service starts, and the app's Settings page does not show it (`AdvancedView` has only the graphics-card and folder-request switches; the only settings RPCs are `settings.advanced` and `settings.answers`). | `crates/common/src/config/mod.rs`, `crates/core/src/query/mod.rs`, `crates/engine/src/lib.rs`, `ui/src/pages/Settings.tsx`. |
| V12 | Model context window | Claude Code reports `contextWindow` 1,000,000 and `maxOutputTokens` 128,000 for claude-sonnet-5-5. A real 50-hit request: 87,442 characters, 35,377 input tokens, 564 output tokens, 21.5 s. | `claude -p --output-format json` (`modelUsage`, `usage`). |
| V13 | Pasted text in the terminal (2026-11-06) | Pi's editor keeps a paste over 10 lines or 1,000 characters aside and shows `[paste #N +L lines]`; `getEditorText` and sending both put the text back. A component shown in the editor's place (`ctx.ui.custom` without `overlay`) makes Pi put the editor back with `setText(getText())` when it closes, and `setText` drops the kept pastes (`InteractiveMode.showExtensionCustom`, pi-tui `Editor.setText`; unchanged in Pi 1.5.0). The old in-place loader therefore left a label with no text: the result was thrown away as "the editor changed", a second Alt+E enhanced the bare label, and Enter sent it. Fix: the loader is an overlay (the editor is left alone; the overlay takes the keyboard and gives it back, pi-tui `showOverlay`). A label still in a draft is asked about before enhancing (`lostPastes`). | Lineage records of 3 failed runs in the user's sessions; reproduced live in an Orca terminal with the user's real 52-line paste and a stand-in `claude`, then the same steps after the fix; Pi 1.4.0 sources and the 1.5.0 package. |

Finding along the way: an RPC prompt sent before Pi has loaded its extensions is plain text and
starts an agent run. People type `/enhance` into a running session, so normal use is unaffected;
the RPC test driver waits for `get_commands` to list `/enhance` and aborts any unexpected run.

## Shape

- `index.ts`: registration and the UX per mode (TUI: shortcut, loader, in-place edit, undo;
  RPC/Orca chat: `/enhance` → editor dialog → submit sends the prompt as the user's message).
- `terminal.ts`: the loader as an overlay, so pastes keep their text (V13), and paste labels that
  lost their text.
- `enhance.ts`: one enhancement: sources → request → rewrite → fallback → summary.
- `session.ts`: conversation, working set, compaction summary, lineage (custom entries of type
  `prompt-enhancer`, never sent to the model).
- `instructions.ts`: AGENTS.md / CLAUDE.md (Pi's list, or Pi's discovery rule), bullet dedupe,
  proportional budget, agent name, `@path` files.
- `workspace.ts`: git and Orca probes with short timeouts.
- `retrieval.ts`: MCP client, folder scoping (cwd, git top level, a worktree's main checkout);
  the whole draft as the query and every hit kept whole (no limits of its own, V10 applies).
- `prompt.ts`: rewrite instructions, tag escaping, output cleanup, heuristic fallback.
- `engine.ts`: Claude Code CLI call.
- `config.ts`: `~/.pi/agent/prompt-enhancer.json`.

## Results

- Tests: 21 of 21 (`node --test "tests/*.test.ts"`), including the retrieval step end to end
  through the real MCP client and a spawned stand-in bridge (`tests/fake-bridge.mjs`), and the
  loader against Pi's paste rules (`tests/terminal.test.ts`, fails on the old in-place loader).
- Pasted text, live in an Orca terminal (user's 52-line paste, stand-in `claude`): before the fix,
  one Alt+E left `[paste #1 +52 lines]` without its text and Enter sent the 20-character label;
  after it, the enhancer gets all 52 lines and the result is applied, undo brings the full text
  back, Esc keeps the paste (Enter sends all 2,390 characters), `/enhance` + paste works, and a
  typed label asks first (cancel runs nothing; "Enhance anyway" runs).
- No limits on retrieval (2026-11-06), real run on this repo's thread: 50 hits, 54,364
  characters (the old cap was 10,000), hits 39 to 1,657 characters, none cut by Selene
  Retrieval; request 87,442 characters, 35,377 tokens, accepted by the model.
- Live pipeline on a real 578-entry session: 75 messages, 56 working-set items, 12 snippets,
  instructions budgeted; about 12 s on a loaded machine; the result resolved "the watcher" and
  "the docs" to exact files and applied the user's build-cadence rule.
- RPC end to end: submit sends the edited prompt; cancel sends nothing.
- TUI end to end in Orca: enhance, undo, and a second enhance that builds on the first.
