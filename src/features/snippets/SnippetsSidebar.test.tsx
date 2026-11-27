import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createBroadcast } from "@/features/workspace/broadcast";
import { startI18n } from "@/i18n";
import { listSnippets, saveSnippet, type Snippet } from "@/lib/ipc/snippets";
import { SnippetsSidebar } from "./SnippetsSidebar";

vi.mock("@/lib/ipc/snippets", () => ({ listSnippets: vi.fn(), saveSnippet: vi.fn(), deleteSnippet: vi.fn() }));

const snippets: Snippet[] = [
  { id: "global", name: "Show path", command: "pwd", group: null, hostIds: [], sendEnter: false },
  { id: "scoped", name: "Find logs", command: "ls ${path:/var/log}", group: "Ops", hostIds: ["saved"], sendEnter: true },
];

let root: Root;
let mount: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSnippets).mockResolvedValue(snippets);
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
});

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent) === label);
}

function fixture() {
  const broadcast = createBroadcast();
  const write = vi.fn();
  broadcast.updateWorkspace("pane", ["tab"], ["pane"]);
  broadcast.register("tab", "pane", write);
  const render = (hostId?: string) => act(async () => {
    root.render(<TooltipProvider><SnippetsSidebar broadcast={broadcast} paneId="pane" hostId={hostId} hosts={[]} /></TooltipProvider>);
  });
  return { broadcast, render, write };
}

it("shows scoped snippets only for a matching Host and sends only on an explicit Run", async () => {
  const { render, write } = fixture();
  await render();
  expect(mount.textContent).toContain("Show path");
  expect(mount.textContent).not.toContain("Find logs");

  await render("other");
  expect(mount.textContent).not.toContain("Find logs");
  await render("saved");
  expect(mount.textContent).toContain("Ops");
  expect(write).not.toHaveBeenCalled();

  await act(async () => button("Run Show path")!.click());
  expect(write).toHaveBeenCalledExactlyOnceWith("pwd");

  act(() => button("Run Find logs")!.click());
  expect(write).toHaveBeenCalledTimes(1);
  expect(document.querySelector<HTMLInputElement>("[role=dialog] input")!.value).toBe("/var/log");
  act(() => button("Cancel")!.click());
  expect(write).toHaveBeenCalledTimes(1);

  act(() => button("Run Find logs")!.click());
  await act(async () => button("Run")!.click());
  expect(write).toHaveBeenLastCalledWith("ls /var/log\r");
  expect(write).toHaveBeenCalledTimes(2);
});

it("retains the editor and the saved list when an edit fails", async () => {
  const { render, write } = fixture();
  vi.mocked(saveSnippet).mockRejectedValue({ kind: "io", message: "Disk is full" });
  await render();
  act(() => button("Edit Show path")!.click());
  await act(async () => button("Save")!.click());
  expect(document.querySelector("[role=dialog] [role=alert]")?.textContent).toContain("Disk is full");
  expect(mount.textContent).toContain("Show path");
  expect(write).not.toHaveBeenCalled();
});
