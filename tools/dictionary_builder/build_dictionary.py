"""Compile the official ECDICT SQLite package into Orange's independent Quick DB.

Offline, stdlib only. No inference, network, lemma.en.txt, or model calls.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

VERSION = "1.2.0"
EDGE = ' \t\r\n.,;:!?"“”‘’()[]{}<>，。；：！？'
MEANING_EDGE = EDGE.translate(str.maketrans('', '', '()[]'))
POS = {"n": "n.", "noun": "n.", "v": "v.", "vt": "v.", "vi": "v.",
       "verb": "v.", "a": "adj.", "j": "adj.", "adj": "adj.",
       "adjective": "adj.", "ad": "adv.", "adv": "adv.", "adverb": "adv.",
       "prep": "prep.", "preposition": "prep.", "phr": "phr.", "phrase": "phr."}
PREFIX = re.compile(r"^((?:(?:vt|vi|adj|adv|prep|phr|n|v|a)\.?\s*[/&]?\s*)+)\.\s*", re.I)
INFLECTION_ONLY = re.compile(r"^[A-Za-z'’-]+\s*的(?:过去式|过去分词|现在分词|复数|第三人称单数|比较级|最高级).*$")
MORPH_KIND = r"(?:过去式|过去时|过去分词|现在分词|第三人称单数|复数|比较级|最高级|变形)"
MORPH_WORD = r"[A-Za-z'’_-][A-Za-z0-9'’_-]*(?:\s+[A-Za-z][A-Za-z0-9'’_-]*)*"
MORPH_ONLY = re.compile(rf"^(?:是\s*)?[\"“‘]?{MORPH_WORD}[\"”’]?\s*的\s*{MORPH_KIND}(?:\s*(?:和|与|及|或|、|/|&)\s*{MORPH_KIND})*(?:形式|词形)?$")
PARENTHETICAL = re.compile(r"[(（]([^()（）]*)(?:[)）]|$)")


def balanced_text(value):
    """Discard unmatched bracket characters only, never their lexical content."""
    stack, matched = [], set()
    pairs = {')': '(', '）': '（', ']': '['}
    for i, char in enumerate(value):
        if char in pairs.values():
            stack.append((i, char))
        elif char in pairs and stack and stack[-1][1] == pairs[char]:
            start, _ = stack.pop()
            matched.update((start, i))
    return ''.join(c for i, c in enumerate(value)
                   if c not in '()（）[]' or i in matched)


def clean_morphology(sense, stats=None, *, trim=True):
    """Remove only fully recognized inflection redirects, never arbitrary asides."""
    def removed(key):
        if stats is not None:
            stats[key] = stats.get(key, 0) + 1
    def aside(match):
        if MORPH_ONLY.fullmatch(match[1].strip(MEANING_EDGE)):
            removed("morphology_annotations_removed")
            return ""
        return match[0]
    value = balanced_text(PARENTHETICAL.sub(aside, sense))
    if trim:
        value = value.strip(MEANING_EDGE)
    if MORPH_ONLY.fullmatch(value):
        removed("morphology_only_senses_removed")
        return ""
    return value


def surface(value):
    return unicodedata.normalize("NFC", value or "").strip(EDGE).lower()


def word_surface(value):
    value = surface(value)
    return value if value and len(value) <= 128 and not any(c.isspace() for c in value) else ""


def entry_identity(value):
    # Lexical identity is NOT a punctuation-stripped lookup alias.
    value = unicodedata.normalize("NFC", value or "").strip().lower()
    return value if value and len(value) <= 128 and not any(c.isspace() for c in value) else ""


def round_robin(groups, limit=2):
    result = []
    for i in range(max(map(len, groups), default=0)):
        for group in groups:
            if i < len(group) and group[i] not in result:
                result.append(group[i])
                if len(result) == limit:
                    return result
    return result


def normalize_entry(translation, pos, *, clean=True, limit=2, stats=None):
    groups, labels, group_keys = [], [], []
    for line in (translation or "").replace("\\n", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        if INFLECTION_ONLY.fullmatch(line):
            # Retain the legacy redirect exclusion/entry admission decision.
            if clean and stats is not None:
                stats["morphology_only_senses_removed"] = stats.get("morphology_only_senses_removed", 0) + 1
            continue
        line = re.sub(r"^\[[^\]]+\]\s*", "", line)
        if clean:
            # Clean BEFORE splitting/edge trimming so ASCII closing brackets
            # survive until morphology recognition. Freeze legacy admission below.
            line = clean_morphology(line, stats, trim=False)
        match = PREFIX.match(line)
        line_labels = []
        if match:
            for token in re.findall(r"[a-z]+", match.group(1).lower()):
                label = POS.get(token)
                if label and label not in labels:
                    labels.append(label)
                if label and label not in line_labels:
                    line_labels.append(label)
            line = line[match.end():]
        # Keep commas inside parentheses; do not split explanatory asides into senses.
        senses, chunk, depth = [], "", 0
        for char in line:
            depth += int(char in "(（[") - int(char in ")）]")
            depth = max(depth, 0)
            if char in ",，;；" and not depth:
                if chunk.strip(MEANING_EDGE if clean else EDGE):
                    senses.append(chunk.strip(MEANING_EDGE if clean else EDGE))
                chunk = ""
            else:
                chunk += char
        if chunk.strip(MEANING_EDGE if clean else EDGE):
            senses.append(chunk.strip(MEANING_EDGE if clean else EDGE))
        # Long prose is not a short Quick meaning. Never truncate into a false sense.
        if clean:
            senses = [clean_morphology(s, stats) for s in senses]
        senses = [s for s in senses if s and len(s) <= 60 and not INFLECTION_ONLY.fullmatch(s)]
        if senses:
            key = "/".join(line_labels)
            if not key and groups:
                groups[-1].extend(senses)
            elif key in group_keys:
                groups[group_keys.index(key)].extend(senses)
            else:
                groups.append(senses)
                group_keys.append(key)
    if not labels:
        for token in (pos or "").split("/"):
            label = POS.get(token.split(":")[0].strip().rstrip("."))
            if label and label not in labels:
                labels.append(label)
    frequencies = {}
    for item in (pos or "").split("/"):
        token, _, number = item.partition(":")
        label = POS.get(token)
        if label and number.isdigit():
            frequencies[label] = int(number)
    groups = [g for _, g in sorted(zip(group_keys, groups), key=lambda pair: -frequencies.get(pair[0], 0))]
    labels.sort(key=lambda label: -frequencies.get(label, 0))
    return "/".join(labels), "；".join(round_robin(groups, limit))


def exchanges(value):
    for item in (value or "").split("/"):
        key, _, values = item.partition(":")
        if key in {"0", "p", "d", "i", "3", "r", "t", "s"}:
            for form in values.split(","):
                normalized = entry_identity(form)
                if normalized:
                    yield key, normalized


def checksum(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def build(source, output, source_version="1.0.28"):
    started = time.perf_counter()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing DB: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = dict(source="ECDICT", source_version=source_version,
                  source_checksum=checksum(source), builder_version=VERSION,
                  input_rows=0, accepted_entries=0, dropped_entries=0,
                  missing_phonetic_count=0, missing_pos_count=0, missing_meaning_count=0,
                  meaning_parse_failures=0, duplicates_removed=0, excluded_phrase_rows=0,
                  morphology_annotations_removed=0, morphology_only_senses_removed=0,
                  meaning_empty_identity_rows=0)
    upstream = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
    upstream.row_factory = sqlite3.Row
    db = sqlite3.connect(output)
    db.executescript("""
        PRAGMA journal_mode=OFF;
        CREATE TABLE entries(id INTEGER PRIMARY KEY, lemma TEXT NOT NULL UNIQUE,
            phonetic TEXT NOT NULL, part_of_speech TEXT NOT NULL, meaning TEXT NOT NULL);
        CREATE TABLE forms(surface TEXT NOT NULL, entry_id INTEGER NOT NULL,
            relation TEXT NOT NULL, priority INTEGER NOT NULL,
            PRIMARY KEY(surface, entry_id), FOREIGN KEY(entry_id) REFERENCES entries(id)) WITHOUT ROWID;
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE surface_phonetics(surface TEXT PRIMARY KEY, phonetic TEXT NOT NULL) WITHOUT ROWID;
        CREATE TEMP TABLE pending(surface TEXT, lemma TEXT, relation TEXT);
        CREATE TEMP TABLE ranks(lemma TEXT PRIMARY KEY, priority INTEGER) WITHOUT ROWID;
    """)
    for row in upstream.execute("SELECT word,phonetic,translation,pos,bnc,frq,exchange FROM stardict ORDER BY id"):
        report["input_rows"] += 1
        lemma = entry_identity(row["word"])
        lookup = word_surface(row["word"])
        if not lemma or not lookup:
            report["dropped_entries"] += 1
            report["excluded_phrase_rows"] += 1
            continue
        links = list(exchanges(row["exchange"]))
        phonetic = (row["phonetic"] or "").strip()
        # Capture actual surface pronunciation even when a pure inflection has
        # no independent semantic entry. Punctuation aliases never supply IPA.
        if lemma == lookup and phonetic and len(phonetic) <= 256:
            db.execute("INSERT OR IGNORE INTO surface_phonetics VALUES(?,?)", (lookup, phonetic))
        for relation, form in links:
            if relation == "0" and form != lemma:
                db.execute("INSERT INTO pending VALUES(?,?,?)", (lookup, form, "lemma" if lookup == lemma else "alias"))
        # Freeze v1.1 entry admission and POS: cleaning must not renumber entries,
        # remove forms, alter candidate priority or pronunciation identity.
        pos, legacy_meaning = normalize_entry(row["translation"], row["pos"], clean=False, limit=3)
        _, meaning = normalize_entry(row["translation"], row["pos"], stats=report)
        if not legacy_meaning:
            report["dropped_entries"] += 1
            report["missing_meaning_count"] += 1
            if row["translation"] and not any(k == "0" for k, _ in links):
                report["meaning_parse_failures"] += 1
            continue
        report["meaning_empty_identity_rows"] += not bool(meaning)
        cursor = db.execute("INSERT OR IGNORE INTO entries(lemma,phonetic,part_of_speech,meaning) VALUES(?,?,?,?)",
                            (lemma, phonetic, pos, meaning))
        if not cursor.rowcount:
            report["duplicates_removed"] += 1
            report["dropped_entries"] += 1
            continue
        report["accepted_entries"] += 1
        report["missing_phonetic_count"] += not bool(phonetic)
        report["missing_pos_count"] += not bool(pos)
        frequencies = [int(v) for v in (row["bnc"], row["frq"]) if v and int(v) > 0]
        rank = min(frequencies, default=10000000)
        db.execute("INSERT INTO ranks VALUES(?,?)", (lemma, rank))
        db.execute("INSERT INTO pending VALUES(?,?,?)", (lookup, lemma, "exact" if lookup == lemma else "alias"))
        for relation, form in links:
            if relation != "0":
                normalized = word_surface(form)
                if normalized:
                    db.execute("INSERT INTO pending VALUES(?,?,?)", (normalized, lemma, relation if lookup == lemma else "alias"))
    db.execute("""INSERT INTO forms SELECT p.surface,e.id,min(p.relation),
        r.priority * 10 + min(CASE WHEN p.relation='exact' THEN 0 ELSE 1 END)
        FROM pending p JOIN entries e ON e.lemma=p.lemma JOIN ranks r ON r.lemma=e.lemma
        WHERE p.relation != 'alias' OR NOT EXISTS(SELECT 1 FROM entries canonical WHERE canonical.lemma=p.surface)
        GROUP BY p.surface,e.id""")
    db.execute("CREATE INDEX forms_rank ON forms(surface,priority,entry_id)")
    report["entry_count"] = db.execute("SELECT count(*) FROM entries").fetchone()[0]
    report["form_count"] = db.execute("SELECT count(*) FROM forms").fetchone()[0]
    report["forms_generated"] = report["form_count"]
    report["ambiguous_surface_count"] = db.execute("SELECT count(*) FROM (SELECT surface FROM forms GROUP BY surface HAVING count(*)>1)").fetchone()[0]
    report["punctuation_alias_links_suppressed"] = db.execute("SELECT count(*) FROM pending p JOIN entries e ON e.lemma=p.lemma WHERE p.relation='alias' AND EXISTS(SELECT 1 FROM entries canonical WHERE canonical.lemma=p.surface)").fetchone()[0]
    report["duplicate_forms_removed"] = db.execute("SELECT count(*) FROM pending p JOIN entries e ON e.lemma=p.lemma").fetchone()[0] - report["form_count"] - report["punctuation_alias_links_suppressed"]
    report["surface_phonetics_count"] = db.execute("SELECT count(*) FROM surface_phonetics").fetchone()[0]
    report["schema_version"] = "2"
    meta = dict(schema_version="2", dictionary_version=f"ecdict-{source_version}-orange-{VERSION}",
                source_name="ECDICT", source_version=source_version,
                source_checksum=report["source_checksum"],
                built_at=datetime.now(timezone.utc).isoformat(), builder_version=VERSION,
                license_notice="ECDICT MIT, Copyright (c) 2017 Linwei. See ECDICT-LICENSE.txt. lemma.en.txt excluded.",
                entry_count=str(report["entry_count"]), form_count=str(report["form_count"]),
                surface_phonetics_count=str(report["surface_phonetics_count"]))
    db.executemany("INSERT INTO meta VALUES(?,?)", meta.items())
    db.commit()
    db.execute("VACUUM")
    assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    db.close()
    upstream.close()
    report["db_size_bytes"] = output.stat().st_size
    report["build_duration_seconds"] = round(time.perf_counter() - started, 3)
    output.with_name("orange_dictionary_build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-version", default="1.0.28")
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output, args.source_version), ensure_ascii=False, indent=2))
