import { describe, expect, it } from "vitest";
import {
  captureShortcut,
  editShortcut,
  matchFileHistoryShortcut,
  matchShortcut,
  matchTerminalShortcut,
  resolveShortcuts,
  shortcutLabel,
  type KeyChord,
} from "./shortcuts";

const chord = (key: string, mods: Partial<Omit<KeyChord, "key" | "code">> = {}, code?: string): KeyChord => ({
  key,
  code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

it("reports a conflict with Terminal Find and replaces its binding only when requested", () => {
  const find = chord("F", { ctrlKey: true, shiftKey: true });
  const proposed = { code: "KeyF", key: "F", mods: ["ctrl", "shift"] } as const;
  expect(editShortcut("other", {}, "newTab", proposed)).toEqual({ conflicts: ["find"] });

  const replaced = editShortcut("other", {}, "newTab", proposed, true);
  expect(replaced).toEqual({ overrides: { newTab: proposed, find: null } });
  const resolved = resolveShortcuts("other", "overrides" in replaced ? replaced.overrides : {});
  expect(matchShortcut(find, resolved)).toEqual({ type: "newTab" });
  expect(matchTerminalShortcut(find, resolved)).toBeNull();
  expect(shortcutLabel("newTab", resolved)).toBe("Ctrl+Shift+F");
  expect(shortcutLabel("find", resolved)).toBe("");
});

it("rebinds all alternatives for an action and checks conflicts when restoring its defaults", () => {
  const custom = { code: "KeyF", key: "F", mods: ["meta", "alt"] } as const;
  const overrides = {
    nextTab: custom,
    find: { code: "Tab", key: "Tab", mods: ["ctrl"] } as const,
  };
  const resolved = resolveShortcuts("mac", overrides);
  expect(matchShortcut(chord("f", { metaKey: true, altKey: true }), resolved)).toEqual({ type: "cycleTab", step: 1 });
  expect(matchShortcut(chord("}", { metaKey: true, shiftKey: true }, "BracketRight"), resolved)).toBeNull();
  expect(matchTerminalShortcut(chord("Tab", { ctrlKey: true }), resolved)).toBe("find");
  expect(editShortcut("mac", overrides, "nextTab", undefined)).toEqual({ conflicts: ["find"] });
  expect(editShortcut("mac", overrides, "nextTab", undefined, true)).toEqual({ overrides: { find: null } });
});

it("reserves non-macOS Ctrl+letter for the shell while preserving the app-only palette default", () => {
  const ctrlK = chord("k", { ctrlKey: true });
  expect(captureShortcut(ctrlK, "other")).toEqual({ issue: "shellCtrlLetter" });
  expect(captureShortcut(chord("Ж", { ctrlKey: true }, "KeyS"), "other")).toEqual({ issue: "shellCtrlLetter" });
  expect(captureShortcut(ctrlK, "mac")).toEqual({ chord: { code: "KeyK", key: "k", mods: ["ctrl"] } });
  const resolved = resolveShortcuts("other", { newTab: { code: "KeyK", key: "k", mods: ["ctrl"] } });
  expect(matchShortcut(ctrlK, resolved)).toBeNull();
  expect(matchShortcut(ctrlK, resolved, "app")).toEqual({ type: "openPalette" });
});

it("finds conflicts with the symbol aliases for Terminal font zoom", () => {
  const plus = { code: "Equal", key: "+", mods: ["meta", "shift"] } as const;
  expect(editShortcut("mac", {}, "find", plus)).toEqual({ conflicts: ["terminalZoomIn"] });
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

describe("pane layout shortcuts", () => {
  it.each([
    ["mac", { metaKey: true }, "⇧⌘Enter", "⌥⌘"],
    ["other", { ctrlKey: true }, "Ctrl+Shift+Enter", "Ctrl+Alt+Shift+"],
  ] as const)("maximizes and swaps panes from a focused Terminal on %s", (platform, mod, maximizeLabel, swapPrefix) => {
    expect(matchShortcut(chord("Enter", { ...mod, shiftKey: true }), platform)).toEqual({ type: "toggleMaximizePane" });
    expect(shortcutLabel("toggleMaximizePane", platform)).toBe(maximizeLabel);

    const swapMods = { ...mod, altKey: true, shiftKey: platform === "other" };
    for (const [code, direction, name, label] of [
      ["ArrowLeft", "left", "swapPaneLeft", "←"],
      ["ArrowRight", "right", "swapPaneRight", "→"],
      ["ArrowUp", "up", "swapPaneUp", "↑"],
      ["ArrowDown", "down", "swapPaneDown", "↓"],
    ] as const) {
      expect(matchShortcut(chord(code, swapMods), platform)).toEqual({ type: "swapPane", direction });
      expect(shortcutLabel(name, platform)).toBe(swapPrefix + label);
    }
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

describe("Terminal font zoom shortcuts", () => {
  it.each([
    ["mac", { metaKey: true }, "⌘"],
    ["other", { ctrlKey: true }, "Ctrl+"],
  ] as const)("zooms with the platform modifier and the plus or minus key on %s", (platform, mods, prefix) => {
    const increase = { type: "zoomTerminalFont", step: 1 };
    expect(matchShortcut(chord("+", { ...mods, shiftKey: true }, "Equal"), platform)).toEqual(increase);
    expect(matchShortcut(chord("+", mods, "NumpadAdd"), platform)).toEqual(increase);
    expect(matchShortcut(chord("=", mods, "Equal"), platform)).toEqual(increase);
    expect(matchShortcut(chord("-", mods, "Minus"), platform)).toEqual({ type: "zoomTerminalFont", step: -1 });
    expect(matchShortcut(chord("_", { ...mods, shiftKey: true }, "Minus"), platform)).toBeNull();
    expect(matchShortcut(chord("+", { ...mods, altKey: true }, "NumpadAdd"), platform)).toBeNull();
    expect(matchShortcut(chord("-", {}, "Minus"), platform)).toBeNull();
    expect(shortcutLabel("terminalZoomIn", platform)).toBe(prefix + "+");
    expect(shortcutLabel("terminalZoomOut", platform)).toBe(prefix + "-");
  });
});

describe("File panel history shortcuts", () => {
  it("leaves Alt+Left and Alt+Right available to the focused panel", () => {
    const back = chord("ArrowLeft", { altKey: true });
    const forward = chord("ArrowRight", { altKey: true });
    expect(matchFileHistoryShortcut(back)).toBe("fileBack");
    expect(matchFileHistoryShortcut(forward)).toBe("fileForward");
    expect(matchFileHistoryShortcut(chord("ArrowLeft", { altKey: true, shiftKey: true }))).toBeNull();
    for (const platform of ["mac", "other"] as const) {
      expect(matchShortcut(back, platform, "app")).toBeNull();
      expect(matchShortcut(forward, platform, "terminal")).toBeNull();
      expect(matchTerminalShortcut(back, platform)).toBeNull();
      expect(matchTerminalShortcut(forward, platform)).toBeNull();
    }
    expect(shortcutLabel("fileBack", "mac")).toBe("⌥←");
    expect(shortcutLabel("fileForward", "other")).toBe("Alt+→");
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
