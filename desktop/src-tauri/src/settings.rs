use serde::{Deserialize, Serialize};
use std::{
    fmt,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway_access_token: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            gateway_access_token: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub schema_version: u32,
    pub gateway_access_configured: bool,
}

impl From<&Settings> for SettingsView {
    fn from(settings: &Settings) -> Self {
        Self {
            schema_version: settings.schema_version,
            gateway_access_configured: !settings.gateway_access_token.is_empty(),
        }
    }
}

#[derive(Debug)]
pub enum SettingsError {
    Io(String),
    InvalidJson(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(f, "settings I/O error: {message}"),
            Self::InvalidJson(message) => write!(f, "settings JSON is invalid: {message}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SettingsRepository {
    path: PathBuf,
}

impl SettingsRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<Settings, SettingsError> {
        let backup = self.path.with_extension("json.bak");
        let source = if self.path.exists() {
            &self.path
        } else if backup.exists() {
            &backup
        } else {
            return Ok(Settings::default());
        };
        let text =
            fs::read_to_string(source).map_err(|error| SettingsError::Io(error.to_string()))?;
        serde_json::from_str(&text).map_err(|error| SettingsError::InvalidJson(error.to_string()))
    }

    pub fn save(&self, settings: &Settings) -> Result<(), SettingsError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| SettingsError::Io(error.to_string()))?;
        }
        let serialized = serde_json::to_string_pretty(settings)
            .map_err(|error| SettingsError::InvalidJson(error.to_string()))?;
        let temporary = self.path.with_extension("json.tmp");
        let backup = self.path.with_extension("json.bak");
        let mut file =
            File::create(&temporary).map_err(|error| SettingsError::Io(error.to_string()))?;
        file.write_all(serialized.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| SettingsError::Io(error.to_string()))?;
        drop(file);

        let had_existing = self.path.exists();
        if had_existing && backup.exists() {
            fs::remove_file(&backup).map_err(|error| SettingsError::Io(error.to_string()))?;
        }
        promote_with_rollback(&temporary, &self.path, &backup, had_existing, |from, to| {
            fs::rename(from, to)
        })?;

        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    }
}

fn promote_with_rollback(
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    had_existing: bool,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), SettingsError> {
    if had_existing {
        rename(destination, backup).map_err(|error| {
            SettingsError::Io(format!("cannot create settings backup: {error}"))
        })?;
    }
    if let Err(promote_error) = rename(temporary, destination) {
        let rollback_error = had_existing
            .then(|| rename(backup, destination).err())
            .flatten();
        let message = match rollback_error {
            Some(rollback_error) => format!(
                "cannot promote settings file: {promote_error}; rollback failed: {rollback_error}; backup retained"
            ),
            None => format!("cannot promote settings file: {promote_error}; original restored"),
        };
        return Err(SettingsError::Io(message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io};

    #[test]
    fn failed_promotion_attempts_rollback_and_reports_its_result() {
        let calls = Cell::new(0);
        let restored = promote_with_rollback(
            Path::new("temporary"),
            Path::new("settings"),
            Path::new("backup"),
            true,
            |_, _| {
                calls.set(calls.get() + 1);
                match calls.get() {
                    1 | 3 => Ok(()),
                    _ => Err(io::Error::other("promotion failed")),
                }
            },
        )
        .unwrap_err()
        .to_string();
        assert_eq!(calls.get(), 3);
        assert!(restored.contains("original restored"));

        let calls = Cell::new(0);
        let failed = promote_with_rollback(
            Path::new("temporary"),
            Path::new("settings"),
            Path::new("backup"),
            true,
            |_, _| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(())
                } else {
                    Err(io::Error::other("rename failed"))
                }
            },
        )
        .unwrap_err()
        .to_string();
        assert_eq!(calls.get(), 3);
        assert!(failed.contains("rollback failed"));
        assert!(failed.contains("backup retained"));
    }
}
