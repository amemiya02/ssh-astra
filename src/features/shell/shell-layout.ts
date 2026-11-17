import { readItem, writeItem, type KeyValueStore } from "@/lib/storage";

/** Where the File panel sits relative to the Terminal area. */
export type FilePanelDock = "right" | "bottom";

/** Panel id → size as a percentage of its resizable group (react-resizable-panels `Layout`). */
export type GroupLayout = Record<string, number>;

/** The parts of the main window layout that survive a restart. */
export interface ShellLayout {
  dock: FilePanelDock;
  /** Saved sizes per resizable group id; a group with no entry uses its default sizes. */
  groups: Record<string, GroupLayout>;
}

export const defaultShellLayout: ShellLayout = { dock: "right", groups: {} };

const storageKey = "sshastra.layout.v1";

export function loadShellLayout(store: KeyValueStore | undefined): ShellLayout {
  const raw = readItem(store, storageKey);
  if (raw === null) return defaultShellLayout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultShellLayout;
  }
  if (!isRecord(parsed)) return defaultShellLayout;

  const dock: FilePanelDock = parsed.dock === "bottom" ? "bottom" : "right";
  const groups: Record<string, GroupLayout> = {};
  if (isRecord(parsed.groups)) {
    for (const [id, layout] of Object.entries(parsed.groups)) {
      if (isGroupLayout(layout)) groups[id] = layout;
    }
  }
  return { dock, groups };
}

/** Collapsible panels collapse to 0%; sub-percent leftovers from rounding count as collapsed too. */
export function isPanelCollapsed(layout: GroupLayout | undefined, panelId: string): boolean {
  const size = layout?.[panelId];
  return size !== undefined && size < 0.5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroupLayout(value: unknown): value is GroupLayout {
  return (
    isRecord(value) &&
    Object.values(value).every((size) => typeof size === "number" && size >= 0 && size <= 100)
  );
}

export function saveShellLayout(store: KeyValueStore | undefined, layout: ShellLayout): void {
  writeItem(store, storageKey, JSON.stringify(layout));
}
