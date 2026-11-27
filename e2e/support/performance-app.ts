/** Drives the real E2E app and samples the macOS processes that render it. */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { remote } from "webdriverio";
import type { E2eHooks } from "../../src/lib/e2e.ts";
import { appEnv, createSandboxHome } from "./sandbox.ts";

const hostName = "Performance OpenSSH";
const fixture = new URL("../../src-tauri/crates/sshastra-core/tests/sshd/", import.meta.url);
const idleSeconds = 15;
const settleMs = 5000;

const emit = (value: object) => console.log(JSON.stringify(value));

type Browser = Awaited<ReturnType<typeof remote>>;
interface ProcessSample {
  pid: number;
  name: string;
  cpuSeconds: number;
  rssMib: number;
}

function processes(): ProcessSample[] {
  const output = execFileSync("/bin/ps", ["-axww", "-o", "pid=,time=,rss=,comm="], { encoding: "utf8" });
  return output.trim().split("\n").flatMap((line) => {
    const row = line.match(/^\s*(\d+)\s+([\d:.]+)\s+(\d+)\s+(.+)$/);
    if (!row) return [];
    const [, pid, time, rss, command] = row;
    const cpuSeconds = time.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
    return [{ pid: Number(pid), name: basename(command), cpuSeconds, rssMib: Number(rss) / 1024 }];
  });
}

function isWebKit({ name }: ProcessSample): boolean {
  return /^com\.apple\.WebKit\.(WebContent|GPU|Networking)$/.test(name);
}

function sampleApp(pid: number, alreadyRunning: Set<number>) {
  return () => {
    const rows = processes();
    const app = rows.find((row) => row.pid === pid);
    if (!app) throw new Error(`App PID ${pid} exited during sampling`);
    const webkit = rows.filter((row) => isWebKit(row) && !alreadyRunning.has(row.pid));
    if (new Set(webkit.map((row) => row.name)).size !== webkit.length) {
      throw new Error("Multiple new processes for a WebKit role; close other apps opening WebKit and rerun");
    }
    return { at: performance.now(), app, webkit, totalRssMib: app.rssMib + webkit.reduce((sum, row) => sum + row.rssMib, 0) };
  };
}

type Sampler = ReturnType<typeof sampleApp>;
type Sample = ReturnType<Sampler>;

function summarize(before: Sample, after: Sample) {
  const elapsed = (after.at - before.at) / 1000;
  const appCpuPct = 100 * (after.app.cpuSeconds - before.app.cpuSeconds) / elapsed;
  const webkit = after.webkit.map((row) => {
    const initial = before.webkit.find((previous) => previous.pid === row.pid);
    return {
      pid: row.pid, name: row.name, rssMib: row.rssMib,
      cpuPct: 100 * (row.cpuSeconds - (initial?.cpuSeconds ?? 0)) / elapsed,
    };
  });
  return {
    seconds: elapsed,
    appRssMib: after.app.rssMib,
    appCpuPct,
    webkit,
    totalRssMib: after.totalRssMib,
    totalCpuPct: appCpuPct + webkit.reduce((sum, row) => sum + row.cpuPct, 0),
  };
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address for an available loopback port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function withApp<T>(
  binary: string,
  env: Record<string, string>,
  measure: (pid: number, stderr: () => string, home: string) => Promise<T>,
  prepare?: (home: string) => void,
): Promise<T> {
  const home = createSandboxHome();
  try {
    prepare?.(home);
    const child = spawn(binary, [], {
      env: { ...process.env, ...appEnv(home), ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    try {
      if (!child.pid) await exited;
      return await measure(child.pid!, () => stderr, home);
    } catch (error) {
      if (stderr) console.error(stderr);
      throw error;
    } finally {
      child.kill();
      await Promise.race([exited, delay(4000, undefined, { ref: false })]).catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, label: string, intervalMs = 40, timeoutMs = 25_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function measureStartup(binary: string) {
  const samples: number[] = [];
  for (let run = 0; run < 5; run++) {
    const ms = await withApp(binary, { SSHASTRA_MEASURE_STARTUP: "1" }, async (_pid, stderr) =>
      waitFor(() => {
        const value = stderr().match(/^SSHASTRA_HOME_FIRST_PAINT_MS=([\d.]+)$/m);
        return value ? Number(value[1]) : undefined;
      }, "Home first paint on stderr"));
    samples.push(ms);
    await delay(750);
  }
  emit({ startup: "home-first-paint", samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2] });
}

async function withDriver(binary: string, measure: (browser: Browser, sample: Sampler) => Promise<void>, prepare?: (home: string) => void) {
  const port = await availablePort();
  const existing = new Set(processes().filter(isWebKit).map(({ pid }) => pid));
  await withApp(binary, { TAURI_WEBDRIVER_PORT: String(port), SHELL: "/bin/bash" }, async (pid) => {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/status`).catch(() => undefined);
      return response?.ok ? true : undefined;
    }, "embedded WebDriver");
    const browser = await remote({
      hostname: "127.0.0.1", port, path: "/", logLevel: "silent", connectionRetryCount: 0,
      capabilities: { browserName: "tauri" },
    });
    try {
      await browser.$("button=New Host").waitForDisplayed();
      await measure(browser, sampleApp(pid, existing));
    } finally {
      await browser.deleteSession();
    }
  }, prepare);
}

async function idle(sample: Sampler, state: string) {
  await delay(settleMs);
  const before = sample();
  if (!before.webkit.some(({ name }) => name === "com.apple.WebKit.WebContent")) {
    throw new Error(`Could not attribute a new WebKit content process to ${state}`);
  }
  await delay(idleSeconds * 1000);
  const after = sample();
  if (before.webkit.some(({ pid }) => !after.webkit.some((process) => process.pid === pid))) {
    throw new Error(`A WebKit process exited during the ${state} sample`);
  }
  const result = summarize(before, after);
  emit({ idle: state, ...result });
  return result;
}

function metrics(browser: Browser, tailLines = 0) {
  return browser.execute((count) =>
    (window as unknown as { __sshastraE2E: E2eHooks }).__sshastraE2E.terminalMetrics(count), tailLines);
}

async function activeTerminal(browser: Browser, tailLines = 0) {
  return (await metrics(browser, tailLines)).find((terminal) => terminal.visible);
}

async function terminalWithLine(browser: Browser, line: string, intervalMs = 40) {
  return waitFor(async () => {
    const terminal = await activeTerminal(browser, 64);
    return terminal?.tail.split("\n").includes(line) ? terminal : undefined;
  }, `Terminal line ${line}`, intervalMs, 90_000);
}

async function focusTerminal(browser: Browser) {
  await waitFor(() => activeTerminal(browser), "visible Terminal");
  await browser.execute(() => document.querySelector<HTMLTextAreaElement>('[role="tabpanel"]:not([hidden]) textarea.xterm-helper-textarea')?.focus());
  if (!(await activeTerminal(browser))?.focused) throw new Error("Terminal did not take focus");
}

async function paste(browser: Browser, script: string) {
  await browser.execute((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, script);
}

async function command(browser: Browser, script: string) {
  await paste(browser, script);
  await browser.keys("Enter");
}

const newLocal = 'nav button[aria-label="New Local terminal"]';

function setCursorBlink(browser: Browser, enabled: boolean) {
  return browser.execute((blink) =>
    (window as unknown as { __sshastraE2E: E2eHooks }).__sshastraE2E.setFocusedCursorBlink(blink), enabled);
}

async function measureLocal(browser: Browser, sample: Sampler) {
  await browser.$(newLocal).click();
  await waitFor(async () => (await activeTerminal(browser, 4))?.tail.match(/[$%>]\s*$/) ? true : undefined, "Local terminal prompt");
  await focusTerminal(browser);
  await command(browser, `printf '\\nASTRA_%s\\n' LOCAL_READY`);
  await terminalWithLine(browser, "ASTRA_LOCAL_READY");
  const focusedBefore = await activeTerminal(browser);
  const focused = await idle(sample, "local-focused");
  const focusedAfter = await activeTerminal(browser);
  await setCursorBlink(browser, false);
  const stillBefore = await activeTerminal(browser);
  const still = await idle(sample, "local-focused-blink-off");
  const stillAfter = await activeTerminal(browser);
  await setCursorBlink(browser, true);
  await browser.execute(() => (document.activeElement as HTMLElement).blur());
  const unfocusedBefore = await activeTerminal(browser);
  const unfocused = await idle(sample, "local-unfocused");
  const unfocusedAfter = await activeTerminal(browser);
  if (!focusedBefore?.focused || !focusedAfter?.focused || !stillBefore?.focused || !stillAfter?.focused
    || !unfocusedBefore || !unfocusedAfter || unfocusedBefore.focused || unfocusedAfter.focused) {
    throw new Error("Terminal focus changed during the idle comparison");
  }
  emit({
    cursor: "focused-vs-unfocused",
    focusedCpuPct: focused.totalCpuPct, blinkOffCpuPct: still.totalCpuPct, unfocusedCpuPct: unfocused.totalCpuPct,
    focusedRenders: focusedAfter.renders - focusedBefore.renders,
    blinkOffRenders: stillAfter.renders - stillBefore.renders,
    unfocusedRenders: unfocusedAfter.renders - unfocusedBefore.renders,
  });

  for (let count = 2; count <= 20; count++) {
    await browser.$(newLocal).click();
    await waitFor(async () => (await metrics(browser)).length === count ? true : undefined, `${count} Local terminals`);
  }
  await waitFor(async () => (await metrics(browser, 4)).every(({ tail }) => tail.trim()) ? true : undefined, "all 20 shell prompts");
  await delay(settleMs);
  const twenty = sample();
  const terminals = await metrics(browser);
  const drawn: boolean[] = [];
  for (let index = 0; index < 20; index++) {
    const previous = (await metrics(browser))[index];
    await browser.execute((tabIndex) => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[tabIndex + 1]?.click();
    }, index);
    await focusTerminal(browser);
    await command(browser, `printf '\\nASTRA_TAB_%s\\n' ${index + 1}`);
    const line = `ASTRA_TAB_${index + 1}`;
    const rendered = await waitFor(async () => {
      const terminal = (await metrics(browser, 8))[index];
      return terminal.visible && terminal.renders > previous.renders && terminal.tail.split("\n").includes(line) ? true : undefined;
    }, `drawn contents of tab ${index + 1}`, 40, 5000).catch(() => false);
    drawn.push(rendered);
  }
  emit({
    tabs: 20, appRssMib: twenty.app.rssMib, totalRssMib: twenty.totalRssMib,
    addedRssMib: twenty.totalRssMib - focused.totalRssMib,
    webkit: twenty.webkit, webglTerminals: terminals.filter((terminal) => terminal.webgl).length, drawn,
  });
}

function prepareSshHome(home: string, sshPort: number, forwardPort?: number) {
  const ssh = join(home, ".ssh");
  mkdirSync(ssh, { mode: 0o700 });
  const key = join(ssh, "fixture_key");
  copyFileSync(new URL("keys/id_ed25519", fixture), key);
  chmodSync(key, 0o600);
  const keyText = readFileSync(new URL("ssh_host_ed25519_key.pub", fixture), "utf8");
  writeFileSync(join(ssh, "known_hosts"), `[127.0.0.1]:${sshPort} ${keyText.trim()}\n`);
  writeFileSync(join(home, "Library", "Application Support", "dev.sshastra.app", "hosts.json"), JSON.stringify({
    version: 5, groups: [], hosts: [{
      id: "performance-sshd", name: hostName, address: "127.0.0.1", port: sshPort, user: "tester",
      auth: { type: "key", identityFile: key },
      forwards: forwardPort === undefined ? [] : [{
        id: "performance-echo", label: "Echo", autoStart: true, type: "local",
        bindAddress: "127.0.0.1", bindPort: forwardPort, remoteHost: "echo", remotePort: 7777,
      }],
    }],
  }));
}

async function verifyEcho(port: number) {
  const socket = createConnection({ port, host: "127.0.0.1" });
  try {
    socket.setTimeout(5000, () => socket.destroy(new Error("Port forward echo timed out")));
    const message = Buffer.from("performance forward\n");
    socket.write(message);
    let reply = Buffer.alloc(0);
    for await (const chunk of socket) {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length >= message.length) break;
    }
    if (!message.equals(reply)) throw new Error("Port forward echo differed from input");
  } finally {
    socket.destroy();
  }
}

function homeHostCard(browser: Browser) {
  return browser.$(`//*[@role='tabpanel' and not(@hidden)]//button[contains(., '${hostName}')]`);
}

async function openRemote(browser: Browser) {
  const card = homeHostCard(browser);
  await card.waitForDisplayed();
  await card.click();
  await waitFor(async () => {
    const terminal = await activeTerminal(browser, 8);
    return terminal?.tail.match(/\$\s*$/) ? true : undefined;
  }, "remote login prompt");
  await focusTerminal(browser);
  await command(browser, `stty -echo; printf '\\nASTRA_%s\\n' SSH_READY`);
  await terminalWithLine(browser, "ASTRA_SSH_READY");
}

async function bulkOutput(browser: Browser, sample: Sampler) {
  await delay(settleMs);
  await paste(browser, `awk 'BEGIN { for (i=1; i<=262144; i++) printf "%06d %056d\\n", i, 0; printf "ASTRA_%s\\n", "OUTPUT_END" }'`);
  const before = (await activeTerminal(browser))!;
  const first = sample();
  const samples = [first];
  let sampleError: unknown;
  const timer = setInterval(() => {
    try { samples.push(sample()); } catch (error) { sampleError = error; }
  }, 50);
  const start = performance.now();
  try {
    await browser.keys("Enter");
    const last = await terminalWithLine(browser, "ASTRA_OUTPUT_END", 15);
    const seconds = (performance.now() - start) / 1000;
    const end = sample();
    samples.push(end);
    clearInterval(timer);
    if (sampleError) throw sampleError;
    const expected = Array.from({ length: 8 }, (_, i) => `${262137 + i} ${"0".repeat(56)}`).join("\n");
    const messages = last.outputMessages - before.outputMessages;
    const wireBytes = last.outputBytes - before.outputBytes;
    await delay(settleMs);
    emit({
      terminal: "bulk-output", payloadBytes: 16 * 1024 * 1024, secondsToMarker: seconds, tailComplete: last.tail.includes(`${expected}\nASTRA_OUTPUT_END`),
      messages, messagesPerSecond: messages / seconds, wireBytes,
      peakPendingOutputBytes: last.peakPendingOutputBytes,
      peakRssMib: Math.max(...samples.map(({ totalRssMib }) => totalRssMib)),
      peakAppRssMib: Math.max(...samples.map(({ app }) => app.rssMib)),
      beforeRssMib: first.totalRssMib, afterRssMib: sample().totalRssMib,
      ...summarize(first, end),
    });
  } finally {
    clearInterval(timer);
  }
}

async function fillScrollback(browser: Browser, sample: Sampler) {
  await delay(settleMs);
  const before = sample();
  const initial = (await activeTerminal(browser))!;
  await command(browser, `awk 'BEGIN { for (i=1; i<=12000; i++) printf "%06d %056d\\n", i, 0; printf "ASTRA_%s\\n", "SCROLLBACK_END" }'`);
  const filled = await terminalWithLine(browser, "ASTRA_SCROLLBACK_END");
  await delay(settleMs);
  const after = sample();
  const webContent = ({ name }: ProcessSample) => name === "com.apple.WebKit.WebContent";
  const beforeContent = before.webkit.find(webContent);
  const afterContent = after.webkit.find(webContent);
  emit({
    terminal: "full-scrollback", beforeLines: initial.scrollbackLines, filledLines: filled.scrollbackLines,
    beforeRssMib: before.totalRssMib, afterRssMib: after.totalRssMib,
    addedRssMib: after.totalRssMib - before.totalRssMib,
    webContentRssDeltaMib: beforeContent && afterContent ? afterContent.rssMib - beforeContent.rssMib : null,
  });
}

async function stoppedInput(browser: Browser, sample: Sampler) {
  await command(browser, `stty raw -echo; printf '\\r\\nASTRA_%s\\r\\n' INPUT_PAUSED; sleep 120`);
  const initial = await terminalWithLine(browser, "ASTRA_INPUT_PAUSED");
  const before = sample();
  const points = [{ pastedMib: 0, appRssMib: before.app.rssMib, totalRssMib: before.totalRssMib }];
  for (let batch = 1; batch <= 4; batch++) {
    await browser.execute(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "a".repeat(2 * 1024 * 1024));
      for (let i = 0; i < 4; i++) {
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      }
    });
    const pastedMib = batch * 8;
    await waitFor(async () => {
      const terminal = await activeTerminal(browser);
      return terminal && terminal.inputCharacters - initial.inputCharacters >= pastedMib * 1024 * 1024 ? true : undefined;
    }, `IPC acknowledgements for ${pastedMib} MiB of paste`);
    await delay(1000);
    const point = sample();
    points.push({ pastedMib, appRssMib: point.app.rssMib, totalRssMib: point.totalRssMib });
  }
  await delay(settleMs);
  const held = sample();
  emit({ terminal: "stopped-input", points, heldAppRssMib: held.app.rssMib, heldTotalRssMib: held.totalRssMib });
}

async function measureRemoteDesktop(binary: string, sshPort: number) {
  const forwardPort = await availablePort();
  await withDriver(binary, async (browser, sample) => {
    // The embedded driver's click dispatches only a click, while the Radix
    // menu opens on pointer-down. Wait for the async Host list before opening it.
    const card = homeHostCard(browser);
    await card.waitForDisplayed();
    await browser.execute((name) => {
      const buttons = Array.from(document.querySelectorAll('[role="tabpanel"]:not([hidden]) button'));
      const host = buttons.find((button) => button.textContent?.includes(name));
      const trigger = host?.parentElement?.querySelector('button[aria-label="More actions"]');
      if (!trigger) throw new Error(`Missing ${name} card's action menu`);
      trigger.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true,
      }));
    }, hostName);
    await waitFor(() => browser.execute(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const item = items.find((element) => element.textContent?.trim() === "Connect only");
      if (!item) return undefined;
      item.click();
      return true;
    }).then((clicked) => clicked || undefined), "the Connect only action", 40, 5000);
    await browser.$("//footer//*[@role='status']//button[normalize-space(.)='1 Port forward']").waitForDisplayed();
    await verifyEcho(forwardPort);
    await idle(sample, "held-connection-and-forward");
    await openRemote(browser);
    await bulkOutput(browser, sample);
  }, (home) => prepareSshHome(home, sshPort, forwardPort));

  await withDriver(binary, async (browser, sample) => {
    await openRemote(browser);
    await fillScrollback(browser, sample);
    await stoppedInput(browser, sample);
  }, (home) => prepareSshHome(home, sshPort));
}

export async function measureDesktop(binary: string, sshPort: number) {
  console.error("Sampling Home and Terminal states. Keep the app visible while this runs.");
  await withDriver(binary, async (_browser, sample) => { await idle(sample, "home"); });
  await withDriver(binary, measureLocal);
  await measureRemoteDesktop(binary, sshPort);
}
