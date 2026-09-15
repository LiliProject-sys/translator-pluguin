"""Exact lexical spans: components are legal, arbitrary fragments are not."""
import unittest
from resolver import matches


class BoundaryContract(unittest.TestCase):
    def test_whole_word(self):
        self.assertEqual(len(matches('segmentation', 'segmentation')), 1)

    def test_right_component(self):
        self.assertEqual(len(matches('over-segmentation', 'segmentation')), 1)

    def test_linear_component(self):
        self.assertEqual(len(matches('non-linear', 'linear')), 1)

    def test_middle_component(self):
        self.assertEqual(len(matches('state-of-the-art', 'the')), 1)

    def test_full_compound(self):
        self.assertEqual(len(matches('k-means', 'k-means')), 1)

    def test_multiword(self):
        self.assertEqual(len(matches('An adaptive morphological reconstruction method',
                                     'adaptive morphological reconstruction')), 1)

    def test_internal_character(self):
        self.assertFalse(matches('segmentation', 't'))

    def test_suffix_fragment(self):
        self.assertFalse(matches('segmentations', 'tions'))

    def test_internal_e(self):
        self.assertFalse(matches('the', 'e'))

    def test_prefix_fragment(self):
        self.assertFalse(matches('combination', 'c'))

    def test_partial_multiword(self):
        self.assertFalse(matches('the seeded segmentation', 'e seeded s'))

    def test_dataset_boundary(self):
        self.assertFalse(matches('BSDS500.', 'SDS500.'))
        self.assertEqual(len(matches('BSDS500.', 'BSDS500.')), 1)

    def test_supported_hyphens(self):
        for hyphen in '-‐‑':
            with self.subTest(hyphen=hyphen):
                self.assertEqual(len(matches('non'+hyphen+'linear', 'linear')), 1)

    def test_existing_punctuation_delimiters(self):
        for delimiter in '–—−':
            self.assertEqual(len(matches('non'+delimiter+'linear', 'linear')), 1)

    def test_word_internal_characters_preserved(self):
        for text in ('models', 'model2', 'model_name', "model's", 'model’s', 'émodel'):
            self.assertFalse(matches(text, 'model'))

    def test_case_sensitive(self):
        self.assertFalse(matches('Model', 'model'))

    def test_multiword_cut_edges(self):
        self.assertFalse(matches('preadaptive morphological reconstructions',
                                 'adaptive morphological reconstruction'))


if __name__ == '__main__':
    unittest.main()
