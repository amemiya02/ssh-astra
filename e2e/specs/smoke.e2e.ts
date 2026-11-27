/**
 * The smoke test: one pass through what a user does first, against the Docker
 * OpenSSH server. The app opens on Home (no Terminal). New Host → connect → trust the host key → run a command and
 * see its output → `cd` and see the File panel follow → upload a file and find
 * it on the server.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import * as sshd from "../support/sshd.ts";

const HOST_NAME = "E2E sshd";
const run = randomUUID().slice(0, 8);
const scratch = `/home/${sshd.USER}/e2e-${run}`;
const uploadName = `upload-${run}.txt`;
const uploadContent = `uploaded by the sshastra E2E test ${run}\n`;

/** All open Terminals' text, read through the test-only hook (`src/lib/e2e.ts`). */
async function terminalText(): Promise<string> {
  const texts = await browser.execute(
    () => (window as unknown as { __sshastraE2E: { terminalText(): string[] } }).__sshastraE2E.terminalText(),
  );
  return texts.join("\n");
}

async function waitForTerminalText(pattern: RegExp, what: string): Promise<void> {
  let text = "";
  await browser
    .waitUntil(async () => pattern.test((text = await terminalText())), { timeout: 20_000 })
    .catch(() => {
      throw new Error(`the Terminal never showed ${what}; it shows:\n${text}`);
    });
}

/**
 * Pastes `command` into the focused Terminal, then presses Enter. Pasted rather
 * than typed: the embedded driver gives lower-case letters the `keyCode` of their
 * character code (`x` → 120, F9's), which xterm reads as function keys.
 */
async function typeCommand(command: string): Promise<void> {
  await browser.execute((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(paste);
  }, command);
  await browser.keys("Enter");
}

describe("sshastra", () => {
  let localDir: string;

  before(async () => {
    // Choosing the (only) window turns off the service's focus recovery, which
    // needs the `tauri-plugin-wdio` plugin and waits 5 s per command without it.
    await browser.switchToWindow(await browser.getWindowHandle());
    // No enter/exit animations: a window in the background (macOS) may never run them,
    // leaving dialogs at opacity 0, which WebDriver reports as not displayed.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
      document.head.append(style);
    });
    localDir = mkdtempSync(join(tmpdir(), "sshastra-e2e-upload-"));
    writeFileSync(join(localDir, uploadName), uploadContent);
  });

  after(() => {
    rmSync(localDir, { recursive: true, force: true });
    sshd.runAsTester(`rm -rf '${scratch}'`);
  });

  it("connects to a new Host, runs a command, follows cd and uploads a file", async () => {
    // New Host pointing at the Docker sshd.
    await $('button[aria-label="New Host"]').click();
    await $("#host-form-name").setValue(HOST_NAME);
    await $("#host-form-address").setValue("127.0.0.1");
    await $("#host-form-port").clearValue();
    await $("#host-form-port").setValue(String(sshd.port()));
    await $("#host-form-user").setValue(sshd.USER);
    await $("button=Save").click();

    // Open it: a Terminal tab connects.
    const hostRow = $(`button*=${HOST_NAME}`);
    await hostRow.waitForDisplayed();
    await hostRow.click();
    await browser.keys("Enter");

    // First Connection: trust the host key, then sign in with the password.
    await $("h2=Unknown host key").waitForDisplayed();
    await $("button=Trust and connect").click();
    const password = $('[role="dialog"] input[type="password"]');
    await password.waitForDisplayed();
    await password.setValue(sshd.PASSWORD);
    await $("button=Connect").click();
    await password.waitForDisplayed({ reverse: true });

    // The trusted key went to the sandbox's known_hosts, not the developer's.
    const knownHosts = join(process.env.SSHASTRA_E2E_HOME!, ".ssh", "known_hosts");
    await browser.waitUntil(() => existsSync(knownHosts), { timeoutMsg: "known_hosts was never written" });
    expect(readFileSync(knownHosts, "utf8")).toContain(`[127.0.0.1]:${sshd.port()}`);

    // Run a command and see its output.
    await waitForTerminalText(/\$\s*$/m, "a prompt");
    // Focus the shown Terminal (the app opens on Home, so the remote one is the only Terminal).
    // A WebDriver click does not reach xterm's focus handling, so focus its input directly.
    const shown = await $$(".xterm").filter((xterm) => xterm.isDisplayed());
    expect(shown).toHaveLength(1);
    const input = await shown[0]!.$("textarea.xterm-helper-textarea");
    await browser.execute((textarea) => textarea.focus(), input);
    await typeCommand(`echo "e2e-$((6 * 7))-${run}"`);
    await waitForTerminalText(new RegExp(`^e2e-42-${run}$`, "m"), "the command's output");

    // cd: the File panel follows the shell.
    await typeCommand(`mkdir ${scratch} && cd ${scratch}`);
    const listing = $(`[role="grid"][aria-label="Files in ${scratch}"]`);
    await listing.waitForDisplayed();
    await expect(listing.$("p=This folder is empty.")).toBeDisplayed();

    // Upload a file into the folder shown (the native picker is answered by the test hook).
    await browser.execute(
      (path) => (window as unknown as { __sshastraE2E: { pickedFiles: string[][] } }).__sshastraE2E.pickedFiles.push([path]),
      join(localDir, uploadName),
    );
    await $('button[aria-label="Upload files"]').click();
    await browser.waitUntil(() => sshd.runAsTester(`cat '${scratch}/${uploadName}' 2>/dev/null || true`) === uploadContent, {
      timeoutMsg: "the uploaded file never matched on the server",
    });
    // The listing reloads by itself once the upload into the folder shown is done.
    await listing.$(`span=${uploadName}`).waitForDisplayed();
  });
});
