/**
 * How many lines pasting `text` would send. A single trailing line break does
 * not count as another line; more than one line asks for confirmation first.
 */
export function pasteLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
}

interface InvisiblePasteCharacter {
  character: string;
  offset: number;
  line: number;
  column: number;
}

export interface PendingPaste {
  text: string;
  lines: number;
  invisibleCharacters?: InvisiblePasteCharacter[];
}

// Tabs and conventional line endings are normal terminal input.
const invisibleCharacter = /(?![\t\r\n])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

function findInvisibleCharacters(text: string): InvisiblePasteCharacter[] {
  const positions: InvisiblePasteCharacter[] = [];
  if (!invisibleCharacter.test(text)) return positions;

  let line = 1;
  let column = 1;
  let offset = 0;
  for (const character of text) {
    if (character === "\r" || character === "\n") {
      if (character === "\r" || text[offset - 1] !== "\r") line++;
      column = 1;
    } else {
      if (invisibleCharacter.test(character)) positions.push({ character, offset, line, column });
      column++;
    }
    offset += character.length;
  }
  return positions;
}

/** Ask before pasting invisible characters, or several lines when multi-line confirmation is on. */
export function planPaste(
  text: string,
  confirm: boolean,
): { paste: string } | { ask: PendingPaste } | null {
  const lines = pasteLines(text);
  if (lines === 0) return null;
  const invisibleCharacters = findInvisibleCharacters(text);
  if (invisibleCharacters.length > 0) return { ask: { text, lines, invisibleCharacters } };
  return confirm && lines > 1 ? { ask: { text, lines } } : { paste: text };
}

/** Snippets use terminal paste encoding, with an optional Enter after the paste. */
export function terminalPasteInput(text: string, bracketed: boolean, enter: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  const paste = normalized && bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  return enter ? paste + "\r" : paste;
}
