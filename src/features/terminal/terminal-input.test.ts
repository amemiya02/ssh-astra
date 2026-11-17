import { describe, expect, it } from "vitest";
import { pasteLines } from "./terminal-input";

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
