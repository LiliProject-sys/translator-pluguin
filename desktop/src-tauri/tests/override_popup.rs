use orange_translator_desktop_lib::{
    app_state::{AppState, CandidateType, ContextCaptureSnapshot, ContextStatus, LatestGatewayTarget,
        RequestType, WordDetailResult, LiveDetailPhase, GatewayParsedResult, PopupTranslationResult},
    dictionary::{DictionaryService, LocalDictionaryEntry, apply_quick_success},
    gateway::build_detail_language_request,
    host_adapter::SelectionRuntimeState,
    selection_bridge::QuickBinding,
    vocabulary::VocabularyRepository,
};
use rusqlite::Connection;
use std::{path::PathBuf, time::{SystemTime, UNIX_EPOCH, Instant}};

fn fields(meaning: &str) -> LocalDictionaryEntry {
    LocalDictionaryEntry { lemma: String::new(), phonetic: String::new(), part_of_speech: "n./v.".into(), meaning: meaning.into() }
}
struct Fixture { service: DictionaryService, dir: PathBuf }
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("orange-override-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Connection::open(dir.join("base.db")).unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('schema_version','2'),('dictionary_version','fixture');
            CREATE TABLE entries(id INTEGER,lemma TEXT,phonetic TEXT,part_of_speech TEXT,meaning TEXT);
            INSERT INTO entries VALUES(1,'feedstock','LEMMA','n.','BASE'),(2,'caxton','LEMMA','n.','PERSON');
            CREATE TABLE forms(surface TEXT,entry_id INTEGER,priority INTEGER);
            INSERT INTO forms VALUES('feedstock',1,0),('caxton',2,0);
            CREATE TABLE surface_phonetics(surface TEXT PRIMARY KEY,phonetic TEXT);
            INSERT INTO surface_phonetics VALUES('feedstock','EXACT_IPA'),('caxton','CAXTON_IPA');").unwrap();
        Self { service: DictionaryService::new(dir.join("base.db"),dir.join("user.db")), dir }
    }
}
// Close SQLite handles before cleaning the uniquely created test directory.
fn cleanup(f: Fixture) { let dir = f.dir.clone(); drop(f); std::fs::remove_dir_all(dir).unwrap(); }

fn ready(state: &AppState, capture: u64, word: &str) -> (LatestGatewayTarget, String) {
    state.begin_external_capture(CandidateType::DoubleClick,capture,"Fixture".into(),1).unwrap();
    let runtime: SelectionRuntimeState = serde_json::from_value(serde_json::json!({
        "status":"OK","reason":"resolved","timingMs":{},"snapshot":{
            "snapshotId":format!("fixture-{capture}"),"capturedAt":"fixture",
            "host":{"adapterId":"wps-pdf","appKind":"wps-pdf"},
            "target":{"text":word},"document":{"documentId":"a".repeat(64),"title":"fixture.pdf"},
            "occurrence":{"kind":"wps-pdf-range","pageIndex":0,"startIndex":0,"endIndex":7},
            "context":{"text":"A public fixture sentence.","source":"pymupdf-sentence","quality":"exact"}
        }})).unwrap();
    let mut context = ContextCaptureSnapshot::empty(ContextStatus::Unsupported);
    context.context_sentence = "A public fixture sentence.".into();
    let target = LatestGatewayTarget {
        binding: Some(QuickBinding { snapshot: runtime.snapshot.unwrap(),mouse_x:10,mouse_y:20,
            capture_epoch:state.capture_epoch(),ready_at:Instant::now() }),
        target:word.into(),request_type:RequestType::WordAnalysis,page_title:String::new(),source_app:"fixture".into(),
        capture_generation:capture,translation_generation:state.next_translation_generation(),captured_at_unix_ms:1,
        context,translation_mode:state.translation_mode().unwrap(),
    };
    state.set_latest_gateway_target(target.clone()).unwrap();
    let claim = state.claim_new_live_gateway_request(&target).unwrap().unwrap();
    (target,claim.request_id)
}
fn quick(state: &AppState, target: &LatestGatewayTarget, id: &str, meaning: &str, source: &str) {
    let result = fields(meaning).display(&target.target,source,"fixture");
    state.update_gateway_test_state_for_live_request(id,target.translation_generation,|g| apply_quick_success(g,&result,None,0)).unwrap().unwrap();
    state.prepare_live_detail(target,id).unwrap();
}

#[test]
fn exact_lexical_priority_case_and_base_bytes_are_preserved() {
    let f=Fixture::new(); let before=std::fs::read(f.dir.join("base.db")).unwrap();
    for word in ["CAxTON","CNN","FDM","PLA","ViT","ResNet","OpenAI","GPT-5","YOLOv8"] {
        f.service.set_override(word,&fields("EXACT")).unwrap();
        assert_eq!(f.service.resolve(word).entry.unwrap().meaning,"EXACT");
        assert_ne!(f.service.resolve(&word.to_lowercase()).entry.map(|e|e.meaning),Some("EXACT".into()));
    }
    for word in ["Caxton","caxton"] { assert_eq!(f.service.resolve(word).entry.unwrap().meaning,"PERSON"); }
    f.service.set_override("feedstock",&fields("LEXICAL")).unwrap();
    for word in ["feedstock","Feedstock"] { assert_eq!(f.service.resolve(word).entry.unwrap().meaning,"LEXICAL"); }
    assert!(f.service.resolve("feedstocks").entry.is_none());
    f.service.set_override("Potential",&fields("TITLE")).unwrap();
    assert_eq!(f.service.resolve("potential").entry.unwrap().meaning,"TITLE");
    f.service.remove_override("Feedstock").unwrap();
    let base=f.service.resolve("feedstock").entry.unwrap();
    assert_eq!(base.meaning,"BASE"); assert_eq!(base.phonetic,"EXACT_IPA");
    assert_eq!(before,std::fs::read(f.dir.join("base.db")).unwrap());
    assert!(!f.service.resolve("absent").diagnostic.generated_cache_enabled);
    cleanup(f);
}

#[test]
fn legacy_migration_preserves_rows_generated_and_exact_coexistence() {
    let f=Fixture::new();
    let db=Connection::open(f.dir.join("user.db")).unwrap();
    db.execute_batch("CREATE TABLE user_overrides(surface TEXT PRIMARY KEY,lemma TEXT NOT NULL,phonetic TEXT NOT NULL,part_of_speech TEXT NOT NULL,meaning TEXT NOT NULL,updated_at TEXT NOT NULL);
        INSERT INTO user_overrides VALUES('caxton','','','','LEGACY','old');
        CREATE TABLE generated_entries(surface TEXT PRIMARY KEY,lemma TEXT,phonetic TEXT,part_of_speech TEXT,meaning TEXT,created_at TEXT,last_used_at TEXT,hit_count INTEGER,source_profile TEXT,skill_version TEXT);
        INSERT INTO generated_entries VALUES('ghost','','','','GENERATED','old','old',2,'fixture','fixture'); PRAGMA user_version=1;").unwrap();
    assert_eq!(f.service.get_override("Caxton").unwrap().unwrap().meaning,"LEGACY");
    f.service.set_override("CAxTON",&fields("EXACT")).unwrap();
    assert_eq!(f.service.resolve("CAxTON").entry.unwrap().meaning,"EXACT");
    assert_eq!(f.service.resolve("Caxton").entry.unwrap().meaning,"LEGACY");
    f.service.remove_override("CAxTON").unwrap();
    assert_eq!(f.service.get_override("caxton").unwrap().unwrap().meaning,"LEGACY");
    assert_eq!(db.query_row("PRAGMA user_version",[],|r|r.get::<_,u32>(0)).unwrap(),2);
    assert_eq!(db.query_row("SELECT hit_count FROM generated_entries",[],|r|r.get::<_,u32>(0)).unwrap(),2);
    assert!(f.service.resolve("ghost").entry.is_none());
    assert_eq!(db.query_row("SELECT updated_at FROM user_overrides",[],|r|r.get::<_,String>(0)).unwrap(),"old");
    drop(db);cleanup(f);
}

#[test]
fn validation_and_sql_error_do_not_overwrite_current_quick() {
    let f=Fixture::new();let state=AppState::default();let (target,id)=ready(&state,1,"feedstock");
    quick(&state,&target,&id,"ORIGINAL","base_dictionary");
    let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
    for invalid in [fields("  "),fields(&"x".repeat(301))] {
        assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(invalid)).is_err());
        assert!(f.service.get_override("feedstock").unwrap().is_none());
    }
    let db=Connection::open(f.dir.join("user.db")).unwrap(); db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("NEW"))).is_err());
    db.execute_batch("ROLLBACK").unwrap();drop(db);
    assert_eq!(state.current_vocabulary_candidate(target.translation_generation,&id).unwrap().unwrap().meaning,"ORIGINAL");
    let mut valid=fields(" TRIMMED ");valid.part_of_speech.clear();
    state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(valid)).unwrap();
    let saved=f.service.get_override("feedstock").unwrap().unwrap();
    assert_eq!(saved.meaning,"TRIMMED");assert!(saved.phonetic.is_empty()&&saved.part_of_speech.is_empty());
    cleanup(f);
}

#[test]
fn detail_prefill_save_immediate_vocabulary_restore_and_sentinel_isolation_all_modes() {
    use orange_translator_desktop_lib::settings::TranslationMode;
    for mode in [TranslationMode::UltraFast,TranslationMode::Fast,TranslationMode::Precise] {
        let f=Fixture::new();let state=AppState::default();state.set_translation_mode(mode).unwrap();
        let (target,id)=ready(&state,1,"CAxTON");quick(&state,&target,&id,"PERSON","base_dictionary");
        let before=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        assert_eq!(before.fields.meaning,"PERSON");
        let detail=state.claim_live_detail(target.translation_generation,&id).unwrap().unwrap();
        state.complete_live_detail(target.translation_generation,&id,&detail.detail_request_id,Ok(WordDetailResult {meaning_in_sentence:"CONTEXT_REFERENCE".into(),comparison:None})).unwrap();
        assert!(f.service.get_override("CAxTON").unwrap().is_none());
        let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        assert_eq!(edit.fields.meaning,"CONTEXT_REFERENCE");assert!(!edit.has_override);
        assert!(state.commit_override_edit(target.translation_generation,&id,before.session_id,&f.service,Some(fields("STALE"))).is_err());
        let result=state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("BANANA_SENTINEL"))).unwrap().unwrap();
        assert!(matches!(result,PopupTranslationResult::Word { meaning,.. } if meaning=="BANANA_SENTINEL"));
        assert_eq!(state.live_detail_phase(),LiveDetailPhase::Success);
        let request=build_detail_language_request(&detail.target,detail.detail_request_id.clone()).unwrap();
        assert_eq!(request.mode,mode);assert_eq!(request.text,"CAxTON");
        assert!(!serde_json::to_string(&request).unwrap().contains("BANANA_SENTINEL"));
        assert_eq!(state.gateway_test_state().unwrap().request_id.as_deref(),Some(id.as_str()));
        let candidate=state.current_vocabulary_candidate(target.translation_generation,&id).unwrap().unwrap();
        assert_eq!(candidate.meaning,"BANANA_SENTINEL");assert_eq!(candidate.detail.as_ref().unwrap().meaning_in_sentence,"CONTEXT_REFERENCE");
        let vocab=VocabularyRepository::new(f.dir.join("vocabulary.json"));vocab.upsert(candidate).unwrap();
        let vocab_id=vocab.load().unwrap().entries[0].id.clone();
        vocab.delete(&vocab_id).unwrap();
        assert_eq!(f.service.get_override("CAxTON").unwrap().unwrap().meaning,"BANANA_SENTINEL");
        vocab.upsert(state.current_vocabulary_candidate(target.translation_generation,&id).unwrap().unwrap()).unwrap();
        let reopen=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        assert!(reopen.has_override);assert_eq!(reopen.fields.meaning,"BANANA_SENTINEL");
        let restored=state.commit_override_edit(target.translation_generation,&id,reopen.session_id,&f.service,None).unwrap().unwrap();
        assert!(matches!(restored,PopupTranslationResult::Word{meaning,phonetic,..} if meaning=="PERSON"&&phonetic=="CAXTON_IPA"));
        assert_eq!(vocab.load().unwrap().entries[0].meaning,"BANANA_SENTINEL");
        assert!(f.service.get_override("CAxTON").unwrap().is_none());
        cleanup(f);
    }
}

#[test]
fn new_capture_same_word_pause_resume_and_request_mismatch_reject_before_write() {
    for action in 0..4 {
        let f=Fixture::new();let state=AppState::default();let (target,id)=ready(&state,1,"feedstock");
        quick(&state,&target,&id,"BASE","base_dictionary");
        let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        match action {
            0=>{state.begin_external_capture(CandidateType::Drag,2,String::new(),1).unwrap();},
            1=>{let (b,bid)=ready(&state,2,"feedstock");quick(&state,&b,&bid,"BASE","base_dictionary");},
            2=>{state.set_auto_translate(false).unwrap();state.set_auto_translate(true).unwrap();},
            _=>{},
        }
        let request=if action==3 {"wrong"} else {&id};
        assert!(state.commit_override_edit(target.translation_generation,request,edit.session_id,&f.service,Some(fields("WRONG"))).is_err());
        assert!(f.service.get_override("feedstock").unwrap().is_none());
        cleanup(f);
    }
}

#[test]
fn base_miss_restore_reuses_only_same_snapshot_original_and_never_override() {
    for initial_override in [false,true] {
        let f=Fixture::new();let state=AppState::default();let (target,id)=ready(&state,1,"unlisted");
        if initial_override {f.service.set_override("unlisted",&fields("OLD_OVERRIDE")).unwrap();}
        quick(&state,&target,&id,"ORIGINAL",if initial_override {"user_override"} else {"model"});
        let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("NEW_OVERRIDE"))).unwrap();
        let reopened=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
        let restored=state.commit_override_edit(target.translation_generation,&id,reopened.session_id,&f.service,None).unwrap();
        if initial_override {assert!(restored.is_none());} else {
            assert!(matches!(restored,Some(PopupTranslationResult::Word{meaning,..}) if meaning=="ORIGINAL"));
        }
        assert!(f.service.get_override("unlisted").unwrap().is_none());
        assert_eq!(state.gateway_test_state().unwrap().request_id.as_deref(),Some(id.as_str()));
        cleanup(f);
    }
}

#[test]
fn pending_detail_can_complete_after_save_without_modifying_override() {
    let f=Fixture::new();let state=AppState::default();let (target,id)=ready(&state,1,"feedstock");
    quick(&state,&target,&id,"BASE","base_dictionary");
    let detail=state.claim_live_detail(target.translation_generation,&id).unwrap().unwrap();
    let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
    state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("MANUAL"))).unwrap();
    state.complete_live_detail(target.translation_generation,&id,&detail.detail_request_id,Ok(WordDetailResult {meaning_in_sentence:"LATE_DETAIL".into(),comparison:None})).unwrap();
    assert_eq!(f.service.get_override("feedstock").unwrap().unwrap().meaning,"MANUAL");
    assert!(matches!(state.gateway_test_state().unwrap().parsed_result,Some(GatewayParsedResult::Word{meaning,..}) if meaning=="MANUAL"));
    cleanup(f);
}

#[test]
fn restoring_exact_preserves_existing_lexical_and_displays_real_next_lookup() {
    let f=Fixture::new();f.service.set_override("caxton",&fields("LEXICAL")).unwrap();
    f.service.set_override("CAxTON",&fields("EXACT")).unwrap();
    let state=AppState::default();let (target,id)=ready(&state,1,"CAxTON");quick(&state,&target,&id,"EXACT","user_override");
    let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
    let restored=state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,None).unwrap().unwrap();
    assert!(matches!(restored,PopupTranslationResult::Word{meaning,..} if meaning=="LEXICAL"));
    assert_eq!(f.service.resolve("CAxTON").entry.unwrap().meaning,"LEXICAL");
    assert_eq!(f.service.resolve("Caxton").entry.unwrap().meaning,"LEXICAL");
    cleanup(f);
}

#[test]
fn restore_miss_keeps_pending_detail_independent_and_forbids_stale_vocabulary() {
    let f=Fixture::new();f.service.set_override("unlisted",&fields("OVERRIDE")).unwrap();
    let state=AppState::default();let (target,id)=ready(&state,1,"unlisted");quick(&state,&target,&id,"OVERRIDE","user_override");
    let claim=state.claim_live_detail(target.translation_generation,&id).unwrap().unwrap();
    let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
    assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,None).unwrap().is_none());
    assert!(state.current_vocabulary_candidate(target.translation_generation,&id).unwrap().is_none());
    assert!(state.is_current_live_detail(target.translation_generation,&id,&claim.detail_request_id));
    assert!(state.complete_live_detail(target.translation_generation,&id,&claim.detail_request_id,Err(())).unwrap().is_some());
    let retry=state.claim_live_detail_retry(target.translation_generation,&claim.detail_request_id).unwrap().unwrap();
    assert!(state.complete_live_detail(target.translation_generation,&id,&retry.detail_request_id,Ok(WordDetailResult{meaning_in_sentence:"INDEPENDENT".into(),comparison:None})).unwrap().is_some());
    assert_eq!(state.live_detail_phase(),LiveDetailPhase::Success);
    assert!(f.service.get_override("unlisted").unwrap().is_none());
    cleanup(f);
}

#[test]
fn same_generation_new_snapshot_and_failed_restore_are_safe() {
    let f=Fixture::new();f.service.set_override("feedstock",&fields("OVERRIDE")).unwrap();
    let state=AppState::default();let (target,id)=ready(&state,1,"feedstock");quick(&state,&target,&id,"OVERRIDE","user_override");
    let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
    let db=Connection::open(f.dir.join("user.db")).unwrap();db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,None).is_err());
    db.execute_batch("ROLLBACK").unwrap();drop(db);
    assert_eq!(state.current_vocabulary_candidate(target.translation_generation,&id).unwrap().unwrap().meaning,"OVERRIDE");
    assert_eq!(f.service.get_override("feedstock").unwrap().unwrap().meaning,"OVERRIDE");
    let mut replacement=target.clone();
    let mut snapshot=serde_json::to_value(&replacement.binding.as_ref().unwrap().snapshot).unwrap();
    snapshot["snapshotId"]=serde_json::json!("different-occurrence");
    replacement.binding.as_mut().unwrap().snapshot=serde_json::from_value(snapshot).unwrap();
    state.set_latest_gateway_target(replacement).unwrap();
    assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("WRONG"))).is_err());
    assert_eq!(f.service.get_override("feedstock").unwrap().unwrap().meaning,"OVERRIDE");
    cleanup(f);
}

#[test]
fn failed_migration_rolls_back_and_future_schema_is_not_downgraded() {
    for future in [false,true] {
        let f=Fixture::new();let db=Connection::open(f.dir.join("user.db")).unwrap();
        if future { db.execute_batch("PRAGMA user_version=99; CREATE TABLE keep_me(value TEXT); INSERT INTO keep_me VALUES('KEEP');").unwrap(); }
        else {db.execute_batch("PRAGMA user_version=1; CREATE TABLE user_overrides(surface TEXT PRIMARY KEY,meaning TEXT); INSERT INTO user_overrides VALUES('word','KEEP');").unwrap();}
        assert!(f.service.get_override("word").is_err());
        assert_eq!(db.query_row("PRAGMA user_version",[],|r|r.get::<_,u32>(0)).unwrap(),if future {99}else{1});
        let sql=if future {"SELECT value FROM keep_me"} else {"SELECT meaning FROM user_overrides"};
        assert_eq!(db.query_row(sql,[],|r|r.get::<_,String>(0)).unwrap(),"KEEP");
        drop(db);cleanup(f);
    }
}

#[test]
fn concurrent_save_and_capture_or_pause_have_only_atomic_outcomes() {
    use std::sync::{Arc, Barrier};
    for pause in [false,true] {
        for _ in 0..24 {
            let f=Fixture::new();let state=Arc::new(AppState::default());
            let (target,id)=ready(&state,1,"feedstock");quick(&state,&target,&id,"BASE","base_dictionary");
            let edit=state.begin_override_edit(target.translation_generation,&id,&f.service).unwrap();
            let barrier=Arc::new(Barrier::new(2));
            let outcome=std::thread::scope(|threads| {
                let s=&state;let d=&f.service;let b=barrier.clone();let id=&id;
                let saver=threads.spawn(move||{b.wait();s.commit_override_edit(target.translation_generation,id,edit.session_id,d,Some(fields("CONFIRMED")))});
                let s=&state;let b=barrier.clone();
                let invalidate=threads.spawn(move||{b.wait();if pause {s.set_auto_translate(false).unwrap();}else{s.begin_external_capture(CandidateType::Drag,2,String::new(),1).unwrap();}});
                let outcome=saver.join().unwrap();invalidate.join().unwrap();outcome
            });
            assert_eq!(f.service.get_override("feedstock").unwrap().is_some(),outcome.is_ok());
            // Once the invalidation has completed, no stale write can follow it.
            assert!(state.commit_override_edit(target.translation_generation,&id,edit.session_id,&f.service,Some(fields("STALE"))).is_err());
            if let Some(saved)=f.service.get_override("feedstock").unwrap(){assert_eq!(saved.meaning,"CONFIRMED");}
            cleanup(f);
        }
    }
}
