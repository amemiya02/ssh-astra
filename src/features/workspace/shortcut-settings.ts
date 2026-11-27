import { defineSection, getSetting, useSetting } from "@/lib/storage";
import {
  currentPlatform,
  parseShortcutOverrides,
  resolveShortcuts,
  type Platform,
  type ResolvedShortcuts,
  type ShortcutOverrides,
} from "./shortcuts";

export const shortcutSetting = defineSection<ShortcutOverrides>("shortcuts", {}, parseShortcutOverrides);

const resolved = {
  mac: new WeakMap<ShortcutOverrides, ResolvedShortcuts>(),
  other: new WeakMap<ShortcutOverrides, ResolvedShortcuts>(),
};

function resolvedShortcuts(platform: Platform, overrides: ShortcutOverrides): ResolvedShortcuts {
  let table = resolved[platform].get(overrides);
  if (!table) {
    table = resolveShortcuts(platform, overrides);
    resolved[platform].set(overrides, table);
  }
  return table;
}

export function getResolvedShortcuts(platform = currentPlatform()): ResolvedShortcuts {
  return resolvedShortcuts(platform, getSetting(shortcutSetting));
}

export function useResolvedShortcuts(platform = currentPlatform()): ResolvedShortcuts {
  const [overrides] = useSetting(shortcutSetting);
  return resolvedShortcuts(platform, overrides);
}
