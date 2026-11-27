//! Settings and the SettingsStore that keeps them: a versioned JSON file
//! (`settings.json`) in the app's config directory, replaced atomically on
//! every change.
//!
//! The file is one object: `version` plus one key per section
//! (`{ "version": 1, "appearance": { "theme": "dark" }, "layout": { .. } }`).
//! The store does not know the sections' shapes: the front end owns its UI
//! sections, and core code that needs a section (e.g. keepalive) reads a typed
//! view with [`SettingsStore::section`]. Sections it does not know survive
//! every save untouched.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::fs_util::write_atomically;

/// The file format version this build writes. To change the format, bump it
/// and append the step from the old version to [`MIGRATIONS`].
pub const CURRENT_VERSION: u32 = 1;

/// A step that rewrites a version `n` document into version `n + 1` in place.
type Migration = fn(&mut Map<String, Value>);

/// `MIGRATIONS[i]` upgrades version `i + 1` to `i + 2`; its length is always
/// `CURRENT_VERSION - 1`.
const MIGRATIONS: &[Migration] = &[];

const VERSION_KEY: &str = "version";

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not access the settings file at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the settings file is damaged: {0}")]
    Corrupt(String),
    #[error("the settings file was written by a newer sshastra (format version {0})")]
    UnsupportedVersion(u32),
    #[error("not a settings section name")]
    ReservedSection,
}

impl SettingsError {
    fn log_file_error(&self, operation: &str) {
        match self {
            Self::Io { source, .. } => {
                log::warn!("settings file {operation} failed: {:?}", source.kind())
            }
            Self::Corrupt(_) => log::warn!("settings file {operation} failed: corrupt"),
            Self::UnsupportedVersion(version) => {
                log::warn!("settings file {operation} failed: unsupported version {version}");
            }
            Self::ReservedSection => {}
        }
    }
}

/// Saved settings, one JSON value per section.
pub struct SettingsStore {
    path: PathBuf,
    sections: Map<String, Value>,
}

impl SettingsStore {
    /// Loads the store at `path`, migrating older formats, or starts empty if
    /// the file does not exist. A damaged or newer file is an error and is
    /// left untouched.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SettingsError> {
        let path = path.into();
        let sections = match fs::read_to_string(&path) {
            Ok(text) => parse(&text, MIGRATIONS),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
            Err(source) => Err(SettingsError::Io {
                path: path.clone(),
                source,
            }),
        }
        .inspect_err(|error| error.log_file_error("read"))?;
        Ok(Self { path, sections })
    }

    /// Every saved section by name (without `version`).
    pub fn sections(&self) -> &Map<String, Value> {
        &self.sections
    }

    /// Replaces one section and saves the file.
    pub fn set(&mut self, section: &str, value: Value) -> Result<(), SettingsError> {
        if section.is_empty() || section == VERSION_KEY {
            return Err(SettingsError::ReservedSection);
        }
        let mut sections = self.sections.clone();
        sections.insert(section.to_owned(), value);
        self.save(sections)
    }

    /// A section as `T`. A missing section, or one that does not fit `T`,
    /// reads as `T::default()`: settings are never a reason to fail. Give `T`
    /// `#[serde(default)]` so one missing field keeps the others.
    pub fn section<T: DeserializeOwned + Default>(&self, section: &str) -> T {
        self.sections
            .get(section)
            .and_then(|value| T::deserialize(value).ok())
            .unwrap_or_default()
    }

    /// Writes `sections` and only then adopts them, so memory never runs
    /// ahead of the file.
    fn save(&mut self, sections: Map<String, Value>) -> Result<(), SettingsError> {
        let mut document = Map::with_capacity(sections.len() + 1);
        document.insert(VERSION_KEY.to_owned(), Value::from(CURRENT_VERSION));
        document.extend(sections.clone());
        let json = serde_json::to_vec_pretty(&document)
            .map_err(|e| SettingsError::Corrupt(e.to_string()))
            .inspect_err(|error| error.log_file_error("serialize"))?;
        write_atomically(&self.path, &json)
            .map_err(|source| SettingsError::Io {
                path: self.path.clone(),
                source,
            })
            .inspect_err(|error| error.log_file_error("write"))?;
        self.sections = sections;
        Ok(())
    }
}

/// Reads a settings document of any supported version, running each
/// migration step from its version up to the current one.
fn parse(text: &str, migrations: &[Migration]) -> Result<Map<String, Value>, SettingsError> {
    let Value::Object(mut document) =
        serde_json::from_str(text).map_err(|e| SettingsError::Corrupt(e.to_string()))?
    else {
        return Err(SettingsError::Corrupt("not a JSON object".into()));
    };
    let version = document
        .remove(VERSION_KEY)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v >= 1)
        .ok_or_else(|| SettingsError::Corrupt("missing or invalid version".into()))?;
    let current = migrations.len() as u32 + 1;
    if version > current {
        return Err(SettingsError::UnsupportedVersion(version));
    }
    for step in &migrations[(version as usize - 1)..] {
        step(&mut document);
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_migration_table_matches_the_current_version() {
        assert_eq!(MIGRATIONS.len() as u32 + 1, CURRENT_VERSION);
    }

    /// A stand-in for future format changes: v1 → v2 renames a section,
    /// v2 → v3 moves a field into a nested object.
    fn rename_general(doc: &mut Map<String, Value>) {
        if let Some(v) = doc.remove("general") {
            doc.insert("interface".into(), v);
        }
    }
    fn nest_language(doc: &mut Map<String, Value>) {
        if let Some(Value::Object(interface)) = doc.get_mut("interface") {
            if let Some(lang) = interface.remove("language") {
                interface.insert("locale".into(), json!({ "language": lang }));
            }
        }
    }
    const STEPS: &[Migration] = &[rename_general, nest_language];

    #[test]
    fn an_old_file_runs_every_step_from_its_version_in_order() {
        let doc = parse(
            r#"{ "version": 1, "general": { "language": "zh" }, "other": 1 }"#,
            STEPS,
        )
        .unwrap();
        assert_eq!(
            Value::Object(doc),
            json!({ "interface": { "locale": { "language": "zh" } }, "other": 1 })
        );
    }

    #[test]
    fn a_file_part_way_along_skips_the_steps_it_already_had() {
        let doc = parse(
            r#"{ "version": 2, "interface": { "language": "en" }, "general": "kept" }"#,
            STEPS,
        )
        .unwrap();
        assert_eq!(
            Value::Object(doc),
            json!({ "interface": { "locale": { "language": "en" } }, "general": "kept" })
        );
    }

    #[test]
    fn a_current_file_is_not_migrated() {
        let text = r#"{ "version": 3, "general": { "language": "en" } }"#;
        let doc = parse(text, STEPS).unwrap();
        assert_eq!(
            Value::Object(doc),
            json!({ "general": { "language": "en" } })
        );
        assert!(matches!(
            parse(r#"{ "version": 4 }"#, STEPS),
            Err(SettingsError::UnsupportedVersion(4))
        ));
    }
}
