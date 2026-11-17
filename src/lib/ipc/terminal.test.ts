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
