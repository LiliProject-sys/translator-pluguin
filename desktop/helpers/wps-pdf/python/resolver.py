"""File-side experiment: no viewer calls, coordinates, ranking or network."""
from pathlib import Path
from time import perf_counter
import re
import pymupdf


def normalize(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    # Expand typography only; do not apply NFKC to scientific symbols.
    text = text.translate(str.maketrans(dict(zip('ﬀﬁﬂﬃﬄ', ['ff', 'fi', 'fl', 'ffi', 'ffl']))))
    # Conservative evidence: only lowercase alphabetic fragments over a line break.
    # Still ambiguous for a compound broken exactly at its real hyphen: retain raw.
    text = re.sub(r'(?<=[a-z])-[ \t]*\n[ \t]*(?=[a-z])', '', text)
    return re.sub(r'\s+', ' ', text).strip()


def matches(text, target):
    target = normalize(target)
    if not target:
        raise ValueError('target must not be empty')
    # v3: exact lexical spans, including complete components beside -, U+2010,
    # U+2011. Preserve Unicode \w and apostrophes as word-internal characters.
    # Other punctuation (including en/em dash and minus) remains a delimiter;
    # normalization, target spelling and multiword span matching are unchanged.
    return list(re.finditer(r"(?<![\w'’])" + re.escape(target) + r"(?![\w'’])", text))


def sentence_spans(text):
    protected = set()
    for m in re.finditer(r'\b(?:e\.g\.|i\.e\.|et al\.|Figs?\.|Eqs?\.|etc\.)', text, re.I):
        protected.update(range(m.start(), m.end()))
    spans, start = [], 0
    for m in re.finditer(r'[.!?]+(?=\s|$)', text):
        if m.start() in protected:
            continue
        end = m.end()
        spans.append((start, end))
        start = end
        while start < len(text) and text[start].isspace():
            start += 1
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def prepare(raw_text, block_texts, words):
    start = perf_counter()
    paragraphs, chunks, offset = [], [], 0
    for raw in block_texts:
        clean = normalize(raw)
        if not clean:
            continue
        paragraphs.append({'start': offset, 'end': offset + len(clean), 'text': clean,
                           'sentences': sentence_spans(clean)})
        chunks.append(clean)
        offset += len(clean) + 2
    text = '\n\n'.join(chunks)
    return {'raw_text': raw_text, 'normalized_text': text,
            'normalized_plain_text': normalize(raw_text), 'paragraphs': paragraphs,
            'words': words, 'normalization_ms': (perf_counter() - start) * 1000}


def resolve_page(data, target):
    started = perf_counter()
    text = data['normalized_text']
    found = matches(text, target)
    search_ms = (perf_counter() - started) * 1000
    reconstruct = perf_counter()
    candidates = []
    for match in found:
        p = next(p for p in data['paragraphs'] if p['start'] <= match.start() < p['end'])
        local = match.start() - p['start']
        a, b = next((a, b) for a, b in p['sentences'] if a <= local < b)
        sentence = p['text'][a:b]
        prose = bool(re.match(r'[A-Z]', p['text']) and re.search(r'[.!?]$', p['text']))
        structural = bool(re.match(r'(?:Fig\.|TABLE|Index Terms|\[\d+\]|[IVX]+\.)', p['text']))
        # Quality is a warning heuristic, never a likelihood of actual selection.
        candidates.append({'index': len(candidates) + 1, 'start': match.start(), 'end': match.end(),
                           'boundary_match': True, 'window': text[max(0, match.start()-80):match.end()+80],
                           'sentence': sentence, 'paragraph': p['text'],
                           'sentence_quality': 'medium' if re.match(r'[A-Z]', sentence) and re.search(r'[.!?]$', sentence) else 'low',
                           'paragraph_quality': 'medium' if prose and not structural else 'low',
                           'quality_basis': 'text-only heuristic; block is not a guaranteed paragraph'})
    return {'target': target, 'occurrence_count': len(found),
            'status': 'not_found' if not found else 'unique_on_page' if len(found) == 1 else 'ambiguous',
            'candidates': candidates,
            'timing_ms': {'find': search_ms, 'reconstruct': (perf_counter()-reconstruct)*1000,
                          'resolve_total': (perf_counter()-started)*1000}}


class Resolver:
    """Single-document in-memory page cache; close explicitly. No persisted cache."""
    def __init__(self, pdf_path):
        started = perf_counter()
        self.path = str(Path(pdf_path).resolve())
        self.document = pymupdf.open(self.path)
        self.open_ms = (perf_counter()-started)*1000
        self.pages = {}

    def close(self):
        self.pages.clear()
        self.document.close()

    def page(self, number):
        if type(number) is not int or not 1 <= number <= len(self.document):
            raise ValueError('page must be a valid 1-based integer')
        if number not in self.pages:
            started = perf_counter()
            page = self.document[number - 1]
            raw = page.get_text('text', sort=False)
            # Explicitly discard all coordinate fields. Preserve content-stream order.
            words = [w[4] for w in page.get_text('words', sort=False)]
            blocks = [b[4] for b in page.get_text('blocks', sort=False) if b[6] == 0]
            extract_ms = (perf_counter()-started)*1000
            data = prepare(raw, blocks, words)
            data['extraction_ms'] = extract_ms
            self.pages[number] = data
        return self.pages[number]

    def resolve(self, page, target):
        started = perf_counter()
        hit = page in self.pages
        data = self.page(page)
        result = resolve_page(data, target)
        result.update(page=page, cache_hit=hit)
        result['timing_ms'].update(extract=0 if hit else data['extraction_ms'],
                                  normalize=0 if hit else data['normalization_ms'],
                                  total=(perf_counter()-started)*1000)
        return result
