import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@/lib/storage";
import { defaultShellLayout, isPanelCollapsed, loadShellLayout, saveShellLayout } from "./shell-layout";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("isPanelCollapsed", () => {
  it("treats a panel resized to (almost) nothing as collapsed", () => {
    expect(isPanelCollapsed({ sidebar: 0, main: 100 }, "sidebar")).toBe(true);
    expect(isPanelCollapsed({ sidebar: 0.2, main: 99.8 }, "sidebar")).toBe(true);
    expect(isPanelCollapsed({ sidebar: 20, main: 80 }, "sidebar")).toBe(false);
  });

  it("treats a panel with no saved size as open", () => {
    expect(isPanelCollapsed(undefined, "sidebar")).toBe(false);
    expect(isPanelCollapsed({ main: 100 }, "sidebar")).toBe(false);
  });
});

describe("shell layout persistence", () => {
  it("starts with the File panel docked on the right and no saved sizes", () => {
    expect(loadShellLayout(memoryStore())).toEqual(defaultShellLayout);
    expect(defaultShellLayout.dock).toBe("right");
  });

  it("restores the dock and panel sizes saved before a restart", () => {
    const store = memoryStore();
    saveShellLayout(store, {
      dock: "bottom",
      groups: { shell: { sidebar: 22, main: 78 } },
    });
    expect(loadShellLayout(store)).toEqual({
      dock: "bottom",
      groups: { shell: { sidebar: 22, main: 78 } },
    });
  });

  it("falls back to the default layout when the saved value is not valid JSON", () => {
    expect(loadShellLayout(memoryStore({ "sshastra.layout.v1": "{oops" }))).toEqual(defaultShellLayout);
  });

  it("keeps the valid parts of a damaged saved layout and drops the rest", () => {
    const saved = JSON.stringify({
      dock: "left",
      groups: {
        shell: { sidebar: 30, main: 70 },
        broken: { a: "wide", b: 50 },
        negative: { a: -5, b: 105 },
        notAnObject: 3,
      },
    });
    expect(loadShellLayout(memoryStore({ "sshastra.layout.v1": saved }))).toEqual({
      dock: "right",
      groups: { shell: { sidebar: 30, main: 70 } },
    });
  });
});
