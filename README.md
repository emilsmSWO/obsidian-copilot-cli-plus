# Copilot CLI Plus

An Obsidian plugin that embeds **GitHub Copilot CLI** as a fully interactive terminal, powered by a lightweight Rust ConPTY bridge.

> **Windows only** — requires Windows 10/11 (ConPTY support).

## Features

- **One-click Copilot** — Opens the Copilot CLI directly in any pane (sidebar, tab, split, bottom).
- **File context awareness** — Writes the active file path to a `.context` file that Copilot reads via instructions, so it always knows what you're working on.
- **Theme sync** — Terminal colors match your Obsidian theme (light/dark, custom themes) and update live.
- **Proper resize** — Real PTY via ConPTY bridge with correct terminal reflow.
- **Clickable links** — Left-click asks to open or copy the URL (never opens the browser on Cancel). Right-click a URL for Copy Hyperlink, Open Hyperlink, Open Hyperlink in Obsidian.
- **Right-click** — On the cursor row (the input line) it pastes the clipboard; elsewhere it opens a menu with Copy.
- **Configurable** — CLI flags, placement, working directory, auto-open toggle.
- **Tiny footprint** — The ConPTY bridge is ~170KB (no Node.js native modules needed).

## Commands

| Command | Description |
|---------|-------------|
| Open Copilot | Open in default placement |
| Open Copilot (right/left/bottom/tab/split) | Open in specific location |
| Toggle focus to/from Copilot | Switch between editor and Copilot |
| Restart Copilot session | Kill and restart the process |
| Add current file as context | Type `@file` into terminal |
| Add selection as context | Type `@file` + selection into terminal |

## Custom prompts

Define frequently used prompts in Settings > Copilot CLI Plus > Prompts. Each active prompt with a name and text becomes a command palette entry ("Copilot CLI Plus: Prompt: <name>"), so hotkeys and other plugins can bind it to a button.

1. Name, prompt text and three flags per prompt: Always new session, Send immediately (Enter), Active.
2. By default the text is pasted into the open Copilot window (opened first if needed). Always new session opens an additional Copilot tab (default placement) with a fresh session and leaves the existing one running.
3. Setting "CLI ready delay (ms)" (default 2500) is how long CLI output must stay quiet before the prompt is sent to a freshly started CLI; raise it for slow starts.
4. Edits are kept in a draft until you press Save changes; Revert changes restores the saved list.

## Prerequisites

1. **GitHub Copilot CLI** installed and authenticated (`copilot` in PATH).
2. **Windows 10/11** (ConPTY support required).

## Installation

Manual installation only.

1. Get the plugin files `main.js`, `manifest.json` and `styles.css`. Either download them from [Releases](https://github.com/emilsmSWO/obsidian-copilot-cli-plus/releases/latest), or build them from source (see Development), which writes `main.js` and `styles.css` to the repository root next to `manifest.json`.
2. Find your vault folder (the one containing a `.obsidian` folder), e.g. via "Open vault folder" in the vault switcher in Obsidian.
3. Create the plugin folder `<vault>/.obsidian/plugins/copilot-cli-plus/`. The folder name must be `copilot-cli-plus` (it must match `id` in `manifest.json`). Enable "Show hidden items" in Explorer if `.obsidian` is not visible.
4. Copy `main.js`, `manifest.json` and `styles.css` into that folder. Do not overwrite or delete an existing `data.json` there: it holds your settings and prompts.
5. Copy `conpty-bridge.exe` (~170KB) into the same folder. The plugin never downloads it and will not start the terminal without it. Get it in one of two ways: (a) download `conpty-bridge.exe` from the same release and place it next to `main.js` (the release zip `copilot-cli-plus.zip` contains all four files, so you can extract that instead of steps 1 and 4); (b) build it yourself with Rust: `cd conpty-bridge && cargo build --release`, then copy `conpty-bridge/target/release/conpty-bridge.exe`. The plugin does not verify the file, so only use a binary from a release you trust or one you built.
6. In Obsidian open Settings > Community plugins, turn off Restricted mode if needed, click Reload, and enable "Copilot CLI Plus".
7. After updating files later, reload the plugin (toggle it off and on) or restart Obsidian with Ctrl+R.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Default placement | Right sidebar | Where Copilot opens |
| Auto-open on vault load | On | Open Copilot when Obsidian starts |
| Copilot CLI flags | `--banner` | Flags passed to the CLI |
| Working directory | vault | CWD for the Copilot session |
| Auto-inject file context | On | Write active file to `.context` for Copilot |
| Sync font with Obsidian theme | Off | Use the theme's monospace font and text size in the terminal |
| Block left-click on links | Off | Left-click on a link does nothing; use the right-click menu |

To force a terminal font (with "Sync font" on), add a CSS snippet in Settings > Appearance > CSS snippets:

```css
body {
  --copilot-terminal-font-family: "Fira Code", monospace;
  --copilot-terminal-font-size: 15px;
}
```
Use a monospace family; proportional fonts break the terminal grid.

## Architecture

```
Obsidian (Electron renderer)
  CopilotView
  +-- xterm.js (terminal rendering)
  +-- .context file writer (active file tracking)
  +-- child_process.spawn(conpty-bridge.exe)
          |
          v  stdin/stdout pipes
  conpty-bridge.exe (170KB Rust binary)
  +-- Windows ConPTY (CreatePseudoConsole)
  +-- copilot CLI (or any shell command)
```

The ConPTY bridge creates a real pseudo-terminal using Windows native APIs. No Node.js native modules (like node-pty) are needed, eliminating ABI compatibility issues across Electron versions.

## Network Usage

The plugin itself makes no network requests: it does not download anything (including the ConPTY bridge, which you install manually) and has no telemetry. The IDE integration listens only on a local named pipe.

1. **GitHub Copilot CLI** — The Copilot CLI itself connects to GitHub's API to process your prompts. This is managed by the Copilot CLI, not the plugin.

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests (Node 22.18+)
npm test

# Build the ConPTY bridge (requires Rust)
cd conpty-bridge && cargo build --release

# Deploy to vault (see Installation)
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/copilot-cli-plus/
```

## Credits

The ConPTY bridge is based on code from [obsidian-ai-terminal](https://github.com/Deok-ho/obsidian-ai-terminal) by Deok-ho, licensed under MIT.

## License

MIT - Emil Smolinski. Contains elements of [obsidian-copilot-cli](https://github.com/sebastienlevert/obsidian-copilot-cli) by Sébastien Levert (MIT); see `LICENSE`.
