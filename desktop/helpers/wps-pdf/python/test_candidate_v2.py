"""Synthetic contracts are not accuracy ground truth for recorded selections."""
import unittest
from unittest.mock import patch
from candidate_v2 import decide, tokens
from resolver import prepare, resolve_page

def case(blocks,local,target='word',audit=False):
    data=prepare('\n'.join(blocks),blocks,[])
    row={'authorized':True,'count':1,'ranges':[[0,0,0]],'target':target,
         'validation':{'match':True,'local':local,'targetOffset':len(local[:local.index(target)].encode('utf-16-le'))//2}}
    return decide(row,data,resolve_page(data,target),audit)

class CandidateTests(unittest.TestCase):
    def test_unique_without_context(self):
        self.assertEqual(case(['Only word here.'],'alien word elsewhere')['resolutionMethod'],'unique_candidate')
    def test_char_preserved(self):
        self.assertEqual(case(['Alpha word beta.','Other word gamma.'],'Alpha word beta.')['resolutionMethod'],'char_exact_20')
    def test_token_recovery(self):
        r=case(['Alpha word beta.','Other word gamma.'],'Alpha, word; beta.')
        self.assertEqual((r['resolutionMethod'],r['candidate']),('token_anchor',1))
        self.assertEqual(r['signature']['leftTokenCount']+r['signature']['rightTokenCount'],1)
    def test_multi_unresolved(self):
        r=case(['Alpha word beta.','Alpha word beta.'],'word')
        self.assertFalse(r['exactUnique']);self.assertEqual(r['failureReason'],'token_no_match')
    def test_token_multi(self):
        r=case(['Alpha word beta.','Alpha word beta.'],'Alpha, word; beta.')
        self.assertEqual(r['failureReason'],'token_multi_match')
    def test_char_token_conflict_audit(self):
        # Fault-inject independent evidence to exercise the defensive audit branch.
        with patch('candidate_v2.token_anchor',return_value={'candidate':2,'reason':None,'signature':None}):
            r=case(['Alpha word beta.','Other word gamma.'],'Alpha word beta.',audit=True)
            self.assertEqual(r['failureReason'],'conflict');self.assertFalse(r['exactUnique'])
    def test_live_char_short_circuit(self):
        with patch('candidate_v2.token_anchor',side_effect=AssertionError('must not run')):
            self.assertTrue(case(['Alpha word beta.','Other word gamma.'],'Alpha word beta.')['exactUnique'])
    def test_one_side(self):
        r=case(['Alpha word beta.','Other word gamma.'],'Alpha, word missing')
        self.assertEqual(r['candidate'],1);self.assertEqual(r['signature']['rightTokenCount'],0)
    def test_opposing_sides_conflict(self):
        r=case(['Alpha word beta.','Other word gamma.'],'Alpha, word; gamma.')
        self.assertEqual(r['failureReason'],'conflict')
    def test_hyphen(self):
        self.assertEqual(tokens('over-segmentation'),['over-segmentation'])
        r=case(['Alpha over-segmentation beta.','Other over-segmentation gamma.'],'Alpha, over-segmentation;',target='over-segmentation')
        self.assertEqual(r['candidate'],1)
        # Generator v3 accepts a complete component; v2 decision is unchanged.
        self.assertEqual(case(['over-segmentation'],'segmentation',target='segmentation')['resolutionMethod'],'unique_candidate')
    def test_whitespace(self):
        self.assertEqual(tokens('a\n b\t c'),['a','b','c'])
        self.assertEqual(case(['Alpha word beta.','Other word gamma.'],'Alpha\n word\t beta.')['candidate'],1)
    def test_control_separator(self):
        self.assertEqual(tokens('ab\x00cd'),['ab','cd'])
        self.assertEqual(case(['Alpha word beta.','Other word gamma.'],'Alpha\x00 word; beta.')['candidate'],1)
    def test_figure_identity(self):
        blocks=['Fig. 17. Comparison word results.','Fig. 18. Comparison word results.']
        a=case(blocks,blocks[0]);b=case(blocks,blocks[1])
        self.assertEqual(a['sentence'],b['sentence'])
        self.assertNotEqual(a['candidateIdentity'],b['candidateIdentity'])
        self.assertEqual([a['candidate'],b['candidate']],[1,2])
    def test_utf16(self):
        self.assertEqual(case(['Alpha word beta.','Other word gamma.'],'😀 Alpha, word; beta.')['candidate'],1)
    def test_ordinal_unknown(self):
        self.assertIsNone(case(['word'],'word')['ordinal']['wpsOccurrenceOrdinal'])

if __name__=='__main__':unittest.main()
