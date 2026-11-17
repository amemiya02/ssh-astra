import { describe, expect, it } from "vitest";
import { appearanceSetting, applyTheme, resolveTheme } from "./theme";

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

describe("appearance settings", () => {
  it("reads a saved theme preference", () => {
    expect(appearanceSetting.parse({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(appearanceSetting.parse({ theme: "light" })).toEqual({ theme: "light" });
  });

  it("follows the system when nothing or garbage is saved", () => {
    expect(appearanceSetting.parse(undefined)).toEqual({ theme: "system" });
    expect(appearanceSetting.parse({ theme: "purple" })).toEqual({ theme: "system" });
    expect(appearanceSetting.parse("dark")).toEqual({ theme: "system" });
    expect(appearanceSetting.parse(null)).toEqual({ theme: "system" });
  });
});
