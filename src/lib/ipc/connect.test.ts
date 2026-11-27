import { describe, expect, it, vi } from "vitest";
import { answerPrompts, readCommandError, type ConnectPrompt } from "./connect";

describe("answerPrompts", () => {
  it("asks the user and sends the answer back under the prompt's id", async () => {
    const answer = vi.fn(() => Promise.resolve());
    const handle = answerPrompts(async (prompt) => {
      if (prompt.type === "hostKey") return { type: "hostKey", decision: prompt.fingerprint === "SHA256:abc" ? "trustForRun" : "reject" };
      return { type: "password", password: "pw" };
    }, answer);

    await handle({ type: "hostKey", id: 7, host: "h", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" });
    await handle({ type: "password", id: 8, host: "h", user: "u", retry: false, canSave: true });

    expect(answer.mock.calls).toEqual([
      [7, { type: "hostKey", decision: "trustForRun" }],
      [8, { type: "password", password: "pw" }],
    ]);
  });

  it("passes on the user's choice to save a password or passphrase", async () => {
    const answer = vi.fn(() => Promise.resolve());
    const handle = answerPrompts(async (prompt) => {
      if (prompt.type === "password") return { type: "password", password: "pw", save: prompt.canSave };
      return { type: "passphrase", passphrase: "pp", save: true };
    }, answer);

    await handle({ type: "password", id: 1, host: "h", user: "u", retry: false, canSave: true });
    await handle({ type: "passphrase", id: 2, keyPath: "/k/id_ed25519", retry: false, canSave: true });

    expect(answer.mock.calls).toEqual([
      [1, { type: "password", password: "pw", save: true }],
      [2, { type: "passphrase", passphrase: "pp", save: true }],
    ]);
  });

  it("treats a failing prompt as a refusal so the connect never hangs", async () => {
    const answer = vi.fn(() => Promise.resolve());
    const handle = answerPrompts(() => Promise.reject(new Error("dialog closed")), answer);
    const prompts: ConnectPrompt[] = [
      { type: "hostKey", id: 1, host: "h", port: 22, algorithm: "a", fingerprint: "f" },
      { type: "password", id: 2, host: "h", user: "u", retry: true, canSave: false },
      { type: "passphrase", id: 3, keyPath: "/k/id_ed25519", retry: false, canSave: false },
      {
        type: "keyboardInteractive",
        id: 4,
        host: "h",
        user: "u",
        name: "",
        instructions: "",
        prompts: [{ text: "OTP: ", echo: true }],
      },
    ];

    for (const prompt of prompts) await handle(prompt);

    expect(answer.mock.calls).toEqual([
      [1, { type: "hostKey", decision: "reject" }],
      [2, { type: "password", password: null }],
      [3, { type: "passphrase", passphrase: null }],
      [4, { type: "keyboardInteractive", answers: null }],
    ]);
  });
});

describe("readCommandError", () => {
  it("reads the backend's error shape, including details", () => {
    const error = readCommandError({
      kind: "hostKeyMismatch",
      message: "changed",
      details: { fingerprint: "SHA256:new", knownFingerprint: "SHA256:old", knownHostsPath: "/k", line: 3 },
    });
    expect(error.kind).toBe("hostKeyMismatch");
    expect(error.details?.line).toBe(3);
  });

  it("wraps anything else as an unknown error", () => {
    expect(readCommandError("boom")).toEqual({ kind: "unknown", message: "boom" });
    expect(readCommandError(new Error("x")).message).toBe("x");
  });
});
