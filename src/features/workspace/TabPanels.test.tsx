import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import type { Host } from "@/lib/ipc/hosts";
import { TabPanels } from "./TabPanels";
import { TabStrip } from "./TabStrip";
import { emptyTabs, newPane, tabsReducer, type Pane, type TabsAction } from "./tabs";

// Keep the real workspace and reducer while substituting a Terminal that can hold user input.
vi.mock("@/features/terminal/LocalTerminalView", () => ({
  LocalTerminalView: () => <input aria-label="Test terminal" />,
}));
vi.mock("@/features/terminal/XtermView", () => ({
  XtermView: ({ attach }: { attach(terminal: Terminal): () => void }) => {
    useEffect(() => {
      const terminal = new Terminal();
      const detach = attach(terminal);
      return () => {
        detach();
        terminal.dispose();
      };
    }, [attach]);
    return null;
  },
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  let nextTerminalId = 0;
  return {
    ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
    Channel: class<T> {
      constructor(public onmessage: (message: T) => void) {}
    },
    invoke: vi.fn(async (command: string) => command === "remote_terminal_open" ? ++nextTerminalId : undefined),
  };
});

const local = (id: string) => newPane({ kind: "local-terminal" }, id);
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.mocked(invoke).mockClear();
});

function renderWorkspace(initialPane: Pane = local("a")) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let state = emptyTabs;
  function dispatch(action: TabsAction) {
    state = tabsReducer(state, action);
    root!.render(
      <TooltipProvider>
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeId}
          platform="mac"
          titleSource="shell"
          onActivate={(id) => dispatch({ type: "activate", id })}
          onTabAction={dispatch}
          onMove={() => {}}
          onNewLocalTerminal={() => {}}
          onSplit={() => {}}
        />
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
        />
      </TooltipProvider>,
    );
  }
  const send = (action: TabsAction) => act(() => dispatch(action));
  send({ type: "open", tabId: "work", pane: initialPane });
  return { container, send };
}

function selectTabMenu(tabId: string, label: string) {
  act(() => document.getElementById(`tab-${tabId}`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
  expect(item, label).toBeDefined();
  act(() => item!.click());
}

describe("TabPanels", () => {
  it.each([
    ["Close other tabs", ["tab-anchor", "tab-locked"]],
    ["Close tabs to the right", ["tab-work", "tab-anchor", "tab-locked"]],
  ])("uses the selected tab as the anchor for %s and keeps locked tabs", (label, survivors) => {
    const { container, send } = renderWorkspace();
    for (const id of ["anchor", "locked", "right"]) {
      send({ type: "open", tabId: id, pane: local(id) });
    }
    send({ type: "setTabLocked", id: "locked", locked: true });

    selectTabMenu("anchor", label);

    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.id)).toEqual(survivors);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("tab-anchor");
  });

  it("opens a separate remote Terminal for each duplicated pane on the same Host", async () => {
    const host: Host = {
      id: "test-host", name: "Test Host", address: "example.com", port: 22, user: "deploy",
      auth: { type: "password" }, jumpHost: null, groupId: null, forwards: [],
    };
    const remote = (id: string) => newPane({ kind: "remote-terminal", host }, id);
    const { container, send } = renderWorkspace(remote("a"));
    send({ type: "split", orientation: "horizontal", pane: remote("b") });
    await act(async () => {});
    vi.mocked(invoke).mockClear();

    selectTabMenu("work", "Duplicate tab");
    await act(async () => {});

    const opens = vi.mocked(invoke).mock.calls.filter(([command]) => command === "remote_terminal_open");
    expect(opens.map(([, args]) => (args as { hostId: string }).hostId)).toEqual([host.id, host.id]);
    expect(opens[0]![1]).toMatchObject({ onEvent: expect.any(Object) });
    expect((opens[0]![1] as { onEvent: unknown }).onEvent).not.toBe((opens[1]![1] as { onEvent: unknown }).onEvent);
    const sizes = vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_resize");
    expect(sizes.map(([, args]) => (args as { id: number }).id)).toEqual([3, 4]);
    const copy = container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
    expect(copy.id).not.toBe("tabpanel-work");
    expect(copy.querySelectorAll('[role="group"]')).toHaveLength(2);
  });
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
