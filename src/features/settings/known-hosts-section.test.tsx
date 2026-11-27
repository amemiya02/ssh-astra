import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { privacyModeSetting } from "@/features/workspace/privacy-mode";
import i18n, { startI18n } from "@/i18n";
import { writeClipboardText } from "@/lib/ipc/system";
import { setSetting, startSettings } from "@/lib/storage";
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

vi.mock("@/lib/ipc/system", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ipc/system")>(),
  writeClipboardText: vi.fn(),
}));

it("opens the Known hosts setting, reveals the configured file and only copies commands for concrete endpoints", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  await startSettings({ load: async () => ({}), save: async () => {} });
  const path = "/tmp/fixture's home/.ssh/known_hosts";
  const removalCommand = "ssh-keygen -f '/tmp/fixture'\\''s home/.ssh/known_hosts' -R '[example.com]:2222'";
  const hash = "|1|35GnQ4K4ZVK6KnYQTz+nkKakeKI=|5Mb0p9I1PAdNIgm0UWFrzQ1NdoA=";
  const fields = { algorithm: "ssh-ed25519", fingerprint: "SHA256:example" };
  vi.mocked(invoke).mockImplementation(async (command) => command === "known_hosts_list" ? {
    path,
    windows: false,
    entries: [
      { ...fields, line: 2, hosts: "[example.com]:2222", marker: null, removalCommand },
      { ...fields, line: 4, hosts: hash, marker: null, removalCommand: null },
      { ...fields, line: 6, hosts: "*.example.com", marker: "@cert-authority", removalCommand: null },
    ],
  } : undefined);
  vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

  try {
    await act(() => root.render(<ThemeProvider><SettingsPage /></ThemeProvider>));
    expect(invoke).not.toHaveBeenCalledWith("known_hosts_list");
    await act(() => button("Known hosts").click());
    expect(container.textContent).toContain(hash);
    expect(container.textContent).toContain("[example.com]:2222");
    expect(container.textContent).toContain("@cert-authority");
    expect(container.textContent).toContain(path);
    expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Copy removal command")).toHaveLength(1);

    await act(() => button("Show in file manager").click());
    expect(invoke).toHaveBeenCalledWith("known_hosts_reveal");
    await act(() => button("Copy removal command").click());
    expect(writeClipboardText).toHaveBeenCalledWith(removalCommand);

    act(() => setSetting(privacyModeSetting, true));
    expect(container.textContent).not.toContain(path);
    expect(container.textContent).not.toContain("example.com");
    expect(container.textContent).not.toContain(hash);
    expect(button("Show in file manager")).toBeUndefined();
    expect(button("Copy removal command")).toBeUndefined();
  } finally {
    act(() => root.unmount());
    container.remove();
    setSetting(privacyModeSetting, false);
    vi.unstubAllGlobals();
  }
});
