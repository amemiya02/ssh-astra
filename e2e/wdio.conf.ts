/**
 * The E2E smoke test: drives the real app (built by `pnpm e2e:build`) through
 * the WebDriver server embedded in it (`tauri-plugin-wdio-webdriver`, compiled
 * in only with the `e2e` Cargo feature) against the Docker OpenSSH server.
 *
 * Run with `pnpm e2e` (Docker required). Screenshots and logs of a failed run
 * land in `e2e/artifacts/`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appEnv, sandboxHome } from "./support/sandbox.ts";
import * as sshd from "./support/sshd.ts";

const root = resolve(import.meta.dirname, "..");
const binary = resolve(root, "src-tauri/target/debug", process.platform === "win32" ? "sshastra.exe" : "sshastra");
const artifacts = resolve(import.meta.dirname, "artifacts");
const home = sandboxHome();

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: binary },
      "wdio:tauriServiceOptions": {
        driverProvider: "embedded",
        env: appEnv(home),
        captureBackendLogs: true,
        logDir: join(artifacts, "logs"),
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  logLevel: "warn",
  outputDir: join(artifacts, "logs"),
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 180_000 },
  reporters: ["spec"],

  onPrepare() {
    mkdirSync(join(artifacts, "logs"), { recursive: true });
    sshd.up();
  },

  async afterTest(test, _context, { passed }) {
    if (passed) return;
    const name = `${test.parent} ${test.title}`.replace(/[^\w.-]+/g, "_");
    mkdirSync(artifacts, { recursive: true });
    await browser.saveScreenshot(join(artifacts, `${name}.png`)).catch(() => undefined);
    const html = await browser.getPageSource().catch(() => "");
    writeFileSync(join(artifacts, `${name}.html`), html);
  },

  async afterSession() {
    const driver = process.env.SSHASTRA_E2E_RESTARTED_DRIVER;
    if (!driver) return;
    // A new session can close the replacement process after the runner has
    // deleted its test session. The service only owns the original process.
    const response = await fetch(new URL("/session", driver), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Could not open a cleanup session for the restarted app.");
    const { value } = await response.json() as { value: { sessionId: string } };
    await fetch(new URL(`/session/${value.sessionId}/window`, driver), {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined); // Closing the last window may end the server before it replies.
  },

  onComplete() {
    rmSync(home, { recursive: true, force: true });
  },
};
