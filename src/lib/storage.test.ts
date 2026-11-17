import { describe, expect, it, vi } from "vitest";
import { defineSection, openSettings, type KeyValueStore, type SettingsBackend } from "./storage";

/** A settings file in memory: what `load` returns is what was last saved. */
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

function memoryKeyValues(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const fontSize = defineSection("example", { size: 13 }, (raw) => {
  const size = (raw as { size?: unknown } | null)?.size;
  return { size: typeof size === "number" && size >= 6 && size <= 72 ? size : 13 };
});

describe("settings", () => {
  it("gives a section's defaults when the file has nothing for it", async () => {
    const settings = await openSettings(memoryBackend());
    expect(settings.get(fontSize)).toEqual({ size: 13 });
  });

  it("reads what the file holds, repaired by the section's parser", async () => {
    expect((await openSettings(memoryBackend({ example: { size: 20 } }))).get(fontSize)).toEqual({ size: 20 });
    expect((await openSettings(memoryBackend({ example: { size: 900 } }))).get(fontSize)).toEqual({ size: 13 });
    expect((await openSettings(memoryBackend({ example: "garbage" }))).get(fontSize)).toEqual({ size: 13 });
  });

  it("applies a change at once and saves it for the next start", async () => {
    const backend = memoryBackend();
    const settings = await openSettings(backend);
    const listener = vi.fn();
    settings.subscribe(listener);

    settings.set(fontSize, { size: 16 });

    expect(settings.get(fontSize)).toEqual({ size: 16 });
    expect(listener).toHaveBeenCalled();
    await Promise.resolve();
    expect((await openSettings(backend)).get(fontSize)).toEqual({ size: 16 });
  });

  it("starts from defaults and keeps working in memory when the file cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings = await openSettings({
      load: () => Promise.reject(new Error("written by a newer sshastra")),
      save: () => Promise.reject(new Error("unavailable")),
    });

    expect(settings.get(fontSize)).toEqual({ size: 13 });
    settings.set(fontSize, { size: 18 });
    expect(settings.get(fontSize)).toEqual({ size: 18 });
    await new Promise((r) => setTimeout(r));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops notifying a listener once it unsubscribes", async () => {
    const settings = await openSettings(memoryBackend());
    const listener = vi.fn();
    const unsubscribe = settings.subscribe(listener);
    unsubscribe();
    settings.set(fontSize, { size: 14 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("moving preferences out of localStorage", () => {
  it("imports the theme, layout and Terminal preferences saved by earlier builds, then forgets them", async () => {
    const backend = memoryBackend();
    const legacy = memoryKeyValues({
      "sshastra.theme": "dark",
      "sshastra.layout.v1": JSON.stringify({ dock: "bottom", groups: { shell: { sidebar: 20, main: 80 } } }),
      "sshastra.terminal": JSON.stringify({ fontSize: 15, copyOnSelect: false }),
      "unrelated": "kept",
    });

    await openSettings(backend, legacy);
    await Promise.resolve();

    expect(backend.file).toEqual({
      appearance: { theme: "dark" },
      layout: { dock: "bottom", groups: { shell: { sidebar: 20, main: 80 } } },
      terminal: { fontSize: 15, copyOnSelect: false },
    });
    expect([...legacy.data.keys()]).toEqual(["unrelated"]);
  });

  it("never overwrites a section the settings file already has", async () => {
    const backend = memoryBackend({ appearance: { theme: "light" } });
    const legacy = memoryKeyValues({ "sshastra.theme": "dark" });

    await openSettings(backend, legacy);

    expect(backend.file).toEqual({ appearance: { theme: "light" } });
    expect(legacy.data.size).toBe(0);
  });

  it("skips values that are not valid JSON", async () => {
    const backend = memoryBackend();
    await openSettings(backend, memoryKeyValues({ "sshastra.layout.v1": "{oops" }));
    expect(backend.file).toEqual({});
  });
});
