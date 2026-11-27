/**
 * Checks a release before and after it is built (`.github/workflows/release.yml`):
 *
 *   node scripts/release-check.ts v0.2.0
 *   node scripts/release-check.ts v0.2.0 path/to/signatures/*.sig
 *
 * The tag must match the version in package.json, tauri.conf.json, Cargo.toml and Cargo.lock,
 * and tauri.conf.json must set the updater public key and require signed versions. Each supplied
 * signature must include the release version in its trusted comment. Prints all problems and
 * exits 1 if there are any.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The placeholder `plugins.updater.pubkey` until the owner's key is put in. */
export const pubkeyPlaceholder = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

/** The contents of the files holding a version. */
export interface ReleaseFiles {
  packageJson: string;
  tauriConf: string;
  cargoToml: string;
  cargoLock: string;
}

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `version = "x"` in the `[workspace.package]` table of Cargo.toml. */
function cargoWorkspaceVersion(toml: string): string | undefined {
  const table = toml.split(/^\[/m).find((part) => part.startsWith("workspace.package]"));
  return table?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

/** The version of the `sshastra` package recorded in Cargo.lock. */
function lockedAppVersion(lock: string): string | undefined {
  return lock.match(/^name = "sshastra"\r?\nversion = "([^"]+)"/m)?.[1];
}

/** Everything wrong with releasing `tag` from these files; empty when it may go ahead. */
export function releaseProblems(tag: string, files: ReleaseFiles): string[] {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!semver.test(version)) return [`The tag "${tag}" is not a release tag like v1.2.3 or v1.2.3-beta.1.`];

  const problems: string[] = [];
  const pkg = JSON.parse(files.packageJson) as { version?: string };
  const conf = JSON.parse(files.tauriConf) as {
    version?: string;
    plugins?: { updater?: { pubkey?: string; requireSignedVersion?: boolean } };
  };
  const found: [string, string | undefined][] = [
    ["package.json", pkg.version],
    ["src-tauri/tauri.conf.json", conf.version],
    ["src-tauri/Cargo.toml", cargoWorkspaceVersion(files.cargoToml)],
  ];
  for (const [file, value] of found) {
    if (value !== version) problems.push(`${file} has version ${value ?? "(none)"}, but the tag is ${tag}.`);
  }
  const locked = lockedAppVersion(files.cargoLock);
  if (locked !== version) {
    problems.push(
      `src-tauri/Cargo.lock has sshastra ${locked ?? "(none)"}, but the tag is ${tag} (run cargo build to update it).`,
    );
  }

  const pubkey = conf.plugins?.updater?.pubkey?.trim() ?? "";
  if (pubkey === "" || pubkey === pubkeyPlaceholder) {
    problems.push(
      "src-tauri/tauri.conf.json still has no updater public key (plugins.updater.pubkey). Put the public key from `pnpm tauri signer generate` there.",
    );
  }
  if (conf.plugins?.updater?.requireSignedVersion !== true) {
    problems.push("src-tauri/tauri.conf.json must set plugins.updater.requireSignedVersion to true.");
  }
  return problems;
}

/** Checks Tauri's base64-encoded minisign comment for the build's version field. */
export function signatureVersionProblem(name: string, signature: string, expectedVersion: string): string | undefined {
  const trustedComment = Buffer.from(signature.trim(), "base64").toString("utf8").split(/\r?\n/)[2];
  const commentPrefix = "trusted comment: ";
  const versionPrefix = "version:";
  const fields = trustedComment?.startsWith(commentPrefix)
    ? trustedComment.slice(commentPrefix.length).split("\t")
    : [];
  const version = fields.find((field) => field.startsWith(versionPrefix))?.slice(versionPrefix.length);
  if (!version) return `${name} has no version in its trusted comment.`;
  if (version !== expectedVersion) {
    return `${name} is signed for version ${version}, but the release version is ${expectedVersion}.`;
  }
}

function main(tag = "", signatures: string[]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string) => readFileSync(root + path, "utf8");
  const problems = releaseProblems(tag, {
    packageJson: read("package.json"),
    tauriConf: read("src-tauri/tauri.conf.json"),
    cargoToml: read("src-tauri/Cargo.toml"),
    cargoLock: read("src-tauri/Cargo.lock"),
  });
  if (problems.length === 0) {
    for (const path of signatures) {
      const problem = signatureVersionProblem(path, readFileSync(path, "utf8"), tag.slice(1));
      if (problem) problems.push(problem);
    }
  }
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`Release ${tag} checks out.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2], process.argv.slice(3));
