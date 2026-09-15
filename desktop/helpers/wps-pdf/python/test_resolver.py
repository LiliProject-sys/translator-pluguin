import unittest
from unittest.mock import Mock, patch
from resolver import Resolver, normalize, prepare, resolve_page, sentence_spans


class ResolverTests(unittest.TestCase):
    def test_whitespace_and_ligatures(self):
        self.assertEqual(normalize('  afﬁnity\r\n\t model\u00a0 '), 'affinity model')

    def test_dehyphenation(self):
        self.assertEqual(normalize('segmen-\ntation state-of-the-art'), 'segmentation state-of-the-art')

    def test_exact_boundary_and_case(self):
        d = prepare('', ['model models pre-model model-based model’s Model model.'], [])
        # v3 also accepts pre-[model] and [model]-based, not model’s/models.
        self.assertEqual(resolve_page(d, 'model')['occurrence_count'], 4)

    def test_ambiguous_all_candidates(self):
        d = prepare('', ['A model works. Another model fails!'], [])
        r = resolve_page(d, 'model')
        self.assertEqual(r['status'], 'ambiguous')
        self.assertEqual(len(r['candidates']), 2)
        self.assertEqual(r['candidates'][1]['sentence'], 'Another model fails!')
        for c in r['candidates']:
            self.assertEqual(d['normalized_text'][c['start']:c['end']], 'model')

    def test_abbreviations_decimal(self):
        t = 'A model, e.g. Eq. 2 and Fig. 3, costs 1.5 units. Next!'
        self.assertEqual(len(sentence_spans(t)), 2)

    def test_paragraph_boundaries_and_raw(self):
        d = prepare('raw\ntext', ['First model.', 'A system.'], [])
        self.assertEqual(d['raw_text'], 'raw\ntext')
        self.assertEqual(resolve_page(d, 'model')['candidates'][0]['paragraph'], 'First model.')
        self.assertEqual(resolve_page(d, 'system')['status'], 'unique_on_page')

    def test_absent_empty(self):
        self.assertEqual(resolve_page(prepare('', [], []), 'model')['status'], 'not_found')
        with self.assertRaises(ValueError):
            resolve_page(prepare('', [], []), ' ')

    def test_fragment_quality(self):
        r = resolve_page(prepare('', ['the model is unfinished'], []), 'model')
        self.assertEqual(r['candidates'][0]['sentence_quality'], 'low')

    def test_cache_page_conversion_and_coordinates_discarded(self):
        page = Mock()
        # Coordinate sentinels cannot be used as numbers or compared for sorting.
        coord = object()
        page.get_text.side_effect = ['A model.', [(coord, coord, coord, coord, 'model', 0, 0, 0)],
                                    [(coord, coord, coord, coord, 'A model.', 0, 0)]]
        doc = Mock()
        doc.__len__ = Mock(return_value=14)
        doc.__getitem__ = Mock(return_value=page)
        with patch('resolver.pymupdf.open', return_value=doc):
            r = Resolver('public.pdf')
            self.assertFalse(r.resolve(10, 'model')['cache_hit'])
            self.assertTrue(r.resolve(10, 'missing')['cache_hit'])
            doc.__getitem__.assert_called_once_with(9)
            self.assertEqual(page.get_text.call_count, 3)
            for invalid in (0, 15, True, '10'):
                with self.assertRaises(ValueError):
                    r.resolve(invalid, 'model')
            r.close()
            doc.close.assert_called_once()
            self.assertEqual(r.pages, {})

    def test_academic_abbreviations(self):
        for prefix in ('e.g.', 'i.e.', 'et al.', 'Fig.', 'Eq.', 'etc.'):
            with self.subTest(prefix=prefix):
                self.assertEqual(len(sentence_spans('See ' + prefix + ' model. Done.')), 2)


if __name__ == '__main__':
    unittest.main()
