use serde::Serialize;

/// The error every command returns. Serialized to the front end as
/// `{ kind, message }` so the UI can branch on `kind` and show `message`.
#[derive(Debug, Serialize)]
pub struct CommandError {
    kind: &'static str,
    message: String,
}

impl From<sshastra_core::terminal::TerminalError> for CommandError {
    fn from(err: sshastra_core::terminal::TerminalError) -> Self {
        use sshastra_core::terminal::TerminalError::*;
        let kind = match err {
            Spawn(_) => "spawn",
            Io(_) => "io",
            NotFound(_) => "notFound",
        };
        Self {
            kind,
            message: err.to_string(),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
