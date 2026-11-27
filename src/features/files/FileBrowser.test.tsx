import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import type { FileEntry, Listing } from "@/lib/ipc/files";
import { setSetting } from "@/lib/storage";
import { FileBrowser } from "./FileBrowser";
import { PermissionsDialog } from "./FileOperationDialogs";
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
  "/": { path: "/", entries: [entry("big", "dir")] },
  "/big": {
    path: "/big",
    entries: [entry("sub", "dir"), ...Array.from({ length: 10_000 }, (_, i) => entry(`f${String(i).padStart(5, "0")}`))],
  },
  "/big/sub": { path: "/big/sub", entries: [entry("inner.txt")] },
};

const api: FilesApi = {
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn((_id: number, path: string) => {
    const listing = listings[path === "" || path === "~" ? "/big" : path.replace(/^~\//, "/big/")];
    return listing ? Promise.resolve(listing) : Promise.reject({ kind: "notFound", message: "no", details: { path } });
  }),
  closeFiles: vi.fn(() => Promise.resolve()),
  openRemoteEdit: vi.fn(() => Promise.resolve(1)),
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(() => Promise.resolve()),
  renameFile: vi.fn(() => Promise.resolve()),
  countFiles: vi.fn(() => Promise.resolve(2)),
  deleteFiles: vi.fn(() => Promise.resolve()),
  chmodFile: vi.fn(() => Promise.resolve()),
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
  vi.clearAllMocks();
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

/** Types into a React-controlled input. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label)!;
const press = (key: string) =>
  container.querySelector('[role="grid"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
const pathButton = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const pathInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Path"]')!;

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

  it("opens a directory by clicking its breadcrumb", async () => {
    const { store } = await render();
    await act(async () => store.getState().navigate("/big/sub"));

    const crumb = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Path"] button')]
      .find((candidate) => candidate.textContent === label)!;
    expect(crumb("sub").getAttribute("aria-current")).toBe("location");
    await act(async () => crumb("big").click());
    expect(store.getState().path).toBe("/big");
    await act(async () => crumb("/").click());
    expect(store.getState().path).toBe("/");
  });

  it("edits the path on demand and shows why a typed path cannot be opened", async () => {
    const { store } = await render();
    const submit = (value: string) => act(async () => {
      const input = pathInput();
      type(input, value);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(pathInput()).toBeNull();
    act(() => pathButton("Edit path").click());
    expect(pathInput().value).toBe("/big");
    expect(document.activeElement).toBe(pathInput());
    await submit("/missing");

    expect(store.getState().path).toBe("/big");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("No such folder: /missing");
    await submit("~/sub");
    expect(store.getState().path).toBe("/big/sub");
    expect(pathInput()).toBeNull();
    act(() => pathButton("Edit path").click());
    await submit("~");
    expect(store.getState().path).toBe("/big");
    act(() => pathButton("Edit path").click());
    await submit("/big/sub");
    expect(store.getState().path).toBe("/big/sub");
  });

  it("uses history buttons and keeps history shortcuts within the focused File panel", async () => {
    const { store } = await render();
    expect(pathButton("Back").disabled).toBe(true);
    await act(async () => store.getState().navigate("/big/sub"));
    await act(async () => store.getState().navigate("/"));
    await act(async () => pathButton("Back").click());
    expect(store.getState().path).toBe("/big/sub");
    await act(async () => pathButton("Forward").click());
    expect(store.getState().path).toBe("/");

    const historyKey = (target: Element, key = "ArrowLeft") => target.dispatchEvent(new KeyboardEvent("keydown", {
      key, code: key, altKey: true, bubbles: true, cancelable: true,
    }));
    const terminal = document.createElement("textarea");
    terminal.className = "xterm";
    container.append(terminal);
    act(() => terminal.focus());
    expect(historyKey(terminal)).toBe(true);
    expect(store.getState().path).toBe("/");

    act(() => pathButton("Edit path").click());
    expect(historyKey(pathInput())).toBe(true);
    expect(store.getState().path).toBe("/");
    act(() => container.querySelector<HTMLElement>('[role="grid"]')!.focus());
    await act(async () => expect(historyKey(document.activeElement!)).toBe(false));
    expect(store.getState().path).toBe("/big/sub");
    await act(async () => expect(historyKey(document.activeElement!)).toBe(false));
    expect(store.getState().path).toBe("/big");
    await act(async () => expect(historyKey(document.activeElement!, "ArrowRight")).toBe(false));
    expect(store.getState().path).toBe("/big/sub");
  });

  it("asks before deleting, saying how many entries will go", async () => {
    const { rows } = await render();
    act(() => rows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await act(async () => press("Delete"));

    expect(api.countFiles).toHaveBeenCalledWith(1, ["/big/sub"]);
    expect(dialog()!.textContent).toContain("2 items will be deleted");
    await act(async () => button("Delete").click());
    expect(api.deleteFiles).toHaveBeenCalledWith(1, ["/big/sub"]);
    expect(dialog()).toBeNull();
  });

  it("renames with F2, refusing a name already in the folder", async () => {
    const { rows } = await render();
    act(() => rows()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => press("F2"));
    const input = dialog()!.querySelector("input")!;
    expect(input.value).toBe("f00000");
    act(() => type(input, "sub"));
    expect(dialog()!.textContent).toContain("“sub” already exists");
    expect(button("Rename").disabled).toBe(true);

    act(() => type(input, "renamed"));
    await act(async () => input.form!.requestSubmit());
    expect(api.renameFile).toHaveBeenCalledWith(1, "/big/f00000", "/big/renamed");
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open with a readable reason when the server refuses", async () => {
    vi.mocked(api.createDir).mockRejectedValueOnce({
      kind: "permissionDenied",
      message: "permission denied",
      details: { path: "/big/new" },
    });
    await render();

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="New folder"]')!.click());
    act(() => type(dialog()!.querySelector("input")!, "new"));
    await act(async () => dialog()!.querySelector("form")!.requestSubmit());

    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe("Permission denied: /big/new");
  });

  it("sorts by a column when its header is clicked", async () => {
    const { rows } = await render();
    const nameHeader = [...container.querySelectorAll<HTMLButtonElement>('[role="columnheader"] button')][0]!;

    act(() => nameHeader.click());

    expect(nameHeader.parentElement!.getAttribute("aria-sort")).toBe("descending");
    expect(rows()[1]!.textContent).toContain("f09999");
  });
});

describe("PermissionsDialog", () => {
  it("keeps the checkboxes and the octal mode in step, then applies the mode", async () => {
    const onApply = vi.fn(() => Promise.resolve(null));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<PermissionsDialog entry={entry("run.sh")} onApply={onApply} onClose={() => {}} />));
    const octal = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="Octal"]')!;
    const box = (label: string) => dialog()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    expect(octal().value).toBe("644");
    act(() => box("Owner execute").click());
    expect(octal().value).toBe("744");
    act(() => type(octal(), "600"));
    expect(box("Group read").getAttribute("aria-checked")).toBe("false");
    expect(box("Owner write").getAttribute("aria-checked")).toBe("true");

    await act(async () => button("Apply").click());
    expect(onApply).toHaveBeenCalledWith(0o600);
  });
});
