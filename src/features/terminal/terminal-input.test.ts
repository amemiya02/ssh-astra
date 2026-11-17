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
  it("asks before pasting several lines while confirmation is on", () => {
    expect(planPaste("cd /tmp\nrm -rf *", true)).toEqual({ ask: { text: "cd /tmp\nrm -rf *", lines: 2 } });
  });

  it("pastes several lines straight away once confirmation is off", () => {
    expect(planPaste("cd /tmp\nrm -rf *", false)).toEqual({ paste: "cd /tmp\nrm -rf *" });
  });

  it("pastes a single line without asking, and nothing for empty text", () => {
    expect(planPaste("ls\n", true)).toEqual({ paste: "ls\n" });
    expect(planPaste("", true)).toBeNull();
  });
});
