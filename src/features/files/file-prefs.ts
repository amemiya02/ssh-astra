import { defineSection } from "@/lib/storage";
import type { FileSort, SortKey } from "./fileList";

/** How every File panel lists files. */
export interface FilesPrefs {
  /** Show dotfiles. */
  showHidden: boolean;
  sort: FileSort;
  showModified: boolean;
  showPermissions: boolean;
}

export const defaultFilesPrefs: FilesPrefs = {
  showHidden: false,
  sort: { key: "name", direction: "asc" },
  showModified: true,
  showPermissions: false,
};

const sortKeys: readonly SortKey[] = ["name", "size", "modified", "permissions"];

/** The `files` section of the settings file. */
export const filesSetting = defineSection<FilesPrefs>("files", defaultFilesPrefs, (raw) => {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const sort = typeof value.sort === "object" && value.sort !== null ? (value.sort as Record<string, unknown>) : {};
  return {
    showHidden: typeof value.showHidden === "boolean" ? value.showHidden : defaultFilesPrefs.showHidden,
    sort: {
      key: sortKeys.includes(sort.key as SortKey) ? (sort.key as SortKey) : defaultFilesPrefs.sort.key,
      direction: sort.direction === "desc" ? "desc" : "asc",
    },
    showModified: typeof value.showModified === "boolean" ? value.showModified : defaultFilesPrefs.showModified,
    showPermissions: typeof value.showPermissions === "boolean" ? value.showPermissions : defaultFilesPrefs.showPermissions,
  };
});
