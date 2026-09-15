"""Pure deterministic candidate decisions; no COM, files, ranking or models."""
import re
import unicodedata
from time import perf_counter
from resolver import normalize

TOKEN=re.compile(r"[^\W_]+(?:[-'’‐‑][^\W_]+)*",re.UNICODE)

def tokens(text):
    text=''.join(' ' if unicodedata.category(c).startswith('C') else c for c in normalize(text))
    return TOKEN.findall(text)

def split_local(row):
    v=row['validation'];local=v['local'];offset=v['targetOffset']
    encoded=local.encode('utf-16-le',errors='surrogatepass')
    prefix=encoded[:offset*2].decode('utf-16-le',errors='surrogatepass')
    pos=len(prefix);target=row['target']
    if local[pos:pos+len(target)]!=target:raise ValueError('local target mismatch')
    return local[:pos],local[pos+len(target):]

def char_exact(text,candidates,left,right):
    attempts=[]
    for width in (20,40,80):
        a,b=normalize(left[-width:]),normalize(right[:width])
        hits=[c['index'] for c in candidates if normalize(text[:c['start']]).endswith(a) and normalize(text[c['end']:]).startswith(b)]
        attempts.append({'width':width,'matches':len(hits),'candidateIds':hits})
        if len(hits)==1:return {'candidate':hits[0],'method':f'char_exact_{width}','attempts':attempts}
    return {'candidate':None,'method':'unresolved','attempts':attempts,
            'reason':'char_multi_match' if any(a['matches']>1 for a in attempts) else 'char_no_match'}

def token_anchor(text,candidates,target,left,right):
    if not TOKEN.fullmatch(normalize(target)):
        return {'candidate':None,'reason':'tokenization_error','signature':None}
    # Keep hyphenated targets intact. Never stem, lower-case or join control splits.
    lt=tokens(left)[-8:];rt=tokens(right)[:8]
    around={c['index']:(tokens(text[:c['start']])[-8:],tokens(text[c['end']:])[:8]) for c in candidates}
    unique={};had_match=False
    # Enumerate by total size; retain first (shortest) signature for each identity.
    # Examine remaining bounded signatures for contradictory one-sided evidence.
    for total in range(1,17):
        for l in range(min(8,total),-1,-1):
            r=total-l
            if r>8 or l>len(lt) or r>len(rt):continue
            a=lt[-l:] if l else [];b=rt[:r]
            hits=[i for i,(cl,cr) in around.items() if (not l or len(cl)>=l and cl[-l:]==a) and (not r or len(cr)>=r and cr[:r]==b)]
            had_match|=bool(hits)
            if len(hits)==1 and hits[0] not in unique:
                unique[hits[0]]={'left':a,'right':b,'leftTokenCount':l,'rightTokenCount':r}
    if len(unique)>1:return {'candidate':None,'reason':'conflict','signature':None,'conflictingCandidates':list(unique)}
    if unique:
        i=next(iter(unique));return {'candidate':i,'signature':unique[i],'reason':None}
    return {'candidate':None,'reason':'token_multi_match' if had_match else 'token_no_match','signature':None}

def decide(row,data,result,audit=False):
    started=perf_counter();cs=result['candidates'];text=data['normalized_text'];n=len(cs)
    out={'exactUnique':False,'candidateCount':n,'candidate':None,'matchedCandidate':None,
         'resolutionMethod':'unresolved','failureReason':None,'sentence':'','blockPreview':'',
         'signature':None,'attempts':[],'page':row['ranges'][0][0]+1,
         'ordinal':{'wpsOccurrenceOrdinal':None,'pymupdfCandidateOrdinal':None,'countsEqual':None,
                    'ordinalAgree':None,'reason':'full WPS PageText not supplied; acquisition unchanged'},
         'stageTimingsMs':{'unique':0,'char':0,'token':0}}
    if not row.get('validation',{}).get('match') or row.get('authorized') is False or row.get('count',1)!=1:
        out['failureReason']='other';return out
    chosen=None;method=None
    try:
        left,right=split_local(row)
        if not n:out['failureReason']='no_candidate'
        elif n==1:
            t=perf_counter();chosen=cs[0]['index'];method='unique_candidate';out['stageTimingsMs']['unique']=(perf_counter()-t)*1000
        else:
            t=perf_counter();char=char_exact(text,cs,left,right);out['stageTimingsMs']['char']=(perf_counter()-t)*1000
            out['attempts']=char['attempts'];chosen=char['candidate'];method=char['method'];out['charFailureReason']=char.get('reason')
            if chosen is None or audit:
                t=perf_counter();token=token_anchor(text,cs,row['target'],left,right);out['stageTimingsMs']['token']=(perf_counter()-t)*1000
                out['tokenEvidence']=token
                conflict=token.get('reason')=='conflict' or (chosen is not None and token['candidate'] is not None and chosen!=token['candidate'])
                if conflict:chosen=None;method='conflict';out['failureReason']='conflict'
                elif chosen is None:
                    chosen=token['candidate'];method='token_anchor' if chosen is not None else 'unresolved'
                    out['failureReason']=token.get('reason');out['signature']=token.get('signature')
                elif token['candidate']==chosen:out['signature']=token.get('signature')
        if chosen is not None:
            c=next(c for c in cs if c['index']==chosen)
            # Verify the generator's lexical contract, retaining the existing boundary policy.
            if not c.get('boundary_match') or text[c['start']:c['end']]!=normalize(row['target']):raise ValueError('candidate contract')
            out.update(exactUnique=True,candidate=chosen,matchedCandidate=chosen,resolutionMethod=method,
                       sentence=c['sentence'],blockPreview=c['paragraph'][:800],failureReason=None,
                       candidateIdentity={'page':out['page'],'index':chosen,'start':c['start'],'end':c['end'],
                                          'blockIndex':next((i+1 for i,p in enumerate(data.get('paragraphs',[])) if p['start']<=c['start']<p['end']),None)})
            out['ordinal']['pymupdfCandidateOrdinal']=chosen
        elif method=='conflict':out['resolutionMethod']='conflict'
    except (ValueError,KeyError,UnicodeError,TypeError):
        out.update(exactUnique=False,candidate=None,matchedCandidate=None,resolutionMethod='unresolved',failureReason='tokenization_error',sentence='',blockPreview='')
    out['decisionMs']=(perf_counter()-started)*1000
    return out
