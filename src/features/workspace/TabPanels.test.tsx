import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { TabPanels } from "./TabPanels";
import { emptyTabs, newPane, tabsReducer, type TabsAction } from "./tabs";

// Keep the real workspace and reducer while substituting a Terminal that can hold user input.
vi.mock("@/features/terminal/LocalTerminalView", () => ({
  LocalTerminalView: () => <input aria-label="Test terminal" />,
}));
vi.mock("@/features/terminal/RemoteTerminalView", () => ({ RemoteTerminalView: () => null }));

const local = (id: string) => newPane({ kind: "local-terminal" }, id);
let root: Root | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

function renderWorkspace() {
  const container = document.createElement("div");
  root = createRoot(container);
  let state = emptyTabs;
  function dispatch(action: TabsAction) {
    state = tabsReducer(state, action);
    root!.render(
      <TabPanels
        tabs={state.tabs}
        activeId={state.activeId}
        renderHome={() => null}
        onFocusPane={(paneId) => dispatch({ type: "focusPane", paneId })}
        onClosePane={(paneId) => dispatch({ type: "closePane", paneId })}
        onEditHost={() => {}}
        onConnectRestoredPane={(paneId) => dispatch({ type: "connectRestoredPane", paneId })}
        onTitleChange={() => {}}
        onStatusChange={() => {}}
        onResizeSplit={(tabId, resize) => dispatch({ type: "resizeSplit", tabId, ...resize })}
      />,
    );
  }
  const send = (action: TabsAction) => act(() => dispatch(action));
  send({ type: "open", tabId: "work", pane: local("a") });
  return { container, send };
}

describe("TabPanels", () => {
  it("keeps open Terminals and their input mounted through nested splits, close and hide", () => {
    const { container, send } = renderWorkspace();
    const terminals = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Test terminal"]')];
    const [first] = terminals();
    first!.value = "first pane's command";
    send({ type: "split", orientation: "horizontal", pane: local("b") });
    const second = terminals()[1]!;
    second.value = "second pane's command";
    send({ type: "split", paneId: "a", orientation: "vertical", pane: local("c") });
    expect(terminals()[0]).toBe(first);
    expect(terminals()[2]).toBe(second);

    send({ type: "open", tabId: "other", pane: newPane({ kind: "home" }, "home") });
    expect(container.querySelector("#tabpanel-work")?.hasAttribute("hidden")).toBe(true);
    send({ type: "activate", id: "work" });
    send({ type: "closePane", paneId: "c" });

    expect(terminals()).toEqual([first, second]);
    expect(terminals().map((input) => input.value)).toEqual(["first pane's command", "second pane's command"]);
  });

  it("maximizes the focused Terminal and restores its siblings with their input and proportions intact", () => {
    const { container, send } = renderWorkspace();
    send({ type: "split", orientation: "horizontal", pane: local("b") });
    send({ type: "resizeSplit", tabId: "work", path: [], after: 0, fraction: 0.75 });
    const first = container.querySelector<HTMLElement>("#pane-a")!;
    const second = container.querySelector<HTMLElement>("#pane-b")!;
    const input = first.querySelector("input")!;
    input.value = "unfinished command";

    send({ type: "toggleMaximizePane" });
    expect(first.hidden).toBe(true);
    expect(first.querySelector("input")).toBe(input);
    expect(second.hidden).toBe(false);
    expect(second.style.left).toBe("0%");
    expect(second.style.width).toBe("100%");
    expect(second.style.height).toBe("100%");
    expect(container.querySelector('[role="separator"]')).toBeNull();

    send({ type: "toggleMaximizePane" });
    expect(first.hidden).toBe(false);
    expect(first.querySelector("input")).toBe(input);
    expect(input.value).toBe("unfinished command");
    expect(second.style.left).toBe("75%");
    expect(second.style.width).toBe("25%");
    expect(container.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("75");
  });

  it("moves the same Terminal surfaces to each other's positions when swapping panes", () => {
    const { container, send } = renderWorkspace();
    send({ type: "split", orientation: "horizontal", pane: local("b") });
    const first = container.querySelector("#pane-a input");
    const second = container.querySelector("#pane-b input");

    send({ type: "swapPane", direction: "left" });

    expect(container.querySelector("#pane-a input")).toBe(first);
    expect(container.querySelector("#pane-b input")).toBe(second);
    expect(container.querySelector<HTMLElement>("#pane-a")?.style.left).toBe("50%");
    expect(container.querySelector<HTMLElement>("#pane-b")?.style.left).toBe("0%");
  });

  it("changes the proportion of a nested split while dragging and keeps it after release", () => {
    const { container, send } = renderWorkspace();
    send({ type: "split", orientation: "horizontal", pane: local("b") });
    send({ type: "split", orientation: "vertical", pane: local("c") });
    const divider = container.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]')!;
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
    divider.setPointerCapture = vi.fn();
    const pointer = (type: string, clientY: number) => act(() => {
      divider.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientY }));
    });

    pointer("pointerdown", 300);
    pointer("pointermove", 450);
    expect(divider.getAttribute("aria-valuenow")).toBe("75");
    pointer("pointerup", 450);
    send({ type: "focusPane", paneId: "b" });

    expect(divider.getAttribute("aria-valuenow")).toBe("75");
    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')?.getAttribute("aria-valuenow")).toBe("50");
  });
});
