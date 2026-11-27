import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { startSettings } from "@/lib/storage";
import { ConnectionSection } from "./connection-section";

it("enables OS detection by default and saves when turned off", async () => {
  startI18n();
  const save = vi.fn().mockResolvedValue(undefined);
  await startSettings({ load: async () => ({}), save });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionSection />));
    const control = container.querySelector('[aria-label="Detect Host operating systems"]')!;
    const [on, off] = control.querySelectorAll<HTMLButtonElement>("button");
    expect(on.getAttribute("aria-checked")).toBe("true");
    act(() => off.click());
    expect(save).toHaveBeenLastCalledWith("connection", { keepaliveSeconds: 30, agentPath: "", detectOs: false });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("saves and clears the custom agent path alongside the existing keepalive setting", async () => {
  startI18n();
  const save = vi.fn().mockResolvedValue(undefined);
  await startSettings({ load: async () => ({ connection: { keepaliveSeconds: 60 } }), save });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionSection />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Custom agent path"]')!;
    expect(input.value).toBe("");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (value: string) => act(() => {
      input.focus();
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const path = "~/Library/Group Containers/agent.sock";
    type(path);
    expect(save).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(save).toHaveBeenLastCalledWith("connection", { keepaliveSeconds: 60, agentPath: path, detectOs: true });

    type("");
    act(() => input.blur());
    expect(save).toHaveBeenLastCalledWith("connection", { keepaliveSeconds: 60, agentPath: "", detectOs: true });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("saves the proxy endpoint and username with the other Connection settings", async () => {
  startI18n();
  const save = vi.fn().mockResolvedValue(undefined);
  const proxy = { kind: "socks5", address: "proxy.example", port: 1080 };
  await startSettings({ load: async () => ({ connection: { agentPath: "~/.ssh/agent", proxy } }), save });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionSection />));
    const username = container.querySelector<HTMLInputElement>("#settings-outbound-proxy-username")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(username, "proxy-user");
      username.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save).not.toHaveBeenCalled();

    act(() => username.form!.requestSubmit());
    expect(save).toHaveBeenLastCalledWith("connection", {
      keepaliveSeconds: 30,
      agentPath: "~/.ssh/agent",
      detectOs: true,
      proxy: { ...proxy, username: "proxy-user" },
    });
    expect(username.form!.querySelector('input[type="password"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
