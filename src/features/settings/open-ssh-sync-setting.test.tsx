import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import i18n, { startI18n } from "@/i18n";
import { startSettings, type SettingsChange } from "@/lib/storage";
import { OpenSshSyncSetting } from "./open-ssh-sync-setting";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(),
}));

it("previews the exact Include before enabling and stays off when cancelled", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let receive: (change: SettingsChange) => void = () => {};
  await startSettings({
    load: async () => ({}),
    watch: async (change) => { receive = change; return {}; },
    save: async () => {},
  });
  const line = "Include ssh-astra.conf";
  const report = { aliases: ["build-api"], issues: [{ host: "Edge", alias: "edge", reason: "userAlias" }] };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "ssh_config_export_preview") return { line, approval: 17, addsInclude: true };
    if (command === "ssh_config_export_enable") return {
      section: "openSshSync", revision: 1, value: { enabled: true, includeLine: line, report },
    };
    if (command === "ssh_config_export_disable") return {
      section: "openSshSync", revision: 3, value: { enabled: false, includeLine: line },
    };
    return undefined;
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const control = (value: string) => container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  const dialogButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
    .find((button) => button.textContent === label)!;

  try {
    act(() => root.render(<OpenSshSyncSetting />));
    expect(control("off").getAttribute("aria-checked")).toBe("true");

    await act(() => control("on").click());
    expect(document.querySelector('[role="dialog"] code')?.textContent).toBe(line);
    expect(invoke).not.toHaveBeenCalledWith("ssh_config_export_enable", expect.anything());
    await act(() => dialogButton("Cancel").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(control("off").getAttribute("aria-checked")).toBe("true");
    expect(invoke).not.toHaveBeenCalledWith("ssh_config_export_enable", expect.anything());

    await act(() => control("on").click());
    await act(() => dialogButton("Enable sync").click());
    expect(invoke).toHaveBeenCalledWith("ssh_config_export_enable", { approval: 17 });
    expect(control("on").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("build-api");
    expect(container.textContent).toContain("edge");

    act(() => receive({
      section: "openSshSync", revision: 2,
      value: { enabled: true, report: { aliases: ["updated-api"], issues: [] }, includeLine: line },
    }));
    expect(container.textContent).toContain("updated-api");
    expect(container.textContent).not.toContain("build-api");
    await act(() => control("off").click());
    expect(control("off").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("code")?.textContent).toBe(line);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
