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

/** True for generic CSS families and for names whose text measures differently from the generic fallbacks */
export function fontInstalled(name: string, measure: (font: string) => number): boolean {
  if (/^(monospace|serif|sans-serif|cursive|fantasy|system-ui|ui-[\w-]+)$/i.test(name)) return true;
  return measure(`${name}, monospace`) !== measure("monospace") || measure(`${name}, serif`) !== measure("serif");
}

/**
 * Font for the terminal. When syncing, takes the first usable size and family from the
 * candidates (themes may leave a variable empty or as ""), keeping the built-in family as a fallback.
 */
export function terminalFont(
  sync: boolean,
  sizes: string[],
  families: string[],
  usable: (name: string) => boolean = () => true
): { size: number; family: string } {
  if (!sync) return DEFAULT_TERMINAL_FONT;
  const size = sizes.map(parseFloat).find((n) => n > 0) ?? DEFAULT_TERMINAL_FONT.size;
  const theme = families
    .map((f) => f.split(",").map((n) => n.trim()).filter((n) => n && n !== '""' && n !== "''" && usable(n)).join(", "))
    .find(Boolean);
  return { size, family: theme ? `${theme}, ${DEFAULT_TERMINAL_FONT.family}` : DEFAULT_TERMINAL_FONT.family };
}
