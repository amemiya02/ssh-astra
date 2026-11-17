/** True on macOS, where app shortcuts use Cmd instead of Ctrl. */
export const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Opens Settings: Cmd+, on macOS, Ctrl+, elsewhere. */
export function isSettingsShortcut(event: KeyboardEvent, mac = isMac): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return primary && !event.shiftKey && !event.altKey && event.key === ",";
}

/** The Settings shortcut as shown in tooltips. */
export const settingsShortcut = isMac ? "⌘," : "Ctrl+,";
