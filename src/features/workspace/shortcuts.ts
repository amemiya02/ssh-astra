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
type FileClipboardShortcut = "fileCopy" | "fileCut" | "filePaste";

export const paneSwapShortcuts = [
  { name: "swapPaneLeft", code: "ArrowLeft", direction: "left" },
  { name: "swapPaneRight", code: "ArrowRight", direction: "right" },
  { name: "swapPaneUp", code: "ArrowUp", direction: "up" },
  { name: "swapPaneDown", code: "ArrowDown", direction: "down" },
] as const;

/** Stable names are also the keys written to the shortcuts settings section. */
const numberedTabShortcuts = [
  "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "lastTab",
] as const;

export const shortcutNames = [
  "newTab", "closePane", "splitRight", "splitDown", "toggleMaximizePane",
  ...paneSwapShortcuts.map(({ name }) => name),
  "nextTab", "previousTab", "nextPane", "previousPane", "moveTabRight", "moveTabLeft",
  ...numberedTabShortcuts,
  "broadcastTab", "broadcastWindow", "commandPalette", "settings", "terminalZoomIn", "terminalZoomOut",
  "find", "fileBack", "fileForward", "fileCopy", "fileCut", "filePaste",
] as const;

export type ShortcutName = (typeof shortcutNames)[number];

const modifiers = ["ctrl", "alt", "shift", "meta"] as const satisfies readonly Modifier[];

type ShortcutChord = {
  code: string;
  // Recorded character, for conflicts with defaults that match by symbol.
  key?: string;
  mods: readonly Modifier[];
} | {
  code?: never;
  key: string;
  mods: readonly Modifier[];
};

export interface CapturedShortcut {
  code: string;
  key: string;
  mods: readonly Modifier[];
}

/** Missing entries use the default. Null marks an action displaced by another shortcut. */
export type ShortcutOverrides = Readonly<Partial<Record<ShortcutName, CapturedShortcut | null>>>;

type NamedBinding = ShortcutChord & { name: ShortcutName };

type Binding = NamedBinding & {
  command: WorkspaceCommand;
  /** Only when focus is outside a Terminal: the chord means something to the shell. */
  appOnly?: true;
};

const split = (orientation: SplitOrientation): WorkspaceCommand => ({ type: "split", orientation });

const goToTab = (mod: Modifier): Binding[] =>
  numberedTabShortcuts.map((name, index) => ({
    name,
    code: `Digit${index + 1}`,
    mods: [mod],
    command: { type: "goToTab", index: name === "lastTab" ? -1 : index },
  }));

const paneSwapBindings = (mods: Modifier[]): Binding[] =>
  paneSwapShortcuts.map(({ name, code, direction }) => ({ name, code, mods, command: { type: "swapPane", direction } }));

function zoomBindings(mod: Modifier): Binding[] {
  const increase: WorkspaceCommand = { type: "zoomTerminalFont", step: 1 };
  const decrease: WorkspaceCommand = { type: "zoomTerminalFont", step: -1 };
  // Match the symbol so the shortcut works on layouts with a dedicated plus key and on keypads.
  return [
    { name: "terminalZoomIn", key: "+", mods: [mod], command: increase },
    { name: "terminalZoomIn", key: "+", mods: [mod, "shift"], command: increase },
    { name: "terminalZoomIn", key: "=", mods: [mod], command: increase },
    { name: "terminalZoomOut", key: "-", mods: [mod], command: decrease },
    { name: "terminalZoomOut", key: "-", mods: [mod, "shift"], command: decrease },
  ];
}

const shared: Binding[] = [
  { name: "nextTab", code: "Tab", mods: ["ctrl"], command: { type: "cycleTab", step: 1 } },
  { name: "previousTab", code: "Tab", mods: ["ctrl", "shift"], command: { type: "cycleTab", step: -1 } },
  { name: "moveTabRight", code: "PageDown", mods: ["ctrl", "shift"], command: { type: "moveTab", step: 1 } },
  { name: "moveTabLeft", code: "PageUp", mods: ["ctrl", "shift"], command: { type: "moveTab", step: -1 } },
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
    { name: "nextPane", code: "BracketRight", mods: ["meta"], command: { type: "cyclePane", step: 1 } },
    { name: "previousPane", code: "BracketLeft", mods: ["meta"], command: { type: "cyclePane", step: -1 } },
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
    { name: "nextPane", code: "KeyN", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: 1 } },
    { name: "previousPane", code: "KeyP", mods: ["ctrl", "shift"], command: { type: "cyclePane", step: -1 } },
    { name: "broadcastTab", code: "KeyB", mods: ["ctrl", "shift"], command: { type: "toggleBroadcast", scope: "tab" } },
    { name: "broadcastWindow", code: "KeyB", mods: ["ctrl", "shift", "alt"], command: { type: "toggleBroadcast", scope: "window" } },
    { name: "commandPalette", code: "KeyK", mods: ["ctrl", "shift"], command: { type: "openPalette" } },
    { name: "settings", code: "Comma", mods: ["ctrl", "shift"], command: { type: "openSettings" } },
    ...zoomBindings("ctrl"),
    // Ctrl+K is kill-line in readline and emacs, so a Terminal keeps it.
    { name: "commandPalette", code: "KeyK", mods: ["ctrl"], command: { type: "openPalette" }, appOnly: true },
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

function fileClipboardBindings(platform: Platform): { code: string; mods: Modifier[]; name: FileClipboardShortcut }[] {
  const mod = platform === "mac" ? "meta" : "ctrl";
  return [
    { name: "fileCopy", code: "KeyC", mods: [mod] },
    { name: "fileCut", code: "KeyX", mods: [mod] },
    { name: "filePaste", code: "KeyV", mods: [mod] },
  ];
}

type ResolvedBinding =
  | (Binding & { scope: "window" })
  | (NamedBinding & { scope: "terminal"; command: TerminalCommand })
  | (NamedBinding & { scope: "history"; name: FileHistoryShortcut })
  | (NamedBinding & { scope: "clipboard"; name: FileClipboardShortcut });

export interface ResolvedShortcuts {
  platform: Platform;
  bindings: readonly ResolvedBinding[];
}

function defaultBindings(platform: Platform): ResolvedBinding[] {
  return [
    ...bindings[platform].map((b) => ({ ...b, scope: "window" as const })),
    ...terminalBindings[platform].map((b) => ({ ...b, scope: "terminal" as const })),
    ...fileHistoryBindings.map((b) => ({ ...b, scope: "history" as const })),
    ...fileClipboardBindings(platform).map((b) => ({ ...b, scope: "clipboard" as const })),
  ];
}

const defaults = { mac: defaultBindings("mac"), other: defaultBindings("other") };

function pressed(chord: KeyChord, mod: Modifier): boolean {
  return { meta: chord.metaKey, ctrl: chord.ctrlKey, alt: chord.altKey, shift: chord.shiftKey }[mod];
}

function matches(chord: KeyChord, binding: ShortcutChord): boolean {
  const sameKey = binding.code === undefined ? binding.key === chord.key : binding.code === chord.code;
  return sameKey && modifiers.every((mod) => pressed(chord, mod) === binding.mods.includes(mod));
}

function overlaps(left: ShortcutChord, right: ShortcutChord): boolean {
  const sameKey = left.code && right.code ? left.code === right.code : left.key === right.key;
  return sameKey && left.mods.length === right.mods.length && left.mods.every((mod) => right.mods.includes(mod));
}

export type ShortcutCaptureIssue = "shellCtrlLetter" | "missingModifier" | "unsupportedKey";

function isModifierKey({ code, key }: Pick<KeyChord, "code" | "key">): boolean {
  return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code) ||
    ["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(key);
}

function shortcutIssue({ code, key, mods }: CapturedShortcut, platform: Platform): ShortcutCaptureIssue | undefined {
  if (isModifierKey({ code, key }) || !code || !key || ["Unidentified", "Dead", "Process"].includes(key) || code === "Unidentified") return "unsupportedKey";
  if (platform === "other" && mods.length === 1 && mods[0] === "ctrl" &&
    (/^Key[A-Z]$/.test(code) || /^\p{L}$/u.test(key))) return "shellCtrlLetter";
  if (!mods.some((mod) => mod !== "shift") && !/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return "missingModifier";
}

export function captureShortcut(event: KeyChord, platform: Platform):
  { chord: CapturedShortcut } | { issue: ShortcutCaptureIssue } | null {
  if (isModifierKey(event)) return null;
  const chord = { code: event.code, key: event.key, mods: modifiers.filter((mod) => pressed(event, mod)) };
  const issue = shortcutIssue(chord, platform);
  return issue ? { issue } : { chord };
}

export function parseShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const overrides: Partial<Record<ShortcutName, CapturedShortcut | null>> = {};
  for (const name of shortcutNames) {
    const entry = source[name];
    if (entry === null) {
      overrides[name] = null;
    } else if (entry && typeof entry === "object" && "code" in entry && "key" in entry && "mods" in entry &&
      typeof entry.code === "string" && typeof entry.key === "string" && Array.isArray(entry.mods)) {
      const savedMods = entry.mods;
      const mods = modifiers.filter((mod) => savedMods.includes(mod));
      if (mods.length === savedMods.length) overrides[name] = { code: entry.code, key: entry.key, mods };
    }
  }
  return overrides;
}

/** Applies persisted overrides to all scopes of the default table. */
export function resolveShortcuts(platform: Platform, overrides: ShortcutOverrides): ResolvedShortcuts {
  const custom: ResolvedBinding[] = [];
  const replaced = new Set<ShortcutName>();
  for (const name of shortcutNames) {
    const chord = overrides[name];
    if (chord === null) replaced.add(name);
    if (!chord || shortcutIssue(chord, platform) || custom.some((binding) => overlaps(chord, binding))) continue;
    const template = defaults[platform].find((binding) => binding.name === name);
    if (template) {
      custom.push({ ...template, ...chord });
      replaced.add(name);
    }
  }
  return {
    platform,
    bindings: [
      ...custom,
      ...defaults[platform].filter((binding) =>
        !replaced.has(binding.name) && !custom.some((override) => overlaps(override, binding))),
    ],
  };
}

/** An undefined chord restores every default binding for the action. */
export function editShortcut(
  platform: Platform,
  overrides: ShortcutOverrides,
  name: ShortcutName,
  chord: CapturedShortcut | undefined,
  replace = false,
): { conflicts: ShortcutName[] } | { overrides: ShortcutOverrides } {
  const proposed = chord ? [chord] : defaults[platform].filter((binding) => binding.name === name);
  const conflicts = [...new Set(resolveShortcuts(platform, overrides).bindings
    .filter((binding) => binding.name !== name && proposed.some((key) => overlaps(key, binding)))
    .map((binding) => binding.name))];
  if (conflicts.length && !replace) return { conflicts };

  const next = { ...overrides };
  if (chord) next[name] = chord;
  else delete next[name];
  for (const conflict of conflicts) next[conflict] = null;
  return { overrides: next };
}

type ShortcutSource = Platform | ResolvedShortcuts;

function table(source: ShortcutSource): readonly ResolvedBinding[] {
  return typeof source === "string" ? defaults[source] : source.bindings;
}

/**
 * The workspace command a key press triggers, or `null` to let it reach the Terminal (or whatever has focus).
 * While a Terminal has focus only the reserved chords match; everything else goes to the remote program.
 */
export function matchShortcut(chord: KeyChord, source: ShortcutSource, focus: KeyFocus = "terminal"): WorkspaceCommand | null {
  const binding = table(source).find((b) =>
    b.scope === "window" && (focus === "app" || !b.appOnly) && matches(chord, b));
  return binding?.scope === "window" ? binding.command : null;
}

/** The Terminal's own command a key press inside it triggers (e.g. find), or `null`. */
export function matchTerminalShortcut(chord: KeyChord, source: ShortcutSource): TerminalCommand | null {
  const binding = table(source).find((b) => b.scope === "terminal" && matches(chord, b));
  return binding?.scope === "terminal" ? binding.command : null;
}

/** History shortcuts are handled by the focused File panel. */
export function matchFileHistoryShortcut(chord: KeyChord, source: ShortcutSource = "other") {
  const binding = table(source).find((b) => b.scope === "history" && matches(chord, b));
  return binding?.scope === "history" ? binding.name : null;
}

/** File clipboard shortcuts are scoped to the File panel. */
export function matchFileClipboardShortcut(chord: KeyChord, source: ShortcutSource) {
  const binding = table(source).find((b) => b.scope === "clipboard" && matches(chord, b));
  return binding?.scope === "clipboard" ? binding.name : null;
}

const macSymbols: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const pcNames: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };

function physicalKeyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return {
    BracketRight: "]", BracketLeft: "[", Comma: ",", Equal: "=", Minus: "-", Period: ".",
    Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  }[code] ?? code;
}

function keyName(code: string): string {
  return {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    PageDown: "PgDn", PageUp: "PgUp", Escape: "Esc",
  }[code] ?? physicalKeyName(code);
}

function chordLabel(binding: ShortcutChord, platform: Platform): string {
  const key = binding.code === undefined ? binding.key : keyName(binding.code);
  if (platform === "mac") {
    // macOS orders modifiers ⌃⌥⇧⌘.
    return modifiers.filter((mod) => binding.mods.includes(mod)).map((mod) => macSymbols[mod]).join("") + key;
  }
  return [...modifiers.filter((mod) => binding.mods.includes(mod)).map((mod) => pcNames[mod]), key].join("+");
}

/** How a named shortcut is written for tooltips and palette actions. */
export function shortcutLabel(name: ShortcutName, source: ShortcutSource): string {
  const binding = table(source).find((b) => b.name === name);
  if (!binding) return "";
  return chordLabel(binding, typeof source === "string" ? source : source.platform);
}

/** Physical keys written in the notation used by aria-keyshortcuts. */
export function shortcutAriaLabel(name: ShortcutName, source: ResolvedShortcuts): string | undefined {
  const binding = source.bindings.find((b) => b.name === name);
  if (!binding) return undefined;
  const names: Record<Modifier, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", meta: "Meta" };
  const key = binding.code === undefined ? binding.key : physicalKeyName(binding.code);
  const keyToken = key === "+" ? "Plus" : key === " " ? "Space" : key;
  return [...modifiers.filter((mod) => binding.mods.includes(mod)).map((mod) => names[mod]), keyToken].join("+");
}

/** All current combinations, including alternate defaults, for the shortcut editor. */
export function shortcutLabels(name: ShortcutName, source: ResolvedShortcuts): string[] {
  return source.bindings.filter((b) => b.name === name).map((b) => chordLabel(b, source.platform));
}

export function currentPlatform(): Platform {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "mac" : "other";
}
