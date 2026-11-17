/**
 * How many lines pasting `text` would send. A single trailing line break does
 * not count as another line; more than one line asks for confirmation first.
 */
export function pasteLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
}
