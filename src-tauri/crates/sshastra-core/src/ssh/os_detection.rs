use std::time::Duration;

use super::Connection;
use crate::hosts::DetectedOs;

// Read the system name and, when available, a bounded part of the OS release file.
// The program never interprets the file contents as a shell script.
const OS_PROBE: &str = "uname -s || exit; \
    if [ -r /etc/os-release ]; then head -c 8192 /etc/os-release; \
    elif [ -r /usr/lib/os-release ]; then head -c 8192 /usr/lib/os-release; fi";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_OUTPUT_LIMIT: usize = 12 * 1024;

impl Connection {
    /// Runs the fixed OS identity probe on this authenticated Connection.
    pub async fn detect_os(&self) -> DetectedOs {
        match self
            .exec_bounded(OS_PROBE, PROBE_OUTPUT_LIMIT, PROBE_TIMEOUT)
            .await
        {
            Ok(output) if output.status == 0 => parse_os(&output.stdout),
            _ => DetectedOs::Unknown,
        }
    }
}

fn parse_os(output: &[u8]) -> DetectedOs {
    let text = String::from_utf8_lossy(output);
    let mut lines = text.lines();
    match lines.next() {
        Some("Linux") => {
            let id = lines
                .find_map(|line| line.strip_prefix("ID="))
                .unwrap_or("");
            let id = id
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .or_else(|| {
                    id.strip_prefix('\'')
                        .and_then(|value| value.strip_suffix('\''))
                })
                .unwrap_or(id);
            match id {
                "debian" => DetectedOs::Debian,
                "ubuntu" => DetectedOs::Ubuntu,
                "arch" => DetectedOs::ArchLinux,
                "alpine" => DetectedOs::AlpineLinux,
                "linuxmint" => DetectedOs::LinuxMint,
                "nixos" => DetectedOs::Nixos,
                _ => DetectedOs::Linux,
            }
        }
        Some("Darwin") => DetectedOs::Macos,
        Some("FreeBSD") => DetectedOs::Freebsd,
        _ => DetectedOs::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_os, DetectedOs};

    #[test]
    fn identifies_supported_systems_from_uname_and_os_release() {
        for (sample, expected) in [
            (
                "Linux\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nID=debian\n",
                DetectedOs::Debian,
            ),
            (
                "Linux\nNAME=\"Ubuntu\"\nID=\"ubuntu\"\nID_LIKE=debian\n",
                DetectedOs::Ubuntu,
            ),
            ("Linux\r\nID='alpine'\r\n", DetectedOs::AlpineLinux),
            ("Linux\nID=arch\n", DetectedOs::ArchLinux),
            ("Linux\nID=linuxmint\n", DetectedOs::LinuxMint),
            ("Linux\nID=nixos\n", DetectedOs::Nixos),
            ("Darwin\n", DetectedOs::Macos),
            ("FreeBSD\n", DetectedOs::Freebsd),
        ] {
            assert_eq!(parse_os(sample.as_bytes()), expected, "{sample:?}");
        }
    }

    #[test]
    fn treats_release_fields_as_data_and_uses_safe_fallbacks() {
        for sample in [
            "Linux\nNAME=\"Fedora Linux\"\nID=fedora\n",
            "Linux\n#ID=ubuntu\nID=\"debian\\\"\n",
            "Linux\nID=\"$(uname)\"\nID_LIKE=debian\n",
            "Linux\n",
        ] {
            assert_eq!(parse_os(sample.as_bytes()), DetectedOs::Linux, "{sample:?}");
        }
        assert_eq!(parse_os(b"\xff\n"), DetectedOs::Unknown);
        assert_eq!(parse_os(b"SunOS\nID=debian\n"), DetectedOs::Unknown);
    }
}
