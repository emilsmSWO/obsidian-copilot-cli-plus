import { createHash } from "crypto";
import * as fs from "fs";

// Bump version and hash together, from a release asset you have verified.
export const BRIDGE_VERSION = "0.5.9";
export const BRIDGE_URL = `https://github.com/sebastienlevert/obsidian-copilot-cli/releases/download/${BRIDGE_VERSION}/conpty-bridge.exe`;
export const BRIDGE_SHA256 = "4bd7594729995006d06462da92387ce61fa37ceab4ca44809824a41acb339541";

export function isPinnedBridge(data: Uint8Array): boolean {
  return createHash("sha256").update(data).digest("hex") === BRIDGE_SHA256;
}

export function isTrustedBridgeFile(file: string): boolean {
  try {
    return isPinnedBridge(fs.readFileSync(file));
  } catch {
    return false;
  }
}
