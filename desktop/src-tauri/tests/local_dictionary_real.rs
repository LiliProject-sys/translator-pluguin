use orange_translator_desktop_lib::dictionary::DictionaryService;
use std::{
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[test]
#[ignore = "Requires the generated official Base DB; run explicitly for release acceptance"]
fn real_base_dictionary_samples_and_latency() {
    let folder = std::env::temp_dir().join(format!(
        "orange-real-dict-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let service = DictionaryService::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/dictionary/orange_dictionary.db"),
        folder.join("user.db"),
    );
    for word in [
        "potential",
        "measure",
        "system",
        "technical",
        "measurements",
        "gave",
        "taken",
        "saw",
        "found",
        "rose",
        "left",
        "conduct",
        "present",
        "k-means",
        "extruded",
        "computation",
        "seen",
    ] {
        let started = Instant::now();
        let resolution = service.resolve(word);
        let micros = started.elapsed().as_micros();
        let entry = resolution
            .entry
            .unwrap_or_else(|| panic!("Base MISS: {word}"));
        assert_eq!(resolution.diagnostic.quick_source, "base_dictionary");
        assert!(!resolution.diagnostic.model_fallback);
        assert!(!entry.meaning.is_empty() && entry.meaning.split('；').count() <= 2);
        if ["saw", "found", "rose", "left"].contains(&word) {
            assert!(entry.lemma.is_empty());
            assert!(resolution.diagnostic.ambiguity_merged);
        }
        if word == "gave" { assert_eq!(entry.phonetic, "geiv"); }
        if word == "taken" { assert_eq!(entry.phonetic, "'teikәn"); }
        assert!(!entry.meaning.contains("过去式") && !entry.meaning.contains("过去分词"), "{word}");
        println!(
            "{}",
            serde_json::json!({"sample":word,"lookupUs":micros,"lemma":entry.lemma,"pos":entry.part_of_speech,"meaning":entry.meaning,"candidates":resolution.diagnostic.candidate_count})
        );
    }
    // Frozen public samples only: repository tests do not require private reports.
    let audit = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dictionary_public_150.jsonl")).unwrap();
    let mut total = 0;
    let mut displayed = 0;
    let (mut one, mut two) = (0, 0);
    let mut groups = std::collections::BTreeMap::<String,(usize,usize)>::new();
    for line in audit.lines().filter(|line| line.starts_with("{\"word\":")) {
        let sample: serde_json::Value = serde_json::from_str(line).unwrap();
        let word = sample["word"].as_str().unwrap();
        let expected = sample["source_phonetic_raw"].as_str().unwrap_or("").trim();
        let result = service.resolve(word);
        assert_eq!(result.diagnostic.quick_source, "base_dictionary", "{word}");
        let entry = result.entry.unwrap();
        assert_eq!(entry.phonetic, expected, "exact surface {word}");
        let meanings = entry.meaning.split('；').count();
        assert!(!entry.meaning.is_empty() && meanings <= 2, "{word}");
        one += usize::from(meanings == 1);
        two += usize::from(meanings == 2);
        total += 1;
        displayed += usize::from(!entry.phonetic.is_empty());
        let group = groups.entry(sample["group"].as_str().unwrap().into()).or_default();
        group.0 += 1;
        group.1 += usize::from(!entry.phonetic.is_empty());
    }
    assert_eq!(total,150);
    assert_eq!(displayed,128);
    println!("audit150 total={total} displayed={displayed} groups={groups:?}");
    println!("minimalism150 one={one} two={two} over_two=0");
    let use_entry = service.resolve("use").entry.unwrap();
    assert_eq!(use_entry.lemma, "use");
    assert_eq!(use_entry.phonetic, "ju:s");
    assert!(use_entry.meaning.contains("使用") && !use_entry.meaning.contains("MKS"));
    assert_eq!(service.resolve("image").entry.unwrap().phonetic, "'imidʒ");
    for word in ["organisational", "confusingly", "pleaser"] {
        let miss = service.resolve(word);
        assert!(miss.entry.is_none(), "morphology-only {word}");
        assert!(miss.diagnostic.model_fallback);
        assert!(miss.diagnostic.errors.is_empty());
    }
    let mut times = Vec::new();
    for _ in 0..200 {
        let t = Instant::now();
        assert!(service.resolve("measure").entry.is_some());
        times.push(t.elapsed().as_micros());
    }
    times.sort();
    println!(
        "warmLookupUs p50={} p95={} max={}",
        times[100], times[190], times[199]
    );
    assert!(service
        .resolve("orangelexicalmissfixturexyz")
        .entry
        .is_none());
    drop(service);
    std::fs::remove_dir_all(folder).unwrap();
}
