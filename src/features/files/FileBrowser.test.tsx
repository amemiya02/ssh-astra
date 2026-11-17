import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import type { FileEntry, Listing } from "@/lib/ipc/files";
import { setSetting } from "@/lib/storage";
import { FileBrowser } from "./FileBrowser";
import { createFileBrowserStore, type FilesApi } from "./fileBrowserStore";
import { filesSetting } from "./file-prefs";

const entry = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({
  name,
  kind,
  size: 2048,
  modified: 1_704_164_645,
  permissions: 0o644,
  linkTarget: null,
});

const listings: Record<string, Listing> = {
  "/big": {
    path: "/big",
    entries: [entry("sub", "dir"), ...Array.from({ length: 10_000 }, (_, i) => entry(`f${String(i).padStart(5, "0")}`))],
  },
  "/big/sub": { path: "/big/sub", entries: [entry("inner.txt")] },
};

const api: FilesApi = {
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn((_id: number, path: string) => {
    const listing = listings[path === "" ? "/big" : path];
    return listing ? Promise.resolve(listing) : Promise.reject({ kind: "notFound", message: "no", details: { path } });
  }),
  closeFiles: vi.fn(() => Promise.resolve()),
  openRemoteEdit: vi.fn(() => Promise.resolve(1)),
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
};

let root: Root | null = null;
let container: HTMLDivElement;

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
  setSetting(filesSetting, filesSetting.defaults);
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
        <FileBrowser store={store} hostName="web-1" />
      </TooltipProvider>,
    ),
  );
  const rows = () => [...container.querySelectorAll('[role="rowgroup"] [role="row"]')];
  return { store, rows };
}

describe("FileBrowser", () => {
  it("renders only a window of a 10,000-entry folder, folders first", async () => {
    const { rows } = await render();

    const grid = container.querySelector('[role="grid"]')!;
    expect(grid.getAttribute("aria-rowcount")).toBe("10002");
    expect(rows().length).toBeLessThan(50);
    expect(rows()[0]!.textContent).toContain("sub");
    expect(rows()[1]!.textContent).toContain("f00000");
    expect(rows()[1]!.textContent).toContain("2 KB");
  });

  it("selects on click and opens a folder on double-click", async () => {
    const { store, rows } = await render();

    act(() => rows()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect([...store.getState().selection]).toEqual(["f00000"]);
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");

    await act(async () => rows()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(store.getState().path).toBe("/big/sub");
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("inner.txt")]);
  });

  it("goes to a typed path and shows why one cannot be opened", async () => {
    const { store } = await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Path"]')!;
    const type = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    act(() => type("/missing"));
    await act(async () => input.form!.requestSubmit());

    expect(store.getState().path).toBe("/big");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("No such folder: /missing");
  });

  it("sorts by a column when its header is clicked", async () => {
    const { rows } = await render();
    const nameHeader = [...container.querySelectorAll<HTMLButtonElement>('[role="columnheader"] button')][0]!;

    act(() => nameHeader.click());

    expect(nameHeader.parentElement!.getAttribute("aria-sort")).toBe("descending");
    expect(rows()[1]!.textContent).toContain("f09999");
  });
});
