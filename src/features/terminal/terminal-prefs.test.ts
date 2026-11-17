import { describe, expect, it } from "vitest";
import { openSettings, type SettingsBackend } from "@/lib/storage";
import { defaultTerminalPrefs, terminalSetting } from "./terminal-prefs";

function memoryBackend(initial: Record<string, unknown> = {}): SettingsBackend & { file: Record<string, unknown> } {
  const file = structuredClone(initial);
  return {
    file,
    load: () => Promise.resolve(structuredClone(file)),
    save: (section, value) => {
      file[section] = structuredClone(value);
      return Promise.resolve();
    },
  };
}

describe("terminal preferences", () => {
  it("defaults to the design's Terminal font, follows the app theme, and turns copy on select and right-click paste on", async () => {
    const prefs = (await openSettings(memoryBackend())).get(terminalSetting);
    expect(prefs).toEqual(defaultTerminalPrefs);
    expect(prefs.fontSize).toBe(13);
    expect(prefs.fontFamily).toContain("monospace");
    expect(prefs.ligatures).toBe(false);
    expect(prefs.colorScheme).toBe("app");
    expect(prefs.copyOnSelect).toBe(true);
    expect(prefs.rightClickPaste).toBe(true);
    expect(prefs.shellIntegration).toBe(true);
  });

  it("survives a restart", async () => {
    const backend = memoryBackend();
    const changed = {
      fontFamily: '"Fira Code", monospace',
      fontSize: 15,
      ligatures: true,
      colorScheme: "solarizedDark" as const,
      copyOnSelect: false,
      rightClickPaste: false,
      shellIntegration: false,
    };
    (await openSettings(backend)).set(terminalSetting, changed);
    expect(backend.file.terminal).toEqual(changed);
    expect((await openSettings(backend)).get(terminalSetting)).toEqual(changed);
  });

  it("keeps the valid parts of a damaged or older saved value and defaults the rest", async () => {
    const backend = memoryBackend({
      terminal: { fontSize: 400, colorScheme: "neon", copyOnSelect: false, fontFamily: "", shellIntegration: "no" },
    });
    expect((await openSettings(backend)).get(terminalSetting)).toEqual({
      ...defaultTerminalPrefs,
      fontSize: 32,
      copyOnSelect: false,
    });
  });

  it("ignores a saved value that is not an object", async () => {
    const settings = await openSettings(memoryBackend({ terminal: "{oops" }));
    expect(settings.get(terminalSetting)).toEqual(defaultTerminalPrefs);
  });

  it("imports the preferences an earlier build kept in localStorage", async () => {
    const backend = memoryBackend();
    const data = new Map([["sshastra.terminal", JSON.stringify({ fontSize: 16, ligatures: true })]]);
    const legacy = { getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => void data.delete(k) };
    const settings = await openSettings(backend, legacy);
    expect(settings.get(terminalSetting)).toEqual({ ...defaultTerminalPrefs, fontSize: 16, ligatures: true });
    expect(data.size).toBe(0);
  });
});
