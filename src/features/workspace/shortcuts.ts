import type { BroadcastScope } from "./broadcast";
import type { PaneDirection } from "./pane-layout";
import type { SplitOrientation } from "./tabs";

/**
 * Keyboard shortcut tables by platform. Window-wide bindings on Windows and Linux
 * avoid plain Ctrl+letter, which the shell owns when a Terminal is focused.
 */
export type Platform = "mac" | "other";

export type WorkspaceCommand =
  | { type: "newTab" }
  | { type: "closePane" }
  | { type: "split"; orientation: SplitOrientation }
  | { type: "cycleTab"; step: 1 | -1 }
  | { type: "cyclePane"; step: 1 | -1 }
  | { type: "toggleMaximizePane" }
  | { type: "swapPane"; direction: PaneDirection }
  | { type: "moveTab"; step: 1 | -1 }
  /** 0-based; -1 is the last tab. */
  | { type: "goToTab"; index: number }
  | { type: "toggleBroadcast"; scope: BroadcastScope }
  | { type: "openPalette" }
  | { type: "openSettings" }
  | { type: "zoomTerminalFont"; step: 1 | -1 };

/** Where keyboard focus is: a Terminal owns every key but the reserved ones; the rest of the app owns a few more. */
export type KeyFocus = "terminal" | "app";

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
type FileHistoryShortcut = "fileBack" | "fileForward";
type FileMoveShortcut = "fileCut" | "filePaste";

export const paneSwapShortcuts = [
  { name: "swapPaneLeft", code: "ArrowLeft", direction: "left" },
  { name: "swapPaneRight", code: "ArrowRight", direction: "right" },
  { name: "swapPaneUp", code: "ArrowUp", direction: "up" },
  { name: "swapPaneDown", code: "ArrowDown", direction: "down" },
] as const;

/** Shortcuts shown in tooltips, by name. */
export type ShortcutName =
  | "newTab"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "toggleMaximizePane"
  | (typeof paneSwapShortcuts)[number]["name"]
  | "nextTab"
  | "previousTab"
  | "broadcastTab"
  | "broadcastWindow"
  | "commandPalette"
  | "settings"
  | "terminalZoomIn"
  | "terminalZoomOut"
  | FileHistoryShortcut
  | FileMoveShortcut
  | "find";

type Binding = ({ code: string; key?: never } | { key: string; code?: never }) & {
  name?: ShortcutName;
  mods: Modifier[];
  command: WorkspaceCommand;
  /** Only when focus is outside a Terminal: the chord means something to the shell. */
  appOnly?: true;
};

const split = (orientation: SplitOrientation): WorkspaceCommand => ({ type: "split", orientation });

const goToTab = (mod: Modifier): Binding[] =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    code: `Digit${n}`,
    mods: [mod],
    command: { type: "goToTab", index: n === 9 ? -1 : n - 1 },
  }));

const paneSwapBindings = (mods: Modifier[]): Binding[] =>
  paneSwapShortcuts.map(({ name, code, direction }) => ({ name, code, mods, command: { type: "swapPane", direction } }));

function zoomBindings(mod: Modifier): Binding[] {
  const increase: WorkspaceCommand = { type: "zoomTerminalFont", step: 1 };
  const decrease: WorkspaceCommand = { type: "zoomTerminalFont", step: -1 };
  // Match the symbol so the shortcut works on layouts with a dedicated plus key and on keypads.
  return [
    { name: "terminalZoomIn", key: "+", mods: [mod], command: increase },
    { key: "+", mods: [mod, "shift"], command: increase },
    { key: "=", mods: [mod], command: increase },
    { name: "terminalZoomOut", key: "-", mods: [mod], command: decrease },
    { key: "-", mods: [mod, "shift"], command: decrease },
  ];
}

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
    { name: "toggleMaximizePane", code: "Enter", mods: ["meta", "shift"], command: { type: "toggleMaximizePane" } },
    ...paneSwapBindings(["meta", "alt"]),
    { name: "nextTab", code: "BracketRight", mods: ["meta", "shift"], command: { type: "cycleTab", step: 1 } },
    { name: "previousTab", code: "BracketLeft", mods: ["meta", "shift"], command: { type: "cycleTab", step: -1 } },
    { code: "BracketRight", mods: ["meta"], command: { type: "cyclePane", step: 1 } },
    { code: "BracketLeft", mods: ["meta"], command: { type: "cyclePane", step: -1 } },
    { name: "broadcastTab", code: "KeyB", mods: ["meta", "shift"], command: { type: "toggleBroadcast", scope: "tab" } },
    { name: "broadcastWindow", code: "KeyB", mods: ["meta", "shift", "alt"], command: { type: "toggleBroadcast", scope: "window" } },
    { name: "commandPalette", code: "KeyK", mods: ["meta"], command: { type: "openPalette" } },
    { name: "settings", code: "Comma", mods: ["meta"], command: { type: "openSettings" } },
    ...zoomBindings("meta"),
    ...goToTab("meta"),
    ...shared,
  ],
  other: [
    { name: "newTab", code: "KeyT", mods: ["ctrl", "shift"], command: { type: "newTab" } },
    { name: "closePane", code: "KeyW", mods: ["ctrl", "shift"], command: { type: "closePane" } },
    { name: "splitRight", code: "KeyE", mods: ["ctrl", "shift"], command: split("horizontal") },
    { name: "splitDown", code: "KeyO", mods: ["ctrl", "shift"], command: split("vertical") },
    { name: "toggleMaximizePane", code: "Enter", mods: ["ctrl", "shift"], command: { type: "toggleMaximizePane" } },
    ...paneSwapBindings(["ctrl", "alt", "shift"]),
    { name: "nextTab", code: "PageDown", mods: ["ctrl"], command: { type: "cycleTab", step: 1 } },
    { name: "previousTab", code: "PageUp", mods: ["ctrl"], command: { type: "cycleTab", step: -1 } },
    { code: "KeyN", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: 1 } },
    { code: "KeyP", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: -1 } },
    { name: "broadcastTab", code: "KeyB", mods: ["ctrl", "shift"], command: { type: "toggleBroadcast", scope: "tab" } },
    { name: "broadcastWindow", code: "KeyB", mods: ["ctrl", "shift", "alt"], command: { type: "toggleBroadcast", scope: "window" } },
    { name: "commandPalette", code: "KeyK", mods: ["ctrl", "shift"], command: { type: "openPalette" } },
    { name: "settings", code: "Comma", mods: ["ctrl", "shift"], command: { type: "openSettings" } },
    ...zoomBindings("ctrl"),
    // Ctrl+K is kill-line in readline and emacs, so a Terminal keeps it.
    { code: "KeyK", mods: ["ctrl"], command: { type: "openPalette" }, appOnly: true },
    ...goToTab("alt"),
    ...shared,
  ],
};

/** Shortcuts a focused Terminal handles itself (xterm's key handler), not the window. */
export type TerminalCommand = "find";

interface TerminalBinding {
  name: ShortcutName;
  code: string;
  mods: Modifier[];
  command: TerminalCommand;
}

const terminalBindings: Record<Platform, TerminalBinding[]> = {
  mac: [{ name: "find", code: "KeyF", mods: ["meta"], command: "find" }],
  // Ctrl+F is forward-char in readline, so the shell keeps it.
  other: [{ name: "find", code: "KeyF", mods: ["ctrl", "shift"], command: "find" }],
};

const fileHistoryBindings: { code: string; mods: Modifier[]; name: FileHistoryShortcut }[] = [
  { name: "fileBack", code: "ArrowLeft", mods: ["alt"] },
  { name: "fileForward", code: "ArrowRight", mods: ["alt"] },
];

function fileMoveBindings(platform: Platform): { code: string; mods: Modifier[]; name: FileMoveShortcut }[] {
  const mod = platform === "mac" ? "meta" : "ctrl";
  return [
    { name: "fileCut", code: "KeyX", mods: [mod] },
    { name: "filePaste", code: "KeyV", mods: [mod] },
  ];
}

function pressed(chord: KeyChord, mod: Modifier): boolean {
  return { meta: chord.metaKey, ctrl: chord.ctrlKey, alt: chord.altKey, shift: chord.shiftKey }[mod];
}

function exactly(chord: KeyChord, mods: Modifier[]): boolean {
  const all: Modifier[] = ["meta", "ctrl", "alt", "shift"];
  return all.every((mod) => pressed(chord, mod) === mods.includes(mod));
}

/**
 * The workspace command a key press triggers, or `null` to let it reach the Terminal (or whatever has focus).
 * While a Terminal has focus only the reserved chords match; everything else goes to the remote program.
 */
export function matchShortcut(chord: KeyChord, platform: Platform, focus: KeyFocus = "terminal"): WorkspaceCommand | null {
  const binding = bindings[platform].find(
    (b) => (b.key === undefined ? b.code === chord.code : b.key === chord.key)
      && (focus === "app" || !b.appOnly)
      && exactly(chord, b.mods),
  );
  return binding?.command ?? null;
}

/** The Terminal's own command a key press inside it triggers (e.g. find), or `null`. */
export function matchTerminalShortcut(chord: KeyChord, platform: Platform): TerminalCommand | null {
  return terminalBindings[platform].find((b) => b.code === chord.code && exactly(chord, b.mods))?.command ?? null;
}

/** History shortcuts are handled by the focused File panel. */
export function matchFileHistoryShortcut(chord: KeyChord) {
  return fileHistoryBindings.find((b) => b.code === chord.code && exactly(chord, b.mods))?.name ?? null;
}

/** File movement uses native cut and paste chords, scoped to the File panel. */
export function matchFileMoveShortcut(chord: KeyChord, platform: Platform) {
  return fileMoveBindings(platform).find((b) => b.code === chord.code && exactly(chord, b.mods))?.name ?? null;
}

const macSymbols: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const pcNames: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };

function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return {
    BracketRight: "]", BracketLeft: "[", PageDown: "PgDn", PageUp: "PgUp", Comma: ",",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  }[code] ?? code;
}

/** How a named shortcut is written on `platform`, for tooltips: `⇧⌘D`, `Ctrl+Shift+T`. */
export function shortcutLabel(name: ShortcutName, platform: Platform): string {
  const binding = [...bindings[platform], ...terminalBindings[platform], ...fileHistoryBindings, ...fileMoveBindings(platform)]
    .find((b) => b.name === name);
  if (!binding) return "";
  const key = binding.code === undefined ? binding.key : keyName(binding.code);
  if (platform === "mac") {
    // macOS orders modifiers ⌃⌥⇧⌘.
    const order: Modifier[] = ["ctrl", "alt", "shift", "meta"];
    return order.filter((m) => binding.mods.includes(m)).map((m) => macSymbols[m]).join("") + key;
  }
  const order: Modifier[] = ["ctrl", "alt", "shift", "meta"];
  return [...order.filter((m) => binding.mods.includes(m)).map((m) => pcNames[m]), key].join("+");
}

export function currentPlatform(): Platform {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "mac" : "other";
}
