use super::{join, FsError, FsResult};
use crate::ssh::{shell_quote, Connection};

// Custom exit statuses belong to the script. Utility failures are normalized
// to 1 so a tool's exit code cannot masquerade as one of these outcomes.
const CONFLICT: u32 = 80;
const MISSING_TOOL: u32 = 81;
const MISSING_MKTEMP: u32 = 82;
const MISSING_LINK: u32 = 83;
const NOT_A_FILE: u32 = 84;
const INCOMPLETE: u32 = 85;

const STAGING: &str = r#"
command -v mktemp >/dev/null 2>&1 || exit 82
stage=$(command mktemp -d ./.sshastra-archive-XXXXXXXX) || exit 1
trap 'command rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
"#;

pub(super) async fn compress(
    connection: &Connection,
    directory: &str,
    names: &[String],
    archive: &str,
) -> FsResult<()> {
    if !valid_name(archive) || names.is_empty() || names.iter().any(|name| !valid_name(name)) {
        return Err(FsError::InvalidName);
    }
    if archive.strip_suffix(".tar.gz").is_none_or(str::is_empty) {
        return Err(FsError::ArchiveUnsupported(archive.to_owned()));
    }
    let script = format!(
        r#"
destination=$1
shift
occupied "$destination" && exit 80
command -v link >/dev/null 2>&1 || exit 83
{STAGING}
command tar -czf "$stage/archive" -- "$@" || exit 1
if command link "$stage/archive" "$destination"; then
    exit 0
fi
occupied "$destination" && exit 80
exit 1
"#,
    );
    // link publishes a completed regular file to the exact destination
    // atomically. A directory or symlink at that name cannot redirect it.
    run(
        connection,
        directory,
        archive,
        "tar",
        &script,
        names.iter().map(String::as_str),
    )
    .await
}

pub(super) async fn extract(
    connection: &Connection,
    directory: &str,
    archive: &str,
) -> FsResult<()> {
    if !valid_name(archive) {
        return Err(FsError::InvalidName);
    }
    let lowercase = archive.to_ascii_lowercase();
    let Some(suffix) = [".tar.gz", ".tgz", ".tar", ".zip"]
        .into_iter()
        .find(|suffix| lowercase.ends_with(suffix))
    else {
        return Err(FsError::ArchiveUnsupported(archive.to_owned()));
    };
    let destination = &archive[..archive.len() - suffix.len()];
    if !valid_name(destination) {
        return Err(FsError::InvalidName);
    }

    // Info-ZIP expands wildcards in archive operands even if the shell
    // doesn't. Give it a fixed name in a private directory.
    let (tool, setup, expand) = if suffix == ".zip" {
        (
            "unzip",
            format!(
                r#"{STAGING}
command ln -s "../$archive" "$stage/input.zip" || exit 1
"#
            ),
            r#"command unzip -n -qq "../$stage/input.zip" </dev/null"#.to_owned(),
        )
    } else {
        let flags = if suffix == ".tar" { "-xkf" } else { "-xkzf" };
        (
            "tar",
            String::new(),
            format!("command tar --no-same-owner --no-same-permissions {flags} - <&3"),
        )
    };
    let script = format!(
        r#"
destination=$1
archive=$2
occupied "$destination" && exit 80
if [ ! -f "$archive" ]; then
    exit 84
fi
{setup}
if ! command mkdir -m 700 "$destination"; then
    occupied "$destination" && exit 80
    exit 1
fi
parent=$PWD
if (
    umask 077
    cd -P "$destination" || exit 1
    [ "$PWD" = "${{parent%/}}/${{destination#./}}" ] || exit 1
    {expand}
) 3< "$archive"; then
    exit 0
fi
exit 85
"#
    );
    // The extractors' normal path checks remain enabled inside a newly
    // created private directory. Never extract through an existing path.
    // Failed extraction leaves its output for inspection instead of deleting
    // a public path that could have been changed concurrently.
    run(connection, directory, destination, tool, &script, [archive]).await
}

fn valid_name(name: &str) -> bool {
    !matches!(name, "" | "." | "..") && !name.contains(['/', '\0'])
}

async fn run<'a>(
    connection: &Connection,
    directory: &str,
    destination: &'a str,
    tool: &'static str,
    body: &str,
    names: impl IntoIterator<Item = &'a str>,
) -> FsResult<()> {
    if !directory.starts_with('/') || directory.contains('\0') {
        return Err(FsError::InvalidName);
    }
    let script = format!(
        r#"
unset CDPATH TAR_OPTIONS GZIP UNZIP UNZIPOPT
command -v {tool} >/dev/null 2>&1 || exit 81
cd -P "$1" || exit 1
shift
occupied() {{ [ -e "$1" ] || [ -L "$1" ]; }}
{body}
"#
    );
    let mut command = format!(
        "sh -c {} sshastra-archive {}",
        shell_quote(&script),
        shell_quote(directory)
    );
    for name in std::iter::once(destination).chain(names) {
        // A literal leading ./ protects option-like leaf names at the tool level.
        command.push(' ');
        command.push_str(&shell_quote(&format!("./{name}")));
    }
    let output = connection
        .exec(&command)
        .await
        .map_err(|error| FsError::ArchiveFailed(error.to_string()))?;
    match output.status {
        0 => Ok(()),
        CONFLICT => Err(FsError::AlreadyExists(join(directory, destination))),
        MISSING_TOOL => Err(FsError::ArchiveToolMissing(tool)),
        MISSING_MKTEMP => Err(FsError::ArchiveToolMissing("mktemp")),
        MISSING_LINK => Err(FsError::ArchiveToolMissing("link")),
        NOT_A_FILE => Err(FsError::ArchiveNotAFile),
        INCOMPLETE => Err(FsError::ArchiveIncomplete {
            path: join(directory, destination),
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        }),
        status => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            let message = if stderr.is_empty() {
                format!("{tool} (exit status {status})")
            } else {
                stderr.to_owned()
            };
            Err(FsError::ArchiveFailed(message))
        }
    }
}
