"""Private JSONL resolver worker. No viewer, network, or persisted document data."""
import json
import sys
from time import perf_counter
from resolver import Resolver
from candidate_v2 import decide

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
current = None
identity = None
try:
    for line in sys.stdin:
        started = perf_counter()
        try:
            request = json.loads(line)
            if request.get('op') == 'exit':
                break
            if request['identity'] != identity:
                if current is not None:
                    current.close()
                current = None
                identity = None
                current = Resolver(request['path'])
                identity = request['identity']
            page = request['ranges'][0][0] + 1
            # One document, four pages; cache identity includes file version.
            if page not in current.pages and len(current.pages) >= 4:
                current.pages.pop(next(iter(current.pages)))
            result = current.resolve(page, request['target'])
            choice = decide(request, current.page(page), result)
            sentence = choice['sentence']
            ok = choice['exactUnique'] and 0 < len(sentence) <= 2000
            response = {'ok': bool(ok), 'text': sentence if ok else '',
                        'reason': 'resolved' if ok else 'resolver_unresolved',
                        'ms': (perf_counter() - started) * 1000}
        except Exception:
            # Never serialize raw exception text, PDF path, or entire PageText.
            response = {'ok': False, 'text': '', 'reason': 'resolver_unavailable',
                        'ms': (perf_counter() - started) * 1000}
        print(json.dumps(response, ensure_ascii=True), flush=True)
finally:
    if current is not None:
        current.close()
