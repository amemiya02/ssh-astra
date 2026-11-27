use std::path::PathBuf;

use serde::Serialize;

use super::ShellCommand;

const MAX_SHELL_LIST_BYTES: u64 = 64 * 1024;

/// An installed shell and the command the backend will use for its ID.
#[derive(Serialize)]
pub struct LocalShell {
    id: String,
    label: String,
    #[serde(skip)]
    command: ShellCommand,
}

impl LocalShell {
    fn new(id: String, label: String, program: PathBuf, args: &[&str]) -> Self {
        Self {
            id,
            label,
            command: ShellCommand::new(program)
                .args(args.iter().copied())
                .with_xterm_env(),
        }
    }
}

/// Lists locally installed options without launching any interactive shells.
pub async fn local_shells() -> Vec<LocalShell> {
    discover(true).await
}

/// Resolves an ID against the current installation before opening the PTY.
pub async fn local_shell_command(id: &str) -> Option<ShellCommand> {
    discover(id.starts_with("wsl:"))
        .await
        .into_iter()
        .find(|shell| shell.id == id)
        .map(|shell| shell.command)
}

/// Resolves Windows filesystem paths and the user's login shell inside a WSL distribution.
pub async fn local_wsl_paths(
    distribution: &str,
    paths: &[String],
) -> Option<(String, Vec<String>)> {
    #[cfg(windows)]
    {
        windows::drop_paths(distribution, paths).await
    }
    #[cfg(not(windows))]
    {
        let _ = (distribution, paths);
        None
    }
}

#[cfg(unix)]
async fn discover(_include_wsl: bool) -> Vec<LocalShell> {
    use std::fs::File;
    use std::io::Read;

    let mut registry = String::new();
    let read = File::open("/etc/shells").and_then(|file| {
        file.take(MAX_SHELL_LIST_BYTES + 1)
            .read_to_string(&mut registry)
    });
    if !read.is_ok_and(|bytes| bytes as u64 <= MAX_SHELL_LIST_BYTES) {
        return Vec::new();
    }

    parse_unix_shells(&registry)
        .into_iter()
        .map(|entry| (entry, PathBuf::from(entry)))
        .filter(|(_, path)| {
            path.is_file() && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
        })
        .map(|(entry, path)| LocalShell::new(entry.to_owned(), entry.to_owned(), path, &[]))
        .collect()
}

#[cfg(unix)]
fn parse_unix_shells(registry: &str) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    registry
        .lines()
        .map(|line| line.split_once('#').map_or(line, |(path, _)| path).trim())
        .filter(|path| path.starts_with('/') && !path.chars().any(char::is_control))
        .filter(|path| seen.insert(*path))
        .collect()
}

#[cfg(windows)]
use windows::discover;

#[cfg(windows)]
mod windows {
    use std::{env, ffi::OsString, os::windows::ffi::OsStringExt, path::Path, ptr, time::Duration};

    use tokio::{io::AsyncReadExt, process::Command, time::timeout};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::{
            Registry::{
                RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
                RRF_SUBKEY_WOW6432KEY,
            },
            Threading::CREATE_NO_WINDOW,
        },
    };

    use super::*;

    pub(super) async fn discover(include_wsl: bool) -> Vec<LocalShell> {
        let system = env_path("SystemRoot").map(|root| root.join("System32"));
        let program_files: Vec<_> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(env_path)
            .collect();
        let path: Vec<_> = env::var_os("PATH")
            .iter()
            .flat_map(env::split_paths)
            .take(128)
            .filter(|dir| dir.is_absolute())
            .collect();

        let cmd = system.as_ref().map(|dir| dir.join("cmd.exe"));
        let windows_powershell = system
            .as_ref()
            .map(|dir| dir.join("WindowsPowerShell/v1.0/powershell.exe"));
        let powershell = program_files
            .iter()
            .map(|dir| dir.join("PowerShell/7/pwsh.exe"))
            .chain(path.iter().map(|dir| dir.join("pwsh.exe")))
            .find(|program| program.is_file());
        let git_bash = [
            git_install_path(HKEY_CURRENT_USER, 0),
            git_install_path(HKEY_LOCAL_MACHINE, 0),
            git_install_path(HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6432KEY),
            env_path("LOCALAPPDATA").map(|dir| dir.join("Programs/Git")),
        ]
        .into_iter()
        .flatten()
        .chain(program_files.iter().map(|dir| dir.join("Git")))
        // Portable Git puts `<install>/cmd` on PATH and sets no registry key.
        .chain(
            path.iter()
                .filter(|dir| {
                    dir.file_name()
                        .is_some_and(|name| name.eq_ignore_ascii_case("cmd"))
                        && dir.join("git.exe").is_file()
                })
                .filter_map(|dir| dir.parent().map(Path::to_path_buf)),
        )
        .map(|dir| dir.join("bin/bash.exe"))
        .find(|program| program.is_absolute() && program.is_file());

        let mut shells: Vec<_> = [
            ("windows:cmd", "CMD", cmd, &[][..]),
            (
                "windows:powershell",
                "Windows PowerShell",
                windows_powershell,
                &[],
            ),
            ("windows:pwsh", "PowerShell", powershell, &[]),
            ("windows:git-bash", "Git Bash", git_bash, &["--login", "-i"]),
        ]
        .into_iter()
        .filter_map(|(id, label, program, args)| {
            let program = program.filter(|path| path.is_file())?;
            Some(LocalShell::new(
                id.to_owned(),
                label.to_owned(),
                program,
                args,
            ))
        })
        .collect();

        if include_wsl {
            if let Some(wsl) = system
                .map(|dir| dir.join("wsl.exe"))
                .filter(|path| path.is_file())
            {
                shells.extend(wsl_distributions(&wsl).await.into_iter().map(|name| {
                    LocalShell::new(
                        format!("wsl:{name}"),
                        format!("WSL · {name}"),
                        wsl.clone(),
                        &["--distribution", &name],
                    )
                }));
            }
        }
        shells
    }

    fn env_path(name: &str) -> Option<PathBuf> {
        env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    pub(super) async fn drop_paths(
        distribution: &str,
        paths: &[String],
    ) -> Option<(String, Vec<String>)> {
        use std::process::Stdio;

        if paths.is_empty()
            || paths
                .iter()
                .any(|path| path.is_empty() || path.chars().any(char::is_control))
        {
            return None;
        }
        // Arguments arrive separately from the fixed script. Resolve each path in the same
        // distribution, whose drive mount prefix and default user can be customized.
        const SCRIPT: &str = r#"
            user=$(getent passwd "$(id -u)") || exit 1
            shell=${user##*:}
            shell=${shell:-/bin/sh}
            printf '%s\0' "${shell##*/}"
            for path; do
                translated=$(wslpath -u "$path") || exit 1
                printf '%s\0' "$translated"
            done
        "#;
        let wsl = env_path("SystemRoot")?.join("System32/wsl.exe");
        let output = timeout(
            Duration::from_secs(5),
            Command::new(wsl)
                .args([
                    "--distribution",
                    distribution,
                    "--exec",
                    "/bin/sh",
                    "-c",
                    SCRIPT,
                    "sh",
                ])
                .args(paths)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        if !output.status.success() {
            return None;
        }
        let output = std::str::from_utf8(&output.stdout)
            .ok()?
            .strip_suffix('\0')?;
        let (program, translated) = output.split_once('\0')?;
        let translated: Vec<_> = translated.split('\0').map(str::to_owned).collect();
        (translated.len() == paths.len()).then(|| (program.to_owned(), translated))
    }

    fn git_install_path(root: HKEY, registry_view: u32) -> Option<PathBuf> {
        let key: Vec<_> = "Software\\GitForWindows\0".encode_utf16().collect();
        let value: Vec<_> = "InstallPath\0".encode_utf16().collect();
        let mut buffer = [0u16; 4096];
        let mut bytes = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: key and value are NUL-terminated UTF-16. The writable buffer has `bytes` bytes.
        let result = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ | registry_view,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if result != ERROR_SUCCESS {
            return None;
        }
        let path = buffer.split(|&unit| unit == 0).next()?;
        Some(PathBuf::from(OsString::from_wide(path)))
    }

    async fn wsl_distributions(wsl: &Path) -> Vec<String> {
        use std::process::Stdio;

        timeout(Duration::from_secs(2), async {
            let mut child = Command::new(wsl)
                .args(["--list", "--quiet"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .kill_on_drop(true)
                .spawn()
                .ok()?;
            let mut output = Vec::new();
            child
                .stdout
                .take()?
                .take(MAX_SHELL_LIST_BYTES + 1)
                .read_to_end(&mut output)
                .await
                .ok()?;
            if output.len() as u64 > MAX_SHELL_LIST_BYTES || !child.wait().await.ok()?.success() {
                return None;
            }
            Some(parse_wsl_shells(&output))
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
    }
}

#[cfg(any(windows, test))]
fn parse_wsl_shells(output: &[u8]) -> Vec<String> {
    use std::borrow::Cow;

    let decoded = if output.starts_with(&[0xff, 0xfe]) || output.contains(&0) {
        let (chunks, remainder) = output.as_chunks::<2>();
        if !remainder.is_empty() {
            return Vec::new();
        }
        String::from_utf16(
            &chunks
                .iter()
                .map(|&pair| u16::from_le_bytes(pair))
                .collect::<Vec<_>>(),
        )
        .ok()
        .map(Cow::Owned)
    } else {
        std::str::from_utf8(output).ok().map(Cow::Borrowed)
    };
    let Some(decoded) = decoded else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    decoded
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|name| !name.trim().is_empty() && !name.chars().any(char::is_control))
        .filter(|name| seen.insert(*name))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unix_shell_registry_keeps_unique_absolute_paths_and_ignores_comments() {
        let registry = "# List of acceptable shells\r\n\n  /bin/zsh  # Apple\r\n\
                        ./bash\n/opt/My Shell/bin/fish\n/bin/zsh\n/bin/bad\0shell\n";
        assert_eq!(
            parse_unix_shells(registry),
            ["/bin/zsh", "/opt/My Shell/bin/fish"]
        );
    }

    #[test]
    fn wsl_list_handles_utf16le_and_utf8_without_losing_distribution_names() {
        let names = "Ubuntu-24.04\r\nDebian 測試\r\nUbuntu-24.04\r\n";
        let utf16: Vec<_> = names.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let expected = ["Ubuntu-24.04", "Debian 測試"];
        assert_eq!(parse_wsl_shells(&utf16), expected);
        assert_eq!(parse_wsl_shells(names.as_bytes()), expected);
    }
}
