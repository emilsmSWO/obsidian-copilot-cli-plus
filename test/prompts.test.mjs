import test from "node:test";
import assert from "node:assert/strict";
import {
  clampReadyDelay,
  interpolatePrompt,
  newPrompt,
  promptCommandId,
  promptsEqual,
  runnablePrompts,
  sanitizePromptConstants,
  sanitizePrompts,
} from "../src/prompts.ts";

test("sanitizePrompts drops malformed entries and duplicate ids, fills defaults", () => {
  const out = sanitizePrompts([
    { id: "a", name: "A", text: "x", newSession: true },
    { id: "a", name: "dup", text: "y" },
    { name: "no id" },
    null,
    { id: "b", name: 5, text: "z", isActive: false },
  ]);
  assert.deepEqual(out.map((p) => p.id), ["a", "b"]);
  assert.equal(out[0].newSession, true);
  assert.equal(out[0].sendImmediately, false);
  assert.equal(out[0].isActive, true);
  assert.equal(out[1].name, "");
  assert.equal(out[1].isActive, false);
  assert.deepEqual(sanitizePrompts(undefined), []);
});

test("sanitizePromptConstants keeps valid names and string values", () => {
  const constants = sanitizePromptConstants({
    " project ": "vault",
    project: "duplicate",
    "bad%name": "ignored",
    "current-doc-path": "ignored",
    invalid: 42,
  });
  assert.deepEqual({ ...constants }, { project: "vault" });
  assert.deepEqual({ ...sanitizePromptConstants(undefined) }, {});
});

test("interpolatePrompt replaces constants and active markdown path, preserving unknown tokens", () => {
  const constants = sanitizePromptConstants({ project: "$&", nested: "%project%" });
  assert.equal(
    interpolatePrompt("%project% %current-doc-path% %unknown% %nested%", constants, "folder/note.md"),
    "$& folder/note.md %unknown% %project%"
  );
  assert.equal(
    interpolatePrompt("%current-doc-path%", constants),
    "%current-doc-path%"
  );
});

test("runnablePrompts keeps only active prompts with name and text", () => {
  const mk = (id, name, text, isActive = true) => ({ ...newPrompt(id), name, text, isActive });
  const out = runnablePrompts([mk("1", "ok", "t"), mk("2", " ", "t"), mk("3", "n", ""), mk("4", "n", "t", false)]);
  assert.deepEqual(out.map((p) => p.id), ["1"]);
});

test("command id is stable across renames; promptsEqual detects edits", () => {
  const p = { ...newPrompt("abc"), name: "one" };
  const renamed = { ...p, name: "two" };
  assert.equal(promptCommandId(p), promptCommandId(renamed));
  assert.equal(promptsEqual([p], [{ ...p }]), true);
  assert.equal(promptsEqual([p], [renamed]), false);
});

test("clampReadyDelay clamps and falls back on junk", () => {
  assert.equal(clampReadyDelay("4000"), 4000);
  assert.equal(clampReadyDelay(10), 500);
  assert.equal(clampReadyDelay(1e9), 60000);
  assert.equal(clampReadyDelay("abc"), 2500);
  assert.equal(clampReadyDelay(undefined), 2500);
});
