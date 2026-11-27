import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import type { EditEvent } from "@/lib/ipc/edit";
import { createFileBrowserStore, type FilesApi } from "./fileBrowserStore";
import { RemoteEdits } from "./RemoteEdits";

let editEvents: (event: EditEvent) => void = () => {};

const api: FilesApi = {
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn(() => Promise.resolve({ path: "/etc", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  openRemoteEdit: vi.fn((_host: string, _path: string, onEvent: (event: EditEvent) => void) => {
    editEvents = onEvent;
    return Promise.resolve(3);
  }),
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(() => Promise.resolve()),
  createEmptyFile: vi.fn(() => Promise.resolve()),
  renameFile: vi.fn(() => Promise.resolve()),
  countFiles: vi.fn(() => Promise.resolve(0)),
  deleteFiles: vi.fn(() => Promise.resolve()),
  chmodFile: vi.fn(() => Promise.resolve()),
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render() {
  const store = createFileBrowserStore(api, "host");
  await store.getState().connect();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <RemoteEdits store={store} hostName="web-1" />
      </TooltipProvider>,
    ),
  );
  return store;
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );

describe("RemoteEdits", () => {
  it("shows nothing while no file is open in the editor", async () => {
    await render();
    expect(container.textContent).toBe("");
  });

  it("reports a failed upload and retries it", async () => {
    const store = await render();
    await act(() => store.getState().open({ name: "app.conf", kind: "file", size: 1, modified: null, permissions: null, linkTarget: null }));
    act(() => editEvents({ state: "uploaded" }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved to web-1");

    act(() => editEvents({ state: "uploadFailed", reason: "connection lost" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Upload failed: connection lost");

    await act(async () => button("Retry")!.click());
    expect(api.retryRemoteEdit).toHaveBeenCalledWith(3);

    act(() => button("Stop editing app.conf")!.click());
    expect(api.closeRemoteEdit).toHaveBeenCalledWith(3);
    expect(container.textContent).toBe("");
  });
});
