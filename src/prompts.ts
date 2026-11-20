export interface PromptDef {
  id: string;
  name: string;
  text: string;
  /** Always open a separate Copilot tab with a fresh session */
  newSession: boolean;
  /** Press Enter after pasting the text */
  sendImmediately: boolean;
  isActive: boolean;
}

export type PromptConstants = Record<string, string>;

export const PROMPT_COMMAND_PREFIX = "prompt-";

export function newPrompt(id: string): PromptDef {
  return { id, name: "", text: "", newSession: false, sendImmediately: false, isActive: true };
}

/** Command id is derived from the stable prompt id, so renaming a prompt keeps hotkeys/buttons bound to it */
export function promptCommandId(p: PromptDef): string {
  return PROMPT_COMMAND_PREFIX + p.id;
}

/** Drop malformed entries and duplicate ids from data.json (it is user-editable and vault-synced) */
export function sanitizePrompts(raw: unknown): PromptDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PromptDef[] = [];
  for (const r of raw) {
    if (!r || typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === "string" ? r.name : "",
      text: typeof r.text === "string" ? r.text : "",
      newSession: r.newSession === true,
      sendImmediately: r.sendImmediately === true,
      isActive: r.isActive !== false,
    });
  }
  return out;
}

export function sanitizePromptConstants(raw: unknown): PromptConstants {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = Object.create(null) as PromptConstants;
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.trim();
    if (!name || name.includes("%") || name === "current-doc-path" || typeof value !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = value;
  }
  return out;
}

export function interpolatePrompt(text: string, constants: PromptConstants, currentDocPath?: string): string {
  return text.replace(/%([^%]+)%/g, (token, name: string) => {
    if (name === "current-doc-path") return currentDocPath || token;
    return Object.prototype.hasOwnProperty.call(constants, name) ? constants[name] : token;
  });
}

/** Prompts that get a command palette entry: active and with both name and text */
export function runnablePrompts(prompts: PromptDef[]): PromptDef[] {
  return prompts.filter((p) => p.isActive && p.name.trim() && p.text.trim());
}

/** Parse the ready-delay setting; falls back to the default for anything non-numeric, clamps to 500-60000 ms */
export function clampReadyDelay(v: unknown, fallback = 2500): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(60000, Math.max(500, Math.round(n))) : fallback;
}

export function promptsEqual(a: PromptDef[], b: PromptDef[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
