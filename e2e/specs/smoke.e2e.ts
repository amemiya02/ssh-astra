/**
 * The smoke test: one pass through what a user does first, against the Docker
 * OpenSSH server. New Host → decline the host key → retry in the same tab →
 * trust and sign in → run a command → `cd` → follow in the File panel → upload a file and find
 * it on the server.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { restartSmokeApp } from "../support/smoke-app.ts";
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

async function prepareWindow(): Promise<void> {
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
}

describe("sshastra", () => {
  let localDir: string;

  before(async () => {
    await prepareWindow();
    localDir = mkdtempSync(join(tmpdir(), "sshastra-e2e-upload-"));
    writeFileSync(join(localDir, uploadName), uploadContent);
  });

  after(() => {
    rmSync(localDir, { recursive: true, force: true });
    sshd.runAsTester(`rm -rf '${scratch}'`);
  });

  it("retries in the same tab, runs a command, follows cd and uploads a file", async () => {
    // New Host pointing at the Docker sshd, from Home's own button (the Host list is hidden on Home).
    await $("button=New Host").click();
    await $("#host-form-name").setValue(HOST_NAME);
    await $("#host-form-address").setValue("127.0.0.1");
    await $("#host-form-port").clearValue();
    await $("#host-form-port").setValue(String(sshd.port()));
    await $("#host-form-user").setValue(sshd.USER);
    await $("button=Save").click();

    // Open it from its Home card: a Terminal tab connects.
    const hostCard = $(`//*[@role='tabpanel' and not(@hidden)]//button[contains(., '${HOST_NAME}')]`);
    await hostCard.waitForDisplayed();
    await hostCard.click();

    // Decline the first host key question, then retry the same Terminal pane.
    await $("h2=Unknown host key").waitForDisplayed();
    const tab = $('[role="tab"][aria-selected="true"]');
    const panelId = await tab.getAttribute("aria-controls");
    if (!panelId) throw new Error("the active tab has no panel");
    await $('[role="dialog"]').$("button=Reject").click();

    const paneId = await $(`#${panelId} [id^="pane-"]`).getAttribute("id");
    if (!paneId) throw new Error("the active panel has no pane");
    const pane = $(`#${paneId}`);
    await expect(pane.$("li*=Verify host key")).toHaveText(expect.stringContaining("Failed"));
    await expect(pane.$('[role="alert"]')).toHaveText(expect.stringContaining("The host key was not trusted."));
    await expect(pane.$("button=Close")).toBeDisplayed();
    await pane.$("button=Edit Host").click();
    await expect($("h2=Edit Host")).toBeDisplayed();
    await expect($("#host-form-name")).toHaveValue(HOST_NAME);
    await $('[role="dialog"]').$("button=Cancel").click();
    await pane.$("button=Retry").click();

    // The old tab and pane stay in place while trust and authentication run again.
    await $("h2=Unknown host key").waitForDisplayed();
    await expect(tab).toHaveAttribute("aria-controls", panelId);
    await expect(pane).toBeDisplayed();
    await $("button=Save and trust").click();
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
    // A WebDriver click does not reach xterm's focus handling, so focus its input directly.
    await expect(tab).toHaveAttribute("aria-controls", panelId);
    await expect(pane.$(".xterm")).toBeDisplayed();
    const input = await pane.$("textarea.xterm-helper-textarea");
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

  it("restores the tab and split layout after restarting and connects only on request", async () => {
    const name = "E2E restored sshd";
    await $('[role="tab"][id]').click();
    await $("button=New Host").click();
    await $("#host-form-name").setValue(name);
    await $("#host-form-address").setValue("127.0.0.1");
    await $("#host-form-port").clearValue();
    await $("#host-form-port").setValue(String(sshd.port()));
    await $("#host-form-user").setValue(sshd.USER);
    await $("button=Save").click();
    await $(`//*[@role='tabpanel' and not(@hidden)]//button[contains(., '${name}')]`).click();

    const password = () => $('[role="dialog"] input[type="password"]');
    const trust = $("button=Save and trust");
    await browser.waitUntil(async () => await password().isDisplayed() || await trust.isDisplayed());
    if (await trust.isDisplayed()) await trust.click();
    await password().waitForDisplayed();
    await password().setValue(sshd.PASSWORD);
    await $('[role="dialog"]').$("button=Connect").click();

    const activeTab = () => $('[role="tab"][aria-selected="true"]');
    await activeTab().$('[data-status="connected"]').waitForExist();
    await $('button[aria-label="Split right"]').click();
    await activeTab().$('[data-status="connected"]').waitForExist();
    const tabs = await $$('[role="tab"]').map((tab) => tab.getAttribute("id"));
    const tab = await activeTab().getAttribute("id");
    const panel = await activeTab().getAttribute("aria-controls");
    if (!panel || !tab) throw new Error("The active tab has no saved identity.");

    const focusedPane = () => $(`//*[@id='${panel}']//*[@data-pane-focus]/..`);
    const focus = await focusedPane().getAttribute("id");
    if (!focus) throw new Error("The split has no focused pane.");
    await browser.waitUntil(async () => {
      return browser.execute(async (id, paneId) => {
        type Saved = { workspace?: { activeId?: string; tabs?: { id: string; activePaneId: string }[] } };
        const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<Saved> } }).__TAURI_INTERNALS__;
        const { workspace } = await tauri.invoke("settings_load");
        return workspace?.activeId === id && workspace.tabs?.some((entry) => entry.id === id && `pane-${entry.activePaneId}` === paneId);
      }, tab.replace(/^tab-/, ""), focus);
    }, { timeoutMsg: "The active tab and split focus were never saved." });

    await restartSmokeApp(browser, async () => {
      const quitDialog = $('[role="dialog"]');
      await expect(quitDialog.$("h2")).toHaveText("Quit SSH Astra?");
      await expect(quitDialog.$("li=1 Connection")).toBeDisplayed();
      // The quit can stop WebDriver before the click response arrives.
      await quitDialog.$("button=Quit").click().catch(() => undefined);
    });
    await prepareWindow();
    await expect(activeTab()).toHaveAttribute("id", tab);
    expect(await $$('[role="tab"]').map((tab) => tab.getAttribute("id"))).toEqual(tabs);
    await expect(focusedPane()).toHaveAttribute("id", focus);
    await expect($(`#${panel} [role="separator"][aria-orientation="vertical"]`)).toBeDisplayed();
    const connect = await $$(`#${panel} button`).filter(async (button) => await button.getText() === "Connect");
    expect(connect).toHaveLength(2);
    await expect($(`#${panel} .xterm`)).not.toExist();
    await expect($('[role="dialog"]')).not.toExist();

    await focusedPane().$("button=Connect").click();
    await password().waitForDisplayed();
    await password().setValue(sshd.PASSWORD);
    await $('[role="dialog"]').$("button=Connect").click();
    await expect(activeTab().$('[data-status="connected"]')).toExist();
    await expect(focusedPane().$(".xterm")).toBeDisplayed();
    await expect($(`#${panel}`).$("button=Connect")).toBeDisplayed();
  });
});
