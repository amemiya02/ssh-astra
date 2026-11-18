/**
 * The demo world the README screenshots show: the Docker servers of
 * `docker-compose.yml` next to this file, and a sandbox home seeded with a
 * fictional Host list (Groups, Jump host, Port forwards), a key the servers
 * accept, and known_hosts entries for every server but the Homelab NAS (so its
 * first Connection asks to trust its key).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const composeFile = resolve(import.meta.dirname, "docker-compose.yml");
const PROJECT = process.env.SSHASTRA_SHOTS_PROJECT?.trim() || "sshastra-screenshots";

/** The servers the screenshots connect to (Compose services), all reached through `bastion`. */
const TRUSTED = ["web-01", "api-01"] as const;
export const USER = "deploy";

function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", "--project-name", PROJECT, "--file", composeFile, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

/** Builds and starts the demo servers, waiting until they are healthy. */
export function up(): void {
  compose(["up", "--detach", "--build", "--wait", "--quiet-pull"]);
}

/** Stops and removes the demo servers. */
export function down(): void {
  compose(["down", "--volumes", "--remove-orphans"]);
}

function bastionPort(): number {
  const published = compose(["port", "bastion", "22"]).trim();
  return Number(published.slice(published.lastIndexOf(":") + 1));
}

/** Where Tauri's `app_config_dir()` points inside `home`. */
function configDir(home: string): string {
  const id = "dev.sshastra.app";
  if (process.platform === "darwin") return join(home, "Library", "Application Support", id);
  if (process.platform === "win32") return join(home, "AppData", "Roaming", id);
  return join(home, ".config", id);
}

/**
 * Seeds `home` (the app's sandbox `$HOME`) for the screenshots: settings (dark
 * theme), the demo Host list, an SSH key the servers accept, and known_hosts.
 */
export function seed(home: string): void {
  const ssh = join(home, ".ssh");
  mkdirSync(ssh, { recursive: true, mode: 0o700 });
  const key = join(ssh, "id_ed25519");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "demo", "-f", key]);
  const publicKey = readFileSync(`${key}.pub`, "utf8");
  for (const service of ["bastion", ...TRUSTED, "nas"]) {
    compose(
      ["exec", "-T", "--user", USER, service, "sh", "-c", "cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"],
      publicKey,
    );
  }

  const port = bastionPort();
  const hostKeys = (service: string) =>
    compose(["exec", "-T", service, "sh", "-c", "cat /etc/ssh/ssh_host_*_key.pub"])
      .trim()
      .split("\n")
      .map((line) => line.split(" ").slice(0, 2).join(" "));
  const knownHosts = [
    ...hostKeys("bastion").map((k) => `[127.0.0.1]:${port} ${k}`),
    ...TRUSTED.flatMap((service) => hostKeys(service).map((k) => `${service} ${k}`)),
  ];
  writeFileSync(join(ssh, "known_hosts"), `${knownHosts.join("\n")}\n`);

  const config = configDir(home);
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ version: 1, general: { language: "en" }, appearance: { theme: "dark" } }),
  );
  writeFileSync(join(config, "hosts.json"), JSON.stringify(hostLibrary(port), null, 2));
}

/** A fictional Host list: Production behind a bastion, Staging, and a Homelab. */
function hostLibrary(bastionPort: number) {
  const production = randomUUID();
  const staging = randomUUID();
  const homelab = randomUUID();
  const bastion = randomUUID();
  const auth = { type: "key", identityFile: "~/.ssh/id_ed25519" };
  const host = (name: string, address: string, groupId: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    name,
    address,
    port: 22,
    user: USER,
    auth,
    jumpHost: null,
    groupId,
    forwards: [],
    ...extra,
  });
  const behindBastion = { jumpHost: bastion };
  return {
    version: 5,
    groups: [
      { id: production, name: "Production", parentId: null },
      { id: staging, name: "Staging", parentId: null },
      { id: homelab, name: "Homelab", parentId: null },
    ],
    hosts: [
      host("bastion", "127.0.0.1", production, { id: bastion, port: bastionPort }),
      host("web-01", "web-01", production, behindBastion),
      host("web-02", "web-02", production, behindBastion),
      host("api-01", "api-01", production, {
        ...behindBastion,
        forwards: [
          {
            id: randomUUID(),
            label: "Postgres on db-01",
            autoStart: true,
            type: "local",
            bindAddress: "127.0.0.1",
            bindPort: 15432,
            remoteHost: "db-01",
            remotePort: 5432,
          },
          {
            id: randomUUID(),
            label: "Webhooks to my dev server",
            autoStart: true,
            type: "remote",
            bindAddress: "localhost",
            bindPort: 9000,
            localHost: "localhost",
            localPort: 3000,
          },
          {
            id: randomUUID(),
            label: "Browse the private network",
            autoStart: false,
            type: "dynamic",
            bindAddress: "127.0.0.1",
            bindPort: 1080,
          },
        ],
      }),
      host("db-01", "db-01", production, behindBastion),
      host("web-staging", "10.20.0.11", staging),
      host("api-staging", "10.20.0.12", staging),
      host("nas", "nas.lan", homelab, { ...behindBastion, user: "admin" }),
      host("pi-hole", "pihole.lan", homelab, { user: "pi" }),
      host("home-assistant", "homeassistant.lan", homelab, { user: "hass" }),
    ],
  };
}
