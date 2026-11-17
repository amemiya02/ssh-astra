import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@/lib/storage";
import { defaultTerminalPrefs, loadTerminalPrefs, saveTerminalPrefs } from "./terminal-prefs";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("terminal preferences", () => {
  it("defaults to the design's Terminal font, follows the app theme, and turns copy on select and right-click paste on", () => {
    const prefs = loadTerminalPrefs(memoryStore());
    expect(prefs).toEqual(defaultTerminalPrefs);
    expect(prefs.fontSize).toBe(13);
    expect(prefs.fontFamily).toContain("monospace");
    expect(prefs.ligatures).toBe(false);
    expect(prefs.colorScheme).toBe("app");
    expect(prefs.copyOnSelect).toBe(true);
    expect(prefs.rightClickPaste).toBe(true);
  });

  it("survives a restart", () => {
    const store = memoryStore();
    const changed = {
      fontFamily: '"Fira Code", monospace',
      fontSize: 15,
      ligatures: true,
      colorScheme: "solarizedDark" as const,
      copyOnSelect: false,
      rightClickPaste: false,
    };
    saveTerminalPrefs(store, changed);
    expect(loadTerminalPrefs(store)).toEqual(changed);
  });

  it("keeps the valid parts of a damaged or older saved value and defaults the rest", () => {
    const store = memoryStore({
      "sshastra.terminal": JSON.stringify({ fontSize: 400, colorScheme: "neon", copyOnSelect: false, fontFamily: "" }),
    });
    expect(loadTerminalPrefs(store)).toEqual({ ...defaultTerminalPrefs, fontSize: 32, copyOnSelect: false });
  });

  it("ignores a saved value that is not JSON", () => {
    expect(loadTerminalPrefs(memoryStore({ "sshastra.terminal": "{oops" }))).toEqual(defaultTerminalPrefs);
  });
});
