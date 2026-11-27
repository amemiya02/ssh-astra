import { describe, expect, it } from "vitest";
import sample from "@/theme/fixtures/sample.itermcolors?raw";
import { parseItermColors } from "@/theme/iterm-colors";
import { openSettings, type SettingsBackend } from "@/lib/storage";
import { defaultTerminalPrefs, normalizeTerminalPrefs, terminalSetting } from "./terminal-prefs";

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
    expect(prefs.bell).toBe("none");
    expect(prefs.copyOnSelect).toBe(true);
    expect(prefs.rightClickPaste).toBe(true);
    expect(prefs.shellIntegration).toBe(true);
    expect(prefs.confirmMultilinePaste).toBe(true);
  });

  it("survives a restart", async () => {
    const backend = memoryBackend();
    const palette = parseItermColors(sample)!;
    const changed = {
      fontFamily: '"Fira Code", monospace',
      fontSize: 15,
      fontWeight: 600,
      lineHeight: 1.45,
      letterSpacing: 2,
      cursorStyle: "bar" as const,
      cursorBlink: false,
      wordSeparator: " ,./",
      titleSource: "host" as const,
      bell: "sound" as const,
      ligatures: true,
      colorScheme: "imported:sample" as const,
      importedSchemes: [{ id: "imported:sample" as const, name: "Sample", palette }],
      highlighting: {
        builtIn: false,
        rules: [{ id: "job", pattern: "job \\d+", kind: "regex" as const, hue: "magenta" as const, enabled: true }],
      },
      copyOnSelect: false,
      rightClickPaste: false,
      shellIntegration: false,
      confirmMultilinePaste: false,
    };
    (await openSettings(backend)).set(terminalSetting, changed);
    expect(backend.file.terminal).toEqual(changed);
    expect((await openSettings(backend)).get(terminalSetting)).toEqual(changed);
  });

  it("repairs invalid appearance preferences while preserving valid separator spaces and typography", () => {
    expect(normalizeTerminalPrefs({
      fontWeight: 950,
      lineHeight: 0.5,
      letterSpacing: 2.7,
      cursorStyle: "circle",
      cursorBlink: "off",
      wordSeparator: " ,./ ",
      titleSource: "directory",
      bell: "both",
    })).toMatchObject({
      fontWeight: 900,
      lineHeight: 1,
      letterSpacing: 3,
      cursorStyle: "block",
      cursorBlink: true,
      wordSeparator: " ,./ ",
      titleSource: "shell",
      bell: "none",
    });
    expect(normalizeTerminalPrefs({
      fontWeight: "heavy",
      lineHeight: Infinity,
      letterSpacing: NaN,
      wordSeparator: "",
    })).toEqual(defaultTerminalPrefs);
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
