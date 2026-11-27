/**
 * The E2E smoke test: drives the real app (built by `pnpm e2e:build`) through
 * the WebDriver server embedded in it (`tauri-plugin-wdio-webdriver`, compiled
 * in only with the `e2e` Cargo feature) against the Docker OpenSSH server.
 *
 * Run with `pnpm e2e` (Docker required). Screenshots and logs of a failed run
 * land in `e2e/artifacts/`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appEnv, sandboxHome } from "./support/sandbox.ts";
import { smokeBinary, smokeLogs, stopReplacement } from "./support/smoke-app.ts";
import * as sshd from "./support/sshd.ts";

const artifacts = dirname(smokeLogs);
const home = sandboxHome();

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: smokeBinary },
      "wdio:tauriServiceOptions": {
        driverProvider: "embedded",
        env: appEnv(home),
        captureBackendLogs: true,
        logDir: smokeLogs,
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  logLevel: "warn",
  outputDir: smokeLogs,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 180_000 },
  reporters: ["spec"],

  onPrepare() {
    mkdirSync(smokeLogs, { recursive: true });
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

  afterSession: stopReplacement,

  onComplete() {
    rmSync(home, { recursive: true, force: true });
  },
};
