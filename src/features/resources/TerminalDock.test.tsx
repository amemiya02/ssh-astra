import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FilePanelDockContext } from "@/features/shell/file-panel-dock";
import { startI18n } from "@/i18n";
import { watchResources, type ResourceEvent, type ResourceSnapshot } from "@/lib/ipc/resources";
import { setSetting } from "@/lib/storage";
import type { ResourceHistories } from "./resource-history";
import { resourceSetting, type ResourceInterval } from "./resource-settings";
import { TerminalDock } from "./TerminalDock";

vi.mock("@/lib/ipc/resources", () => ({ watchResources: vi.fn() }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

it("watches only the visible Resource panel for the active Terminal and discards late snapshots", () => {
  const subscriptions: {
    id: number; interval: ResourceInterval; emit(event: ResourceEvent): void;
    stop(): void; setInterval(interval: ResourceInterval): void;
  }[] = [];
  vi.mocked(watchResources).mockImplementation((id, interval, emit) => {
    const stop = vi.fn();
    const setInterval = vi.fn();
    subscriptions.push({ id, interval, emit, stop, setInterval });
    return { stop, setInterval };
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const select = vi.fn();
  const histories: ResourceHistories = new Map();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (terminalId: number | null, resources: boolean, collapsed = false, moving = false, generation = 0) =>
    act(() => root.render(
      <TooltipProvider>
        <FilePanelDockContext value={{ dock: "right", collapsed, collapse() {} }}>
          <TerminalDock terminalId={terminalId} generation={generation} resources={resources} paused={moving} onSelect={select}
            histories={histories}>
            <div>File listing</div>
          </TerminalDock>
        </FilePanelDockContext>
      </TooltipProvider>,
    ));

  try {
    render(1, false);
    expect(subscriptions).toHaveLength(0);
    const resourcesTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((node) => node.textContent === "Resources")!;
    act(() => resourcesTab.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(select).not.toHaveBeenCalled();
    act(() => resourcesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(select).toHaveBeenCalledWith(true);
    render(1, true);
    expect(subscriptions.map(({ id }) => id)).toEqual([1]);
    expect(subscriptions[0]?.interval).toBe(2);
    const interval = container.querySelector<HTMLSelectElement>('select[aria-label="Sampling interval"]')!;
    expect(Array.from(interval.options, (option) => option.value)).toEqual(["1", "2", "5"]);
    expect(interval.value).toBe("2");
    act(() => {
      interval.value = "5";
      interval.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(interval.value).toBe("5");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.setInterval).toHaveBeenCalledExactlyOnceWith(5);
    act(() => subscriptions[0]!.emit({ type: "unsupported" }));
    expect(container.textContent).toContain("This system is unsupported.");

    render(1, true, true);
    expect(subscriptions[0]!.stop).toHaveBeenCalledOnce();
    act(() => setSetting(resourceSetting, { intervalSeconds: 1 }));
    expect(subscriptions[0]!.setInterval).toHaveBeenCalledOnce();
    render(2, true);
    act(() => subscriptions[0]!.emit({ type: "unsupported" }));
    expect(subscriptions.map(({ id }) => id)).toEqual([1, 2]);
    expect(subscriptions[1]?.interval).toBe(1);
    expect(container.textContent).not.toContain("This system is unsupported.");

    const snapshot: ResourceSnapshot = {
      cpuPercent: 12.5, cores: 4, load: [0.15, 0.25, 0.5],
      memory: { used: 2048, total: 4096 }, swap: { used: 0, total: 0 },
      disks: [{ mount: "/data files", used: 1024, total: 4096 }],
      network: [{ name: "eth0", receiveRate: 1024, sendRate: 2048 }],
      uptimeSeconds: 3601,
    };
    act(() => subscriptions[1]!.emit({ type: "snapshot", snapshot }));
    for (const value of ["12.5% · 4 cores", "0.15 / 0.25 / 0.5", "2 KB / 4 KB", "Swap", "/data files", "eth0", "RX 1 KB/s · TX 2 KB/s", "Uptime"]) {
      expect(container.textContent).toContain(value);
    }
    expect(container.textContent).toContain("Last five minutes");

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(subscriptions[1]!.stop).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => subscriptions[2]!.emit({ type: "snapshot", snapshot: { ...snapshot, cpuPercent: 32.5 } }));
    expect(container.querySelector('[aria-label="CPU ranged from 12.5% to 32.5% over the last five minutes"]')).not.toBeNull();

    render(2, true, false, false, 1);
    expect(subscriptions[2]!.stop).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("/data files");
    act(() => subscriptions[3]!.emit({ type: "snapshot", snapshot: { ...snapshot, cpuPercent: 40 } }));
    expect(container.querySelector('[aria-label="CPU ranged from 40% to 40% over the last five minutes"]')).not.toBeNull();
    expect(subscriptions.map(({ id }) => id)).toEqual([1, 2, 2, 2]);

    render(2, true, false, true, 1);
    expect(subscriptions[3]!.stop).toHaveBeenCalledOnce();
    render(null, true);
    expect(subscriptions).toHaveLength(4);
  } finally {
    act(() => root.unmount());
    visibility.mockRestore();
  }
});
