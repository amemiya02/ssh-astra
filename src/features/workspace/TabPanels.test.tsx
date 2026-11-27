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
