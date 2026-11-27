import { describe, expect, it } from "vitest";
import { pasteLines, planPaste } from "./terminal-input";

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

describe("planPaste", () => {
  it("marks invisible characters and still asks when multi-line confirmation is off", () => {
    const text = "echo\u202Ex\u200B\r\né😀\u001B\u{E0061}\r\u034F\u2028";

    expect(planPaste(text, false)).toEqual({
      ask: {
        text,
        lines: 3,
        invisibleCharacters: [
          { character: "\u202E", offset: 4, line: 1, column: 5 },
          { character: "\u200B", offset: 6, line: 1, column: 7 },
          { character: "\u001B", offset: 12, line: 2, column: 3 },
          { character: "\u{E0061}", offset: 13, line: 2, column: 4 },
          { character: "\u034F", offset: 16, line: 3, column: 1 },
          { character: "\u2028", offset: 17, line: 3, column: 2 },
        ],
      },
    });
  });

  it("asks before pasting several lines while confirmation is on", () => {
    expect(planPaste("cd /tmp\nrm -rf *", true)).toEqual({ ask: { text: "cd /tmp\nrm -rf *", lines: 2 } });
  });

  it("pastes several lines straight away once confirmation is off", () => {
    expect(planPaste("cd /tmp\nrm -rf *", false)).toEqual({ paste: "cd /tmp\nrm -rf *" });
  });

  it("pastes a single line without asking, and nothing for empty text", () => {
    expect(planPaste("ls\n", true)).toEqual({ paste: "ls\n" });
    expect(planPaste("echo\t'你好 👋 مرحبا'\r\n", true)).toEqual({ paste: "echo\t'你好 👋 مرحبا'\r\n" });
    expect(planPaste("", true)).toBeNull();
  });
});
