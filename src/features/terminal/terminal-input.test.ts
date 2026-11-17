import { describe, expect, it } from "vitest";
import { isFindShortcut, pasteLines } from "./terminal-input";

describe("pasteLines", () => {
  it("counts a single line as one, even with a trailing line break", () => {
    expect(pasteLines("ls -la")).toBe(1);
    expect(pasteLines("ls -la\n")).toBe(1);
    expect(pasteLines("ls -la\r\n")).toBe(1);
  });

  it("counts every line of multi-line text, whatever the line endings", () => {
    expect(pasteLines("cd /tmp\nrm -rf *")).toBe(2);
    expect(pasteLines("a\r\nb\rc\n")).toBe(3);
  });

  it("counts empty text as nothing to paste", () => {
    expect(pasteLines("")).toBe(0);
  });
});

const key = (init: Partial<KeyboardEventInit> & { key: string }) => new KeyboardEvent("keydown", init);

describe("isFindShortcut", () => {
  it("is Cmd+F on macOS", () => {
    expect(isFindShortcut(key({ key: "f", metaKey: true }), true)).toBe(true);
    expect(isFindShortcut(key({ key: "f", ctrlKey: true }), true)).toBe(false);
  });

  it("is Ctrl+Shift+F elsewhere, leaving Ctrl+F to the shell", () => {
    expect(isFindShortcut(key({ key: "F", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isFindShortcut(key({ key: "f", ctrlKey: true }), false)).toBe(false);
  });

  it("ignores key releases", () => {
    expect(isFindShortcut(new KeyboardEvent("keyup", { key: "f", metaKey: true }), true)).toBe(false);
  });
});
