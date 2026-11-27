import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { paletteActions } from "@/features/palette/palette-actions";
import { startI18n } from "@/i18n";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { AppShell } from "./AppShell";
import { getSetting, setSetting } from "@/lib/storage";
import { useFilePanelDock } from "./file-panel-dock";
import type { PaneKind } from "@/features/workspace/tabs";
import { defaultShellLayout, layoutSetting } from "./shell-layout";

let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  // jsdom lays nothing out; give every element a window-sized box so the panels can measure.
  const box = { x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  HTMLElement.prototype.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
  startI18n();
});

beforeEach(() => setSetting(layoutSetting, defaultShellLayout));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function DockState() {
  const { collapsed } = useFilePanelDock();
  return <p data-testid="dock">{collapsed ? "hidden" : "shown"}</p>;
}

function shell(activeKind: PaneKind["kind"] | null) {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AppShell
          sidebar={{ hosts: <p>hosts view</p>, forwards: <p>forwards view</p> }}
          nav={{ activeKind, onHome() {}, onSftp() {}, onLocalTerminal() {}, onSettings() {} }}
          tabs={null}
          workspace={null}
          filePanel={<DockState />}
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function render(activeKind: PaneKind["kind"] | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(shell(activeKind)));
  return container;
}

/** The focused tab changes to `activeKind`. */
const focus = (activeKind: PaneKind["kind"] | null) => act(() => root!.render(shell(activeKind)));

const toggleAction = () => paletteActions.list().find((a) => a.id === "files.togglePanel");

describe("AppShell", () => {
  it("offers showing and hiding the File panel in the command palette", () => {
    const container = render();
    const dock = () => container.querySelector('[data-testid="dock"]')!.textContent;
    expect(dock()).toBe("shown");
    expect(toggleAction()?.title).toBe("Hide File panel");

    act(() => toggleAction()!.run());

    expect(dock()).toBe("hidden");
    expect(toggleAction()?.title).toBe("Show File panel");

    act(() => toggleAction()!.run());

    expect(dock()).toBe("shown");
  });

  it("shows the Host list first and switches the sidebar view from the command palette", () => {
    const container = render();
    const view = (text: string) => [...container.querySelectorAll("aside > div")].find((el) => el.textContent === text)!;
    expect(view("hosts view").hasAttribute("hidden")).toBe(false);
    expect(view("forwards view").hasAttribute("hidden")).toBe(true);

    act(() => paletteActions.list().find((a) => a.id === "shell.showForwards")!.run());

    expect(view("hosts view").hasAttribute("hidden")).toBe(true);
    expect(view("forwards view").hasAttribute("hidden")).toBe(false);
    expect(getSetting(layoutSetting).sidebarView).toBe("forwards");

    act(() => paletteActions.list().find((a) => a.id === "shell.showHosts")!.run());
    expect(getSetting(layoutSetting).sidebarView).toBe("hosts");
  });

  it("marks the open sidebar view on the rail, and its button collapses and reopens the column", () => {
    const container = render();
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`nav button[aria-label="${label}"]`)!;
    expect(button("Hosts").getAttribute("aria-pressed")).toBe("true");
    expect(button("Port forwards").getAttribute("aria-pressed")).toBe("false");

    act(() => button("Port forwards").click());
    expect(button("Hosts").getAttribute("aria-pressed")).toBe("false");
    expect(button("Port forwards").getAttribute("aria-pressed")).toBe("true");

    act(() => button("Port forwards").click());
    expect(button("Port forwards").getAttribute("aria-pressed")).toBe("false");

    act(() => button("Port forwards").click());
    expect(button("Port forwards").getAttribute("aria-pressed")).toBe("true");
  });

  describe("on Home", () => {
    const button = (container: HTMLElement, label: string) =>
      container.querySelector<HTMLButtonElement>(`nav button[aria-label="${label}"]`)!;
    const shown = (container: HTMLElement) => button(container, "Hosts").getAttribute("aria-pressed") === "true";

    it("hides the Host list, which Home repeats, and brings it back when another tab is focused", () => {
      const container = render("home");
      expect(shown(container)).toBe(false);

      focus("local-terminal");
      expect(shown(container)).toBe(true);

      focus("home");
      expect(shown(container)).toBe(false);
    });

    it("saves nothing for the hidden column", () => {
      const container = render("local-terminal");
      focus("home");
      expect(shown(container)).toBe(false);
      expect(getSetting(layoutSetting).groups.shell?.sidebar).toBeGreaterThan(1);
    });

    it("opens the column for this visit from the Hosts button, and closes it again from there", () => {
      const container = render("home");
      act(() => button(container, "Hosts").click());
      expect(shown(container)).toBe(true);

      act(() => button(container, "Hosts").click());
      expect(shown(container)).toBe(false);

      act(() => button(container, "Hosts").click());
      focus("local-terminal");
      expect(shown(container)).toBe(true);
    });

    it("keeps a column the user closed closed when leaving Home", () => {
      const container = render("local-terminal");
      act(() => button(container, "Hosts").click());
      expect(shown(container)).toBe(false);

      focus("home");
      focus("local-terminal");
      expect(shown(container)).toBe(false);
    });

    it("still shows the Port forwards view", () => {
      const container = render("home");
      act(() => button(container, "Port forwards").click());
      expect(button(container, "Port forwards").getAttribute("aria-pressed")).toBe("true");
      expect(shown(container)).toBe(false);
    });
  });

  it("gives the focused page the tile and a shown sidebar view only a bar, never both on one item", () => {
    const container = render("settings");
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`nav button[aria-label="${label}"]`)!;
    const tile = (label: string) => button(label).classList.contains("bg-selected");
    const bar = (label: string) => button(label).parentElement!.querySelector("[data-rail-indicator]") !== null;

    expect(button("Settings").getAttribute("aria-current")).toBe("page");
    expect(button("Settings").getAttribute("aria-pressed")).toBeNull();
    expect(tile("Settings")).toBe(true);
    expect(bar("Settings")).toBe(false);

    expect(button("Hosts").getAttribute("aria-pressed")).toBe("true");
    expect(button("Hosts").getAttribute("aria-current")).toBeNull();
    expect(tile("Hosts")).toBe(false);
    expect(bar("Hosts")).toBe(true);

    expect(bar("Port forwards")).toBe(false);
  });

  it("withdraws the action when the shell unmounts", () => {
    render();
    act(() => root?.unmount());
    root = null;
    expect(toggleAction()).toBeUndefined();
  });
});
