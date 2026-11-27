import { defineSection } from "@/lib/storage";

/** Where the File panel sits relative to the Terminal area. */
export type FilePanelDock = "right" | "bottom";

/** What the sidebar column shows; the nav rail switches it. */
export type SidebarView = "hosts" | "forwards";

/** Panel id → size as a percentage of its resizable group (react-resizable-panels `Layout`). */
export type GroupLayout = Record<string, number>;

/** The parts of the main window layout that survive a restart. */
export interface ShellLayout {
  dock: FilePanelDock;
  /** The view in the sidebar column (the column itself may be collapsed). */
  sidebarView: SidebarView;
  /** Saved sizes per resizable group id; a group with no entry uses its default sizes. */
  groups: Record<string, GroupLayout>;
}

export const defaultShellLayout: ShellLayout = { dock: "right", sidebarView: "hosts", groups: {} };

/** The `layout` section of the settings file. The window's own size and position are kept by Tauri. */
export const layoutSetting = defineSection<ShellLayout>("layout", defaultShellLayout, (raw) => {
  if (!isRecord(raw)) return defaultShellLayout;
  const dock: FilePanelDock = raw.dock === "bottom" ? "bottom" : "right";
  const sidebarView: SidebarView = raw.sidebarView === "forwards" ? "forwards" : "hosts";
  const groups: Record<string, GroupLayout> = {};
  if (isRecord(raw.groups)) {
    for (const [id, layout] of Object.entries(raw.groups)) {
      if (isGroupLayout(layout)) groups[id] = layout;
    }
  }
  return { dock, sidebarView, groups };
});

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
