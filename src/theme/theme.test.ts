import { describe, expect, it } from "vitest";
import { applyTheme, loadThemePreference, resolveTheme, saveThemePreference } from "./theme";

describe("resolveTheme", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit preference override the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("marks the root dark and tells the browser which scheme native controls use", () => {
    const root = document.createElement("html");
    applyTheme(root, "dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");

    applyTheme(root, "light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("theme preference storage", () => {
  it("round-trips a saved preference", () => {
    const storage = new Map<string, string>();
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
    saveThemePreference(store, "dark");
    expect(loadThemePreference(store)).toBe("dark");
  });

  it("defaults to system when nothing or garbage is stored", () => {
    expect(loadThemePreference({ getItem: () => null })).toBe("system");
    expect(loadThemePreference({ getItem: () => "purple" })).toBe("system");
  });

  it("defaults to system when storage throws", () => {
    expect(
      loadThemePreference({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe("system");
  });
});
