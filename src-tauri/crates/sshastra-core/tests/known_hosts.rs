//! KnownHosts: reads and appends OpenSSH `known_hosts` files, so sshastra and
//! the `ssh` command line trust the same hosts.
//!
//! Hashed lines below were produced by `ssh-keygen -H`, and fingerprints by
//! `ssh-keygen -lf`, so they are an independent source of truth.

use std::fs;
use std::path::PathBuf;

use sshastra_core::known_hosts::{HostKey, KnownHosts, Verdict};

const KEY_A: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcBDB1UjHN/eesqq7DdD1lWjjN3fCPWh4CoYJ5wJZ3R";
const KEY_A_FINGERPRINT: &str = "SHA256:24cOZtmpJuDzEPMb3bJGFzZoT/+00xaBsVgublFMlZs";
const KEY_B: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAjhZmXDc0HbS/zxE2m8D+d8C1UD4GQ6+z0RK+E2Dlat";
const KEY_B_FINGERPRINT: &str = "SHA256:GFBZreKwZXgLB9nceGwwjg3GLE30I2glfEBji1QVP0Q";
const ECDSA_KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFoCNAwwj3lRww0T4yLZ84KxYteIRKNbEaxokJBq2O9ie5dXLNrHzidGtvoDEIZ4BlKTm0hO3JkXuXxxAJ8ihIU=";

/// `example.com` (port 22) and `[example.com]:2222`, both with KEY_A, hashed.
const HASHED_EXAMPLE_22: &str = "|1|35GnQ4K4ZVK6KnYQTz+nkKakeKI=|5Mb0p9I1PAdNIgm0UWFrzQ1NdoA=";
const HASHED_EXAMPLE_2222: &str = "|1|ipcs7UhJ6xgZF3oaqz1Tvch5vbY=|rGqdEOSqDVbLXoB2COT4+yT13Y0=";

fn key(openssh: &str) -> HostKey {
    HostKey::from_openssh(openssh).unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Fixture {
    fn with(contents: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        fs::write(&path, contents).unwrap();
        Self { _dir: dir, path }
    }

    fn known_hosts(&self) -> KnownHosts {
        KnownHosts::new(&self.path)
    }

    fn contents(&self) -> String {
        fs::read_to_string(&self.path).unwrap()
    }
}

#[test]
fn a_listed_host_with_the_same_key_matches() {
    let f = Fixture::with(&format!("example.com {KEY_A}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 22, &key(KEY_A))
        .unwrap();
    assert_eq!(verdict, Verdict::Match);
}

#[test]
fn a_host_that_is_not_listed_is_unknown() {
    let f = Fixture::with(&format!("other.example {KEY_A}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 22, &key(KEY_A))
        .unwrap();
    assert_eq!(verdict, Verdict::Unknown);
}

#[test]
fn a_missing_file_means_every_host_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let kh = KnownHosts::new(dir.path().join("nope"));
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn a_different_key_of_the_same_type_is_a_mismatch_naming_the_old_key_and_line() {
    let f = Fixture::with(&format!("# my hosts\n\nexample.com {KEY_A}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 22, &key(KEY_B))
        .unwrap();
    match verdict {
        Verdict::Mismatch(m) => {
            assert_eq!(m.fingerprint, KEY_A_FINGERPRINT);
            assert_eq!(m.path, f.path);
            assert_eq!(m.line, 3);
        }
        other => panic!("expected a mismatch, got {other:?}"),
    }
}

#[test]
fn a_match_on_any_listed_key_wins_over_a_mismatch_on_another() {
    let f = Fixture::with(&format!("example.com {KEY_B}\nexample.com {KEY_A}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 22, &key(KEY_A))
        .unwrap();
    assert_eq!(verdict, Verdict::Match);
}

#[test]
fn only_a_key_of_another_type_listed_is_unknown_not_a_mismatch() {
    // OpenSSH asks again in this case rather than raising the alarm.
    let f = Fixture::with(&format!("example.com {ECDSA_KEY}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 22, &key(KEY_A))
        .unwrap();
    assert_eq!(verdict, Verdict::Unknown);
}

#[test]
fn hashed_host_names_match() {
    let f = Fixture::with(&format!("{HASHED_EXAMPLE_22} {KEY_A}\n"));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("example.org", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
    assert!(matches!(
        kh.verify("example.com", 22, &key(KEY_B)).unwrap(),
        Verdict::Mismatch(_)
    ));
}

#[test]
fn hashed_host_names_with_a_port_match_only_that_port() {
    let f = Fixture::with(&format!("{HASHED_EXAMPLE_2222} {KEY_A}\n"));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 2222, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn bracketed_host_port_entries_match_only_that_port() {
    let f = Fixture::with(&format!("[example.com]:2222 {KEY_A}\n"));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 2222, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
    assert_eq!(
        kh.verify("example.com", 2200, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn a_bare_host_entry_does_not_cover_other_ports() {
    let f = Fixture::with(&format!("example.com {KEY_A}\n"));
    let verdict = f
        .known_hosts()
        .verify("example.com", 2222, &key(KEY_A))
        .unwrap();
    assert_eq!(verdict, Verdict::Unknown);
}

#[test]
fn pattern_lists_wildcards_and_case_are_handled_like_openssh() {
    let f = Fixture::with(&format!(
        "alias,Example.COM,10.0.0.1 {KEY_A}\n*.internal,!db.internal {KEY_B}\n"
    ));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("10.0.0.1", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("web.internal", 22, &key(KEY_B)).unwrap(),
        Verdict::Match
    );
    // Negated: the line does not apply at all.
    assert_eq!(
        kh.verify("db.internal", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn revoked_keys_are_refused_and_cert_authority_lines_are_not_host_keys() {
    let f = Fixture::with(&format!(
        "@cert-authority example.com {KEY_B}\n@revoked * {KEY_A}\n"
    ));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Revoked
    );
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_B)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn malformed_lines_and_extra_whitespace_are_tolerated() {
    let f = Fixture::with(&format!(
        "garbage\n\texample.com\t  {}   trailing comment\nexample.org ssh-ed25519 !!!notbase64\n",
        KEY_A.replace(' ', "\t")
    ));
    let kh = f.known_hosts();
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("example.org", 22, &key(KEY_A)).unwrap(),
        Verdict::Unknown
    );
}

#[test]
fn accept_appends_a_plain_openssh_line() {
    let f = Fixture::with(&format!("# keep me\nexample.org {KEY_B}"));
    let kh = f.known_hosts();

    kh.accept("example.com", 22, &key(KEY_A)).unwrap();
    kh.accept("10.1.2.3", 2222, &key(KEY_B)).unwrap();

    assert_eq!(
        f.contents(),
        format!("# keep me\nexample.org {KEY_B}\nexample.com {KEY_A}\n[10.1.2.3]:2222 {KEY_B}\n")
    );
    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    assert_eq!(
        kh.verify("10.1.2.3", 2222, &key(KEY_B)).unwrap(),
        Verdict::Match
    );
}

#[test]
fn accept_creates_the_file_and_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".ssh").join("known_hosts");
    let kh = KnownHosts::new(&path);

    kh.accept("::1", 2222, &key(KEY_A)).unwrap();

    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!("[::1]:2222 {KEY_A}\n")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn system_wide_files_are_read_but_never_written() {
    let global = Fixture::with(&format!("example.com {KEY_A}\n"));
    let user = Fixture::with("");
    let kh = user.known_hosts().with_global_file(&global.path);

    assert_eq!(
        kh.verify("example.com", 22, &key(KEY_A)).unwrap(),
        Verdict::Match
    );
    match kh.verify("example.com", 22, &key(KEY_B)).unwrap() {
        Verdict::Mismatch(m) => assert_eq!(m.path, global.path),
        other => panic!("expected a mismatch, got {other:?}"),
    }

    kh.accept("example.org", 22, &key(KEY_B)).unwrap();
    assert_eq!(global.contents(), format!("example.com {KEY_A}\n"));
    assert_eq!(user.contents(), format!("example.org {KEY_B}\n"));
}

#[test]
fn host_keys_report_their_sha256_fingerprint_and_algorithm() {
    let k = key(KEY_B);
    assert_eq!(k.fingerprint(), KEY_B_FINGERPRINT);
    assert_eq!(k.algorithm(), "ssh-ed25519");
}
