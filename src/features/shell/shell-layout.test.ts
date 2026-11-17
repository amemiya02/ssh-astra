import { describe, expect, it } from "vitest";
import { defaultShellLayout, isPanelCollapsed, layoutSetting } from "./shell-layout";

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

describe("layout settings", () => {
  it("starts with the File panel docked on the right and no saved sizes", () => {
    expect(layoutSetting.parse(undefined)).toEqual(defaultShellLayout);
    expect(defaultShellLayout.dock).toBe("right");
  });

  it("restores the dock and panel sizes saved before a restart", () => {
    const saved = { dock: "bottom", groups: { shell: { sidebar: 22, main: 78 } } };
    expect(layoutSetting.parse(saved)).toEqual(saved);
  });

  it("falls back to the default layout when the saved value is not an object", () => {
    expect(layoutSetting.parse("{oops")).toEqual(defaultShellLayout);
    expect(layoutSetting.parse([1, 2])).toEqual(defaultShellLayout);
    expect(layoutSetting.parse(null)).toEqual(defaultShellLayout);
  });

  it("keeps the valid parts of a damaged saved layout and drops the rest", () => {
    const saved = {
      dock: "left",
      groups: {
        shell: { sidebar: 30, main: 70 },
        broken: { a: "wide", b: 50 },
        negative: { a: -5, b: 105 },
        notAnObject: 3,
      },
    };
    expect(layoutSetting.parse(saved)).toEqual({
      dock: "right",
      groups: { shell: { sidebar: 30, main: 70 } },
    });
  });
});
