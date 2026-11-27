import { defineSection } from "@/lib/storage";

export const restoreTabsOptions = ["none", "layout", "connect"] as const;
export type RestoreTabs = (typeof restoreTabsOptions)[number];

interface WorkspacePrefs {
  restoreTabs: RestoreTabs;
  confirmClose: boolean;
}

export const workspaceSetting = defineSection<WorkspacePrefs>(
  "workspacePreferences",
  { restoreTabs: "layout", confirmClose: true },
  (raw) => {
    const prefs = raw && typeof raw === "object" ? raw as Partial<Record<keyof WorkspacePrefs, unknown>> : {};
    return {
      restoreTabs: restoreTabsOptions.find((option) => option === prefs.restoreTabs) ?? "layout",
      confirmClose: prefs.confirmClose !== false,
    };
  },
);
