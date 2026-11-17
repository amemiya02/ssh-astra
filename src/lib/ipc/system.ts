import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * The system clipboard, through the Tauri plugin rather than
 * `navigator.clipboard` (WebKit asks the user before every read).
 */
export function readClipboardText(): Promise<string> {
  return readText();
}

export function writeClipboardText(text: string): Promise<void> {
  return writeText(text);
}

/** Opens a web link in the user's browser. Only http(s) is allowed (see capabilities). */
export function openExternalUrl(url: string): Promise<void> {
  return openUrl(url);
}
