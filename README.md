# Prompt Enhancer for Pi

An **Enhance** button for the [Pi](https://github.com/earendil-works/pi) coding agent, modelled on the
composer button in [Selene](https://github.com/tercumantanumut/selene). It rewrites your draft into a
clearer, grounded prompt using this session's live context, in a terminal and in Orca's chat.

## Requirements

- [Pi](https://github.com/earendil-works/pi) 1.4 or later (built and tested on Windows with Pi 1.4.0).
- The Claude Code CLI (`claude`), signed in. Each enhancement is one call on your Claude sign-in.
- Optional: [Selene Retrieval](https://github.com/tercumantanumut/selene-retrieval) 0.1.0 or later
  ([download](https://github.com/tercumantanumut/selene-retrieval/releases)). It adds matching passages
  from your indexed folders. The enhancer finds it at its default install path, or through a
  `selene-retrieval` entry in Pi's `~/.pi/agent/mcp.json`. Earlier builds, whose search tool was
  called `search`, are not supported; the enhancer then runs without retrieval and says so.

## Install

Clone this repository into Pi's extensions folder; Pi loads its `index.ts` from there:

```sh
git clone https://github.com/tercumantanumut/pi-prompt-enhancer.git "$HOME/.pi/agent/extensions/prompt-enhancer"
```

New Pi sessions load it; in a session that is already open, run `/reload`.

## Use it

| Where | Do this | What happens |
|---|---|---|
| Terminal (Pi TUI, Orca CLI mode) | Type a draft, press **alt+e** | The draft is replaced in place. **alt+shift+e** brings it back. Esc cancels while it works. |
| Terminal | `/enhance <draft>` | Same, with the text you typed after the command. |
| Orca chat (UI mode) | `/enhance <draft>` | The result opens in an editable box. **Submit** sends it to the agent; **Cancel** sends nothing. |
| Anywhere | `/enhance undo`, `/enhance help` | Undo the last enhancement; show this help. |

Enhance as often as you like. Each enhancement uses the latest state of *that* session and
remembers the earlier enhancements in it, so a second enhance refines the first.

Pasted text counts. Pi shows a long paste as `[paste #1 +52 lines]`; the enhancer reads the whole
text behind it, and the paste stays attached to your draft while the enhancer works and after
Esc. If a label has lost its text, the enhancer asks before it runs (see Limits).

## What it reads

- Recent conversation of the current branch (newest kept first, size-budgeted).
- The working set: files the agent read or changed, commands it ran, errors it hit.
- The session summary when the session was compacted.
- Earlier enhancements in this session (draft, result, sent or not).
- Your AGENTS.md / CLAUDE.md, as Pi loaded them (repeated bullets removed).
- Git branch, changed files, recent commits; Orca workspace name, comment and linked issue.
- Files you reference with `@path` in the draft.
- Selene Retrieval matches: up to 50 hits (setting, at most 150) from the indexed folders that
  overlap this checkout (an Orca worktree uses its main checkout's folder), searched with your
  whole draft.

Every source is labeled. The conversation, working set, earlier enhancements, instructions and
`@path` files are size-budgeted, and anything left out is counted. Retrieval results are
included whole: the extension sets no character limit on them.

## How it works

1. Gather the sources above (git and Orca probes have short timeouts).
2. Search Selene Retrieval through its MCP bridge (`sr-bridge.exe`, from Pi's `mcp.json` or the
   default install path): one `context_search` call with the whole draft as the query, asking for
   `retrieval.maxResults` hits.
3. Rewrite with Claude Code in print mode, on your sign-in, locked down: no tools, no MCP,
   no settings or hooks, no slash commands, no transcript.
4. If Claude Code is unavailable: your draft plus the matching files (clearly labeled, no model).

Pi's default `claude-bridge` provider cannot serve this call (it only answers requests whose
system prompt matches the session's), which is why the rewrite runs through the CLI.

## Settings

Optional: `~/.pi/agent/prompt-enhancer.json`. Every field is optional; invalid values fall back to
the default and are reported once when a session starts. `retrieval.maxResults` takes 1 to 150
(Selene Retrieval's cap); a higher value is lowered to 150.

```json
{
  "model": "claude-sonnet-5-5",
  "claudePath": null,
  "shortcut": "alt+e",
  "undoShortcut": "alt+shift+e",
  "timeoutSeconds": 120,
  "retrieval": { "enabled": true, "maxResults": 50, "timeoutSeconds": 20, "command": null, "args": null },
  "budgets": {
    "conversationChars": 14000,
    "messageChars": 2500,
    "workingSetItems": 24,
    "earlierEnhancements": 3,
    "instructionsChars": 12000,
    "referencedFileChars": 6000
  }
}
```

## Limits

- In Orca chat the result comes back in a dialog, not in the composer: Orca's chat ignores
  Pi's "set editor text" request, and its plugin API has no composer access. Orca also shows
  no progress from extensions, so the dialog simply appears when the rewrite is ready.
- Attached images are described (count and type), not sent to the model.
- Pi (1.4.0 and 1.5.0) drops the text behind its paste labels when an extension's panel shown
  in place of the editor closes. This extension's loader is an overlay, so it leaves the editor
  alone; another extension's panel can still do it. A draft that shows a label with no text
  behind it would reach the enhancer and the agent as just that label, so the enhancer asks first:
  **Cancel and paste it again** or **Enhance anyway** (for text that really contains such a label).
- Selene Retrieval's own limits still apply to the search: at most 150 hits, snippets longer
  than 4,000 characters are cut (they end with "…"), and a query over 8,192 bytes is refused,
  so a draft that long gets no retrieval. Its vector search reads the first 512 tokens of the
  query; keyword search uses all of it.
- Request size: with 50 hits a real request was about 87,000 characters (35,000 tokens), and
  the retrieval part can reach about 200,000 characters (50 × 4,000). Claude Code gives
  claude-sonnet-5-5 a 1,000,000-token context window. If a request is ever too large or too
  slow, the error falls back to the no-model prompt.
- Each enhancement is one Claude call on your subscription, usually 10 to 25 seconds.

## Develop

- Tests: `node --test "tests/*.test.ts"` (Node 24, no install step).
- Live run over a real session file:
  `node tests/live.ts <session.jsonl> <cwd> "<draft>" [--no-model]`.
- Design notes and the checks behind them: [DESIGN.md](DESIGN.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
