import { describe, expect, it } from "vitest";
import { matchShortcut, matchTerminalShortcut, shortcutLabel, type KeyChord } from "./shortcuts";

const chord = (key: string, mods: Partial<Omit<KeyChord, "key" | "code">> = {}, code?: string): KeyChord => ({
  key,
  code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("matchShortcut on macOS", () => {
  const mac = (c: KeyChord) => matchShortcut(c, "mac");

  it("uses ⌘ for tabs and splits, like iTerm", () => {
    expect(mac(chord("t", { metaKey: true }))).toEqual({ type: "newTab" });
    expect(mac(chord("w", { metaKey: true }))).toEqual({ type: "closePane" });
    expect(mac(chord("d", { metaKey: true }))).toEqual({ type: "split", orientation: "horizontal" });
    expect(mac(chord("D", { metaKey: true, shiftKey: true }))).toEqual({ type: "split", orientation: "vertical" });
    expect(mac(chord("}", { metaKey: true, shiftKey: true }, "BracketRight"))).toEqual({ type: "cycleTab", step: 1 });
    expect(mac(chord("{", { metaKey: true, shiftKey: true }, "BracketLeft"))).toEqual({ type: "cycleTab", step: -1 });
    expect(mac(chord("]", { metaKey: true }, "BracketRight"))).toEqual({ type: "cyclePane", step: 1 });
    expect(mac(chord("[", { metaKey: true }, "BracketLeft"))).toEqual({ type: "cyclePane", step: -1 });
    expect(mac(chord("3", { metaKey: true }, "Digit3"))).toEqual({ type: "goToTab", index: 2 });
  });

  it("leaves Ctrl chords to the shell", () => {
    expect(mac(chord("d", { ctrlKey: true }))).toBeNull();
    expect(mac(chord("w", { ctrlKey: true }))).toBeNull();
    expect(mac(chord("t"))).toBeNull();
  });
});

describe("matchShortcut on Windows and Linux", () => {
  const pc = (c: KeyChord) => matchShortcut(c, "other");

  it("uses Ctrl+Shift so Ctrl+D, Ctrl+W and Ctrl+T still reach the shell", () => {
    expect(pc(chord("T", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "newTab" });
    expect(pc(chord("W", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "closePane" });
    expect(pc(chord("E", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "split", orientation: "horizontal" });
    expect(pc(chord("O", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "split", orientation: "vertical" });
    expect(pc(chord("d", { ctrlKey: true }))).toBeNull();
    expect(pc(chord("w", { ctrlKey: true }))).toBeNull();
    expect(pc(chord("t", { ctrlKey: true }))).toBeNull();
  });

  it("switches tabs with Ctrl+Tab and Ctrl+PageUp/PageDown, panes with Ctrl+Shift+N/P, tabs by number with Alt", () => {
    expect(pc(chord("Tab", { ctrlKey: true }))).toEqual({ type: "cycleTab", step: 1 });
    expect(pc(chord("Tab", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "cycleTab", step: -1 });
    expect(pc(chord("PageDown", { ctrlKey: true }))).toEqual({ type: "cycleTab", step: 1 });
    expect(pc(chord("PageUp", { ctrlKey: true }))).toEqual({ type: "cycleTab", step: -1 });
    expect(pc(chord("N", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "cyclePane", step: 1 });
    expect(pc(chord("P", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "cyclePane", step: -1 });
    expect(pc(chord("1", { altKey: true }, "Digit1"))).toEqual({ type: "goToTab", index: 0 });
  });
});

describe("matchShortcut on every platform", () => {
  it("cycles tabs with Ctrl+Tab and moves the active tab with Ctrl+Shift+PageUp/PageDown", () => {
    for (const platform of ["mac", "other"] as const) {
      expect(matchShortcut(chord("Tab", { ctrlKey: true }), platform)).toEqual({ type: "cycleTab", step: 1 });
      expect(matchShortcut(chord("PageDown", { ctrlKey: true, shiftKey: true }), platform)).toEqual({
        type: "moveTab",
        step: 1,
      });
      expect(matchShortcut(chord("PageUp", { ctrlKey: true, shiftKey: true }), platform)).toEqual({
        type: "moveTab",
        step: -1,
      });
    }
  });

  it("goes to the last tab with 9, as browsers do", () => {
    expect(matchShortcut(chord("9", { metaKey: true }, "Digit9"), "mac")).toEqual({ type: "goToTab", index: -1 });
  });

  it("matches by physical key, so non-US layouts and Shift-ed symbols still work", () => {
    expect(matchShortcut(chord("†", { metaKey: true, altKey: false }, "KeyT"), "mac")).toEqual({ type: "newTab" });
  });
});

describe("shortcutLabel", () => {
  it("shows each platform's own notation", () => {
    expect(shortcutLabel("newTab", "mac")).toBe("⌘T");
    expect(shortcutLabel("splitDown", "mac")).toBe("⇧⌘D");
    expect(shortcutLabel("newTab", "other")).toBe("Ctrl+Shift+T");
    expect(shortcutLabel("splitRight", "other")).toBe("Ctrl+Shift+E");
  });
});

describe("the command palette chord", () => {
  const palette = { type: "openPalette" };

  it("is ⌘K on macOS, even while a Terminal has focus", () => {
    expect(matchShortcut(chord("k", { metaKey: true }), "mac", "terminal")).toEqual(palette);
    expect(matchShortcut(chord("k", { metaKey: true }), "mac", "app")).toEqual(palette);
    expect(shortcutLabel("commandPalette", "mac")).toBe("⌘K");
  });

  it("is Ctrl+Shift+K elsewhere; plain Ctrl+K opens it only outside a Terminal, where readline's kill-line wins", () => {
    expect(matchShortcut(chord("K", { ctrlKey: true, shiftKey: true }), "other", "terminal")).toEqual(palette);
    expect(matchShortcut(chord("k", { ctrlKey: true }), "other", "app")).toEqual(palette);
    expect(matchShortcut(chord("k", { ctrlKey: true }), "other", "terminal")).toBeNull();
    expect(shortcutLabel("commandPalette", "other")).toBe("Ctrl+Shift+K");
  });
});

describe("keys a focused Terminal keeps (vim, tmux, emacs)", () => {
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const terminalChords: [string, KeyChord][] = [
    ...letters.map((l): [string, KeyChord] => [`Ctrl+${l}`, chord(l, { ctrlKey: true })]),
    ...letters.map((l): [string, KeyChord] => [`Alt+${l}`, chord(l, { altKey: true })]),
    ...letters.map((l): [string, KeyChord] => [`Ctrl+Alt+${l}`, chord(l, { ctrlKey: true, altKey: true })]),
    ["Ctrl+[", chord("[", { ctrlKey: true }, "BracketLeft")],
    ["Ctrl+]", chord("]", { ctrlKey: true }, "BracketRight")],
    ["Ctrl+Space", chord(" ", { ctrlKey: true }, "Space")],
    ["Ctrl+\\", chord("\\", { ctrlKey: true }, "Backslash")],
    ["Ctrl+/", chord("/", { ctrlKey: true }, "Slash")],
    ["Escape", chord("Escape")],
    ["Tab", chord("Tab")],
    ["Shift+Tab", chord("Tab", { shiftKey: true })],
  ];

  for (const platform of ["mac", "other"] as const) {
    it(`all reach the remote on ${platform}`, () => {
      const taken = terminalChords.filter(([, c]) => matchShortcut(c, platform, "terminal") !== null).map(([n]) => n);
      expect(taken).toEqual([]);
    });
  }
});

describe("Settings shortcut", () => {
  const settings = { type: "openSettings" };

  it("is Cmd+, on macOS, even from a Terminal", () => {
    expect(matchShortcut(chord(",", { metaKey: true }, "Comma"), "mac", "terminal")).toEqual(settings);
    expect(matchShortcut(chord(",", { ctrlKey: true }, "Comma"), "mac", "app")).toBeNull();
    expect(shortcutLabel("settings", "mac")).toBe("⌘,");
  });

  it("is Ctrl+Shift+, elsewhere, leaving Ctrl+, to the shell", () => {
    expect(matchShortcut(chord("<", { ctrlKey: true, shiftKey: true }, "Comma"), "other", "terminal")).toEqual(settings);
    expect(matchShortcut(chord(",", { ctrlKey: true }, "Comma"), "other", "terminal")).toBeNull();
    expect(shortcutLabel("settings", "other")).toBe("Ctrl+Shift+,");
  });
});

describe("matchTerminalShortcut", () => {
  it("finds in the Terminal with Cmd+F on macOS", () => {
    expect(matchTerminalShortcut(chord("f", { metaKey: true }), "mac")).toBe("find");
    expect(matchTerminalShortcut(chord("f", { ctrlKey: true }), "mac")).toBeNull();
  });

  it("finds with Ctrl+Shift+F elsewhere, leaving Ctrl+F to the shell", () => {
    expect(matchTerminalShortcut(chord("F", { ctrlKey: true, shiftKey: true }), "other")).toBe("find");
    expect(matchTerminalShortcut(chord("f", { ctrlKey: true }), "other")).toBeNull();
  });

  it("is not a window-wide shortcut", () => {
    expect(matchShortcut(chord("f", { metaKey: true }), "mac", "app")).toBeNull();
  });
});
