*Vibe coded.*

# Codex Chat Exporter

Export Codex chat threads to Markdown files.

## Requirements

- Node.js on PATH
- `codex` CLI on PATH (used via `codex app-server`)
- Windows is required for the GUI folder picker; the CLI works cross-platform

No install step. The project uses only Node.js built-ins — no package manager or `npm install` needed.

## GUI

Run from the project root:

```
node gui/server.js
```

Then open `http://127.0.0.1:8787` in a browser.

On first run, you will be prompted to choose a default export directory via a native folder picker. That choice is saved to `.ai/gui-settings.json` and reused on subsequent runs.

From the GUI you can:

- Select a thread from the list of recent Codex threads
- Or enter a thread ID manually
- Toggle "Include tool calls" to include plans, commands, and file changes
- Click Export to write the Markdown file

## CLI

```
node script/export-codex-thread.js <THREAD_ID> [OUT.md] [--with-tools]
```

Examples:

```
node script/export-codex-thread.js thread-123
node script/export-codex-thread.js thread-123 exported-chats/my-thread.md
node script/export-codex-thread.js thread-123 exported-chats/my-thread.md --with-tools
```

If no output path is given, the file is written to the current directory with a name derived from the thread.

## Output

Each export produces a single `.md` file containing the full thread: user messages and Codex responses in order.

With `--with-tools` (or the GUI toggle enabled), the output also includes tool call detail: plans, reasoning steps, shell commands, and file edits.

## Tests

```
node --test
```

Test files: `gui/server.test.js`, `script/export-core.test.js`, `script/export-codex-thread.test.js`.