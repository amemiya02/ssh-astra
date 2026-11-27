import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { appEnv } from "./sandbox.ts";

export const smokeBinary = resolve(
  import.meta.dirname, "../../src-tauri/target/debug", process.platform === "win32" ? "sshastra.exe" : "sshastra",
);
export const smokeLogs = resolve(import.meta.dirname, "../artifacts/logs");

export async function relaunchSmokeApp(args = ["--single-instance-check", "argument with spaces"]): Promise<void> {
  const home = process.env.SSHASTRA_E2E_HOME;
  if (!home) throw new Error("The SSH Astra smoke test sandbox is missing.");
  await promisify(execFile)(smokeBinary, args, {
    cwd: home,
    env: { ...process.env, ...appEnv(home) },
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
}

let replacement: { child: ChildProcess; exited: Promise<void> } | undefined;

function killReplacement() {
  replacement?.child.kill("SIGKILL");
}

export async function stopReplacement(): Promise<void> {
  if (!replacement) return;
  const { child, exited } = replacement;
  const stopped = exited.then(() => true);
  child.kill();
  if (!await Promise.race([stopped, delay(5000, false, { ref: false })])) {
    child.kill("SIGKILL");
    if (!await Promise.race([stopped, delay(1000, false, { ref: false })])) {
      throw new Error(`The restarted SSH Astra process ${child.pid} did not exit after SIGKILL.`);
    }
  }
  replacement = undefined;
  process.off("exit", killReplacement);
}

export async function restartSmokeApp(
  browser: WebdriverIO.Browser,
  confirmQuit: () => Promise<void>,
  requestAppQuit?: () => Promise<void>,
  startupArgs: string[] = [],
): Promise<void> {
  const home = process.env.SSHASTRA_E2E_HOME;
  if (!home) throw new Error("The SSH Astra smoke test sandbox is missing.");
  const { hostname, port } = browser.options;
  const driver = new URL(`http://${hostname}:${port}`);
  const status = new URL("/status", driver);
  // Closing the last window can shut down WebDriver before it sends a reply.
  const closeRequest = requestAppQuit
    ? requestAppQuit().then(() => undefined)
    : fetch(new URL(`/session/${browser.sessionId}/window`, driver), {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  if (requestAppQuit) await closeRequest;
  await confirmQuit();
  const close = await closeRequest;
  if (close && !close.ok) throw new Error(`Could not close SSH Astra: ${await close.text()}`);
  await close?.body?.cancel();

  // The embedded server binds once at startup and stays up until the app exits.
  // Starting the replacement first can leave it without a listener.
  await browser.waitUntil(async () => {
    try {
      const response = await fetch(status, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      return false;
    } catch (error) {
      return error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";
    }
  }, { timeoutMsg: `The first SSH Astra process did not release ${driver.origin}.` });

  const log = join(smokeLogs, `restart-${process.pid}.log`);
  const fd = openSync(log, "w");
  let exitReason: string | undefined;
  try {
    const child = spawn(smokeBinary, startupArgs, {
      env: {
        ...process.env,
        ...appEnv(home),
        TAURI_WEBDRIVER_PORT: String(port),
        WDIO_EMBEDDED_SERVER: "true",
      },
      stdio: ["ignore", fd, fd],
    });
    const exited = new Promise<void>((done) => {
      let processError: Error | undefined;
      child.on("error", (error) => { processError = error; });
      child.once("close", (code, signal) => {
        exitReason = processError?.message ?? signal ?? `exit code ${code}`;
        done();
      });
    });
    replacement = { child, exited };
    // The worker may skip afterSession if the driver disappears during teardown.
    process.once("exit", killReplacement);
    child.unref();
  } finally {
    closeSync(fd);
  }

  try {
    await browser.waitUntil(async () => {
      if (exitReason) return true;
      try {
        const response = await fetch(status, { signal: AbortSignal.timeout(1000) });
        const body = await response.json() as { value?: { ready?: boolean } };
        return response.ok && body.value?.ready === true;
      } catch {
        return false;
      }
    }, { timeout: 60_000, timeoutMsg: `The restarted SSH Astra process never became ready. See ${log}.` });
    if (exitReason) throw new Error(`SSH Astra exited during startup (${exitReason}). See ${log}.`);
    await browser.reloadSession();
  } catch (error) {
    await stopReplacement();
    throw error;
  }
}
