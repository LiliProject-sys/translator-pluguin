import sqlite3
import tempfile
import unittest
from pathlib import Path
from build_dictionary import build, normalize_entry, surface, exchanges, clean_morphology


class BuilderTests(unittest.TestCase):
    def test_normalization(self):
        self.assertEqual(surface(' “Measurements,” '), 'measurements')
        self.assertEqual(surface("Don't"), "don't")
        self.assertEqual(surface('state-of-the-art'), 'state-of-the-art')
        self.assertEqual(surface('cafe\u0301'), 'café')

    def test_pos_meaning_groups(self):
        pos, meaning = normalize_entry('vt. 进行, 实施\nvi. 引导\nn. 行为, 举止', 'v:80/n:20')
        self.assertEqual(pos, 'v./n.')
        self.assertEqual(meaning, '进行；行为')
        self.assertEqual(normalize_entry('n. 系统, 体系\n[计] 系统', '')[1], '系统；体系')
        self.assertEqual(normalize_entry('n. 示例（包含，逗号）, 例子', '')[1], '示例（包含，逗号）；例子')
        self.assertEqual(normalize_entry('give的过去式', '')[1], '')

    def test_minimalism_and_morphology(self):
        for raw in ['extrude 的过去式和过去分词', '“give”的过去分词', 'is 的第三人称单数',
                    'word 的复数形式', 'good的比较级', 'good的最高级', 'word的变形']:
            self.assertEqual(clean_morphology(raw), '', raw)
        self.assertEqual(clean_morphology('挤压出( extrude的过去式和过去分词 )'), '挤压出')
        self.assertEqual(clean_morphology('尺寸（measurement的复数）'), '尺寸')
        for sense in ['均值（统计学）', '管口（用于喷射）', '缩写（CNN）', '（复数概念，不是词形转指）',
                      '动词（过去式表示过去事件）', '参与（take part的过去式；指共同工作）']:
            self.assertEqual(clean_morphology(sense), sense)
        self.assertEqual(normalize_entry('n. 唯一义', '')[1], '唯一义')
        self.assertEqual(normalize_entry('n. 甲, 甲, 乙, 丙', '')[1], '甲；乙')
        self.assertEqual(normalize_entry('v. extrude 的过去式和过去分词; 挤压出; 挤压成; 伸出', '')[1], '挤压出；挤压成')
        self.assertEqual(normalize_entry('v. 甲,乙\nn. 丙,丁', 'n:80/v:20'), ('n./v.', '丙；甲'))

    def test_cleaning_does_not_delete_identity_forms_or_surface_ipa(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'source.db', Path(folder)/'base.db'
            db = sqlite3.connect(source)
            db.execute('CREATE TABLE stardict(id INTEGER PRIMARY KEY,word,phonetic,translation,pos,bnc,frq,exchange)')
            db.executemany('INSERT INTO stardict VALUES(?,?,?,?,?,?,?,?)', [
                (1,'give','GIVE','v. 给, 授予','v:100',1,1,'p:gave'),
                (2,'gave','GAVE','v. （give的过去式）','v:100',2,2,'0:give'),
            ])
            db.commit(); db.close()
            report = build(source, output)
            db = sqlite3.connect(output)
            self.assertEqual(db.execute("SELECT id,meaning FROM entries WHERE lemma='gave'").fetchone(), (2,''))
            self.assertEqual(db.execute("SELECT count(*) FROM forms WHERE surface='gave'").fetchone()[0],2)
            self.assertEqual(db.execute("SELECT phonetic FROM surface_phonetics WHERE surface='gave'").fetchone()[0],'GAVE')
            self.assertEqual(report['meaning_empty_identity_rows'],1)
            self.assertEqual(report['morphology_annotations_removed'],1)
            db.close()

    def test_real_ascii_and_unbalanced_brackets(self):
        self.assertEqual(normalize_entry('v. 挤压出( extrude的过去式和过去分词 ); 挤压成; 突出; 伸出', 'j:100')[1], '挤压出；挤压成')
        self.assertEqual(normalize_entry('[n. 凶恶；厉害；残忍', '')[1], '凶恶；厉害')
        self.assertEqual(normalize_entry('n. 均值(统计学; 限定), 平均值, 中值', '')[1], '均值(统计学; 限定)；平均值')
        self.assertEqual(normalize_entry('v. 挤出(extrude的过去式', '')[1], '挤出')
        self.assertEqual(normalize_entry('n. 甲(说明,乙,丙', '')[1], '甲说明；乙')
        self.assertEqual(normalize_entry('a. organise的变形', '')[1], '')
        self.assertEqual(clean_morphology('(统计学)'), '(统计学)')

    def test_explicit_exchange_only(self):
        self.assertEqual(list(exchanges('0:give/1:p/p:gave/d:given')), [('0','give'),('p','gave'),('d','given')])

    def test_independent_schema_forms_and_report(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'upstream.db', Path(folder)/'orange.db'
            db = sqlite3.connect(source)
            db.execute('CREATE TABLE stardict(id INTEGER PRIMARY KEY,word,phonetic,translation,pos,bnc,frq,exchange)')
            db.executemany('INSERT INTO stardict VALUES(?,?,?,?,?,?,?,?)', [
                (1,'see','si:','vt. 看见, 查看','v:100',47,67,'p:saw/d:seen'),
                (2,'saw','','n. 锯子\nvt. 锯\nsee的过去式','n:75/v:25',6947,7433,'0:see/1:p'),
                (3,'give','','vt. 给','v:100',71,80,'p:gave'),
                (4,'gave','','give的过去式','',0,0,'0:give/1:p'),
                (5,'two words','','n. 词组','',0,0,''),
                (6,'unknown','','','',0,0,''),
            ])
            db.commit(); db.close()
            report = build(source, output)
            db = sqlite3.connect(output)
            self.assertEqual(report['input_rows'], 6)
            self.assertEqual(report['entry_count'], 3)
            self.assertEqual(report['ambiguous_surface_count'], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM forms WHERE surface='saw'").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT e.lemma FROM forms f JOIN entries e ON e.id=f.entry_id WHERE surface='gave'").fetchone()[0], 'give')
            self.assertEqual(db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], '2')
            self.assertGreater(report['missing_phonetic_count'], 0)
            self.assertTrue(output.with_name('orange_dictionary_build_report.json').exists())
            db.close()
            with self.assertRaises(FileExistsError): build(source, output)

    def test_identity_exact_pronunciation_and_order_independence(self):
        rows = [
            ('.use', '', '[计] MKS文件', '', 1, 1, '0:other'),
            ('other', 'OTHER', 'n. 其他', '', 1, 1, ''),
            ('use', 'ju:s', 'vt. 使用, 利用', 'v:100', 80, 80, 'p:used'),
            ('.image', 'WRONG_ALIAS', 'n. 别名', '', 1, 1, ''),
            ('image', 'IMAGE_EXACT', 'n. 图像', 'n:100', 100, 100, ''),
            ('give', 'giv', 'vt. 给', 'v:100', 70, 70, 'p:gave'),
            ('gave', 'geiv', 'give的过去式', '', 0, 0, '0:give'),
            ('see', 'si:', 'vt. 看见', '', 30, 30, 'p:saw/d:seen'),
            ('saw', 'saw-exact', 'n. 锯子', '', 100, 100, '0:see'),
            ('seen', '', 'see的过去分词', '', 0, 0, '0:see'),
            ('(wrapped)', 'ALIAS_ONLY', 'n. 包装', '', 0, 0, ''),
            ('measure', 'MEASURE', 'n. 测量', '', 0, 0, ''),
        ]
        for order in (rows, list(reversed(rows))):
            with tempfile.TemporaryDirectory() as folder:
                source, output = Path(folder)/'source.db', Path(folder)/'base.db'
                db = sqlite3.connect(source)
                db.execute('CREATE TABLE stardict(id INTEGER PRIMARY KEY,word,phonetic,translation,pos,bnc,frq,exchange)')
                db.executemany('INSERT INTO stardict VALUES(?,?,?,?,?,?,?,?)', [(i,*row) for i,row in enumerate(order)])
                db.commit(); db.close()
                build(source, output)
                db = sqlite3.connect(output)
                self.assertEqual(db.execute("SELECT count(*) FROM entries WHERE lemma IN ('.use','use','.image','image')").fetchone()[0], 4)
                for word in ('use','image'):
                    self.assertEqual(db.execute('SELECT e.lemma FROM forms f JOIN entries e ON e.id=f.entry_id WHERE surface=? ORDER BY priority,e.id LIMIT 2',(word,)).fetchall(), [(word,)])
                self.assertEqual(dict(db.execute('SELECT surface,phonetic FROM surface_phonetics'))['gave'], 'geiv')
                self.assertEqual(dict(db.execute('SELECT surface,phonetic FROM surface_phonetics'))['image'], 'IMAGE_EXACT')
                self.assertNotIn('seen', dict(db.execute('SELECT surface,phonetic FROM surface_phonetics')))
                self.assertNotIn('wrapped', dict(db.execute('SELECT surface,phonetic FROM surface_phonetics')))
                self.assertEqual(db.execute("SELECT count(*) FROM forms WHERE surface='wrapped'").fetchone()[0],1)
                self.assertEqual(db.execute("SELECT count(*) FROM forms WHERE surface='saw'").fetchone()[0],2)
                self.assertEqual(surface('measure,'), 'measure')
                db.close()


if __name__ == '__main__': unittest.main()
