import { describe, expect, it } from "vitest";
import { decodeTerminalMessage } from "./terminal";

describe("decodeTerminalMessage", () => {
  it("treats raw bytes as terminal output", () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x6d, 0xe4, 0xbd]).buffer;
    const event = decodeTerminalMessage(bytes);
    expect(event.type).toBe("output");
    expect(event.type === "output" && Array.from(event.data)).toEqual([0x1b, 0x5b, 0x6d, 0xe4, 0xbd]);
  });

  it("treats raw bytes delivered as a number array as terminal output", () => {
    const event = decodeTerminalMessage([104, 105]);
    expect(event.type === "output" && Array.from(event.data)).toEqual([104, 105]);
  });

  it("reads the exit message", () => {
    expect(decodeTerminalMessage({ exitCode: 3 })).toEqual({ type: "exit", code: 3 });
    expect(decodeTerminalMessage({ exitCode: null })).toEqual({ type: "exit", code: null });
  });
});

describe("decodeTerminalMessage for a remote Terminal's directory", () => {
  it("reads the directory its shell reported", () => {
    expect(decodeTerminalMessage({ cwd: "/tmp/my dir/日本" })).toEqual({ type: "cwd", path: "/tmp/my dir/日本" });
  });
});

describe("decodeTerminalMessage for a remote Terminal's Connection", () => {
  it("reads reconnect progress", () => {
    expect(decodeTerminalMessage({ connection: { state: "reconnecting", attempt: 2, attempts: 3 } })).toEqual({
      type: "connection",
      state: { state: "reconnecting", attempt: 2, attempts: 3 },
    });
  });

  it("reads giving up and coming back", () => {
    expect(decodeTerminalMessage({ connection: { state: "disconnected", reason: "cannot reach the host", reportReconnectFailure: true } })).toEqual({
      type: "connection",
      state: { state: "disconnected", reason: "cannot reach the host", reportReconnectFailure: true },
    });
    expect(decodeTerminalMessage({ connection: { state: "connected" } })).toEqual({
      type: "connection",
      state: { state: "connected" },
    });
  });
});

describe("decodeTerminalMessage for Shell integration", () => {
  it("receives availability and command markers over the Terminal Channel", () => {
    const markers = [
      { type: "availability", status: "available" },
      { type: "promptStart", promptId: 1 },
      { type: "commandStart", commandLine: "false" },
      { type: "commandEnd", exitCode: 1 },
    ] as const;
    for (const marker of markers) {
      expect(decodeTerminalMessage({ shellIntegration: marker })).toEqual({
        type: "shellIntegration",
        event: marker,
      });
    }
  });
});

it("reads Terminal log state without treating it as output or an exit", () => {
  expect(decodeTerminalMessage({ terminalLog: { state: "active" } })).toEqual({
    type: "terminalLog",
    status: { state: "active" },
  });
});
