import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { settingsPageSections } from "@/features/settings/sections";
import { startI18n } from "@/i18n";
import type { FileEntry, Listing } from "@/lib/ipc/files";
import { localStorageBackend, openSettings, setSetting, startSettings } from "@/lib/storage";
import { FileBrowser, type FileExchange } from "./FileBrowser";
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
  "/counts": { path: "/counts", entries: [entry(".env"), entry("a.txt"), entry("b.txt")] },
  "/move": { path: "/move", entries: [entry("sub", "dir"), entry("a.txt"), entry("b.txt"), entry("c.txt")] },
  "/move/sub": { path: "/move/sub", entries: [] },
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
  createEmptyFile: vi.fn(() => Promise.resolve()),
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
  act(() => root?.unmount());
  setSetting(filesSetting, filesSetting.defaults);
  container.remove();
});

async function render({ showSettings, exchange, startPath, enableMove }: {
  showSettings?: boolean;
  exchange?: FileExchange;
  startPath?: string;
  enableMove?: boolean;
} = {}) {
  const store = createFileBrowserStore(api, "host", startPath);
  const FilesSection = settingsPageSections.find((section) => section.id === "files")?.Component;
  await store.getState().connect();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <FileBrowser store={store} hostName="web-1" exchange={exchange} enableMove={enableMove} />
        {showSettings && FilesSection && <FilesSection />}
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
    expect(container.querySelector('[role="status"]')!.textContent).toContain("10,001 items");
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

  it("cuts and pastes from the focused file list, reporting each failed entry", async () => {
    const { store, rows } = await render({ startPath: "/counts", enableMove: true });
    const key = (target: Element, letter: string) => target.dispatchEvent(new KeyboardEvent("keydown", {
      key: letter.toLowerCase(), code: `Key${letter}`, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    const click = (row: Element, ctrlKey = false) => row.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey }));
    act(() => {
      click(rows()[0]!);
      click(rows()[1]!, true);
      pathButton("Edit path").click();
    });
    expect(key(pathInput(), "X")).toBe(true);
    expect(store.getState().cut).toBeNull();

    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    act(() => grid.focus());
    act(() => expect(key(grid, "X")).toBe(false));
    expect(store.getState().cut?.names).toEqual(["a.txt", "b.txt"]);

    await act(async () => store.getState().navigate("/big/sub"));
    vi.mocked(api.renameFile)
      .mockRejectedValueOnce({ kind: "alreadyExists", message: "exists", details: { path: "/big/sub/a.txt" } })
      .mockRejectedValueOnce({ kind: "permissionDenied", message: "denied", details: { path: "/counts/b.txt" } });
    await act(async () => expect(key(container.querySelector('[role="grid"]')!, "V")).toBe(false));
    expect(dialog()?.textContent).toContain("a.txtAlready exists: /big/sub/a.txt");
    expect(dialog()?.textContent).toContain("b.txtPermission denied: /counts/b.txt");
    expect(store.getState().error).toBeNull();
  });

  it("moves dragged selections into folders and ignores a drop on a file", async () => {
    const { rows } = await render({ startPath: "/move", enableMove: true });
    const [folder, a, b, c] = rows();
    const pointer = (target: EventTarget, type: string, y: number) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: y,
      }));
    };
    rows().forEach((row, index) => { row.getBoundingClientRect = () => new DOMRect(0, index * 26, 100, 26); });
    act(() => {
      a!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      b!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    const dragFromA = async (target: Element, y: number) => {
      act(() => pointer(a!, "pointerdown", 36));
      act(() => pointer(document, "pointermove", 46));
      act(() => pointer(target, "pointermove", y));
      await act(async () => pointer(target, "pointerup", y));
    };

    await dragFromA(c!, 85);
    expect(api.renameFile).not.toHaveBeenCalled();
    await dragFromA(folder!, 10);
    expect(vi.mocked(api.renameFile).mock.calls).toEqual([
      [1, "/move/a.txt", "/move/sub/a.txt"],
      [1, "/move/b.txt", "/move/sub/b.txt"],
    ]);
  });

  it("offers Cut on a row and Paste in an empty destination's context menu", async () => {
    const { rows } = await render({ startPath: "/move", enableMove: true });
    const openMenu = (target: Element) => act(async () => {
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    });
    const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.startsWith(label))!;
    await openMenu(rows()[1]!);
    await act(async () => menuItem("Cut").click());
    await act(async () => rows()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await openMenu(container.querySelector('[role="grid"]')!);
    await act(async () => menuItem("Paste").click());

    expect(api.renameFile).toHaveBeenCalledExactlyOnceWith(1, "/move/a.txt", "/move/sub/a.txt");
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

  it("edits the focused name in its row with F2 and discards changes with Escape", async () => {
    const { rows } = await render();
    const row = rows()[1]!;
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => press("F2"));

    expect(dialog()).toBeNull();
    const input = row.querySelector("input")!;
    expect(input.value).toBe("f00000");
    expect(document.activeElement).toBe(input);

    act(() => type(input, "changed"));
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(row.querySelector("input")).toBeNull();
    expect(row.textContent).toContain("f00000");
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('[role="grid"]'));
  });

  it("focuses the same inline editor from the row menu", async () => {
    const { rows } = await render({ startPath: "/counts" });
    const row = rows()[0]!;
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Rename")!;

    await act(async () => rename.click());

    // Radix releases the menu's focus scope after unmounting it.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(row.querySelector("input") === document.activeElement).toBe(true);
  });

  it("submits an inline rename with Enter and keeps a refused name editable", async () => {
    vi.mocked(api.renameFile).mockRejectedValueOnce({
      kind: "alreadyExists", message: "exists", details: { path: "/counts/taken.txt" },
    });
    const { rows } = await render({ startPath: "/counts" });
    act(() => rows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => press("F2"));
    const input = rows()[0]!.querySelector("input")!;
    const enter = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    act(() => type(input, "b.txt"));
    await act(async () => enter());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("“b.txt” already exists");
    expect(api.renameFile).not.toHaveBeenCalled();

    act(() => type(input, "taken.txt"));
    await act(async () => enter());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("/counts/taken.txt");
    expect(document.activeElement).toBe(input);

    act(() => type(input, "renamed.txt"));
    vi.mocked(api.listFiles).mockResolvedValueOnce({
      path: "/counts", entries: [entry(".env"), entry("b.txt"), entry("renamed.txt")],
    });
    await act(async () => enter());
    expect(container.querySelector('[role="grid"] input')).toBeNull();
    const renamed = rows().find((row) => row.textContent?.includes("renamed.txt"));
    expect(renamed?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("creates an empty file from the path bar in the directory shown", async () => {
    const { rows } = await render({ startPath: "/counts" });
    act(() => pathButton("New file").click());
    const input = dialog()!.querySelector("input")!;
    expect(input.value).toBe("");

    act(() => type(input, "empty.txt"));
    vi.mocked(api.listFiles).mockResolvedValueOnce({
      path: "/counts", entries: [...listings["/counts"]!.entries, { ...entry("empty.txt"), size: 0 }],
    });
    await act(async () => input.form!.requestSubmit());

    expect(api.createEmptyFile).toHaveBeenCalledWith(1, "/counts/empty.txt");
    expect(dialog()).toBeNull();
    expect(rows().some((row) => row.textContent?.includes("empty.txt"))).toBe(true);
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

  it("updates both optional columns from Settings and restores their saved visibility", async () => {
    const backend = localStorageBackend(window.localStorage, "test.files.settings");
    await backend.save("files", { showHidden: true, sort: { key: "permissions", direction: "desc" } });
    await startSettings(backend);
    const { rows } = await render({ showSettings: true });
    const headers = () => [...container.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent);
    const choose = (label: string, option: string) => [...container.querySelectorAll<HTMLButtonElement>(
      `[role="radiogroup"][aria-label="${label}"] [role="radio"]`,
    )].find((button) => button.textContent === option)!.click();

    expect(headers()).toEqual(["Name", "Size", "Modified"]);
    expect(container.querySelector('[role="columnheader"][aria-sort="ascending"]')?.textContent).toBe("Name");
    act(() => choose("Show permissions column", "On"));
    expect(headers()).toEqual(["Name", "Size", "Modified", "Permissions"]);
    expect(container.querySelector('[role="columnheader"][aria-sort="descending"]')?.textContent).toBe("Permissions");
    expect(rows()[1]!.textContent).toContain("-rw-r--r--");
    await act(async () => choose("Show modified column", "Off"));
    expect(headers()).toEqual(["Name", "Size", "Permissions"]);
    expect(rows()[1]!.querySelectorAll('[role="gridcell"]')).toHaveLength(3);

    const reopened = await openSettings(backend);
    expect(reopened.get(filesSetting)).toEqual({
      showHidden: true,
      sort: { key: "permissions", direction: "desc" },
      showModified: false,
      showPermissions: true,
    });
  });

  it("counts the displayed entries and visible selection through filtering", async () => {
    const { rows } = await render({ exchange: { side: "local" }, startPath: "/counts" });
    const counts = () => [...container.querySelectorAll('[role="status"] span')].map((span) => span.textContent);
    const select = (name: string, ctrlKey = false) => act(() => rows()
      .find((row) => row.querySelector('[role="gridcell"]')?.textContent === name)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey })));
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const showHidden = (value: boolean) => act(() => setSetting(filesSetting, { ...filesSetting.defaults, showHidden: value }));

    expect(counts()).toEqual(["2 items", "0 selected"]);
    showHidden(true);
    expect(counts()).toEqual(["3 items", "0 selected"]);
    select(".env");
    select("a.txt", true);
    expect(counts()).toEqual(["3 items", "2 selected"]);
    showHidden(false);
    expect(counts()).toEqual(["2 items", "1 selected", "1 hidden selection"]);
    act(() => type(filter, "b.txt"));
    expect(counts()).toEqual(["1 item", "0 selected", "2 hidden selections"]);
    select("b.txt");
    expect(counts()).toEqual(["1 item", "1 selected"]);
    act(() => type(filter, "missing"));
    expect(counts()).toEqual(["0 items", "0 selected", "1 hidden selection"]);
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
