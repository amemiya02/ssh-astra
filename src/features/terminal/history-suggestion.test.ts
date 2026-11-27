import { expect, it } from "vitest";
import { selectHistorySuffix } from "./history-suggestion";

it("takes the newest matching Command history line and returns only the remainder", () => {
  expect(selectHistorySuffix(["pwd", "git status --short", "git status"], "git st")).toBe("atus --short");
});

it("leaves an empty input, an exact match and case mismatches alone", () => {
  expect(selectHistorySuffix(["git status"], "")).toBeUndefined();
  expect(selectHistorySuffix(["git status", "git status --short"], "git status")).toBeUndefined();
  expect(selectHistorySuffix(["git status"], "GIT")).toBeUndefined();
  expect(selectHistorySuffix(["echo e\u0301"], "echo e")).toBeUndefined();
});

it.each(["\r", "\n", "\t", "\x1b", "\u202e", "\u200b", "\ud800", "x".repeat(512)])(
  "skips a non-printable or oversized command before suggesting a safe Unicode command",
  (text) => expect(selectHistorySuffix([`cd ${text}`, "cd 日本語"], "cd ")).toBe("日本語"),
);
