/**
 * The README screenshots: drives the real app through the demo world
 * (`demo.ts`) and saves each view to `docs/screenshots/`. Run with
 * `pnpm screenshots`; see `../wdio.screenshots.conf.ts`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $, $$, browser } from "@wdio/globals";
import { USER } from "./demo.ts";

const out = resolve(import.meta.dirname, "../../docs/screenshots");
const WIDTH = 1440;
const HEIGHT = 900;

interface Hooks {
  pickedFiles: string[][];
  terminalText(): string[];
}

async function terminalTexts(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __sshastraE2E: Hooks }).__sshastraE2E.terminalText());
}

async function waitForTerminalText(pattern: RegExp, what: string, timeout = 30_000): Promise<void> {
  let text = "";
  await browser
    .waitUntil(async () => pattern.test((text = (await terminalTexts()).join("\n"))), { timeout })
    .catch(() => {
      throw new Error(`no Terminal showed ${what}; they show:\n${text}`);
    });
}

/** The xterm input of the `index`th Terminal on screen (left to right). */
async function focusTerminal(index = 0): Promise<void> {
  const shown = await $$(".xterm").filter((xterm) => xterm.isDisplayed());
  const input = await shown[index]!.$("textarea.xterm-helper-textarea");
  await browser.execute((textarea) => textarea.focus(), input);
}

/** Pastes `command` into the focused Terminal and presses Enter (typed letters reach xterm as function keys). */
async function run(command: string): Promise<void> {
  await browser.execute((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, command);
  await browser.keys("Enter");
}

/** Presses a window shortcut (⌘ on macOS, else Ctrl+Shift) as the workspace listener sees it. */
async function shortcut(code: string, key: string): Promise<void> {
  await browser.execute(
    (code, key) => {
      const mac = /Mac/.test(navigator.userAgent);
      const init = { code, key, bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac, shiftKey: !mac };
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
    },
    code,
    key,
  );
}

/** Clicks through the DOM: for controls that only show on hover, which WebDriver calls not displayed. */
async function domClick(selector: string): Promise<void> {
  await browser.waitUntil(() => browser.execute((s) => document.querySelector(s) !== null, selector), {
    timeoutMsg: `nothing matches ${selector}`,
  });
  await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), selector);
}

async function hostRow(name: string) {
  const row = $(`//aside//button[.//*[normalize-space()="${name}"]]`);
  await row.waitForDisplayed();
  return row;
}

async function openHost(name: string): Promise<void> {
  const row = await hostRow(name);
  await row.click();
  await browser.keys("Enter");
}

/** Opens a Host row's "More actions" menu from the keyboard and picks `item`. */
async function hostMenu(name: string, item: string): Promise<void> {
  const row = await hostRow(name);
  await row.click();
  await browser.execute(
    (button) => (button.closest("li")!.querySelector('[aria-label="More actions"]') as HTMLElement).focus(),
    row,
  );
  await browser.keys("Enter");
  const entry = $(`//*[@role="menuitem"][normalize-space()="${item}"]`);
  await entry.waitForDisplayed();
  await entry.click();
}

async function setFilePanel(shown: boolean): Promise<void> {
  const want = shown ? "Show File panel" : "Hide File panel";
  const has = await browser.execute((l) => document.querySelector(`[aria-label="${l}"]`) !== null, want);
  if (has) await domClick(`[aria-label="${want}"]`);
}

/** Opens Settings, stops following the system appearance, and picks the named theme's card. */
async function setTheme(name: string): Promise<void> {
  await shortcut("Comma", ",");
  const off = $(`//*[@role="radiogroup"][@aria-label="Follow system appearance"]//*[@role="radio"][normalize-space()="Off"]`);
  await off.waitForDisplayed();
  if ((await off.getAttribute("aria-checked")) !== "true") await off.click();
  const card = $(`[role="radio"][aria-label="${name}"]`);
  await card.waitForDisplayed();
  await card.click();
  await parkPointer();
}

async function closeTab(title: string): Promise<void> {
  await domClick(`button[aria-label="Close ${title}"]`);
}

/** Moves the pointer off whatever it last clicked, so no hover state shows. */
async function parkPointer(): Promise<void> {
  await browser
    .action("pointer")
    .move({ x: Math.round(WIDTH * 0.62), y: HEIGHT - 4 })
    .perform()
    .catch(() => undefined);
}

/** Saves the window as `docs/screenshots/<name>.png`, quantised by ImageMagick when it is installed. */
/**
 * Whether a Terminal on screen came out blank in the capture `file` (its canvas is
 * sometimes caught before it repaints): too few colours inside its screen area.
 */
async function blankTerminal(file: string): Promise<boolean> {
  const rects = await browser.execute(() =>
    [...document.querySelectorAll(".xterm-screen")]
      .filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * window.devicePixelRatio))),
  );
  return rects.some(([x, y, w, h]) => {
    try {
      const colours = execFileSync("magick", [file, "-crop", `${w}x${h}+${x}+${y}`, "-format", "%k", "info:"], {
        encoding: "utf8",
      });
      return Number(colours) < 8;
    } catch {
      return false; // No ImageMagick: no check.
    }
  });
}

/** `checkTerminals: false` for a shot whose Terminal is empty on purpose. */
async function shot(name: string, { checkTerminals = true } = {}): Promise<void> {
  await parkPointer();
  const file = join(out, `${name}.png`);
  for (let attempt = 1; ; attempt++) {
    // Let xterm repaint and the File panel settle.
    await browser.pause(1200);
    await browser.saveScreenshot(file);
    if (!checkTerminals || !(await blankTerminal(file))) break;
    if (attempt === 5) throw new Error(`${name}: a Terminal stayed blank in every capture`);
    console.log(`${name}: a Terminal came out blank, capturing again`);
  }
  // The capture can run past the page when the screen is too short for the window: keep the page only.
  const [width, height] = await browser.execute(() => [
    Math.round(window.innerWidth * window.devicePixelRatio),
    Math.round(window.innerHeight * window.devicePixelRatio),
  ]);
  try {
    execFileSync("magick", [
      file,
      "-crop",
      `${width}x${height}+0+0`,
      "+repage",
      "-strip",
      "-dither",
      "None",
      "-colors",
      "256",
      `PNG8:${file}`,
    ]);
  } catch {
    // No ImageMagick: keep the full-colour PNG.
  }
  console.log(`${name}.png: ${Math.round(statSync(file).size / 1024)} KB`);
}

describe("README screenshots", () => {
  let localDir: string;

  before(async () => {
    mkdirSync(out, { recursive: true });
    await browser.switchToWindow(await browser.getWindowHandle());
    await browser.setWindowSize(WIDTH, HEIGHT).catch(() => undefined);
    await browser.pause(500);
    console.log(
      "viewport",
      await browser.execute(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]),
      await browser.getWindowSize().catch(() => null),
    );
    // No enter/exit animations, so nothing is caught mid-frame.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
      document.head.append(style);
    });

    localDir = mkdtempSync(join(tmpdir(), "sshastra-shots-"));
    const sizes: [string, number][] = [
      ["orbit-api-2.4.0.tar.gz", 38],
      ["orbit-web-2.4.0.tar.gz", 22],
      ["static-assets.zip", 27],
      ["migrations-2.4.0.sql", 2],
      ["release-notes.md", 1],
    ];
    for (const [file, mb] of sizes) writeFileSync(join(localDir, file), randomBytes(mb * 1024 * 1024));
  });

  after(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  it("Home: the Host vault the app opens with (dark)", async () => {
    // The app starts on the Home tab with no Terminal; this machine's shell is no part of the demo.
    await $('[role="tab"][aria-label="Home"]').waitForDisplayed();
    await $("//*[@role='tabpanel' and not(@hidden)]//button[.//*[normalize-space()='web-01']]").waitForDisplayed();
    await shot("home-dark", { checkTerminals: false });
  });

  it("hero: Host list, a remote Terminal and its File panel (dark)", async () => {
    await openHost("web-01");
    await waitForTerminalText(new RegExp(`${USER}@web-01:~\\$ *$`, "m"), "web-01's prompt");
    await focusTerminal();
    await run("cd ~/app");
    await $(`[role="grid"][aria-label="Files in /home/${USER}/app"]`).waitForDisplayed();
    await run("clear");
    await run("git log --graph --oneline --decorate --all");
    await waitForTerminalText(/Initial commit/, "git log");
    await run("ls");
    await waitForTerminalText(/tsconfig\.json/, "ls");
    await shot("hero-dark");
  });

  it("Settings, then the main view in the light theme", async () => {
    await shortcut("Comma", ",");
    await $('[role="radiogroup"][aria-label="Dark themes"]').waitForDisplayed();
    await setFilePanel(false);
    await shot("settings");
    await setTheme("Astra Light");
    await setFilePanel(true);
    await closeTab("Settings");
    await focusTerminal();
    await shot("main-light");
    // Two of the other whole-window themes: chrome and Terminal recolour together.
    await setTheme("Tokyo Night");
    await closeTab("Settings");
    await focusTerminal();
    await shot("theme-tokyo-night");
    await setTheme("Catppuccin Latte");
    await closeTab("Settings");
    await focusTerminal();
    await shot("theme-catppuccin-latte");
    await setTheme("Astra Dark");
    await closeTab("Settings");
  });

  it("split panes: two Terminals side by side", async () => {
    // Wider panes without the File panel; the left one shows the history again.
    await setFilePanel(false);
    await focusTerminal(0);
    await run("clear");
    await run("git log --graph --oneline --decorate --all");
    await domClick('button[aria-label="Split right"]');
    await browser.waitUntil(async () => (await $$(".xterm").filter((x) => x.isDisplayed())).length === 2);
    await browser.waitUntil(
      async () => (await terminalTexts()).filter((t) => new RegExp(`${USER}@web-01:~\\$ *$`, "m").test(t)).length >= 1,
    );
    await browser.pause(1500);
    await focusTerminal(1);
    await run("htop");
    await waitForTerminalText(/Load average/, "htop");
    // htop's first frame shows 0% everywhere; wait for a real sample.
    await browser.pause(3000);
    await shot("split-panes");
  });

  it("the ⌘K command palette", async () => {
    await shortcut("KeyK", "k");
    const input = $('[role="dialog"] input');
    await input.waitForDisplayed();
    await shot("command-palette");
    await browser.keys("Escape");
    await input.waitForDisplayed({ reverse: true });
  });

  it("the Known host trust dialog", async () => {
    await openHost("nas");
    const title = $("h2=Unknown host key");
    await title.waitForDisplayed();
    await shot("known-host-trust", { checkTerminals: false });
    await $("button=Cancel").click();
    await title.waitForDisplayed({ reverse: true });
    await closeTab("nas");
  });

  it("Port forwards: local, remote and SOCKS rules running", async () => {
    await setFilePanel(false);
    await hostMenu("api-01", "Port forwards");
    // The sidebar's Port forwards view has a (hidden) heading of the same name: look in the shown tab.
    await $('//*[@role="tabpanel" and not(@hidden)]//h2[normalize-space()="Port forwards"]').waitForDisplayed();
    await hostMenu("api-01", "Connect only");
    await browser.waitUntil(async () => (await $$("span=Running").length) === 2, {
      timeoutMsg: "the auto-start rules never ran",
    });
    await $("button=Start").click();
    await browser.waitUntil(async () => (await $$("span=Running").length) === 3, {
      timeoutMsg: "the SOCKS rule never ran",
    });
    await shot("port-forwards");
  });

  it("File panel transfer queue", async () => {
    await $('button[role="tab"][aria-label*="web-01"]').click();
    await setFilePanel(true);
    // Back to one Terminal: close the htop pane.
    await focusTerminal(1);
    await shortcut("KeyW", "w");
    await browser.waitUntil(async () => (await $$(".xterm").filter((x) => x.isDisplayed())).length === 1);
    await focusTerminal(0);
    await run("clear && cd ~/releases && ls -lh");
    await $(`[role="grid"][aria-label="Files in /home/${USER}/releases"]`).waitForDisplayed();
    const files = ["orbit-api-2.4.0.tar.gz", "orbit-web-2.4.0.tar.gz", "static-assets.zip", "migrations-2.4.0.sql", "release-notes.md"];
    await browser.execute(
      (paths) => (window as unknown as { __sshastraE2E: Hooks }).__sshastraE2E.pickedFiles.push(paths),
      files.map((f) => join(localDir, f)),
    );
    await $('button[aria-label="Upload files"]').click();
    // Focus back in the Terminal, so the button's tooltip closes.
    await focusTerminal(0);
    await browser.pause(4000);
    await shot("file-transfers");
  });
});
