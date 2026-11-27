import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import { listFiles } from "@/lib/ipc/files";
import * as transferIpc from "@/lib/ipc/transfers";
import { currentPlatform } from "@/features/workspace/shortcuts";
import { closeRemoteEdit } from "@/lib/ipc/edit";
import type { Host } from "@/lib/ipc/hosts";
import { emptyTabs, newPane, remoteTerminalPaneIds, tabsReducer, type TabsState } from "@/features/workspace/tabs";
import { FilePanelDockContext } from "@/features/shell/file-panel-dock";
import { FilePanelContent } from "./FilePanelContent";
import { fileBrowsers } from "./fileBrowsers";
import { terminalCwds } from "./terminalCwds";
import { useRetainRemoteFilePanels } from "./use-retain-remote-file-panels";

// The real File panels (`fileBrowsers`) over fake SFTP and remote edit commands.
vi.mock("@/lib/ipc/files", () => ({
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn((_id: number, path: string) => Promise.resolve({ path: path || "/etc", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(),
  compressFiles: vi.fn(() => Promise.resolve()),
  extractArchive: vi.fn(() => Promise.resolve()),
  createEmptyFile: vi.fn(),
  renameFile: vi.fn(),
  countFiles: vi.fn(),
  folderSize: vi.fn(),
  searchNames: vi.fn(() => Promise.resolve(null)),
  deleteFiles: vi.fn(),
  chmodFile: vi.fn(),
}));
// No native window to drop files on.
vi.mock("@/lib/ipc/transfers", async (original) => ({
  ...(await original<typeof import("@/lib/ipc/transfers")>()),
  copyRemoteFiles: vi.fn(() => Promise.resolve([1])),
  onOsFileDrag: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/lib/ipc/edit", () => ({
  maxEditSize: 10 * 1024 * 1024,
  openRemoteEdit: vi.fn((_host: string, path: string) => Promise.resolve(path.endsWith("a.conf") ? 1 : 2)),
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
}));

const host: Host = {
  id: "web",
  name: "web",
  address: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
  forwards: [],
};

let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function DockForTabs({ state }: { state: TabsState }) {
  useRetainRemoteFilePanels(remoteTerminalPaneIds(state));
  return <FilePanelContent />;
}

function render(state: TabsState) {
  const container = document.createElement("div");
  root = createRoot(container);
  const show = (s: TabsState) =>
    act(() =>
      root!.render(
        <FilePanelDockContext value={{ dock: "right", collapsed: false, collapse() {} }}>
          <TooltipProvider>
            <DockForTabs state={s} />
          </TooltipProvider>
        </FilePanelDockContext>,
      ),
    );
  show(state);
  return show;
}

async function editIn(paneId: string, name: string) {
  const store = fileBrowsers.get(paneId, host.id);
  await store.getState().connect();
  await store.getState().open({ name, kind: "file", size: 1, modified: null, permissions: null, linkTarget: null });
}

describe("closing a Terminal", () => {
  it("closes the File panel of a closed tab, stopping its remote edits (and their temp files)", async () => {
    const a = newPane({ kind: "remote-terminal", host });
    const b = newPane({ kind: "remote-terminal", host });
    let state = tabsReducer(emptyTabs, { type: "open", tabId: "t1", pane: a });
    state = tabsReducer(state, { type: "open", tabId: "t2", pane: b });
    await editIn(a.id, "a.conf");
    await editIn(b.id, "b.conf");
    const show = render(state);

    show(tabsReducer(state, { type: "close", id: "t1" }));

    expect(closeRemoteEdit).toHaveBeenCalledWith(1);
    expect(closeRemoteEdit).not.toHaveBeenCalledWith(2);
    expect(fileBrowsers.find(a.id)).toBeUndefined();
    expect(fileBrowsers.find(b.id)).toBeDefined();
  });

  it("closes the File panel of a closed split pane", async () => {
    const a = newPane({ kind: "remote-terminal", host });
    const b = newPane({ kind: "remote-terminal", host });
    let state = tabsReducer(emptyTabs, { type: "open", tabId: "t1", pane: a });
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: b });
    await editIn(b.id, "b.conf");
    vi.mocked(closeRemoteEdit).mockClear();
    const show = render(state);

    show(tabsReducer(state, { type: "closePane", paneId: b.id }));

    expect(closeRemoteEdit).toHaveBeenCalledWith(2);
    expect(fileBrowsers.find(b.id)).toBeUndefined();
  });
});

describe("a File panel following its Terminal's cd", () => {
  it("shows one path bar, for the new folder", async () => {
    const pane = newPane({ kind: "remote-terminal", host });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <FilePanelDockContext value={{ dock: "right", collapsed: false, collapse() {} }}>
          <TooltipProvider>
            <FilePanelContent pane={{ id: pane.id, host, status: "connected" }} />
          </TooltipProvider>
        </FilePanelDockContext>,
      ),
    );
    const pathBars = () => [...container.querySelectorAll('nav[aria-label="Path"]')]
      .map((bar) => [...bar.querySelectorAll("button")].map((crumb) => crumb.textContent));
    expect(pathBars()).toEqual([["/", "etc"]]);

    await act(async () => terminalCwds.report(pane.id, "/srv/www"));

    expect(pathBars()).toEqual([["/", "srv", "www"]]);
    container.remove();
  });
});


describe("copying between Hosts", () => {
  const source = { id: "from-pane", host: { ...host, defaultDirectory: "/source" }, status: "connected" } as const;
  const target = {
    id: "to-pane",
    host: { ...host, id: "backup", name: "Backup", defaultDirectory: "/target" },
    status: "connected",
  } as const;

  it("pastes the selected absolute paths from the previously focused Host", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const show = (pane: typeof source | typeof target) => act(async () => root!.render(
      <FilePanelDockContext value={{ dock: "right", collapsed: false, collapse() {} }}>
        <TooltipProvider>
          <FilePanelContent pane={pane} />
        </TooltipProvider>
      </FilePanelDockContext>,
    ));
    vi.mocked(listFiles).mockResolvedValueOnce({
      path: "/source", entries: [{ name: "notes.txt", kind: "file", size: 3, modified: null, permissions: null, linkTarget: null }],
    });
    const command = (code: string) => {
      const mac = currentPlatform() === "mac";
      container.querySelector('[role="grid"]')!.dispatchEvent(new KeyboardEvent("keydown", {
        code, key: code.at(-1)!.toLowerCase(), bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac,
      }));
    };

    await show(source);
    act(() => container.querySelector('[role="rowgroup"] [role="row"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => command("KeyC"));
    await show(target);
    await act(async () => command("KeyV"));

    expect(transferIpc.copyRemoteFiles).toHaveBeenCalledExactlyOnceWith(
      { id: "web", name: "web" }, ["/source/notes.txt"], { id: "backup", name: "Backup" }, "/target",
    );
    container.remove();
  });
});
