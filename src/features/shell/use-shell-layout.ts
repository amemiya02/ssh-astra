import { useCallback } from "react";
import { getSetting, setSetting, useSetting } from "@/lib/storage";
import { layoutSetting, type FilePanelDock, type GroupLayout, type SidebarView } from "./shell-layout";

/** The persisted layout for this Window, saved whenever it changes. */
export function useShellLayout() {
  const [layout] = useSetting(layoutSetting);

  // Read the latest value at call time: resize events can arrive in bursts between renders.
  const saveGroup = useCallback((groupId: string, groupLayout: GroupLayout) => {
    const prev = getSetting(layoutSetting);
    setSetting(layoutSetting, { ...prev, groups: { ...prev.groups, [groupId]: groupLayout } });
  }, []);

  const setDock = useCallback((dock: FilePanelDock) => {
    const prev = getSetting(layoutSetting);
    if (prev.dock !== dock) setSetting(layoutSetting, { ...prev, dock });
  }, []);

  const setSidebarView = useCallback((sidebarView: SidebarView) => {
    const prev = getSetting(layoutSetting);
    if (prev.sidebarView !== sidebarView) setSetting(layoutSetting, { ...prev, sidebarView });
  }, []);

  return { layout, saveGroup, setDock, setSidebarView };
}
