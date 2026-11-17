/**
 * The Docker OpenSSH server the E2E test connects to: the `ssh` service of the
 * integration-test Compose file (`src-tauri/crates/sshastra-core/tests/sshd/`),
 * in the same Compose project the Rust integration tests use for this checkout.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const coreDir = resolve(root, "src-tauri/crates/sshastra-core");
const composeFile = resolve(coreDir, "tests/sshd/docker-compose.yml");

export const SERVICE = "ssh";
export const USER = "tester";
export const PASSWORD = "testpass";

/**
 * `$SSHASTRA_IT_PROJECT`, else `sshastra-it-<hash of the core crate's path>`:
 * the same name `support::project()` gives the Rust tests (FNV-1a, low 32 bits).
 */
export function project(): string {
  const fromEnv = process.env.SSHASTRA_IT_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(coreDir)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `sshastra-it-${(hash & 0xffffffffn).toString(16).padStart(8, "0")}`;
}

function compose(args: string[]): string {
  const name = project();
  return execFileSync("docker", ["compose", "--project-name", name, "--file", composeFile, ...args], {
    env: { ...process.env, SSHASTRA_IT_PROJECT: name },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Builds and starts the server if needed, waiting until it is healthy. */
export function up(): void {
  compose(["up", "--detach", "--build", "--wait", "--quiet-pull", SERVICE]);
}

/** The loopback port the server is published on. */
export function port(): number {
  const published = compose(["port", SERVICE, "22"]).trim();
  const port = Number(published.slice(published.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`unexpected \`docker compose port\` output: ${published}`);
  return port;
}

/** Runs `script` with bash on the server as the test user; resolves with its stdout. */
export function runAsTester(script: string): string {
  return compose(["exec", "-T", "--user", USER, SERVICE, "bash", "-c", script]);
}
