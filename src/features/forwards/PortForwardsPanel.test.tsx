import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import type { Host } from "@/lib/ipc/hosts";
import { PortForwardsPanel } from "./PortForwardsPanel";

it("lists an HTTP CONNECT rule and offers only its listening end in the editor", () => {
  startI18n();
  const host: Host = {
    id: "web",
    name: "Web",
    address: "web.example.test",
    port: 22,
    user: "dev",
    auth: { type: "password" },
    jumpHost: null,
    groupId: null,
    forwards: [
      { id: "http", type: "http", label: "", autoStart: false, bindAddress: "127.0.0.1", bindPort: 8080 },
    ],
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<TooltipProvider><PortForwardsPanel host={host} /></TooltipProvider>));
    const row = container.querySelector("li");
    expect(row?.textContent).toContain("HTTP CONNECT");
    expect(row?.textContent).toContain("localhost:8080");

    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add Port forward");
    expect(add).toBeDefined();
    act(() => add!.click());
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === "HTTP");
    expect(option).toBeDefined();
    act(() => option!.click());

    const form = container.querySelector("form");
    const labels = [...form!.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Name", "Local port", "Listen address", "Start when connected"]);
    expect(form?.textContent).toContain("HTTP CONNECT");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
