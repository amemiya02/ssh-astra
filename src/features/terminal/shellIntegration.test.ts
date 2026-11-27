import { describe, expect, it } from "vitest";
import { createShellIntegrationState } from "./shellIntegration";

describe("Shell integration state", () => {
  it("only reports an empty prompt after the shell marks a new prompt", () => {
    const terminals = createShellIntegrationState();
    terminals.open("pane-a");
    terminals.open("pane-b");
    terminals.event("pane-a", { type: "availability", status: "available" });
    terminals.event("pane-a", { type: "promptStart" });
    expect(terminals.get("pane-a")).toEqual({ status: "available", atEmptyPrompt: true });
    expect(terminals.get("pane-b").atEmptyPrompt).toBe(false);

    terminals.input("pane-a", "a");
    expect(terminals.get("pane-a").atEmptyPrompt).toBe(false);
    terminals.event("pane-a", { type: "commandStart", commandLine: "false" });
    terminals.event("pane-a", { type: "commandEnd", exitCode: 1 });
    expect(terminals.get("pane-a").atEmptyPrompt).toBe(false);
    terminals.event("pane-a", { type: "promptStart" });
    expect(terminals.get("pane-a").atEmptyPrompt).toBe(true);
  });

  it("keeps a prompt unverified when input was sent while its command was running", () => {
    const terminals = createShellIntegrationState();
    terminals.open("pane-a");
    terminals.event("pane-a", { type: "availability", status: "available" });
    terminals.event("pane-a", { type: "promptStart" });
    terminals.event("pane-a", { type: "commandStart", commandLine: "sleep 1" });
    terminals.input("pane-a", "a");
    terminals.event("pane-a", { type: "commandEnd", exitCode: 0 });
    terminals.event("pane-a", { type: "promptStart" });
    expect(terminals.get("pane-a").atEmptyPrompt).toBe(false);
    terminals.event("pane-a", { type: "promptStart" });
    expect(terminals.get("pane-a").atEmptyPrompt).toBe(true);
  });

  it("reports why integration is unavailable and clears readiness when the shell is replaced", () => {
    let enabled = true;
    const terminals = createShellIntegrationState(() => enabled);
    terminals.open("pane-a");
    terminals.event("pane-a", { type: "availability", status: "available" });
    terminals.event("pane-a", { type: "promptStart" });
    enabled = false;
    expect(terminals.get("pane-a")).toEqual({ status: "disabled", atEmptyPrompt: false });

    enabled = true;
    terminals.close("pane-a");
    expect(terminals.get("pane-a")).toEqual({ status: "disconnected", atEmptyPrompt: false });
    terminals.open("pane-a");
    terminals.event("pane-a", { type: "availability", status: "unsupported" });
    terminals.event("pane-a", { type: "promptStart" });
    expect(terminals.get("pane-a")).toEqual({ status: "unsupported", atEmptyPrompt: false });
  });
});
