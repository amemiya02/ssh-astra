import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import i18n, { startI18n } from "@/i18n";
import { startSettings } from "@/lib/storage";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { SettingsPage } from "./SettingsPage";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => true,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: async () => {} }),
}));

it("shows recent activity while access is off and clears it from Settings", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  await startSettings({ load: async () => ({}), save: async () => {} });
  const timestamp = Date.UTC(2026, 10, 20, 12, 30);
  let records = [
    { timestamp, tool: "read_file", host: "Build", path: "/srv/example", outcome: "allowed" },
    { timestamp: timestamp - 1000, tool: "read_terminal", outcome: "timedOut" },
  ];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_activity_list") return records;
    if (command === "agent_activity_clear") records = [];
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

  try {
    await act(() => root.render(<ThemeProvider><SettingsPage /></ThemeProvider>));
    expect(invoke).not.toHaveBeenCalledWith("agent_activity_list");
    await act(() => button("Agent access").click());
    expect(invoke).toHaveBeenCalledWith("agent_activity_list");
    expect(container.querySelector("time")?.dateTime).toBe(new Date(timestamp).toISOString());
    expect(container.textContent).toContain("read_file");
    expect(container.textContent).toContain("Build");
    expect(container.textContent).toContain("/srv/example");
    expect(container.textContent).toContain("Allowed");
    expect(container.textContent).toContain("Timed out");
    await act(() => button("Clear activity").click());
    expect(invoke).toHaveBeenCalledWith("agent_activity_clear");
    expect(container.textContent).toContain("No recent activity.");
    expect(container.textContent).not.toContain("/srv/example");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
