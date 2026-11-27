const maxCommandLength = 512;
const nonPrintable = /[\p{C}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

export function isPlainCommandText(text: string): boolean {
  return text.length <= maxCommandLength && !nonPrintable.test(text);
}

/** The saved lines are newest first. An exact match has no suffix. */
export function selectHistorySuffix(commands: readonly string[], prefix: string): string | undefined {
  if (!prefix || prefix.startsWith(" ") || !isPlainCommandText(prefix)) return;
  const match = commands.find((command) => command.startsWith(prefix) && isPlainCommandText(command));
  const suffix = match?.slice(prefix.length);
  // A leading mark can change the last typed glyph instead of appearing after it.
  return suffix && !/^\p{M}/u.test(suffix) ? suffix : undefined;
}
