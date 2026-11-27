import { describe, expect, it } from "vitest";
import { releaseProblems, signatureVersionProblem, type ReleaseFiles } from "./release-check";

const files = (version: string, pubkey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="): ReleaseFiles => ({
  packageJson: JSON.stringify({ name: "sshastra", version }),
  tauriConf: JSON.stringify({ version, plugins: { updater: { pubkey, requireSignedVersion: true, endpoints: [] } } }),
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

  it.each([undefined, false])("refuses to release when requireSignedVersion is %s", (requireSignedVersion) => {
    const release = files("0.2.0");
    const config = JSON.parse(release.tauriConf);
    config.plugins.updater.requireSignedVersion = requireSignedVersion;
    release.tauriConf = JSON.stringify(config);

    expect(releaseProblems("v0.2.0", release)).toEqual([
      "src-tauri/tauri.conf.json must set plugins.updater.requireSignedVersion to true.",
    ]);
  });
});

describe("updater signature version", () => {
  function signature(trustedFields: string) {
    return Buffer.from(
      `untrusted comment: minisign signature\nartifact-signature\ntrusted comment: ${trustedFields}\ncomment-signature\n`,
    ).toString("base64");
  }

  it("accepts the tag version in the trusted comment", () => {
    expect(signatureVersionProblem("app.sig", signature("timestamp:1\tfile:app\tversion:0.2.0"), "0.2.0"))
      .toBeUndefined();
  });

  it("reports a different signed version", () => {
    expect(signatureVersionProblem("app.sig", signature("timestamp:1\tfile:app\tversion:0.1.0"), "0.2.0"))
      .toBe("app.sig is signed for version 0.1.0, but the release version is 0.2.0.");
  });

  it("requires a version field even when the filename contains a version", () => {
    expect(signatureVersionProblem("app.sig", signature("timestamp:1\tfile:app version:0.2.0"), "0.2.0"))
      .toBe("app.sig has no version in its trusted comment.");
  });
});
