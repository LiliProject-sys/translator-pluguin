use orange_translator_desktop_lib::{
    app_state::{
        AppState, ContextCaptureSnapshot, ContextSource, ContextStatus, ContextUnit,
        GatewayConnectionState, GatewayParsedResult, LatestGatewayTarget, RequestType,
        WordDetailComparison, WordDetailResult,
    },
    vocabulary::{
        promote_vocabulary_with_rollback, VocabularyCandidate, VocabularyComparison,
        VocabularyDetail, VocabularyEntry, VocabularyFile, VocabularyRepository,
        VocabularySaveStatus, VocabularySource,
    },
};
use std::{cell::Cell, fs, io, path::Path, time::SystemTime};

fn temp_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "orange-stage5-{name}-{}-{nonce}",
        std::process::id()
    ))
}

fn source(url: Option<&str>) -> VocabularySource {
    VocabularySource {
        app: "Microsoft Word".into(),
        title: "Document".into(),
        url: url.map(str::to_owned),
    }
}

fn candidate(word: &str, lemma: &str, detail: Option<VocabularyDetail>) -> VocabularyCandidate {
    VocabularyCandidate {
        word: word.into(),
        lemma: lemma.into(),
        phonetic: "/test/".into(),
        part_of_speech: "v.".into(),
        meaning: "使用；采用".into(),
        context: "They employed a careful method.".into(),
        source: source(None),
        detail,
    }
}

fn detail() -> VocabularyDetail {
    VocabularyDetail {
        meaning_in_sentence: "在此处表示采用".into(),
        comparison: Some(VocabularyComparison {
            word: "use".into(),
            difference: "employ is more formal".into(),
        }),
    }
}

fn live_target(generation: u64) -> LatestGatewayTarget {
    LatestGatewayTarget {
        target: "employed".into(),
        request_type: RequestType::WordAnalysis,
        page_title: "Document".into(),
        source_app: "Microsoft Word".into(),
        capture_generation: 7,
        translation_generation: generation,
        captured_at_unix_ms: 8,
        context: ContextCaptureSnapshot {
            context_sentence: "They employed a careful method.".into(),
            status: ContextStatus::Success,
            source: ContextSource::Uia,
            unit: ContextUnit::Paragraph,
            context_length: 31,
            context_preview: "They employed a careful method.".into(),
        },
    }
}

fn quick_word() -> GatewayParsedResult {
    GatewayParsedResult::Word {
        provider: "gateway".into(),
        upstream_provider: "provider".into(),
        skill_version: "context-analysis-v6".into(),
        word: "employed".into(),
        lemma: "employ".into(),
        phonetic: "/ɪmˈplɔɪ/".into(),
        part_of_speech: "v.".into(),
        meaning: "使用；采用".into(),
    }
}

#[test]
fn repository_saves_updates_searches_deletes_and_round_trips() {
    let root = temp_path("repository");
    let path = root.join("vocabulary.json");
    let repository = VocabularyRepository::new(path.clone());
    assert_eq!(repository.list(None).unwrap().total, 0);

    let saved = repository
        .upsert(candidate("employed", "employ", None))
        .unwrap();
    assert_eq!(saved.status, VocabularySaveStatus::Saved);
    let first = repository.load().unwrap().entries.remove(0);
    assert_eq!(first.key, "employ");
    assert_eq!(first.source.url, None);
    assert!(first.detail.is_none());

    let updated = repository
        .upsert(candidate("Employ", " EMPLOY ", Some(detail())))
        .unwrap();
    assert_eq!(updated.status, VocabularySaveStatus::Updated);
    let second = repository.load().unwrap().entries.remove(0);
    assert_eq!(second.id, first.id);
    assert_eq!(second.created_at, first.created_at);
    assert!(second.detail.is_some());

    repository
        .upsert(candidate("employ", "employ", None))
        .unwrap();
    assert!(repository.load().unwrap().entries[0].detail.is_some());
    assert_eq!(repository.list(Some("采用")).unwrap().entries.len(), 1);
    assert_eq!(repository.list(Some("EMPLOY")).unwrap().entries.len(), 1);
    assert_eq!(repository.delete(&first.id).unwrap().total, 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn app_state_candidate_uses_only_current_rust_snapshot_and_existing_detail() {
    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation = state.next_translation_generation();
    let target = live_target(generation);
    state.set_latest_gateway_target(target.clone()).unwrap();
    state
        .update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Success;
            gateway.request_id = Some("quick-1".into());
            gateway.request_type = Some(RequestType::WordAnalysis);
            gateway.parsed_result = Some(quick_word());
        })
        .unwrap();
    let without_detail = state
        .current_vocabulary_candidate(generation, "quick-1")
        .unwrap()
        .unwrap();
    assert_eq!(without_detail.context, target.context.context_sentence);
    assert_eq!(without_detail.source, source(None));
    assert!(without_detail.detail.is_none());

    assert!(state.prepare_live_detail(&target, "quick-1").unwrap());
    let claim = state
        .claim_live_detail(generation, "quick-1")
        .unwrap()
        .unwrap();
    state
        .complete_live_detail(
            generation,
            "quick-1",
            &claim.detail_request_id,
            Ok(WordDetailResult {
                meaning_in_sentence: "在此处表示采用".into(),
                comparison: Some(WordDetailComparison {
                    word: "use".into(),
                    difference: "more formal".into(),
                }),
            }),
        )
        .unwrap();
    assert!(state
        .current_vocabulary_candidate(generation, "quick-1")
        .unwrap()
        .unwrap()
        .detail
        .is_some());
    assert!(state
        .current_vocabulary_candidate(generation, "stale")
        .unwrap()
        .is_none());
}

#[test]
fn import_merges_atomically_and_export_can_be_reimported() {
    let root = temp_path("import");
    fs::create_dir_all(&root).unwrap();
    let local = VocabularyRepository::new(root.join("local.json"));
    local
        .upsert(candidate("employed", "employ", Some(detail())))
        .unwrap();
    let original = local.load().unwrap().entries[0].clone();

    let mut imported_same = original.clone();
    imported_same.id = "foreign-id".into();
    imported_same.meaning = "雇用".into();
    imported_same.detail = None;
    let imported_new = VocabularyEntry {
        id: "foreign-new".into(),
        key: "measure".into(),
        word: "measured".into(),
        lemma: "measure".into(),
        phonetic: "/measure/".into(),
        part_of_speech: "v.".into(),
        meaning: "测量".into(),
        context: String::new(),
        source: source(Some("https://example.com/source")),
        detail: None,
        created_at: original.created_at.clone(),
        updated_at: original.updated_at.clone(),
    };
    let import_path = root.join("import.json");
    fs::write(
        &import_path,
        serde_json::to_vec_pretty(&VocabularyFile {
            schema_version: 1,
            entries: vec![imported_same, imported_new],
        })
        .unwrap(),
    )
    .unwrap();
    let result = local.import_from(&import_path).unwrap();
    assert_eq!((result.added, result.updated, result.total), (1, 1, 2));
    let merged = local.load().unwrap();
    let employed = merged
        .entries
        .iter()
        .find(|entry| entry.key == "employ")
        .unwrap();
    assert_eq!(employed.id, original.id);
    assert_eq!(employed.created_at, original.created_at);
    assert_eq!(employed.meaning, "雇用");
    assert!(employed.detail.is_some());

    let export_path = root.join("export.json");
    local.export_to(&export_path).unwrap();
    let restored = VocabularyRepository::new(root.join("restored.json"));
    assert_eq!(restored.import_from(&export_path).unwrap().total, 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn invalid_imports_and_id_conflicts_leave_local_file_unchanged() {
    let root = temp_path("invalid");
    fs::create_dir_all(&root).unwrap();
    let repository = VocabularyRepository::new(root.join("vocabulary.json"));
    repository
        .upsert(candidate("employed", "employ", None))
        .unwrap();
    let original_bytes = fs::read(repository.path()).unwrap();
    let original = repository.load().unwrap().entries[0].clone();

    for (name, value) in [
        (
            "schema",
            serde_json::json!({"schemaVersion":2,"entries":[]}),
        ),
        (
            "missing-url",
            serde_json::json!({"schemaVersion":1,"entries":[{
                "id":"x","key":"employ","word":"employ","lemma":"employ","phonetic":"/x/",
                "partOfSpeech":"v.","meaning":"x","context":"","source":{"app":"","title":""},
                "detail":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }]}),
        ),
        (
            "invalid-url",
            serde_json::json!({"schemaVersion":1,"entries":[{
                "id":"x","key":"employ","word":"employ","lemma":"employ","phonetic":"/x/",
                "partOfSpeech":"v.","meaning":"x","context":"","source":{"app":"","title":"","url":"file:///tmp/x"},
                "detail":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }]}),
        ),
    ] {
        let path = root.join(format!("{name}.json"));
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(repository.import_from(&path).is_err());
        assert_eq!(fs::read(repository.path()).unwrap(), original_bytes);
    }

    let malformed_path = root.join("malformed.json");
    fs::write(&malformed_path, b"{not-json").unwrap();
    assert!(repository.import_from(&malformed_path).is_err());
    assert_eq!(fs::read(repository.path()).unwrap(), original_bytes);

    let mut duplicate = original.clone();
    duplicate.id = "duplicate-id".into();
    let duplicate_path = root.join("duplicate-key.json");
    fs::write(
        &duplicate_path,
        serde_json::to_vec_pretty(&VocabularyFile {
            schema_version: 1,
            entries: vec![original.clone(), duplicate],
        })
        .unwrap(),
    )
    .unwrap();
    assert!(repository.import_from(&duplicate_path).is_err());
    assert_eq!(fs::read(repository.path()).unwrap(), original_bytes);

    let conflicting = VocabularyEntry {
        id: original.id,
        key: "different".into(),
        word: "different".into(),
        lemma: "different".into(),
        phonetic: "/d/".into(),
        part_of_speech: "adj.".into(),
        meaning: "不同".into(),
        context: String::new(),
        source: source(None),
        detail: None,
        created_at: original.created_at.clone(),
        updated_at: original.updated_at,
    };
    let conflict_path = root.join("conflict.json");
    fs::write(
        &conflict_path,
        serde_json::to_vec_pretty(&VocabularyFile {
            schema_version: 1,
            entries: vec![conflicting],
        })
        .unwrap(),
    )
    .unwrap();
    assert!(repository.import_from(&conflict_path).is_err());
    assert_eq!(fs::read(repository.path()).unwrap(), original_bytes);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn promotion_failure_attempts_rollback_and_reports_rollback_failure() {
    let calls = Cell::new(0);
    let error = promote_vocabulary_with_rollback(
        Path::new("temporary"),
        Path::new("vocabulary"),
        Path::new("backup"),
        true,
        |_from, _to| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(())
            } else {
                Err(io::Error::other("blocked"))
            }
        },
    )
    .unwrap_err()
    .to_string();
    assert_eq!(calls.get(), 3);
    assert!(error.contains("rollback failed"));
}

#[test]
fn serialized_file_contains_no_gateway_or_secret_fields() {
    let root = temp_path("safe-serialization");
    let repository = VocabularyRepository::new(root.join("vocabulary.json"));
    repository
        .upsert(candidate("employed", "employ", Some(detail())))
        .unwrap();
    let json = fs::read_to_string(repository.path()).unwrap();
    for forbidden in [
        "accessToken",
        "gatewayAccessToken",
        "rawPreview",
        "provider",
        "requestId",
    ] {
        assert!(!json.contains(forbidden));
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn export_never_reuses_or_deletes_fixed_user_sidecar_names() {
    let root = temp_path("export-sidecars");
    fs::create_dir_all(&root).unwrap();
    let repository = VocabularyRepository::new(root.join("local.json"));
    repository
        .upsert(candidate("employed", "employ", None))
        .unwrap();

    let destination = root.join("user-choice.json");
    let fixed_backup = root.join("user-choice.json.bak");
    let fixed_temporary = root.join("user-choice.json.tmp");
    fs::write(&destination, b"old destination").unwrap();
    fs::write(&fixed_backup, b"user backup").unwrap();
    fs::write(&fixed_temporary, b"user temporary").unwrap();
    repository.export_to(&destination).unwrap();
    assert_eq!(fs::read(&fixed_backup).unwrap(), b"user backup");
    assert_eq!(fs::read(&fixed_temporary).unwrap(), b"user temporary");
    assert_eq!(
        serde_json::from_slice::<VocabularyFile>(&fs::read(&destination).unwrap())
            .unwrap()
            .entries
            .len(),
        1
    );

    let collision_destination = root.join("collision.json.bak");
    fs::write(&collision_destination, b"old collision target").unwrap();
    repository.export_to(&collision_destination).unwrap();
    assert_eq!(
        serde_json::from_slice::<VocabularyFile>(&fs::read(&collision_destination).unwrap())
            .unwrap()
            .entries
            .len(),
        1
    );
    let temporary_named_destination = root.join("collision.json.tmp");
    fs::write(&temporary_named_destination, b"old temporary-named target").unwrap();
    repository.export_to(&temporary_named_destination).unwrap();
    assert_eq!(
        serde_json::from_slice::<VocabularyFile>(&fs::read(&temporary_named_destination).unwrap())
            .unwrap()
            .entries
            .len(),
        1
    );
    let _ = fs::remove_dir_all(root);
}
