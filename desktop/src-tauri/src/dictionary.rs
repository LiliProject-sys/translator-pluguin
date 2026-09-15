//! Host-independent Quick acceleration. This module never receives context or mode.
use crate::app_state::{
    GatewayConnectionState, GatewayParseStatus, GatewayParsedResult, GatewayTestState,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;

// 2026-09-15: all six paired-context tests were context-dependent (12 calls).
// Keep reads AND writes closed. No setting/database may override this safety gate.
pub const GENERATED_CACHE_ENABLED: bool = false;
const EDGE: &str = " \t\r\n.,;:!?\"“”‘’()[]{}<>，。；：！？";

pub fn normalize_surface(value: &str) -> String {
    value
        .nfc()
        .collect::<String>()
        .trim_matches(|c| EDGE.contains(c))
        .to_lowercase()
}

fn override_key(value: &str) -> (String, &'static str) {
    let surface = value.nfc().collect::<String>().trim_matches(|c| EDGE.contains(c)).to_owned();
    let letters: Vec<char> = surface.chars().filter(|c| c.is_alphabetic()).collect();
    let special = surface.chars().any(|c| c.is_numeric())
        || (!letters.is_empty() && letters.iter().all(|c| c.is_uppercase()))
        || letters.iter().skip(1).any(|c| c.is_uppercase());
    if special { (surface, "exact") } else { (surface.to_lowercase(), "lexical") }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDictionaryEntry {
    pub lemma: String,
    pub phonetic: String,
    pub part_of_speech: String,
    pub meaning: String,
}

impl LocalDictionaryEntry {
    pub fn validate(&self) -> bool {
        !self.meaning.trim().is_empty()
            && self.meaning.chars().count() <= 300
            && self.lemma.chars().count() <= 128
            && self.phonetic.chars().count() <= 256
            && self
                .part_of_speech
                .split('/')
                .all(|p| matches!(p, "" | "n." | "v." | "adj." | "adv." | "prep." | "phr."))
    }

    /// Internal display union only; NEVER passed to the network response parser.
    pub fn display(&self, target: &str, source: &str, version: &str) -> GatewayParsedResult {
        GatewayParsedResult::Word {
            provider: "local".into(),
            upstream_provider: source.into(),
            skill_version: version.into(),
            word: target.into(),
            lemma: self.lemma.clone(),
            phonetic: self.phonetic.clone(),
            part_of_speech: self.part_of_speech.clone(),
            meaning: self.meaning.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupDiagnostic {
    pub quick_source: String,
    pub lookup_surface: String,
    pub candidate_count: usize,
    pub dictionary_version: String,
    pub lookup_latency_us: u64,
    pub ambiguity_merged: bool,
    pub model_fallback: bool,
    pub generated_cache_enabled: bool,
    pub errors: Vec<String>,
}

pub struct LocalResolution {
    pub entry: Option<LocalDictionaryEntry>,
    pub diagnostic: LookupDiagnostic,
}

/// One cached read-only base connection; a distinct, lazily opened user DB.
/// SQLite work is dispatched off the async/UI thread by the caller.
pub struct DictionaryService {
    base_path: PathBuf,
    user_path: PathBuf,
    base: Mutex<Option<Connection>>,
    user: Mutex<Option<Connection>>,
    generated_enabled: bool,
}

impl DictionaryService {
    pub fn new(base_path: PathBuf, user_path: PathBuf) -> Self {
        Self {
            base_path,
            user_path,
            base: Mutex::new(None),
            user: Mutex::new(None),
            generated_enabled: GENERATED_CACHE_ENABLED,
        }
    }

    fn with_user<T>(
        &self,
        action: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let mut guard = self
            .user
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if guard.is_none() {
            if let Some(parent) = self.user_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| rusqlite::Error::InvalidPath(parent.to_owned()))?;
            }
            let mut db = Connection::open(&self.user_path)?;
            db.busy_timeout(Duration::from_millis(20))?;
            let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
            if version > 2 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let tx = db.transaction()?;
            if version < 2 {
                tx.execute_batch("
                CREATE TABLE IF NOT EXISTS user_overrides(surface TEXT PRIMARY KEY,lemma TEXT NOT NULL,phonetic TEXT NOT NULL,part_of_speech TEXT NOT NULL,meaning TEXT NOT NULL,updated_at TEXT NOT NULL);
                ALTER TABLE user_overrides RENAME TO user_overrides_v1;
                CREATE TABLE user_overrides(surface TEXT NOT NULL,match_scope TEXT NOT NULL CHECK(match_scope IN ('lexical','exact')),lemma TEXT NOT NULL,phonetic TEXT NOT NULL,part_of_speech TEXT NOT NULL,meaning TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(surface,match_scope));
                INSERT INTO user_overrides SELECT surface,'lexical',lemma,phonetic,part_of_speech,meaning,updated_at FROM user_overrides_v1;
                DROP TABLE user_overrides_v1;
                ")?;
            }
            tx.execute_batch("
                CREATE TABLE IF NOT EXISTS generated_entries(surface TEXT PRIMARY KEY,lemma TEXT NOT NULL,phonetic TEXT NOT NULL,part_of_speech TEXT NOT NULL,meaning TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,hit_count INTEGER NOT NULL,source_profile TEXT NOT NULL,skill_version TEXT NOT NULL);
                PRAGMA user_version=2;")?;
            tx.commit()?;
            *guard = Some(db);
        }
        action(guard.as_ref().unwrap())
    }

    fn user_entry(
        &self,
        surface: &str,
        generated: bool,
    ) -> rusqlite::Result<Option<LocalDictionaryEntry>> {
        if !generated { return self.get_override(surface); }
        self.with_user(|db| {
            let sql = if generated { "SELECT lemma,phonetic,part_of_speech,meaning FROM generated_entries WHERE surface=?1" }
                      else { "SELECT lemma,phonetic,part_of_speech,meaning FROM user_overrides WHERE surface=?1" };
            let entry = db.query_row(sql, [surface], read_entry).optional()?;
            if generated && entry.is_some() {
                // A failed stats write must not invalidate a successfully read hit.
                let _ = db.execute("UPDATE generated_entries SET hit_count=hit_count+1,last_used_at=datetime('now') WHERE surface=?1", [surface]);
            }
            Ok(entry)
        })
    }

    fn base_entries(&self, surface: &str) -> rusqlite::Result<(Vec<LocalDictionaryEntry>, String, Option<String>)> {
        let mut guard = self
            .base
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if guard.is_none() {
            let db =
                Connection::open_with_flags(&self.base_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(Duration::from_millis(20))?;
            let version: String = db.query_row(
                "SELECT value FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )?;
            if version != "1" && version != "2" {
                return Err(rusqlite::Error::InvalidQuery);
            }
            *guard = Some(db);
        }
        let db = guard.as_ref().unwrap();
        let version = db.query_row(
            "SELECT value FROM meta WHERE key='dictionary_version'",
            [],
            |r| r.get(0),
        )?;
        let mut query = db.prepare_cached("SELECT e.lemma,e.phonetic,e.part_of_speech,e.meaning FROM forms f JOIN entries e ON e.id=f.entry_id WHERE f.surface=?1 ORDER BY f.priority,f.entry_id LIMIT 2")?;
        let entries = query
            .query_map([surface], read_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let schema: String = db.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0))?;
        let exact_phonetic = if schema == "2" {
            let value: String = db.query_row("SELECT phonetic FROM surface_phonetics WHERE surface=?1", [surface], |r| r.get(0))
                .optional()?.unwrap_or_default();
            if value.chars().count() > 256 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Some(value)
        } else { None };
        Ok((entries, version, exact_phonetic))
    }

    pub fn resolve(&self, target: &str) -> LocalResolution {
        let started = Instant::now();
        let surface = normalize_surface(target);
        let mut d = LookupDiagnostic {
            quick_source: "model".into(),
            lookup_surface: surface.clone(),
            model_fallback: true,
            generated_cache_enabled: self.generated_enabled,
            ..Default::default()
        };
        let mut entry = None;
        if !surface.is_empty()
            && surface.chars().count() <= 128
            && !surface.chars().any(char::is_whitespace)
        {
            match self.get_override(target) {
                Ok(Some(e)) if e.validate() => {
                    entry = Some(e);
                    d.quick_source = "user_override".into();
                    d.candidate_count = 1;
                }
                Ok(Some(_)) => d.errors.push("override_invalid".into()),
                Err(_) => d.errors.push("user_db_unavailable".into()),
                _ => {}
            }
            if entry.is_none() {
                match self.base_entries(&surface) {
                    Ok((entries, version, exact_phonetic)) => {
                        d.dictionary_version = version;
                        if !entries.is_empty() && entries.iter().all(|e| {
                            // Builder retains identity/forms for morphology-only
                            // rows. Empty meaning contributes no semantic slot.
                            let mut check = e.clone();
                            if check.meaning.is_empty() { check.meaning = "_".into(); }
                            check.validate()
                        })
                        {
                            d.candidate_count = entries.len();
                            d.ambiguity_merged = entries.len() > 1;
                            let mut merged = merge(&entries);
                            // The entry's pronunciation is for its lemma, not necessarily
                            // this inflection (gave/give, taken/take). Do not mislabel it.
                            if let Some(phonetic) = exact_phonetic {
                                // Schema 2 pronunciation belongs to the selected surface,
                                // independently of semantic candidates. Missing stays empty.
                                merged.phonetic = phonetic;
                            } else if normalize_surface(&merged.lemma) != surface {
                                merged.phonetic.clear();
                            }
                            if !merged.meaning.is_empty() {
                                entry = Some(merged);
                                d.quick_source = "base_dictionary".into();
                            }
                        } else if !entries.is_empty() {
                            d.errors.push("base_invalid".into());
                        }
                    }
                    Err(_) => d.errors.push("base_db_unavailable".into()),
                }
            }
            if entry.is_none() && self.generated_enabled {
                match self.user_entry(&surface, true) {
                    Ok(Some(e)) if e.validate() => {
                        entry = Some(e);
                        d.quick_source = "generated_cache".into();
                        d.candidate_count = 1;
                    }
                    Ok(Some(_)) => d.errors.push("generated_invalid".into()),
                    Err(_) => d.errors.push("generated_db_unavailable".into()),
                    _ => {}
                }
            }
        }
        d.model_fallback = entry.is_none();
        d.lookup_latency_us = started.elapsed().as_micros() as u64;
        LocalResolution {
            entry,
            diagnostic: d,
        }
    }

    pub fn set_override(&self, target: &str, entry: &LocalDictionaryEntry) -> rusqlite::Result<()> {
        let (surface, scope) = override_key(target);
        if !entry.validate()
            || surface.is_empty()
            || surface.chars().count() > 128
            || surface.chars().any(char::is_whitespace)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.with_user(|db| db.execute("INSERT INTO user_overrides VALUES(?1,?2,?3,?4,?5,?6,datetime('now')) ON CONFLICT(surface,match_scope) DO UPDATE SET lemma=excluded.lemma,phonetic=excluded.phonetic,part_of_speech=excluded.part_of_speech,meaning=excluded.meaning,updated_at=excluded.updated_at",
            params![surface,scope,entry.lemma.trim(),entry.phonetic.trim(),entry.part_of_speech,entry.meaning.trim()]).map(|_| ()))
    }

    /// Exact first; legacy lexical rows remain readable, without expanding forms.
    pub fn get_override(&self, target: &str) -> rusqlite::Result<Option<LocalDictionaryEntry>> {
        let exact = target.nfc().collect::<String>().trim_matches(|c| EDGE.contains(c)).to_owned();
        self.with_user(|db| db.query_row(
            "SELECT lemma,phonetic,part_of_speech,meaning FROM user_overrides WHERE (surface=?1 AND match_scope='exact') OR (surface=?2 AND match_scope='lexical') ORDER BY CASE match_scope WHEN 'exact' THEN 0 ELSE 1 END LIMIT 1",
            params![exact,normalize_surface(target)], read_entry).optional())
    }

    pub fn remove_override(&self, target: &str) -> rusqlite::Result<()> {
        let exact = target.nfc().collect::<String>().trim_matches(|c| EDGE.contains(c)).to_owned();
        self.with_user(|db| {
            db.execute(
                "DELETE FROM user_overrides WHERE (surface,match_scope) IN (SELECT surface,match_scope FROM user_overrides WHERE (surface=?1 AND match_scope='exact') OR (surface=?2 AND match_scope='lexical') ORDER BY CASE match_scope WHEN 'exact' THEN 0 ELSE 1 END LIMIT 1)",
                params![exact,normalize_surface(target)],
            )
            .map(|_| ())
        })
    }

    /// Called only with a successfully validated network result. No form expansion.
    pub fn cache_network_result(
        &self,
        target: &str,
        result: &GatewayParsedResult,
        profile: &str,
    ) -> rusqlite::Result<()> {
        if !self.generated_enabled {
            return Ok(());
        }
        let surface = normalize_surface(target);
        if surface.is_empty()
            || surface.chars().count() > 128
            || surface.chars().any(char::is_whitespace)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let GatewayParsedResult::Word {
            lemma,
            phonetic,
            part_of_speech,
            meaning,
            skill_version,
            ..
        } = result
        else {
            return Ok(());
        };
        let entry = LocalDictionaryEntry {
            lemma: lemma.clone(),
            phonetic: phonetic.clone(),
            part_of_speech: part_of_speech.clone(),
            meaning: meaning.clone(),
        };
        if !entry.validate() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.with_user(|db| db.execute("INSERT INTO generated_entries VALUES(?1,?2,?3,?4,?5,datetime('now'),datetime('now'),0,?6,?7) ON CONFLICT(surface) DO UPDATE SET lemma=excluded.lemma,phonetic=excluded.phonetic,part_of_speech=excluded.part_of_speech,meaning=excluded.meaning,source_profile=excluded.source_profile,skill_version=excluded.skill_version,last_used_at=excluded.last_used_at",
            params![normalize_surface(target),lemma,phonetic,part_of_speech,meaning,profile,skill_version]).map(|_| ()))
    }
}

fn read_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalDictionaryEntry> {
    Ok(LocalDictionaryEntry {
        lemma: row.get(0)?,
        phonetic: row.get(1)?,
        part_of_speech: row.get(2)?,
        meaning: row.get(3)?,
    })
}

fn base_meanings(value: &str) -> Vec<&str> {
    let (mut depth, mut start) = (0usize, 0usize);
    let mut senses = Vec::new();
    for (offset, c) in value.char_indices() {
        match c {
            '(' | '（' | '[' => depth += 1,
            ')' | '）' | ']' => depth = depth.saturating_sub(1),
            '；' if depth == 0 => {
                senses.push(&value[start..offset]);
                start = offset + c.len_utf8();
            }
            _ => {}
        }
    }
    senses.push(&value[start..]);
    senses
}

fn merge(entries: &[LocalDictionaryEntry]) -> LocalDictionaryEntry {
    let mut pos = Vec::new();
    let mut meanings = Vec::new();
    let groups: Vec<Vec<&str>> = entries
        .iter()
        .map(|e| base_meanings(&e.meaning))
        .collect();
    for e in entries {
        for p in e.part_of_speech.split('/') {
            if !p.is_empty() && !pos.contains(&p) {
                pos.push(p);
            }
        }
    }
    let quota = if entries.len() == 1 { 2 } else { 1 };
    for g in &groups {
        let mut contributed = 0;
        for s in g.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if !meanings.contains(&s) && meanings.len() < 2 {
                meanings.push(s);
                contributed += 1;
                if contributed == quota { break; }
            }
        }
    }
    let unique = entries.len() == 1;
    LocalDictionaryEntry {
        lemma: if unique {
            entries[0].lemma.clone()
        } else {
            String::new()
        },
        phonetic: if unique {
            entries[0].phonetic.clone()
        } else {
            String::new()
        },
        part_of_speech: pos.join("/"),
        meaning: meanings.join("；"),
    }
}

/// Shared success application for local and network Quick. HTTP None means no
/// network request; Success describes completed Quick, not fabricated transport.
pub fn apply_quick_success(
    state: &mut GatewayTestState,
    display: &GatewayParsedResult,
    http_status: Option<u16>,
    latency_ms: u64,
) {
    state.connection_state = GatewayConnectionState::Success;
    state.http_status = http_status;
    state.latency_ms = Some(latency_ms);
    state.parse_status = GatewayParseStatus::Success;
    state.parsed_result = Some(display.clone());
    state.raw_preview = None;
    state.error_code = None;
    state.gateway_error_code = None;
    state.error_message = None;
    state.live_error_kind = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> (DictionaryService, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "orange-dictionary-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Connection::open(dir.join("base.db")).unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
            INSERT INTO meta VALUES('schema_version','1'),('dictionary_version','fixture');
            CREATE TABLE entries(id INTEGER PRIMARY KEY,lemma TEXT,phonetic TEXT,part_of_speech TEXT,meaning TEXT);
            INSERT INTO entries VALUES(1,'see','si:','v.','看见；查看'),(2,'saw','','n./v.','锯子；锯');
            CREATE TABLE forms(surface TEXT,entry_id INTEGER,relation TEXT,priority INTEGER,PRIMARY KEY(surface,entry_id));
            INSERT INTO forms VALUES('saw',1,'p',10),('saw',2,'exact',20),('seen',1,'d',10),('see',1,'exact',10);").unwrap();
        drop(db);
        (
            DictionaryService::new(dir.join("base.db"), dir.join("user.db")),
            dir,
        )
    }
    fn entry() -> LocalDictionaryEntry {
        LocalDictionaryEntry {
            lemma: String::new(),
            phonetic: String::new(),
            part_of_speech: "n./v.".into(),
            meaning: "本地测试义".into(),
        }
    }

    #[test]
    fn normalization_preserves_lexical_structure() {
        assert_eq!(normalize_surface(" “Measurements,” "), "measurements");
        assert_eq!(normalize_surface("Don't"), "don't");
        assert_eq!(normalize_surface("k-means"), "k-means");
        assert_eq!(normalize_surface("cafe\u{301}"), "café");
    }

    #[test]
    fn empty_base_meanings_are_semantic_miss_without_placeholder_or_override_loss() {
        let (service, dir) = fixture();
        let db = Connection::open(dir.join("base.db")).unwrap();
        db.execute("UPDATE entries SET meaning=''", []).unwrap();
        for surface in ["see", "saw"] {
            let result = service.resolve(surface);
            assert!(result.entry.is_none());
            assert!(result.diagnostic.model_fallback);
            assert!(result.diagnostic.errors.is_empty());
            assert_ne!(result.diagnostic.quick_source, "base_dictionary");
        }
        db.execute("UPDATE entries SET meaning='锯子；锯' WHERE id=2", []).unwrap();
        let hit = service.resolve("saw");
        assert!(!hit.diagnostic.model_fallback);
        assert_eq!(hit.entry.unwrap().meaning, "锯子");
        service.set_override("see", &entry()).unwrap();
        let custom = service.resolve("see");
        assert!(!custom.diagnostic.model_fallback);
        assert_eq!(custom.entry.unwrap().meaning, entry().meaning);
        assert!(!GENERATED_CACHE_ENABLED);
        drop(db);
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn base_merge_budget_is_per_candidate_and_preserves_pos_and_asides() {
        let item = |meaning: &str, pos: &str| LocalDictionaryEntry { meaning: meaning.into(), part_of_speech: pos.into(), ..entry() };
        assert_eq!(merge(&[item("唯一义", "n.")]).meaning, "唯一义");
        assert_eq!(merge(&[item("甲；甲；乙；丙", "n.")]).meaning, "甲；乙");
        assert_eq!(merge(&[item("甲；乙", "v."),item("丙；丁", "n.")]).meaning, "甲；丙");
        let combined = merge(&[item("甲；乙", "v."),item("甲；丙", "n./v.")]);
        assert_eq!(combined.meaning, "甲；丙");
        assert_eq!(combined.part_of_speech, "v./n.");
        assert_eq!(merge(&[item("甲；乙", "v."),item("甲；甲", "n.")]).meaning, "甲");
        assert_eq!(merge(&[item("甲（限定；说明）；乙；丙", "n.")]).meaning, "甲（限定；说明）；乙");
        assert_eq!(merge(&[item("", "v."),item("甲；乙", "n.")]).meaning, "甲");
    }

    #[test]
    fn user_override_full_meaning_never_passes_through_base_minimalism() {
        let (service, dir) = fixture();
        let mut custom = entry();
        custom.meaning = "第一义；第二义；第三义（word的过去式）；第四义（专业限定）".into();
        service.set_override("saw", &custom).unwrap();
        assert_eq!(service.get_override("saw").unwrap().unwrap().meaning, custom.meaning);
        let found = service.resolve("saw");
        assert_eq!(found.diagnostic.quick_source, "user_override");
        let e = found.entry.unwrap();
        assert_eq!(e.meaning, custom.meaning);
        assert!(matches!(e.display("saw", "user_override", "fixture"), GatewayParsedResult::Word{meaning,..} if meaning==custom.meaning));
        drop(service); std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn base_forms_ambiguity_missing_phonetic_and_override_priority() {
        let (service, dir) = fixture();
        let merged = service.resolve("saw");
        assert_eq!(merged.diagnostic.quick_source, "base_dictionary");
        assert_eq!(merged.diagnostic.candidate_count, 2);
        assert!(!merged.diagnostic.model_fallback);
        let e = merged.entry.unwrap();
        assert!(e.lemma.is_empty() && e.phonetic.is_empty());
        assert_eq!(e.meaning, "看见；锯子");
        assert_eq!(service.resolve("seen").entry.unwrap().lemma, "see");
        assert!(service.resolve("seen").entry.unwrap().phonetic.is_empty());
        assert_eq!(service.resolve("see").entry.unwrap().phonetic, "si:");
        service.set_override("saw", &entry()).unwrap();
        assert_eq!(
            service.resolve("saw").diagnostic.quick_source,
            "user_override"
        );
        service.remove_override("saw").unwrap();
        assert_eq!(
            service.resolve("saw").diagnostic.quick_source,
            "base_dictionary"
        );
        assert!(service.resolve("two words").entry.is_none());
        assert!(service.resolve("missing").entry.is_none());
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn schema2_surface_phonetic_is_independent_and_never_borrows_lemma() {
        let (service, dir) = fixture();
        let db = Connection::open(dir.join("base.db")).unwrap();
        db.execute_batch("UPDATE meta SET value='2' WHERE key='schema_version';
            CREATE TABLE surface_phonetics(surface TEXT PRIMARY KEY,phonetic TEXT NOT NULL);
            INSERT INTO surface_phonetics VALUES('saw','SAW_EXACT'),('seen','SEEN_EXACT');").unwrap();
        let saw = service.resolve("saw");
        assert_eq!(saw.diagnostic.candidate_count, 2);
        let e = saw.entry.unwrap();
        assert!(e.lemma.is_empty());
        assert_eq!(e.meaning, "看见；锯子");
        assert_eq!(e.part_of_speech, "v./n.");
        assert_eq!(e.phonetic, "SAW_EXACT");
        assert_eq!(service.resolve(" (seen), ").entry.unwrap().phonetic, "SEEN_EXACT");
        assert_eq!(service.resolve("seen").entry.unwrap().lemma, "see");
        // see has lemma IPA, but no exact surface row: never borrow it.
        assert!(service.resolve("see").entry.unwrap().phonetic.is_empty());
        let mut custom = entry();
        custom.phonetic = "USER_EXACT".into();
        service.set_override("saw", &custom).unwrap();
        assert_eq!(service.resolve("saw").entry.unwrap().phonetic, "USER_EXACT");
        service.remove_override("saw").unwrap();
        db.execute("UPDATE surface_phonetics SET phonetic=?1 WHERE surface='saw'", ["x".repeat(257)]).unwrap();
        assert!(service.resolve("saw").entry.is_none());
        db.execute_batch("DROP TABLE surface_phonetics;").unwrap();
        assert!(service.resolve("saw").entry.is_none());
        drop(db);
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generated_is_exact_surface_and_never_overrides_base_or_expands_lemma() {
        let (mut service, dir) = fixture();
        service.generated_enabled = true;
        let network = entry().display("extrusions", "fixture", "test");
        service
            .cache_network_result("extrusions", &network, "UltraFast")
            .unwrap();
        assert_eq!(
            service.resolve("extrusions").diagnostic.quick_source,
            "generated_cache"
        );
        assert!(service.resolve("extrusion").entry.is_none());
        service
            .cache_network_result("saw", &network, "Precise")
            .unwrap();
        assert_eq!(
            service.resolve("saw").diagnostic.quick_source,
            "base_dictionary"
        );
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn closed_safety_gate_ignores_existing_generated_entries() {
        let (mut service, dir) = fixture();
        service.generated_enabled = true;
        service
            .cache_network_result(
                "missing",
                &entry().display("missing", "test", "test"),
                "Fast",
            )
            .unwrap();
        service.generated_enabled = false;
        assert!(service.resolve("missing").entry.is_none());
        service
            .cache_network_result("absent", &entry().display("absent", "test", "test"), "Fast")
            .unwrap();
        service.generated_enabled = true;
        assert!(service.resolve("absent").entry.is_none());
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_corrupt_base_and_user_db_degrade_without_panicking() {
        let (service, dir) = fixture();
        std::fs::write(dir.join("base.db"), b"corrupt").unwrap();
        let r = service.resolve("saw");
        assert!(r.entry.is_none());
        assert!(r.diagnostic.errors.contains(&"base_db_unavailable".into()));
        service.set_override("saw", &entry()).unwrap();
        assert!(service.resolve("saw").entry.is_some());
        drop(service);
        let service = DictionaryService::new(dir.join("missing.db"), dir.clone());
        assert!(service.resolve("saw").entry.is_none());
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
