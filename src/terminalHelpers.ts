/** Same pattern as @xterm/addon-web-links, so left-click and right-click agree on what a link is */
export const URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

export const DEFAULT_TERMINAL_FONT = {
  size: 14,
  family: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
};

/** Only http(s) URLs may be handed to the OS; returns the normalized URL or null */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** The URL that covers character `offset` of `text`, if any */
export function urlAt(text: string, offset: number): string | null {
  const re = new RegExp(URL_PATTERN.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (offset >= m.index && offset < m.index + m[0].length) return m[0];
  }
  return null;
}

/** Terminal cell under a mouse position, clamped to the grid */
export function cellAt(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number
): { col: number; row: number } {
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
  return {
    col: clamp(Math.floor(((x - rect.left) / rect.width) * cols), cols),
    row: clamp(Math.floor(((y - rect.top) / rect.height) * rows), rows),
  };
}

/** Font for the terminal: the theme's monospace font and text size when syncing, otherwise the built-in default */
export function terminalFont(sync: boolean, cssSize: string, cssFamily: string): { size: number; family: string } {
  const size = parseFloat(cssSize);
  const family = cssFamily.trim();
  return sync
    ? { size: size > 0 ? size : DEFAULT_TERMINAL_FONT.size, family: family || DEFAULT_TERMINAL_FONT.family }
    : DEFAULT_TERMINAL_FONT;
}
