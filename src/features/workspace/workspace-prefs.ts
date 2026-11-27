import { defineSection } from "@/lib/storage";

export const restoreTabsOptions = ["none", "layout", "connect"] as const;
export type RestoreTabs = (typeof restoreTabsOptions)[number];

export const tabOrientations = ["horizontal", "vertical"] as const;
export type TabOrientation = (typeof tabOrientations)[number];

export const minTabStripWidth = 120;
export const maxTabStripWidth = 320;
export const defaultTabStripWidth = 192;
export const compactTabStripWidth = 38;

export function clampTabStripWidth(width: number, max = maxTabStripWidth): number {
  return Math.max(minTabStripWidth, Math.min(max, Math.round(width)));
}

interface WorkspacePrefs {
  restoreTabs: RestoreTabs;
  confirmClose: boolean;
  confirmQuit: boolean;
  closeToTray: boolean;
  tabOrientation: TabOrientation;
  verticalTabWidth: number;
  verticalTabsCompact: boolean;
  groupTabsByHost: boolean;
}

export const workspaceSetting = defineSection<WorkspacePrefs>(
  "workspacePreferences",
  {
    restoreTabs: "layout",
    confirmClose: true,
    confirmQuit: true,
    closeToTray: false,
    tabOrientation: "horizontal",
    verticalTabWidth: defaultTabStripWidth,
    verticalTabsCompact: false,
    groupTabsByHost: false,
  },
  (raw) => {
    const prefs = raw && typeof raw === "object" ? raw as Partial<Record<keyof WorkspacePrefs, unknown>> : {};
    return {
      restoreTabs: restoreTabsOptions.find((option) => option === prefs.restoreTabs) ?? "layout",
      confirmClose: prefs.confirmClose !== false,
      confirmQuit: prefs.confirmQuit !== false,
      closeToTray: prefs.closeToTray === true,
      tabOrientation: prefs.tabOrientation === "vertical" ? "vertical" : "horizontal",
      verticalTabWidth: typeof prefs.verticalTabWidth === "number" && Number.isFinite(prefs.verticalTabWidth)
        ? clampTabStripWidth(prefs.verticalTabWidth)
        : defaultTabStripWidth,
      verticalTabsCompact: prefs.verticalTabsCompact === true,
      groupTabsByHost: prefs.groupTabsByHost === true,
    };
  },
);
