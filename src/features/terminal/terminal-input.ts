/**
 * How many lines pasting `text` would send. A single trailing line break does
 * not count as another line; more than one line asks for confirmation first.
 */
export function pasteLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
}

/** Whether the platform uses Cmd (not Ctrl) for app shortcuts. */
export const isMacPlatform = (): boolean => /mac/i.test(navigator.userAgent);

/**
 * The "find in Terminal" chord: Cmd+F on macOS, Ctrl+Shift+F elsewhere, so
 * Ctrl+F still reaches the shell (forward-char in readline).
 */
export function isFindShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (event.type !== "keydown" || event.key.toLowerCase() !== "f" || event.altKey) return false;
  return mac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
}
