import { createContext, useContext } from "react";
import type { SettingRowDefinition } from "./setting-rows";

export const SettingsViewContext = createContext<{
  visibleRows: ReadonlySet<SettingRowDefinition>;
  searching: boolean;
} | null>(null);

export function useSettingRowVisible(row: SettingRowDefinition): boolean {
  return useContext(SettingsViewContext)?.visibleRows.has(row) ?? true;
}
