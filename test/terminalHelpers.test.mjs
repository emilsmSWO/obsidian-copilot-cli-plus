import test from "node:test";
import assert from "node:assert/strict";
import { cellAt, safeHttpUrl, terminalFont, urlAt, DEFAULT_TERMINAL_FONT } from "../src/terminalHelpers.ts";

test("urlAt returns the URL covering the offset, without trailing punctuation", () => {
  const text = "see https://example.com/a?b=1, or http://x.io.";
  assert.equal(urlAt(text, 10), "https://example.com/a?b=1");
  assert.equal(urlAt(text, 41), "http://x.io");
  assert.equal(urlAt(text, 1), null);
  assert.equal(urlAt(text, 29), null);
});

test("safeHttpUrl allows only http(s)", () => {
  assert.equal(safeHttpUrl("https://example.com"), "https://example.com/");
  assert.equal(safeHttpUrl("file:///C:/Windows/calc.exe"), null);
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("not a url"), null);
});

test("cellAt maps pixels to cells and clamps to the grid", () => {
  const rect = { left: 10, top: 20, width: 800, height: 480 };
  assert.deepEqual(cellAt(10, 20, rect, 80, 24), { col: 0, row: 0 });
  assert.deepEqual(cellAt(55, 65, rect, 80, 24), { col: 4, row: 2 });
  assert.deepEqual(cellAt(5000, 5000, rect, 80, 24), { col: 79, row: 23 });
  assert.deepEqual(cellAt(0, 0, rect, 80, 24), { col: 0, row: 0 });
});

test("terminalFont uses the theme only when syncing, skipping empty candidates", () => {
  assert.deepEqual(terminalFont(false, ["20px"], ["Fira"]), DEFAULT_TERMINAL_FONT);
  assert.deepEqual(terminalFont(true, ["", "16px"], ['"", Fira Code, monospace', "Consolas"]), {
    size: 16,
    family: `Fira Code, monospace, ${DEFAULT_TERMINAL_FONT.family}`,
  });
  assert.deepEqual(terminalFont(true, ["", "0px"], ['""', ""]), DEFAULT_TERMINAL_FONT);
});
