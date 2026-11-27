import { invoke } from "@tauri-apps/api/core";
import { receiveSettingsChange, type SettingsChange } from "@/lib/storage";

export interface OpenSshPreview {
  line: string;
  addsInclude: boolean;
  approval: number;
}

export const previewOpenSshSync = () => invoke<OpenSshPreview>("ssh_config_export_preview");
export const cancelOpenSshPreview = () => invoke<void>("ssh_config_export_cancel");
export const enableOpenSshSync = (approval: number) =>
  invoke<SettingsChange>("ssh_config_export_enable", { approval }).then(receiveSettingsChange);
export const disableOpenSshSync = () =>
  invoke<SettingsChange>("ssh_config_export_disable").then(receiveSettingsChange);
export const refreshOpenSshSync = () => invoke<void>("ssh_config_export_refresh");
export const importOpenSshAliases = (approval: number) =>
  invoke<void>("ssh_config_sync_import", { approval });
