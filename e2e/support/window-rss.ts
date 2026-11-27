import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

interface ProcessSample {
  pid: number;
  parent: number;
  rssKiB: number;
  command: string;
}

function sampleProcessTree(): ProcessSample[] {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n");
  const processes = rows.map((row): ProcessSample => {
    const [pid, parent, rss, ...command] = row.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), rssKiB: Number(rss), command: command.join(" ") };
  });
  const sandbox = `SSHASTRA_E2E_HOME=${process.env.SSHASTRA_E2E_HOME}`;
  const apps = processes.filter(({ pid, command }) => {
    if (command !== "sshastra") return false;
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(sandbox);
    } catch {
      return false;
    }
  });
  if (apps.length !== 1) throw new Error(`Expected one SSH Astra process for this sandbox. Found ${apps.length}.`);
  const [app] = apps;
  const children = new Map<number, ProcessSample[]>();
  for (const process of processes) {
    if (!children.has(process.parent)) children.set(process.parent, []);
    children.get(process.parent)?.push(process);
  }
  const tree = [app];
  for (let index = 0; index < tree.length; index++) tree.push(...children.get(tree[index].pid) ?? []);
  if (!tree.some(({ command }) => command.startsWith("WebKitWebProce"))) {
    throw new Error("No WebKit content process found below the SSH Astra process.");
  }
  return tree;
}

function linuxDistribution(): string | undefined {
  try {
    return readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1];
  } catch {
    return undefined;
  }
}

/** Three Linux RSS snapshots of the isolated E2E app and its descendants. */
export async function measureWindowRss(windows: number): Promise<void> {
  if (process.env.SSHASTRA_E2E_WINDOW_RSS !== "1") return;
  const settleMs = 3000;
  const sampleIntervalMs = 500;
  await delay(settleMs);
  const samples = [];
  for (let index = 0; index < 3; index++) {
    if (index > 0) await delay(sampleIntervalMs);
    const processes = sampleProcessTree();
    samples.push({ processes, totalRssKiB: processes.reduce((sum, { rssKiB }) => sum + rssKiB, 0) });
  }
  const [, medianRssKiB] = samples.map(({ totalRssKiB }) => totalRssKiB).sort((a, b) => a - b);
  console.log("SSHASTRA_E2E_WINDOW_RSS " + JSON.stringify({
    windows,
    workload: "idle Home Windows in one app process under Xvfb",
    build: "debug E2E",
    revision: process.env.GITHUB_SHA,
    distro: linuxDistribution(),
    arch: arch(),
    kernel: release(),
    cpu: cpus()[0]?.model,
    physicalMemoryMiB: Math.round(totalmem() / 1024 ** 2),
    settleMs,
    sampleIntervalMs,
    medianRssKiB,
    samples,
  }));
}
