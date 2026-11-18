import { describe, expect, it } from "vitest";
import { releaseProblems, type ReleaseFiles } from "./release-check";

const files = (version: string, pubkey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="): ReleaseFiles => ({
  packageJson: JSON.stringify({ name: "sshastra", version }),
  tauriConf: JSON.stringify({ version, plugins: { updater: { pubkey, endpoints: [] } } }),
  cargoToml: `[workspace]\nmembers = ["."]\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n\n[package]\nname = "sshastra"\nversion.workspace = true\n`,
  cargoLock: `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "sshastra"\nversion = "${version}"\n\n[[package]]\nname = "sshastra-core"\nversion = "${version}"\n`,
});

describe("release check", () => {
  it("passes when the tag matches every version and the public key is set", () => {
    expect(releaseProblems("v0.2.0", files("0.2.0"))).toEqual([]);
  });

  it("refuses a tag that is not v followed by a version", () => {
    expect(releaseProblems("0.2.0", files("0.2.0"))).toEqual([
      'The tag "0.2.0" is not a release tag like v1.2.3 or v1.2.3-beta.1.',
    ]);
  });

  it("names each file whose version differs from the tag", () => {
    const stale = files("0.1.0");
    expect(releaseProblems("v0.2.0", { ...files("0.2.0"), packageJson: stale.packageJson, cargoLock: stale.cargoLock })).toEqual([
      "package.json has version 0.1.0, but the tag is v0.2.0.",
      "src-tauri/Cargo.lock has sshastra 0.1.0, but the tag is v0.2.0 (run cargo build to update it).",
    ]);
    expect(releaseProblems("v0.2.0", { ...files("0.2.0"), tauriConf: stale.tauriConf, cargoToml: stale.cargoToml })).toEqual([
      "src-tauri/tauri.conf.json has version 0.1.0, but the tag is v0.2.0.",
      "src-tauri/Cargo.toml has version 0.1.0, but the tag is v0.2.0.",
    ]);
  });

  it("accepts a pre-release tag", () => {
    expect(releaseProblems("v0.2.0-beta.1", files("0.2.0-beta.1"))).toEqual([]);
  });

  it("refuses to release with the placeholder updater public key", () => {
    expect(releaseProblems("v0.1.0", files("0.1.0", "REPLACE_WITH_UPDATER_PUBLIC_KEY"))).toEqual([
      "src-tauri/tauri.conf.json still has no updater public key (plugins.updater.pubkey). Put the public key from `pnpm tauri signer generate` there.",
    ]);
    expect(releaseProblems("v0.1.0", files("0.1.0", ""))).toHaveLength(1);
  });
});
