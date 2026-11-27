import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { EditQuestionDialog } from "./EditQuestionDialog";
import { createFileBrowserStore, type FilesApi } from "./fileBrowserStore";

const api = (openRemoteEdit: FilesApi["openRemoteEdit"]): FilesApi => ({
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn(() => Promise.resolve({ path: "/srv", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  openRemoteEdit,
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(() => Promise.resolve()),
  createEmptyFile: vi.fn(() => Promise.resolve()),
  renameFile: vi.fn(() => Promise.resolve()),
  countFiles: vi.fn(() => Promise.resolve(0)),
  folderSize: vi.fn(() => Promise.resolve(0)),
  deleteFiles: vi.fn(() => Promise.resolve()),
  chmodFile: vi.fn(() => Promise.resolve()),
});

let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function render(openRemoteEdit: FilesApi["openRemoteEdit"], size = 1) {
  const store = createFileBrowserStore(api(openRemoteEdit), "host");
  await store.getState().connect();
  const onDownload = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<EditQuestionDialog store={store} onDownload={onDownload} />));
  await act(() =>
    store.getState().open({ name: "data.bin", kind: "file", size, modified: null, permissions: null, linkTarget: null }),
  );
  return { store, onDownload };
}

// The dialog renders in a portal on document.body.
const button = (name: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === name);

describe("EditQuestionDialog", () => {
  it("offers only a download for a file over the size limit", async () => {
    const open = vi.fn<FilesApi["openRemoteEdit"]>();
    const { onDownload } = await render(open, 64 * 1024 * 1024);

    expect(document.body.textContent).toContain("data.bin is larger than 10 MB");
    expect(button("Open anyway")).toBeUndefined();
    await act(async () => button("Download")!.click());

    expect(onDownload).toHaveBeenCalledWith("/srv/data.bin");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a binary-looking file anyway when asked to", async () => {
    const open = vi
      .fn<FilesApi["openRemoteEdit"]>()
      .mockRejectedValueOnce({ kind: "binary", message: "binary" })
      .mockResolvedValue(4);
    const { store } = await render(open);

    expect(document.body.textContent).toContain("data.bin does not look like text");
    await act(async () => button("Open anyway")!.click());

    expect(open).toHaveBeenLastCalledWith("host", "/srv/data.bin", expect.any(Function), { allowBinary: true });
    expect(store.getState().edits).toMatchObject([{ name: "data.bin", status: "editing" }]);
  });
});
