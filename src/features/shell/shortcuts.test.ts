import { describe, expect, it } from "vitest";
import { isSettingsShortcut } from "./shortcuts";

const key = (init: Partial<KeyboardEventInit>) => new KeyboardEvent("keydown", { key: ",", ...init });

describe("isSettingsShortcut", () => {
  it("is Cmd+, on macOS", () => {
    expect(isSettingsShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSettingsShortcut(key({ ctrlKey: true }), true)).toBe(false);
  });

  it("is Ctrl+, elsewhere", () => {
    expect(isSettingsShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSettingsShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it("ignores a plain comma and other modifiers", () => {
    expect(isSettingsShortcut(key({}), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, key: "." }), true)).toBe(false);
  });
});
