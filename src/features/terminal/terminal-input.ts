/**
 * How many lines pasting `text` would send. A single trailing line break does
 * not count as another line; more than one line asks for confirmation first.
 */
export function pasteLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
}

/**
 * What pasting `text` does: paste it at once, ask first (several lines while `confirm`, the
 * `confirmMultilinePaste` preference, is on), or nothing for empty text.
 */
export function planPaste(
  text: string,
  confirm: boolean,
): { paste: string } | { ask: { text: string; lines: number } } | null {
  const lines = pasteLines(text);
  if (lines === 0) return null;
  return confirm && lines > 1 ? { ask: { text, lines } } : { paste: text };
}
