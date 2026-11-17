import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
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

/** A file type offered in a file picker, e.g. `{ name: "JSON", extensions: ["json"] }`. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Asks where to save a file (native picker); null if the user cancels. */
export function pickSavePath(options: { title: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null> {
  return save(options);
}

/** Asks for one file to open (native picker); null if the user cancels. */
export function pickOpenPath(options: { title: string; filters?: FileFilter[] }): Promise<string | null> {
  return open({ ...options, multiple: false, directory: false });
}
