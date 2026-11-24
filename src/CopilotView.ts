import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { VIEW_TYPE_COPILOT } from "./constants";
import { clampReadyDelay } from "./prompts";
import { URL_PATTERN, fontInstalled, cellAt, safeHttpUrl, terminalFont, urlAt } from "./terminalHelpers";
import { confirmLink } from "./LinkConfirmModal";
import type CopilotPlugin from "./main";
import { resolveCopilot } from "./resolveCopilot";

// xterm.js CSS (injected at runtime)
import xtermCss from "@xterm/xterm/css/xterm.css";

import { ChildProcess } from "child_process";

export class CopilotView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private childProc: ChildProcess | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private restartPending = false;
  private plugin: CopilotPlugin;
  private lastActiveFile: string | null = null;
  private inputBuffer: string = ""; // tracks current line input to detect commands like /clear
  private themeMutationObserver: MutationObserver | null = null;
  private documentKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private terminalWrapper: HTMLElement | null = null;
  // Auto-connect /ide once copilot startup settles (see maybeAutoConnectIde)
  private ideAutoConnectSent = false;
  private ideAutoConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ideAutoConnectMaxTimer: ReturnType<typeof setTimeout> | null = null;
  private userHasTyped = false;
  /** Set for tabs opened by a "new session" prompt; this tab never touches the machine session ID */
  private sessionOverride = "";
  /** True once startup output has settled, i.e. the CLI can take input */
  private ready = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPrompt: { text: string; enter: boolean } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CopilotPlugin) {
    super(leaf);
    this.plugin = plugin;
    const launch = plugin.pendingLaunch;
    if (launch) {
      plugin.pendingLaunch = null;
      this.sessionOverride = launch.sessionId;
      this.pendingPrompt = { text: launch.prompt.text, enter: launch.prompt.sendImmediately };
    }
  }

  getViewType(): string {
    return VIEW_TYPE_COPILOT;
  }

  getDisplayText(): string {
    return "Copilot";
  }

  getIcon(): string {
    return "copilot-icon";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("copilot-terminal-container");

    // Inject xterm CSS into the document
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = xtermCss;
    document.head.appendChild(this.styleEl);

    // Terminal wrapper fills the view
    const wrapper = container.createDiv({ cls: "copilot-terminal-wrapper" });
    this.terminalWrapper = wrapper;

    // Initialize xterm.js — theme reads from Obsidian CSS variables
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: this.getFont().size,
      fontFamily: this.getFont().family,
      theme: this.getObsidianTheme(),
      allowProposedApi: true,
      scrollback: 10000,
      // OSC 8 hyperlinks: xterm's default is confirm() + window.open, which opens the page even on Cancel
      linkHandler: { activate: (e, uri) => this.onLinkClick(e, uri) },
    });

    // Addons
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon((e, uri) => this.onLinkClick(e, uri), { urlRegex: URL_PATTERN }));

    // Canvas renderer is used (WebGL requires Workers which Obsidian doesn't support)

    this.terminal.open(wrapper);

    // --- Native keyboard & clipboard handling ---
    // Obsidian intercepts key events at the document level, so we must
    // stop propagation before they bubble up from the terminal.
    this.setupKeyboardInterception(wrapper);
    this.setupContextMenu(wrapper);
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyFont()));

    // Watch for Obsidian theme changes (light/dark toggle, theme switch)
    this.themeMutationObserver = new MutationObserver(() => {
      if (this.terminal) {
        this.terminal.options.theme = this.getObsidianTheme();
        this.applyFont();
      }
    });
    this.themeMutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // Delay fit to allow DOM layout to settle, then spawn
    requestAnimationFrame(() => {
      this.fitTerminal();
      this.spawnCopilot();
    });

    // Resize observer - refit terminal and notify PTY on container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(wrapper);

    // Cache active file for PTY environment
    this.cacheEditorContext();
  }

  /** Theme font and size when "Sync font" is on, otherwise the built-in default */
  private getFont(): { size: number; family: string } {
    // Resolve through real note elements so the theme's own CSS decides: text size from the note body, family from inline code
    const probe = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    probe.setCssStyles({ position: "absolute", visibility: "hidden" });
    const code = probe.createEl("code");
    const size = getComputedStyle(probe).fontSize;
    const family = getComputedStyle(code).fontFamily;
    probe.remove();
    const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name);
    const ctx = document.createElement("canvas").getContext("2d");
    const measure = (font: string) => {
      if (!ctx) return 0;
      ctx.font = `16px ${font}`;
      return ctx.measureText("mmmmmmmmmmlli").width;
    };
    return terminalFont(
      this.plugin.settings.syncObsidianFont,
      [css("--copilot-terminal-font-size"), size, css("--font-text-size")],
      [css("--copilot-terminal-font-family"), family, css("--font-monospace")],
      (name) => fontInstalled(name, measure)
    );
  }

  /** Apply the current font setting and refit; a no-op when nothing changed */
  applyFont(): void {
    const t = this.terminal;
    if (!t) return;
    const font = this.getFont();
    if (t.options.fontSize === font.size && t.options.fontFamily === font.family) return;
    t.options.fontSize = font.size;
    t.options.fontFamily = font.family;
    requestAnimationFrame(() => this.handleResize());
  }

  fontInfo(): string {
    const f = this.terminal?.options;
    return f ? `${f.fontSize}px, ${String(f.fontFamily).split(",").slice(0, 2).join(",")}` : "";
  }

  /** Left-click on a link: ask before opening, unless links are limited to the right-click menu */
  private onLinkClick(e: MouseEvent, uri: string): void {
    if (e.button !== 0 || this.plugin.settings.blockLinkClick) return;
    const safe = safeHttpUrl(uri);
    if (safe) confirmLink(this.app, uri, () => this.openLink(safe), () => this.copyText(uri));
  }

  private copyText(text: string): void {
    // Electron's clipboard has no focus requirement; navigator.clipboard fails right after a native menu closes
    try {
      (require("electron") as { clipboard: { writeText(text: string): void } }).clipboard.writeText(text);
    } catch {
      navigator.clipboard.writeText(text).catch(() => new Notice("Could not copy to the clipboard."));
    }
  }

  /** Open in the default browser; goes through the OS directly, so Obsidian's own navigate warning never fires */
  private openLink(url: string): void {
    const { shell } = require("electron") as { shell: { openExternal(url: string): Promise<void> } };
    shell.openExternal(url).catch(() => new Notice("Could not open the link."));
  }

  private openLinkInObsidian(url: string): void {
    const webviewer = (this.app as any).internalPlugins?.plugins?.webviewer;
    if (webviewer && !webviewer.enabled) {
      new Notice("Web viewer core plugin is off; opening in the browser.");
      this.openLink(url);
      return;
    }
    this.app.workspace
      .getLeaf("tab")
      .setViewState({ type: "webviewer", active: true, state: { url, navigate: true } })
      .catch(() => this.openLink(url));
  }

  /** URL under a terminal cell (viewport row/col), following lines the terminal wrapped */
  private urlAtCell(row: number, col: number): string | null {
    const buf = this.terminal?.buffer.active;
    if (!buf) return null;
    const clicked = buf.viewportY + row;
    let start = clicked;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = "";
    let offset = -1;
    for (let y = start; ; y++) {
      const line = buf.getLine(y);
      if (!line) break;
      for (let x = 0; x < line.length; x++) {
        if (y === clicked && x === col) offset = text.length;
        const cell = line.getCell(x);
        if (cell && cell.getWidth() !== 0) text += cell.getChars() || " ";
      }
      if (!buf.getLine(y + 1)?.isWrapped) break;
    }
    return offset < 0 ? null : urlAt(text, offset);
  }

  /**
   * Right-click: a link opens the link menu, the cursor row (the CLI's input line)
   * pastes the clipboard, anywhere else offers Copy. Handled in the capture phase
   * so neither xterm's native Cut/Copy/Paste menu nor the CLI's mouse reporting
   * ever sees the right button.
   */
  private setupContextMenu(wrapper: HTMLElement): void {
    const swallow = (e: MouseEvent) => {
      if (e.button !== 2) return;
      e.stopPropagation();
      if (e.type === "mousedown") e.preventDefault(); // keep the selection
    };
    wrapper.addEventListener(
      "mousedown",
      (e) => {
        this.contextMenu?.hide();
        if (e.button === 0) this.lastSelection = ""; // a new click starts a new selection
      },
      true
    );
    // xterm drops its selection whenever the CLI redraws mouse modes or receives input, so remember the last one
    this.terminal?.onSelectionChange(() => {
      const s = this.terminal?.getSelection();
      if (s) this.lastSelection = s;
    });
    this.setupLinkClick(wrapper);
    wrapper.addEventListener("mousedown", swallow, true);
    wrapper.addEventListener("mouseup", swallow, true);
    wrapper.addEventListener("auxclick", swallow, true);
    wrapper.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onRightClick(e);
      },
      true
    );
  }

  /**
   * Left-click on a link. xterm forwards mouse clicks to the CLI when it enables mouse reporting,
   * and the CLI opens links itself, so a click on a link must never reach xterm. Shift-click is left
   * for selecting text.
   */
  private setupLinkClick(wrapper: HTMLElement): void {
    let downAt = "";
    const linkAt = (e: MouseEvent): string | null => {
      const t = this.terminal;
      const screen = t?.element?.querySelector(".xterm-screen");
      if (!t || !screen || e.button !== 0 || e.shiftKey) return null;
      const { col, row } = cellAt(e.clientX, e.clientY, screen.getBoundingClientRect(), t.cols, t.rows);
      const hovered = screen.classList.contains("xterm-cursor-pointer");
      // OSC 8 links have no URL in the text, so xterm's own hover state supplies it
      const osc = hovered ? (t as any)._core?.linkifier?.currentLink?.link?.text : null;
      return this.urlAtCell(row, col) ?? osc ?? null;
    };
    for (const type of ["mousedown", "mouseup", "click"] as const) {
      wrapper.addEventListener(
        type,
        (e) => {
          const url = linkAt(e);
          if (!url) return;
          e.stopPropagation();
          if (type === "mousedown") downAt = `${e.clientX},${e.clientY}`;
          // a drag across a link is a selection, not a click
          else if (type === "mouseup" && downAt === `${e.clientX},${e.clientY}`) this.onLinkClick(e, url);
        },
        true
      );
    }
  }

  private contextMenu: Menu | null = null;
  private lastSelection = "";

  /** xterm's selection, or the page's when the DOM renderer keeps it there */
  private currentSelection(): string {
    return this.terminal?.getSelection() || window.getSelection()?.toString() || "";
  }

  private showMenu(e: MouseEvent, fill: (menu: Menu) => void): void {
    this.contextMenu?.hide();
    this.contextMenu = new Menu();
    fill(this.contextMenu);
    this.contextMenu.showAtMouseEvent(e);
  }

  private onRightClick(e: MouseEvent): void {
    this.contextMenu?.hide();
    const t = this.terminal;
    const screen = t?.element?.querySelector(".xterm-screen");
    if (!t || !screen) return;
    const { col, row } = cellAt(e.clientX, e.clientY, screen.getBoundingClientRect(), t.cols, t.rows);

    const link = this.urlAtCell(row, col);
    const safe = link && safeHttpUrl(link);
    if (link && safe) {
      this.showMenu(e, (m) =>
        m
          .addItem((i) => i.setTitle("Copy Hyperlink").setIcon("copy").onClick(() => this.copyText(link)))
          .addItem((i) => i.setTitle("Open Hyperlink").setIcon("external-link").onClick(() => this.openLink(safe)))
          .addItem((i) =>
            i.setTitle("Open Hyperlink in Obsidian").setIcon("globe").onClick(() => this.openLinkInObsidian(safe))
          )
      );
    } else if (row === t.buffer.active.cursorY) {
      void this.handlePaste();
      t.focus();
    } else {
      // Snapshot now: xterm may have cleared the selection by the time the menu item is clicked
      const selected = this.currentSelection() || this.lastSelection;
      this.showMenu(e, (m) =>
        m.addItem((i) =>
          i.setTitle("Copy").setIcon("copy").onClick(() => {
            if (!selected) {
              new Notice("Nothing selected in the terminal. If the CLI highlights text itself, hold Shift while selecting.");
              return;
            }
            this.copyText(selected);
            new Notice("Copied.");
          })
        )
      );
    }
  }

  /** Build xterm theme from Obsidian's CSS variables — adapts to any theme */
  private getObsidianTheme(): Record<string, string> {
    const style = getComputedStyle(document.body);
    const get = (v: string) => style.getPropertyValue(v).trim();
    const isDark = document.body.classList.contains("theme-dark");

    // Pull colors from Obsidian CSS vars where possible, fallback to sensible defaults
    const bg = get("--background-primary") || (isDark ? "#1e1e1e" : "#ffffff");
    const fg = get("--text-normal") || (isDark ? "#dcddde" : "#383a42");
    const muted = get("--text-muted") || (isDark ? "#999999" : "#6a6a6a");
    const accent = get("--interactive-accent") || (isDark ? "#7289da" : "#4078f2");
    const selBg = get("--text-selection") || (isDark ? "#264f78" : "#bfceff");

    return {
      background: bg,
      foreground: fg,
      cursor: accent,
      selectionBackground: selBg,
      black: isDark ? "#1e1e1e" : "#383a42",
      red: get("--color-red") || (isDark ? "#f44747" : "#e45649"),
      green: get("--color-green") || (isDark ? "#6a9955" : "#50a14f"),
      yellow: get("--color-yellow") || (isDark ? "#d7ba7d" : "#c18401"),
      blue: get("--color-blue") || (isDark ? "#569cd6" : "#4078f2"),
      magenta: get("--color-purple") || (isDark ? "#c586c0" : "#a626a4"),
      cyan: get("--color-cyan") || (isDark ? "#4ec9b0" : "#0184bc"),
      white: isDark ? "#d4d4d4" : "#fafafa",
      brightBlack: muted,
      brightRed: get("--color-red") || (isDark ? "#f44747" : "#e45649"),
      brightGreen: get("--color-green") || (isDark ? "#6a9955" : "#50a14f"),
      brightYellow: get("--color-yellow") || (isDark ? "#d7ba7d" : "#c18401"),
      brightBlue: get("--color-blue") || (isDark ? "#569cd6" : "#4078f2"),
      brightMagenta: get("--color-purple") || (isDark ? "#c586c0" : "#a626a4"),
      brightCyan: get("--color-cyan") || (isDark ? "#4ec9b0" : "#0184bc"),
      brightWhite: isDark ? "#ffffff" : "#ffffff",
    };
  }

  /**
   * Intercept keyboard and clipboard events so Obsidian doesn't steal them
   * from the terminal.
   *
   * Strategy:
   *  - attachCustomKeyEventHandler: tell xterm what to handle vs. ignore,
   *    and manually handle Ctrl+V paste / Ctrl+C copy.
   *  - Wrapper bubble-phase listener: call stopPropagation() AFTER xterm
   *    has processed the event so it never reaches Obsidian's hotkey system
   *    (which listens higher up the DOM).
   */
  private setupKeyboardInterception(wrapper: HTMLElement): void {
    if (!this.terminal) return;

    // Tell xterm which keys it should handle vs. pass through.
    // Return true  → xterm processes the key normally.
    // Return false → xterm ignores the key.
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Let Obsidian keep its devtools / reload shortcuts
      if (mod && e.shiftKey && e.key === "I") return false;
      if (mod && e.key === "r") return false;
      if (e.key === "F11") return false;
      if (e.key === "F12") return false;

      // Ctrl+V → paste from clipboard. Handles text and images.
      // Return false so xterm doesn't also send raw \x16.
      if (mod && e.key === "v" && e.type === "keydown") {
        e.preventDefault();
        this.handlePaste();
        return false;
      }

      // Ctrl+Enter → send newline for multi-line input in Copilot CLI.
      // xterm sends \r for all Enter variants, so we handle this manually.
      if (e.ctrlKey && e.key === "Enter" && e.type === "keydown") {
        this.childProc?.stdin?.write("\n");
        e.preventDefault();
        return false;
      }

      // Shift+Enter → also used for new lines in some CLI tools.
      if (e.shiftKey && e.key === "Enter" && e.type === "keydown") {
        this.childProc?.stdin?.write("\n");
        e.preventDefault();
        return false;
      }

      // Ctrl+C with a selection → copy to clipboard, don't send SIGINT
      if (mod && e.key === "c" && this.terminal?.hasSelection()) {
        navigator.clipboard.writeText(this.terminal.getSelection());
        this.terminal.clearSelection();
        e.preventDefault();
        return false;
      }

      // Everything else: let xterm handle it
      return true;
    });

    // Bubble-phase listener on the wrapper: after xterm has processed the
    // event, stop it from bubbling up to Obsidian's document-level handlers.
    this.documentKeyHandler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Let passthrough shortcuts bubble to Obsidian
      if (mod && e.shiftKey && e.key === "I") return;
      if (mod && e.key === "r") return;
      if (e.key === "F11" || e.key === "F12") return;

      e.stopPropagation();
    };

    wrapper.addEventListener("keydown", this.documentKeyHandler, false);
    wrapper.addEventListener("keyup", this.documentKeyHandler, false);
  }

  /**
   * Read the clipboard and paste into the terminal. Handles both text and
   * image content. Images are saved to the vault and the file path is pasted.
   */
  private async handlePaste(): Promise<void> {
    if (!this.terminal) return;

    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // Prefer text if available
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          const text = await blob.text();
          if (text) {
            this.terminal.paste(text);
            return;
          }
        }

        // Handle image types — save to vault and paste the path
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] === "jpeg" ? "jpg" : imageType.split("/")[1];
          const fileName = `paste-${Date.now()}.${ext}`;
          const folderPath = this.plugin.settings.imagePasteFolder || "copilot-images";

          // Ensure the folder exists
          if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            await this.app.vault.createFolder(folderPath);
          }

          const filePath = `${folderPath}/${fileName}`;
          const buffer = await blob.arrayBuffer();
          await this.app.vault.createBinary(filePath, buffer);

          this.terminal.paste(filePath);
          return;
        }
      }
    } catch {
      // Fallback to readText (e.g. if clipboard.read() is not supported)
      try {
        const text = await navigator.clipboard.readText();
        if (text) this.terminal.paste(text);
      } catch {
        // Clipboard access denied — nothing to paste
      }
    }
  }

  /** Cache the active file */
  private cacheEditorContext(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      this.lastActiveFile = file.path;
    }
  }

  /**
   * Fit the terminal to its container, reducing rows by 1 to prevent the
   * Copilot CLI TUI from rendering an extra separator line at the bottom.
   * The FitAddon can over-count rows due to subpixel rounding in embedded
   * contexts like Obsidian.
   */
  private fitTerminal(): void {
    if (!this.fitAddon || !this.terminal) return;
    const dims = this.fitAddon.proposeDimensions();
    if (dims) {
      this.terminal.resize(dims.cols, Math.max(1, dims.rows - 1));
    }
  }

  /** Refit the xterm canvas and send resize to the PTY relay */
  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitTerminal();
      if (this.childProc?.stdin?.writable) {
        // ConPTY bridge resize protocol: escape sequence parsed by the Rust binary
        this.childProc.stdin.write(`\x1b]resize;${this.terminal.cols};${this.terminal.rows}\x07`);
      }
    } catch {
      // Ignore transient resize errors during teardown
    }
  }

  /** Spawn the Copilot CLI via the ConPTY bridge (no node-pty needed) */
  private spawnCopilot(): void {
    if (!this.terminal) return;

    // Reset per-spawn auto-connect state
    // A fresh session has no resume gate, so the CLI auto-connects to the IDE itself
    this.ideAutoConnectSent = !!this.sessionOverride;
    this.userHasTyped = false;
    this.ready = false;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.ideAutoConnectTimer) { clearTimeout(this.ideAutoConnectTimer); this.ideAutoConnectTimer = null; }
    if (this.ideAutoConnectMaxTimer) { clearTimeout(this.ideAutoConnectMaxTimer); this.ideAutoConnectMaxTimer = null; }

    try {
      const { spawn } = require("child_process") as typeof import("child_process");
      const path = require("path") as typeof import("path");
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const pluginDir = path.join(vaultPath, this.plugin.manifest.dir);
      const bridgePath = path.join(pluginDir, "conpty-bridge.exe");

      const settings = this.plugin.settings;
      const cwd = settings.workingDirectory === "vault" ? vaultPath : settings.workingDirectory;
      // Use --session-id (not --resume) so a known UUID is *forced*: the CLI
      // resumes the session if it exists, or creates a new one with that exact
      // UUID if it doesn't. --resume errors out ("No session ... matched") when
      // the session file is missing — e.g. on a fresh machine or after the CLI's
      // local history was cleared — which left users unable to start the terminal.
      const sessionId = this.sessionOverride ||
        (settings.persistentSession ? this.plugin.getMachineSessionId() : "");
      const resumeFlag = sessionId ? ` --session-id=${sessionId}` : "";

      // Obsidian launched from the GUI often inherits a PATH that lacks the npm
      // global bin directory (common with nvm / fnm / non-standard Node installs),
      // so a bare `copilot` fails with "not recognized". Resolve the launcher's
      // absolute path and prepend the discovered Node / npm-global directories to
      // PATH so the launcher and the `node` it shells out to are both found.
      const resolved = resolveCopilot(settings.copilotPath);
      const copilotInvocation = resolved.resolved
        ? `& '${resolved.command.replace(/'/g, "''")}'`
        : "copilot";
      if (!resolved.resolved) {
        console.warn(
          "Copilot CLI: could not locate the copilot executable in known Node/npm locations; " +
            "falling back to PATH lookup. Set an explicit path in settings if launching fails."
        );
      }
      const cmd = `${copilotInvocation} ${settings.copilotFlags}${resumeFlag}`.trim();

      // Build the full shell command for ConPTY
      const shellCmd = `powershell.exe -NoLogo -NoProfile -Command ${cmd}`;

      // Prepend discovered Node directories to PATH (case-insensitive key on Win).
      const baseEnv = { ...(process.env as Record<string, string>) };
      const pathKey =
        Object.keys(baseEnv).find((k) => k.toLowerCase() === "path") || "PATH";
      const existingPath = baseEnv[pathKey] || "";
      const mergedPath = [...resolved.extraPathDirs, existingPath]
        .filter(Boolean)
        .join(path.delimiter);

      const fs = require("fs") as typeof import("fs");
      if (!fs.existsSync(bridgePath)) {
        this.terminal.write(
          `\x1b[31mConPTY bridge not found:\x1b[0m ${bridgePath}\r\n` +
            "\x1b[90mCopy conpty-bridge.exe into the plugin folder (see README, Installation).\x1b[0m\r\n"
        );
        return;
      }

      // Dim startup trace so a failed launch is never a silent blank pane.
      const resumeHint = resumeFlag
        ? " \x1b[90m(resuming your saved session — this can take several seconds)\x1b[0m"
        : "";
      this.terminal.write(`\x1b[90m$ ${cmd}\x1b[0m${resumeHint}\r\n`);

      this.childProc = spawn(bridgePath, [
        String(this.terminal.cols),
        String(this.terminal.rows),
        cwd,
        shellCmd,
      ], {
        cwd: cwd,
        env: {
          ...baseEnv,
          [pathKey]: mergedPath,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          PENSIEVE_ACTIVE_FILE: this.lastActiveFile || "",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // relay stdout -> xterm
      this.childProc.stdout?.on("data", (data: Buffer) => {
        this.terminal?.write(data.toString("utf-8"));
        this.scheduleReady();
        this.scheduleIdeAutoConnect();
      });

      // relay stderr -> xterm
      this.childProc.stderr?.on("data", (data: Buffer) => {
        this.terminal?.write(data.toString("utf-8"));
      });

      // xterm input -> PTY stdin (simple passthrough — context is via .context file)
      this.terminal.onData((data: string) => {
        if (this.restartPending) {
          this.restartPending = false;
          this.restart();
          return;
        }
        // Any real user input cancels pending auto-/ide so we never interrupt typing
        this.userHasTyped = true;
        // Track input to detect /clear command
        if (data === "\r" || data === "\n") {
          const cmd = this.inputBuffer.trim();
          if (cmd === "/clear") {
            this.onClearCommand();
          }
          this.inputBuffer = "";
        } else if (data === "\x7f" || data === "\b") {
          // Backspace
          this.inputBuffer = this.inputBuffer.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          this.inputBuffer += data;
        }
        this.childProc?.stdin?.write(data);
      });

      // Handle process exit
      this.childProc.on("exit", (code: number | null) => {
        this.terminal?.write(
          `\r\n\x1b[90m[Copilot exited (code ${code ?? 0}). Press any key to restart]\x1b[0m\r\n`
        );
        this.restartPending = true;
      });

      this.childProc.on("error", (err: Error) => {
        this.terminal?.write(`\x1b[31mProcess error: ${err.message}\x1b[0m\r\n`);
      });

      // Fallback: auto-connect /ide even if copilot output never fully settles.
      if (this.plugin.settings.enableIdeIntegration && this.plugin.settings.autoConnectIde) {
        this.ideAutoConnectMaxTimer = setTimeout(() => this.sendIdeAutoConnect(), 30000);
      }
    } catch (e: any) {
      this.terminal.write(
        `\x1b[31mFailed to start Copilot CLI: ${e.message}\x1b[0m\r\n\r\n`
      );
      this.terminal.write(
        "\x1b[90mTroubleshooting:\r\n" +
          "  1. Ensure GitHub Copilot CLI is installed (npm install -g @github/copilot)\r\n" +
          "  2. If Node is managed via nvm, set 'Copilot executable path' in settings\r\n" +
          "  3. Ensure conpty-bridge.exe exists in the plugin folder\r\n" +
          "  4. Restart Obsidian after making changes\x1b[0m\r\n"
      );
    }
  }

  /**
   * Auto-connect the CLI to Obsidian's IDE server by sending `/ide` once copilot
   * has started and its output has settled (startup/resume finished). The CLI's
   * native startup auto-connect is skipped when a session is resumed (via
   * `--session-id`/`--resume`), so we replicate the user's manual `/ide` — which
   * is not subject to that gate.
   * Debounced on output: fires only after ~2.5s of no output, and never if the
   * user has already started typing.
   */
  private scheduleIdeAutoConnect(): void {
    const s = this.plugin.settings;
    if (!s.enableIdeIntegration || !s.autoConnectIde) return;
    if (this.ideAutoConnectSent || this.userHasTyped) return;
    if (this.ideAutoConnectTimer) clearTimeout(this.ideAutoConnectTimer);
    this.ideAutoConnectTimer = setTimeout(() => this.sendIdeAutoConnect(), 2500);
  }

  /** Actually send the `/ide` command to the PTY (guarded, one-shot). */
  private sendIdeAutoConnect(): void {
    if (this.ideAutoConnectTimer) { clearTimeout(this.ideAutoConnectTimer); this.ideAutoConnectTimer = null; }
    if (this.ideAutoConnectMaxTimer) { clearTimeout(this.ideAutoConnectMaxTimer); this.ideAutoConnectMaxTimer = null; }
    const s = this.plugin.settings;
    if (!s.enableIdeIntegration || !s.autoConnectIde) return;
    if (this.ideAutoConnectSent || this.userHasTyped) return;
    if (!this.childProc?.stdin?.writable) return;
    this.ideAutoConnectSent = true;
    this.childProc.stdin.write("/ide\r");
  }

  /** Handle /clear command — generate a new session ID so we don't resume the old conversation */
  private async onClearCommand(): Promise<void> {
    if (this.plugin.settings.persistentSession && !this.sessionOverride) {
      const crypto = require("crypto") as typeof import("crypto");
      this.plugin.setMachineSessionId(crypto.randomUUID());
      await this.plugin.saveSettings();
      console.log(`Copilot CLI: /clear detected — new session ID: ${this.plugin.getMachineSessionId()}`);
    }
  }

  /** Send text to the PTY as a paste, so embedded newlines can't submit a prompt */
  sendInput(text: string): void {
    const t = this.terminal;
    if (!t) return;
    // Strip control chars (incl. ESC) so text can't close the paste markers early.
    const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    // Without bracketed paste, xterm turns \n into \r (Enter); flatten instead.
    t.paste(t.modes.bracketedPasteMode ? clean : clean.replace(/\r?\n/g, " "));
  }

  /** Debounce CLI output; when it goes quiet the startup is done and any queued prompt can be sent */
  private scheduleReady(): void {
    if (this.ready) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.ready = true;
      this.flushPrompt();
    }, clampReadyDelay(this.plugin.settings.promptReadyDelayMs));
  }

  private flushPrompt(): void {
    const p = this.pendingPrompt;
    if (!p || !this.ready) return;
    this.pendingPrompt = null;
    this.sendInput(p.text);
    // Enter goes through xterm so /clear detection and restart handling still apply
    if (p.enter) setTimeout(() => this.terminal?.input("\r", true), 150);
  }

  /** Paste a prompt into the CLI now, or as soon as the CLI has finished starting */
  submitPrompt(text: string, enter: boolean): void {
    this.pendingPrompt = { text, enter };
    if (this.restartPending) {
      this.restartPending = false;
      this.restart();
    }
    this.flushPrompt();
  }

  /** Focus the xterm terminal element */
  focusTerminal(): void {
    this.terminal?.focus();
  }

  /** Kill the current process and start a fresh Copilot session */
  restart(): void {
    this.killProcess();
    if (this.terminal) {
      this.terminal.clear();
      this.terminal.write("\x1b[2J\x1b[H");
    }
    this.spawnCopilot();
  }

  private killProcess(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.ideAutoConnectTimer) { clearTimeout(this.ideAutoConnectTimer); this.ideAutoConnectTimer = null; }
    if (this.ideAutoConnectMaxTimer) { clearTimeout(this.ideAutoConnectMaxTimer); this.ideAutoConnectMaxTimer = null; }
    if (this.childProc) {
      try {
        this.childProc.kill();
      } catch {
        // Already dead
      }
      this.childProc = null;
    }
  }

  async onClose(): Promise<void> {
    this.killProcess();
    this.resizeObserver?.disconnect();
    this.themeMutationObserver?.disconnect();
    if (this.documentKeyHandler && this.terminalWrapper) {
      this.terminalWrapper.removeEventListener("keydown", this.documentKeyHandler, false);
      this.terminalWrapper.removeEventListener("keyup", this.documentKeyHandler, false);
      this.documentKeyHandler = null;
    }
    this.terminalWrapper = null;
    this.terminal?.dispose();
    this.styleEl?.remove();
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.themeMutationObserver = null;
    this.styleEl = null;
  }
}

