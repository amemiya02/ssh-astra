import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import { closeRemoteEdit } from "@/lib/ipc/edit";
import type { Host } from "@/lib/ipc/hosts";
import { emptyTabs, newPane, remoteTerminalPaneIds, tabsReducer, type TabsState } from "@/features/workspace/tabs";
import { FilePanelDockContext } from "@/features/shell/file-panel-dock";
import { FilePanelContent } from "./FilePanelContent";
import { fileBrowsers } from "./fileBrowsers";

// The real File panels (`fileBrowsers`) over fake SFTP and remote edit commands.
vi.mock("@/lib/ipc/files", () => ({
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn(() => Promise.resolve({ path: "/etc", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(),
  renameFile: vi.fn(),
  countFiles: vi.fn(),
  deleteFiles: vi.fn(),
  chmodFile: vi.fn(),
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
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function render(state: TabsState) {
  const container = document.createElement("div");
  root = createRoot(container);
  const show = (s: TabsState) =>
    act(() =>
      root!.render(
        <FilePanelDockContext value={{ dock: "right", collapsed: false, collapse() {} }}>
          <TooltipProvider>
            <FilePanelContent remotePaneIds={remoteTerminalPaneIds(s)} />
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
