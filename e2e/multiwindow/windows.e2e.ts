import { $, $$, browser, expect } from "@wdio/globals";
import { restartSmokeApp } from "../support/smoke-app.ts";
import * as sshd from "../support/sshd.ts";
import { measureWindowRss } from "../support/window-rss.ts";

const name = "Shared smoke Host";
const homeCard = () => $(`//*[@role='tabpanel' and not(@hidden)]//button[contains(., '${name}')]`);
const activeTab = () => $('[role="tab"][aria-selected="true"]');
const activeTerminal = () => $('[role="tabpanel"]:not([hidden]) .xterm');
const tabIds = () => $$('[role="tab"]').map((tab) => tab.getAttribute("id"));

async function shortcut(code: string, altKey = false): Promise<void> {
  await browser.execute((key, alt) => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
      key: key.replace("Key", ""), code: key, ctrlKey: true, shiftKey: true, altKey: alt,
      bubbles: true, cancelable: true,
    }));
  }, code, altKey);
}

async function selectWindow(label: string): Promise<void> {
  await browser.switchToWindow(label);
  await $('button[aria-label="Home"]').waitForExist();
  await browser.execute(() => {
    if (document.getElementById("e2e-no-motion")) return;
    const style = document.createElement("style");
    style.id = "e2e-no-motion";
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.append(style);
  });
}

async function liveConnections(): Promise<number> {
  return browser.execute(() => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<number> } }).__TAURI_INTERNALS__;
    return tauri.invoke("quit_live_connection_count");
  });
}

async function typeCommand(command: string, pane = 0): Promise<void> {
  await browser.execute((text, index) => {
    const input = document.querySelectorAll<HTMLTextAreaElement>('[role="tabpanel"]:not([hidden]) .xterm-helper-textarea')[index];
    if (!input) throw new Error("The active Terminal has no input");
    input.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, command, pane);
  await browser.keys("Enter");
}

async function terminalText(): Promise<string[]> {
  return browser.execute(() =>
    (window as unknown as { __sshastraE2E: { terminalText(): string[] } }).__sshastraE2E.terminalText());
}

async function transportEndpoint(): Promise<string> {
  await typeCommand('printf "astra-transport %s\\n" "$SSH_CONNECTION"');
  let matched = "";
  await browser.waitUntil(async () => {
    matched = (await terminalText()).join("\n").match(/^astra-transport ([0-9.:]+ \d+ [0-9.:]+ \d+)$/m)?.[1] ?? "";
    return matched !== "";
  }, { timeoutMsg: "The Terminal never reported its SSH transport endpoint." });
  return matched;
}

async function requestAppQuit(label: string): Promise<void> {
  await browser.execute((targetLabel) => {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args: object): Promise<void> };
    }).__TAURI_INTERNALS__;
    // Dispatch the native Quit menu's event. WebDriver sends keys to the DOM
    // so a synthetic Ctrl+Shift+Q does not reach the GTK menu bar.
    return tauri.invoke("plugin:event|emit_to", {
      target: { kind: "WebviewWindow", label: targetLabel },
      event: "app-quit-requested",
      payload: null,
    });
  }, label);
}

describe("SSH Astra Windows", function () {
  before(function () {
    if (process.platform !== "linux") this.skip();
  });

  it("shares settings and one Connection, and restores independent Windows", async () => {
    const main = await browser.getWindowHandle();
    await selectWindow(main);
    await expect(activeTab()).toHaveText("Home");

    // Open via the workspace shortcut. The palette advertises the same action.
    await shortcut("KeyK");
    await $('[role="combobox"]').setValue("New Window");
    await expect($('[role="option"]')).toHaveText(expect.stringContaining("New Window"));
    await browser.keys("Escape");
    await measureWindowRss(1);
    await shortcut("KeyN", true);
    let handles: string[] = [];
    await browser.waitUntil(async () => (handles = await browser.getWindowHandles()).length === 2);
    const second = handles.find((label) => label !== main)!;
    await selectWindow(second);
    await expect(activeTab()).toHaveText("Home");
    await measureWindowRss(2);
    await expect($$('[role="tab"]')).toBeElementsArrayOfSize(1);

    await selectWindow(main);
    const theme = async () => browser.execute(() => document.documentElement.dataset.theme);
    const initialTheme = await theme();
    const selectedTheme = initialTheme === "dark" ? "Astra Light" : "Astra Dark";
    const selectedId = initialTheme === "dark" ? "light" : "dark";
    await shortcut("KeyK");
    await $('[role="combobox"]').setValue(selectedTheme);
    await $(`//*[@role='option' and contains(., 'Theme: ${selectedTheme}')]`).click();
    await browser.waitUntil(async () => await theme() === selectedId);

    await $("button=New Host").click();
    await $("#host-form-name").setValue(name);
    await $("#host-form-address").setValue("127.0.0.1");
    await $("#host-form-port").setValue(String(sshd.port()));
    await $("#host-form-user").setValue(sshd.USER);
    await $("button=Save").click();
    await homeCard().waitForDisplayed();
    await homeCard().click();
    await $("button=Save and trust").waitForDisplayed();
    await $("button=Save and trust").click();
    const password = $('[role="dialog"] input[type="password"]');
    await password.waitForDisplayed();
    await password.setValue(sshd.PASSWORD);
    await $('[role="dialog"]').$("button=Connect").click();
    await activeTab().$('[data-status="connected"]').waitForExist();
    await activeTerminal().waitForDisplayed();
    const endpoint = await transportEndpoint();

    await selectWindow(second);
    // No reload. The open Home acquired the changed theme and newly saved Host.
    await browser.waitUntil(async () => await theme() === selectedId);
    await homeCard().waitForDisplayed();
    await homeCard().click();
    await activeTab().$('[data-status="connected"]').waitForExist();
    await activeTerminal().waitForDisplayed();
    await expect($('[role="dialog"]')).not.toExist();
    expect(await liveConnections()).toBe(1);
    expect(await transportEndpoint()).toBe(endpoint);

    // Capture both shell identities and their output before moving the whole split.
    await shortcut("KeyE");
    const shownPanes = () => $$('[role="tabpanel"]:not([hidden]) .xterm');
    await expect(shownPanes()).toBeElementsArrayOfSize(2);
    await browser.waitUntil(async () => {
      return (await shownPanes().map((pane) => pane.isDisplayed())).every(Boolean)
        && (await terminalText()).every((text) => text.length > 0);
    });
    for (const pane of [0, 1]) {
      await typeCommand(`ASTRA_PANE=split-${pane}; printf '%s:%s\\n' "$ASTRA_PANE" "$$"`, pane);
    }
    const identities = () => terminalText().then((texts) =>
      texts.map((text, index) => text.match(new RegExp(`^split-${index}:(\\d+)$`, "m"))?.[0]));
    let shells: (string | undefined)[] = [];
    await browser.waitUntil(async () => (shells = await identities()).length === 2 && shells.every(Boolean));
    const movedTab = await activeTab().getAttribute("id");
    if (!movedTab) throw new Error("The split has no tab ID.");
    await browser.execute(() => {
      // Open the DOM context menu independently of native pointer synthesis.
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      if (!tab) throw new Error("The active tab is missing before opening its menu.");
      const bounds = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: bounds.x + 4, clientY: bounds.y + 4,
      }));
    });
    const move = $('//*[@role="menuitem" and contains(., "Move to New Window")]');
    await move.waitForDisplayed();
    await expect(move).not.toHaveAttribute("aria-disabled", "true");
    await move.click();
    await browser.waitUntil(async () => (handles = await browser.getWindowHandles()).length === 3);
    const destination = handles.find((label) => label !== main && label !== second)!;
    await selectWindow(destination);
    await expect(activeTab()).toHaveAttribute("id", movedTab);
    await expect(shownPanes()).toBeElementsArrayOfSize(2);
    await browser.waitUntil(async () => (await identities()).join(",") === shells.join(","));
    await browser.waitUntil(() => browser.execute(() =>
      !document.querySelector('[role="tabpanel"]:not([hidden])')?.closest("[inert]")));
    expect(await liveConnections()).toBe(1);
    for (const pane of [0, 1]) {
      await typeCommand(`printf 'after-%s:%s\\n' "$ASTRA_PANE" "$$"`, pane);
    }
    await browser.waitUntil(async () =>
      (await terminalText()).every((text, pane) => text.split("\n").includes(`after-${shells[pane]}`)));
    await selectWindow(second);
    await browser.waitUntil(async () => !(await tabIds()).includes(movedTab));
    await selectWindow(destination);
    await browser.closeWindow();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    await selectWindow(second);
    await homeCard().click();
    await activeTab().$('[data-status="connected"]').waitForExist();

    await $('button[aria-label="Port forwards"]').click();
    await expect($('button[aria-label="Port forwards"]')).toHaveAttribute("aria-pressed", "true");
    const secondTabs = await tabIds();
    const secondFocused = await activeTab().getAttribute("id");
    if (!secondFocused) throw new Error("The second Window has no active tab ID.");
    const secondRect = await browser.setWindowRect(350, 115, 880, 675);

    await selectWindow(main);
    await expect($('button[aria-label="Port forwards"]')).toHaveAttribute("aria-pressed", "false");
    await $('nav button[aria-label="New Local terminal"]').click();
    const mainTabs = await tabIds();
    const mainFocused = await activeTab().getAttribute("id");
    if (!mainFocused) throw new Error("The first Window has no active tab ID.");
    expect(mainTabs).toHaveLength(3);
    const mainRect = await browser.setWindowRect(54, 60, 922, 712);
    expect(mainRect).not.toEqual(secondRect);

    await restartSmokeApp(browser, async () => {
      const quit = $('[role="dialog"]');
      await expect(quit.$("h2")).toHaveText("Quit SSH Astra?");
      await expect(quit.$("li=1 Connection")).toBeDisplayed();
      await quit.$("button=Quit").click().catch(() => undefined);
    }, () => requestAppQuit(main));

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    await selectWindow(main);
    expect(await tabIds()).toEqual(mainTabs);
    await expect(activeTab()).toHaveAttribute("id", mainFocused);
    expect(await browser.getWindowRect()).toEqual(mainRect);
    await expect($('button[aria-label="Port forwards"]')).toHaveAttribute("aria-pressed", "false");

    await selectWindow(second);
    expect(await tabIds()).toEqual(secondTabs);
    await expect(activeTab()).toHaveAttribute("id", secondFocused);
    expect(await browser.getWindowRect()).toEqual(secondRect);
    await expect($('button[aria-label="Port forwards"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('[role="tabpanel"]:not([hidden])').$("button=Connect")).toBeDisplayed();
    await browser.closeWindow();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1);
    await selectWindow(main);
    expect(await tabIds()).toEqual(mainTabs);
  });
});
