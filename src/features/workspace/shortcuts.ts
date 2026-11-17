import type { SplitOrientation } from "./tabs";

/** The default shortcuts for tabs and splits. On Windows and Linux they avoid plain Ctrl+letter, which the shell owns. */
export type Platform = "mac" | "other";

export type WorkspaceCommand =
  | { type: "newTab" }
  | { type: "closePane" }
  | { type: "split"; orientation: SplitOrientation }
  | { type: "cycleTab"; step: 1 | -1 }
  | { type: "cyclePane"; step: 1 | -1 }
  | { type: "moveTab"; step: 1 | -1 }
  /** 0-based; -1 is the last tab. */
  | { type: "goToTab"; index: number };

/** The parts of a `KeyboardEvent` a shortcut looks at. */
export interface KeyChord {
  key: string;
  /** The physical key (`KeyT`, `Digit1`, `BracketRight`): layout-independent. */
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type Modifier = "meta" | "ctrl" | "alt" | "shift";

/** Shortcuts shown in tooltips, by name. */
export type ShortcutName = "newTab" | "closePane" | "splitRight" | "splitDown" | "nextTab" | "previousTab";

interface Binding {
  name?: ShortcutName;
  code: string;
  mods: Modifier[];
  command: WorkspaceCommand;
}

const split = (orientation: SplitOrientation): WorkspaceCommand => ({ type: "split", orientation });

const goToTab = (mod: Modifier): Binding[] =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    code: `Digit${n}`,
    mods: [mod],
    command: { type: "goToTab", index: n === 9 ? -1 : n - 1 },
  }));

const shared: Binding[] = [
  { code: "Tab", mods: ["ctrl"], command: { type: "cycleTab", step: 1 } },
  { code: "Tab", mods: ["ctrl", "shift"], command: { type: "cycleTab", step: -1 } },
  { code: "PageDown", mods: ["ctrl", "shift"], command: { type: "moveTab", step: 1 } },
  { code: "PageUp", mods: ["ctrl", "shift"], command: { type: "moveTab", step: -1 } },
];

const bindings: Record<Platform, Binding[]> = {
  mac: [
    { name: "newTab", code: "KeyT", mods: ["meta"], command: { type: "newTab" } },
    { name: "closePane", code: "KeyW", mods: ["meta"], command: { type: "closePane" } },
    { name: "splitRight", code: "KeyD", mods: ["meta"], command: split("horizontal") },
    { name: "splitDown", code: "KeyD", mods: ["meta", "shift"], command: split("vertical") },
    { name: "nextTab", code: "BracketRight", mods: ["meta", "shift"], command: { type: "cycleTab", step: 1 } },
    { name: "previousTab", code: "BracketLeft", mods: ["meta", "shift"], command: { type: "cycleTab", step: -1 } },
    { code: "BracketRight", mods: ["meta"], command: { type: "cyclePane", step: 1 } },
    { code: "BracketLeft", mods: ["meta"], command: { type: "cyclePane", step: -1 } },
    ...goToTab("meta"),
    ...shared,
  ],
  other: [
    { name: "newTab", code: "KeyT", mods: ["ctrl", "shift"], command: { type: "newTab" } },
    { name: "closePane", code: "KeyW", mods: ["ctrl", "shift"], command: { type: "closePane" } },
    { name: "splitRight", code: "KeyE", mods: ["ctrl", "shift"], command: split("horizontal") },
    { name: "splitDown", code: "KeyO", mods: ["ctrl", "shift"], command: split("vertical") },
    { name: "nextTab", code: "PageDown", mods: ["ctrl"], command: { type: "cycleTab", step: 1 } },
    { name: "previousTab", code: "PageUp", mods: ["ctrl"], command: { type: "cycleTab", step: -1 } },
    { code: "KeyN", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: 1 } },
    { code: "KeyP", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: -1 } },
    ...goToTab("alt"),
    ...shared,
  ],
};

function pressed(chord: KeyChord, mod: Modifier): boolean {
  return { meta: chord.metaKey, ctrl: chord.ctrlKey, alt: chord.altKey, shift: chord.shiftKey }[mod];
}

/** The workspace command a key press triggers, or `null` to let it reach the Terminal. */
export function matchShortcut(chord: KeyChord, platform: Platform): WorkspaceCommand | null {
  const all: Modifier[] = ["meta", "ctrl", "alt", "shift"];
  const binding = bindings[platform].find(
    (b) => b.code === chord.code && all.every((mod) => pressed(chord, mod) === b.mods.includes(mod)),
  );
  return binding?.command ?? null;
}

const macSymbols: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const pcNames: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };

function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return { BracketRight: "]", BracketLeft: "[", PageDown: "PgDn", PageUp: "PgUp" }[code] ?? code;
}

/** How a named shortcut is written on `platform`, for tooltips: `⇧⌘D`, `Ctrl+Shift+T`. */
export function shortcutLabel(name: ShortcutName, platform: Platform): string {
  const binding = bindings[platform].find((b) => b.name === name);
  if (!binding) return "";
  if (platform === "mac") {
    // macOS orders modifiers ⌃⌥⇧⌘.
    const order: Modifier[] = ["ctrl", "alt", "shift", "meta"];
    return order.filter((m) => binding.mods.includes(m)).map((m) => macSymbols[m]).join("") + keyName(binding.code);
  }
  const order: Modifier[] = ["ctrl", "alt", "shift", "meta"];
  return [...order.filter((m) => binding.mods.includes(m)).map((m) => pcNames[m]), keyName(binding.code)].join("+");
}

export function currentPlatform(): Platform {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "mac" : "other";
}
