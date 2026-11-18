/**
 * The README screenshots (`pnpm screenshots`, after `pnpm e2e:build`): drives
 * the real app against the demo servers in `screenshots/docker-compose.yml`
 * and writes PNGs to `docs/screenshots/`. Not part of `pnpm e2e` or CI; run it
 * again to refresh the images. Needs Docker; ImageMagick (`magick`) shrinks
 * the files if installed.
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { appEnv, sandboxHome } from "./support/sandbox.ts";
import * as demo from "./screenshots/demo.ts";

const root = resolve(import.meta.dirname, "..");
const binary = resolve(root, "src-tauri/target/debug", process.platform === "win32" ? "sshastra.exe" : "sshastra");
const logs = resolve(import.meta.dirname, "artifacts", "screenshots-logs");
const home = sandboxHome();

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./screenshots/screenshots.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: binary },
      "wdio:tauriServiceOptions": {
        driverProvider: "embedded",
        env: appEnv(home),
        captureBackendLogs: true,
        logDir: logs,
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  logLevel: "warn",
  outputDir: logs,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  // Each shot builds on the state the one before left, so stop at the first failure.
  mochaOpts: { ui: "bdd", timeout: 300_000, bail: true },
  reporters: ["spec"],

  onPrepare() {
    mkdirSync(logs, { recursive: true });
    demo.up();
    demo.seed(home);
  },

  onComplete() {
    demo.down();
    rmSync(home, { recursive: true, force: true });
  },
};
