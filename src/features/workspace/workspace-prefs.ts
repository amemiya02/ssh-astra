import { defineSection } from "@/lib/storage";

export const restoreTabsOptions = ["none", "layout", "connect"] as const;
export type RestoreTabs = (typeof restoreTabsOptions)[number];

interface WorkspacePrefs {
  restoreTabs: RestoreTabs;
}

export const workspaceSetting = defineSection<WorkspacePrefs>("workspacePreferences", { restoreTabs: "layout" }, (raw) => {
  const value = raw && typeof raw === "object" && "restoreTabs" in raw ? raw.restoreTabs : undefined;
  return { restoreTabs: restoreTabsOptions.find((option) => option === value) ?? "layout" };
});
