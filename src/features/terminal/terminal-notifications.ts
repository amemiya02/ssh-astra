import type { Terminal } from "@xterm/xterm";

function plainText(text: string): string {
  // The program supplies this text. Keep it short and strip control characters
  // before giving it to the operating system.
  const clean = text.slice(0, 512).replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").trim();
  return Array.from(clean).slice(0, 240).join("");
}

/** Follow iTerm2 OSC 9 and rxvt OSC 777 notification requests in Terminal output. */
export function watchTerminalNotifications(terminal: Terminal, onNotification: (body: string) => void): () => void {
  const message = terminal.parser.registerOscHandler(9, (data) => {
    // ConEmu subcommands use a numeric prefix for progress, directory changes and other requests.
    if (/^\d+;/.test(data)) return false;
    const body = plainText(data);
    if (body) onNotification(body);
    return true;
  });
  const titled = terminal.parser.registerOscHandler(777, (data) => {
    if (!data.startsWith("notify;")) return false;
    const separator = data.indexOf(";", "notify;".length);
    if (separator < 0) return true;
    const summary = plainText(data.slice("notify;".length, separator));
    const body = plainText(data.slice(separator + 1));
    if (summary || body) onNotification([summary, body].filter(Boolean).join("\n"));
    return true;
  });

  return () => {
    message.dispose();
    titled.dispose();
  };
}
