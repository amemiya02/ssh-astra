/**
 * A throwaway home directory for the app under test, so an E2E run never reads
 * or writes the developer's ~/.ssh (known_hosts, config) or sshastra's own
 * settings and Host list: the app finds both through `$HOME` (and the XDG
 * variables on Linux).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTIFIER = "dev.sshastra.app";

/** Where Tauri's `app_config_dir()` points inside `home`. */
function configDir(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", IDENTIFIER);
  if (process.platform === "win32") return join(home, "AppData", "Roaming", IDENTIFIER);
  return join(home, ".config", IDENTIFIER);
}

/**
 * The sandbox home for this run, created once and shared with the worker
 * processes through `$SSHASTRA_E2E_HOME`. The app starts in English.
 */
export function sandboxHome(): string {
  const existing = process.env.SSHASTRA_E2E_HOME;
  if (existing) return existing;
  const home = createSandboxHome();
  process.env.SSHASTRA_E2E_HOME = home;
  return home;
}

/** A separate sandbox for each desktop process in a measurement run. */
export function createSandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sshastra-e2e-"));
  const config = configDir(home);
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "settings.json"), JSON.stringify({ version: 1, general: { language: "en" } }));
  return home;
}

/** The environment the app runs with: the sandbox home and no ssh-agent. */
export function appEnv(home: string): Record<string, string> {
  return {
    SSHASTRA_E2E_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    SSH_AUTH_SOCK: "",
  };
}
