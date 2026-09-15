use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fmt,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const VOCABULARY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularySource {
    pub app: String,
    pub title: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyComparison {
    pub word: String,
    pub difference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyDetail {
    pub meaning_in_sentence: String,
    pub comparison: Option<VocabularyComparison>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyEntry {
    pub id: String,
    pub key: String,
    pub word: String,
    pub lemma: String,
    pub phonetic: String,
    pub part_of_speech: String,
    pub meaning: String,
    pub context: String,
    pub source: VocabularySource,
    pub detail: Option<VocabularyDetail>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyFile {
    pub schema_version: u32,
    pub entries: Vec<VocabularyEntry>,
}

impl Default for VocabularyFile {
    fn default() -> Self {
        Self {
            schema_version: VOCABULARY_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabularyCandidate {
    pub word: String,
    pub lemma: String,
    pub phonetic: String,
    pub part_of_speech: String,
    pub meaning: String,
    pub context: String,
    pub source: VocabularySource,
    pub detail: Option<VocabularyDetail>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VocabularySaveStatus {
    Saved,
    Updated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularySaveResult {
    pub status: VocabularySaveStatus,
    pub entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyListResult {
    pub entries: Vec<VocabularyEntry>,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyImportResult {
    pub cancelled: bool,
    pub added: usize,
    pub updated: usize,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyExportResult {
    pub cancelled: bool,
    pub exported: usize,
}

#[derive(Debug)]
pub enum VocabularyError {
    Io(String),
    InvalidJson(String),
    InvalidData(String),
}

impl fmt::Display for VocabularyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(f, "vocabulary I/O error: {message}"),
            Self::InvalidJson(message) => write!(f, "vocabulary JSON is invalid: {message}"),
            Self::InvalidData(message) => write!(f, "vocabulary data is invalid: {message}"),
        }
    }
}

#[derive(Debug)]
pub struct VocabularyRepository {
    path: PathBuf,
    id_sequence: AtomicU64,
}

impl VocabularyRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            id_sequence: AtomicU64::new(0),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<VocabularyFile, VocabularyError> {
        load_file_or_default(&self.path)
    }

    pub fn list(&self, query: Option<&str>) -> Result<VocabularyListResult, VocabularyError> {
        let mut file = self.load()?;
        file.entries
            .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let total = file.entries.len();
        let normalized_query = query.unwrap_or_default().trim().to_lowercase();
        if !normalized_query.is_empty() {
            file.entries.retain(|entry| {
                [&entry.word, &entry.lemma, &entry.meaning]
                    .iter()
                    .any(|value| value.to_lowercase().contains(&normalized_query))
            });
        }
        Ok(VocabularyListResult {
            entries: file.entries,
            total,
        })
    }

    pub fn upsert(
        &self,
        candidate: VocabularyCandidate,
    ) -> Result<VocabularySaveResult, VocabularyError> {
        validate_candidate(&candidate)?;
        let mut file = self.load()?;
        let key = normalized_key(&candidate.lemma, &candidate.word);
        let now = now_rfc3339()?;
        if let Some(existing) = file.entries.iter_mut().find(|entry| entry.key == key) {
            existing.word = candidate.word;
            existing.lemma = candidate.lemma;
            existing.phonetic = candidate.phonetic;
            existing.part_of_speech = candidate.part_of_speech;
            existing.meaning = candidate.meaning;
            existing.context = candidate.context;
            existing.source = candidate.source;
            if candidate.detail.is_some() {
                existing.detail = candidate.detail;
            }
            existing.updated_at = now;
            let entry_id = existing.id.clone();
            save_file_atomic(&self.path, &file)?;
            return Ok(VocabularySaveResult {
                status: VocabularySaveStatus::Updated,
                entry_id,
            });
        }

        let id_suffix = self.id_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let unix_nanos = OffsetDateTime::now_utc().unix_timestamp_nanos();
        let entry = VocabularyEntry {
            id: format!("vocab-{unix_nanos}-{id_suffix}"),
            key,
            word: candidate.word,
            lemma: candidate.lemma,
            phonetic: candidate.phonetic,
            part_of_speech: candidate.part_of_speech,
            meaning: candidate.meaning,
            context: candidate.context,
            source: candidate.source,
            detail: candidate.detail,
            created_at: now.clone(),
            updated_at: now,
        };
        let entry_id = entry.id.clone();
        file.entries.push(entry);
        save_file_atomic(&self.path, &file)?;
        Ok(VocabularySaveResult {
            status: VocabularySaveStatus::Saved,
            entry_id,
        })
    }

    pub fn delete(&self, id: &str) -> Result<VocabularyListResult, VocabularyError> {
        if id.trim().is_empty() {
            return Err(VocabularyError::InvalidData("entry id is empty".into()));
        }
        let mut file = self.load()?;
        let before = file.entries.len();
        file.entries.retain(|entry| entry.id != id);
        if file.entries.len() == before {
            return Err(VocabularyError::InvalidData("entry was not found".into()));
        }
        save_file_atomic(&self.path, &file)?;
        self.list(None)
    }

    pub fn import_from(&self, source: &Path) -> Result<VocabularyImportResult, VocabularyError> {
        let imported_text =
            fs::read_to_string(source).map_err(|error| VocabularyError::Io(error.to_string()))?;
        let imported = parse_vocabulary_file(&imported_text)?;
        validate_file(&imported)?;

        let mut local = self.load()?;
        let existing_ids: HashSet<String> =
            local.entries.iter().map(|entry| entry.id.clone()).collect();
        for candidate in &imported.entries {
            if local
                .entries
                .iter()
                .any(|entry| entry.id == candidate.id && entry.key != candidate.key)
            {
                return Err(VocabularyError::InvalidData(format!(
                    "entry id conflicts with local data: {}",
                    candidate.id
                )));
            }
        }
        let now = now_rfc3339()?;
        let mut added = 0usize;
        let mut updated = 0usize;
        for candidate in imported.entries {
            if let Some(existing) = local
                .entries
                .iter_mut()
                .find(|entry| entry.key == candidate.key)
            {
                existing.word = candidate.word;
                existing.lemma = candidate.lemma;
                existing.phonetic = candidate.phonetic;
                existing.part_of_speech = candidate.part_of_speech;
                existing.meaning = candidate.meaning;
                existing.context = candidate.context;
                existing.source = candidate.source;
                if candidate.detail.is_some() {
                    existing.detail = candidate.detail;
                }
                existing.updated_at = now.clone();
                updated += 1;
            } else {
                if existing_ids.contains(&candidate.id) {
                    return Err(VocabularyError::InvalidData(format!(
                        "entry id conflicts with local data: {}",
                        candidate.id
                    )));
                }
                local.entries.push(candidate);
                added += 1;
            }
        }
        save_file_atomic(&self.path, &local)?;
        Ok(VocabularyImportResult {
            cancelled: false,
            added,
            updated,
            total: local.entries.len(),
        })
    }

    pub fn export_to(&self, destination: &Path) -> Result<VocabularyExportResult, VocabularyError> {
        let file = self.load()?;
        save_export_atomic(destination, &file)?;
        Ok(VocabularyExportResult {
            cancelled: false,
            exported: file.entries.len(),
        })
    }

    pub fn source_url(&self, id: &str) -> Result<Option<String>, VocabularyError> {
        let file = self.load()?;
        Ok(file
            .entries
            .into_iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.source.url))
    }
}

pub fn normalized_key(lemma: &str, word: &str) -> String {
    let source = if lemma.trim().is_empty() { word } else { lemma };
    source.trim().to_lowercase()
}

pub fn validate_source_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn validate_candidate(candidate: &VocabularyCandidate) -> Result<(), VocabularyError> {
    for (name, value) in [
        ("word", &candidate.word),
        ("meaning", &candidate.meaning),
    ] {
        if value.trim().is_empty() {
            return Err(VocabularyError::InvalidData(format!("{name} is empty")));
        }
    }
    validate_detail(candidate.detail.as_ref())
}

fn validate_file(file: &VocabularyFile) -> Result<(), VocabularyError> {
    if file.schema_version != VOCABULARY_SCHEMA_VERSION {
        return Err(VocabularyError::InvalidData(format!(
            "unsupported schemaVersion: {}",
            file.schema_version
        )));
    }
    let mut keys = HashSet::new();
    let mut ids = HashSet::new();
    for (index, entry) in file.entries.iter().enumerate() {
        validate_entry(entry)
            .map_err(|error| VocabularyError::InvalidData(format!("entry {index}: {error}")))?;
        if !keys.insert(entry.key.clone()) {
            return Err(VocabularyError::InvalidData(format!(
                "duplicate key in file: {}",
                entry.key
            )));
        }
        if !ids.insert(entry.id.clone()) {
            return Err(VocabularyError::InvalidData(format!(
                "duplicate id in file: {}",
                entry.id
            )));
        }
    }
    Ok(())
}

fn validate_entry(entry: &VocabularyEntry) -> Result<(), String> {
    if entry.id.trim().is_empty() {
        return Err("id is empty".into());
    }
    for (name, value) in [
        ("word", &entry.word),
        ("meaning", &entry.meaning),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{name} is empty"));
        }
    }
    if entry.key != normalized_key(&entry.lemma, &entry.word) {
        return Err("key does not match normalized lemma/word".into());
    }
    OffsetDateTime::parse(&entry.created_at, &Rfc3339)
        .map_err(|_| "createdAt is not RFC3339".to_owned())?;
    OffsetDateTime::parse(&entry.updated_at, &Rfc3339)
        .map_err(|_| "updatedAt is not RFC3339".to_owned())?;
    if let Some(url) = entry.source.url.as_deref() {
        if !validate_source_url(url) {
            return Err("source.url must be http/https".into());
        }
    }
    validate_detail(entry.detail.as_ref()).map_err(|error| error.to_string())
}

fn validate_detail(detail: Option<&VocabularyDetail>) -> Result<(), VocabularyError> {
    let Some(detail) = detail else {
        return Ok(());
    };
    if detail.meaning_in_sentence.trim().is_empty() {
        return Err(VocabularyError::InvalidData(
            "detail.meaningInSentence is empty".into(),
        ));
    }
    if let Some(comparison) = detail.comparison.as_ref() {
        if comparison.word.trim().is_empty() || comparison.difference.trim().is_empty() {
            return Err(VocabularyError::InvalidData(
                "detail comparison contains an empty field".into(),
            ));
        }
    }
    Ok(())
}

fn load_file_or_default(path: &Path) -> Result<VocabularyFile, VocabularyError> {
    let backup = path.with_extension("json.bak");
    let source = if path.exists() {
        path
    } else if backup.exists() {
        &backup
    } else {
        return Ok(VocabularyFile::default());
    };
    let text =
        fs::read_to_string(source).map_err(|error| VocabularyError::Io(error.to_string()))?;
    let file = parse_vocabulary_file(&text)?;
    validate_file(&file)?;
    Ok(file)
}

fn parse_vocabulary_file(text: &str) -> Result<VocabularyFile, VocabularyError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| VocabularyError::InvalidJson(error.to_string()))?;
    let entries = value
        .as_object()
        .and_then(|root| root.get("entries"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| VocabularyError::InvalidData("entries must be an array".into()))?;
    for (index, entry) in entries.iter().enumerate() {
        let object = entry.as_object().ok_or_else(|| {
            VocabularyError::InvalidData(format!("entry {index} must be an object"))
        })?;
        if !object.contains_key("detail") {
            return Err(VocabularyError::InvalidData(format!(
                "entry {index}: detail is missing"
            )));
        }
        let source = object
            .get("source")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| {
                VocabularyError::InvalidData(format!("entry {index}: source must be an object"))
            })?;
        if !source.contains_key("url") {
            return Err(VocabularyError::InvalidData(format!(
                "entry {index}: source.url is missing"
            )));
        }
        if let Some(detail) = object.get("detail").and_then(serde_json::Value::as_object) {
            if !detail.contains_key("comparison") {
                return Err(VocabularyError::InvalidData(format!(
                    "entry {index}: detail.comparison is missing"
                )));
            }
        }
    }
    serde_json::from_value(value).map_err(|error| VocabularyError::InvalidJson(error.to_string()))
}

fn now_rfc3339() -> Result<String, VocabularyError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| VocabularyError::InvalidData(error.to_string()))
}

fn save_file_atomic(path: &Path, file: &VocabularyFile) -> Result<(), VocabularyError> {
    validate_file(file)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| VocabularyError::Io(error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(file)
        .map_err(|error| VocabularyError::InvalidJson(error.to_string()))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut output =
        File::create(&temporary).map_err(|error| VocabularyError::Io(error.to_string()))?;
    output
        .write_all(serialized.as_bytes())
        .and_then(|()| output.sync_all())
        .map_err(|error| VocabularyError::Io(error.to_string()))?;
    drop(output);

    let had_existing = path.exists();
    if had_existing && backup.exists() {
        fs::remove_file(&backup).map_err(|error| VocabularyError::Io(error.to_string()))?;
    }
    promote_vocabulary_with_rollback(&temporary, path, &backup, had_existing, |from, to| {
        fs::rename(from, to)
    })?;
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn save_export_atomic(path: &Path, file: &VocabularyFile) -> Result<(), VocabularyError> {
    validate_file(file)?;
    let parent = path
        .parent()
        .ok_or_else(|| VocabularyError::Io("export destination has no parent".into()))?;
    fs::create_dir_all(parent).map_err(|error| VocabularyError::Io(error.to_string()))?;
    let serialized = serde_json::to_string_pretty(file)
        .map_err(|error| VocabularyError::InvalidJson(error.to_string()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| VocabularyError::Io("export destination has no valid file name".into()))?;
    let nonce = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let mut sequence = 0u32;
    let (temporary, backup) = loop {
        sequence += 1;
        let stem = format!(
            ".{file_name}.orange-export-{}-{nonce}-{sequence}",
            std::process::id()
        );
        let temporary = parent.join(format!("{stem}.tmp"));
        let backup = parent.join(format!("{stem}.bak"));
        if temporary != path && backup != path && !temporary.exists() && !backup.exists() {
            break (temporary, backup);
        }
    };
    let mut output =
        File::create(&temporary).map_err(|error| VocabularyError::Io(error.to_string()))?;
    output
        .write_all(serialized.as_bytes())
        .and_then(|()| output.sync_all())
        .map_err(|error| VocabularyError::Io(error.to_string()))?;
    drop(output);

    let had_existing = path.exists();
    let result =
        promote_vocabulary_with_rollback(&temporary, path, &backup, had_existing, |from, to| {
            fs::rename(from, to)
        });
    if result.is_ok() && backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[doc(hidden)]
pub fn promote_vocabulary_with_rollback(
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    had_existing: bool,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), VocabularyError> {
    if had_existing {
        rename(destination, backup).map_err(|error| {
            VocabularyError::Io(format!("cannot create vocabulary backup: {error}"))
        })?;
    }
    if let Err(promote_error) = rename(temporary, destination) {
        let rollback_error = had_existing
            .then(|| rename(backup, destination).err())
            .flatten();
        let message = match rollback_error {
            Some(rollback_error) => format!(
                "cannot promote vocabulary file: {promote_error}; rollback failed: {rollback_error}; backup retained"
            ),
            None => format!("cannot promote vocabulary file: {promote_error}; original restored"),
        };
        return Err(VocabularyError::Io(message));
    }
    Ok(())
}
