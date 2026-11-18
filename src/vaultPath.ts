import * as fs from "fs";
import * as path from "path";

/**
 * Resolve `p` (absolute or vault-relative) to a real path inside the vault.
 * Symlinks are resolved, and `.obsidian` is refused because writing there
 * (plugins, hotkeys) would give code execution on the next reload.
 */
export function resolveInVault(vaultPath: string, p: string): string {
  const root = fs.realpathSync(vaultPath);
  const abs = path.resolve(vaultPath, p);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // New file: resolve its parent so a symlinked directory can't escape.
    real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  }
  const rel = path.relative(root, real);
  const outside = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  if (outside || rel.split(path.sep)[0] === ".obsidian") {
    throw new Error("Path is outside the vault or in .obsidian");
  }
  return real;
}
