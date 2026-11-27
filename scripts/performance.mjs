/** Run the manual macOS performance baseline from a clean checkout. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The desktop performance baseline requires macOS");

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "src-tauri", "target");
const releaseTarget = join(target, "performance-core");
const composeFile = join(root, "src-tauri/crates/sshastra-core/tests/sshd/docker-compose.yml");
const project = `sshastra-perf-${randomBytes(5).toString("hex")}`;
const env = { ...process.env, SSHASTRA_IT_PROJECT: project };
delete env.SSHASTRA_MEASURE_STARTUP;
delete env.VITE_E2E;

function printOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env, stdio: ["ignore", process.stderr, "inherit"], ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited (${result.signal ?? result.status})`);
}

function getOutput(command, args) {
  return execFileSync(command, args, { cwd: root, env, encoding: "utf8" }).trim();
}

const compose = ["compose", "--file", composeFile, "--project-name", project, "--profile", "performance"];
const shellPort = (service) => {
  const port = getOutput("docker", [...compose, "port", service, "22"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error(`Compose did not publish ${service} on a loopback port`);
  return port;
};
const cargo = ["--locked", "--manifest-path", "src-tauri/Cargo.toml", "--release", "-p", "sshastra-core", "--example", "performance"];
const releaseEnv = { ...env, CARGO_TARGET_DIR: releaseTarget };

console.log(JSON.stringify({
  measurement: "sshastra-macos",
  date: new Date().toISOString(),
  version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  revision: getOutput("git", ["rev-parse", "HEAD"]),
  dirty: Boolean(getOutput("git", ["status", "--porcelain"])),
  chip: getOutput("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
  memoryBytes: Number(getOutput("/usr/sbin/sysctl", ["-n", "hw.memsize"])),
  macOS: getOutput("/usr/bin/sw_vers", ["-productVersion"]),
  macOSBuild: getOutput("/usr/bin/sw_vers", ["-buildVersion"]),
  architecture: process.arch,
  dockerServerVersion: getOutput("docker", ["info", "--format", "{{.ServerVersion}}"]),
}));

printOutput("pnpm", ["install", "--frozen-lockfile"]);
printOutput("pnpm", ["e2e:build"], { env: { ...env, CARGO_TARGET_DIR: target } });
printOutput("pnpm", ["tauri", "build", "--no-bundle"], { env: releaseEnv });
printOutput("cargo", ["build", ...cargo], { env: releaseEnv });

try {
  printOutput("docker", [...compose, "up", "--detach", "--build", "--wait", "--quiet-pull", "ssh", "delayed", "echo"]);
  const plain = shellPort("ssh");
  const delayed = shellPort("delayed");
  const qdisc = getOutput("docker", [...compose, "exec", "-T", "delayed", "tc", "qdisc", "show", "dev", "eth0"]);
  console.log(JSON.stringify({ link: "100ms", qdisc }));

  const { measureStartup, measureDesktop } = await import("../e2e/support/performance-app.ts");
  await measureStartup(join(releaseTarget, "release", "sshastra"));
  await measureDesktop(join(target, "debug", "sshastra"), Number(plain));
  printOutput("cargo", ["run", ...cargo, "--", "all", plain, delayed], {
    env: releaseEnv, stdio: ["ignore", "inherit", "inherit"],
  });
} finally {
  printOutput("docker", [...compose, "down", "--rmi", "all"]);
}
