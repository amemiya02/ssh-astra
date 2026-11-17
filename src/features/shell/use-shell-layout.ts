import { useCallback, useEffect, useState } from "react";
import { browserStore } from "@/lib/storage";
import {
  loadShellLayout,
  saveShellLayout,
  type FilePanelDock,
  type GroupLayout,
  type ShellLayout,
} from "./shell-layout";

/** The persisted main window layout, saved whenever it changes. */
export function useShellLayout() {
  const [store] = useState(browserStore);
  const [layout, setLayout] = useState<ShellLayout>(() => loadShellLayout(store));

  useEffect(() => saveShellLayout(store, layout), [store, layout]);

  const saveGroup = useCallback((groupId: string, groupLayout: GroupLayout) => {
    setLayout((prev) => ({ ...prev, groups: { ...prev.groups, [groupId]: groupLayout } }));
  }, []);

  const setDock = useCallback((dock: FilePanelDock) => {
    setLayout((prev) => (prev.dock === dock ? prev : { ...prev, dock }));
  }, []);

  return { layout, saveGroup, setDock };
}
