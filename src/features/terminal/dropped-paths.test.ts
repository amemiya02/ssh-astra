import { expect, it } from "vitest";
import { quoteDroppedPaths } from "./dropped-paths";

it.each([
  ["bash", ["/tmp/a b", "/tmp/it's $HOME; &"], "'/tmp/a b' '/tmp/it'\\''s $HOME; &'"],
  ["zsh", ["/tmp/it's (a test)"], "'/tmp/it'\\''s (a test)'"],
  ["fish", ["/tmp/it's \\ literal"], "'/tmp/it\\'s \\\\ literal'"],
  ["tcsh", ["/tmp/it's !important"], "'/tmp/it'\\''s \\!important'"],
  ["bash.exe", [String.raw`C:\some folder\it's.txt`], "'/c/some folder/it'\\''s.txt'"],
  ["pwsh.exe", [String.raw`C:\some folder\it’s $HOME.txt`], String.raw`'C:\some folder\it’’s $HOME.txt'`],
  ["cmd.exe", [String.raw`C:\some folder\a & b.txt`], String.raw`"C:\some folder\a & b.txt"`],
])("quotes file paths as literal %s arguments", (shell, paths, expected) => {
  expect(quoteDroppedPaths(shell, paths)).toBe(expected);
});

it.each([
  ["bash", "/tmp/valid\nnewline"],
  ["bash", "/tmp/escape\u001b"],
  ["cmd.exe", "C:\\%USERPROFILE%\\a.txt"],
  ["cmd.exe", "C:\\!variable!\\a.txt"],
  ["unrecognized", "/tmp/a b"],
])("withholds a drop %s cannot paste literally", (shell, path) => {
  expect(quoteDroppedPaths(shell, [path])).toBeNull();
});
