#!/usr/bin/env python3
"""Check static public artifacts against the real analysis engine."""
from pathlib import Path
import hashlib, json, re, sys, tempfile, unittest
from unittest.mock import patch, Mock
from urllib.parse import urlsplit
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'tools'))
from build_site import build, build_cloud, QUESTIONS
from core.engine import analyze, ask
class PublicSiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='courtlens-pages-')
        cls.out=Path(cls.tmp.name)/'site-dist'
        cls.bundle=build(cls.out)
        cls.original=json.loads((ROOT/'data/demo.json').read_text())
    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()
    def test_analysis_is_the_actual_engine_output(self):
        for audience in ('fan','analyst'):
            self.assertEqual(self.bundle['analyses'][audience],analyze(self.original,audience))
    def test_every_answer_is_actual_engine_output(self):
        for audience in ('fan','analyst'):
            for p in self.original['possessions']:
                for key,q in QUESTIONS.items():
                    self.assertEqual(self.bundle['answers'][audience][p['id']][key],ask(self.original,q,p['id'],audience))
    def test_answer_references_resolve(self):
        for audience in ('fan','analyst'):
            refs={e['id'] for p in self.bundle['analyses'][audience]['possessions'] for e in p['evidence']}
            for responses in self.bundle['answers'][audience].values():
                for answer in responses.values():
                    self.assertTrue(set(answer['evidence_ids']).issubset(refs))
    def test_media_digest_remains_bound(self):
        self.assertEqual(hashlib.sha256((self.out/'media/demo.mp4').read_bytes()).hexdigest(),self.bundle['dataset']['video']['sha256'])
    def test_root_enters_broadcast_without_publishing_archived_apps(self):
        root=(self.out/'index.html').read_text()
        self.assertIn('url=broadcast/',root)
        self.assertIn('CourtLens Broadcast',root)
        self.assertTrue((self.out/'broadcast/index.html').is_file())
        self.assertFalse((self.out/'arena.html').exists())
        self.assertFalse((self.out/'studio.html').exists())
        self.assertFalse((self.out/'broadcast/app.mjs').exists())
    def test_public_entry_is_usable_without_unpublished_api(self):
        preview=(self.out/'broadcast/index.html').read_text()
        self.assertIn('href="../demo.html"',preview)
        self.assertIn('自制合成',preview)
        self.assertIn('真实 48 秒版本',preview)
        self.assertIn('src="../media/broadcast-rehearsal.mp4"',preview)
        self.assertIn('src="./preview.mjs"',preview)
        self.assertIn('LIVE SIGNAL',preview)
        self.assertTrue((self.out/'broadcast/preview.mjs').is_file())
        preview_data=json.loads((self.out/'broadcast/preview-data.json').read_text())
        self.assertEqual(preview_data['provenance'],'synthetic')
        self.assertEqual(len(preview_data['cues']),12)
        self.assertTrue((self.out/'media/broadcast-rehearsal.mp4').is_file())
        self.assertNotIn('src="./app.mjs"',preview)
        self.assertNotIn('正在连接制作台',preview)
    def test_cloud_package_is_the_real_editor_not_the_pages_preview(self):
        cloud=Path(self.tmp.name)/'cloud-dist'
        build_cloud(cloud)
        app=(cloud/'broadcast/index.html').read_text()
        self.assertIn('src="./app.mjs"',app)
        self.assertIn('正在连接制作台',app)
        self.assertNotIn('合成演练',app)
        self.assertFalse((cloud/'demo.html').exists())
        self.assertFalse((cloud/'media').exists())
    def test_project_pages_asset_paths_are_relative_and_exist(self):
        for page in ('index.html','broadcast/index.html'):
            html=(self.out/page).read_text()
            parent=(self.out/page).parent
            for url in re.findall(r'(?:href|src)="([^"]+)"',html):
                if url.startswith(('https://','#','data:')): continue
                path=urlsplit(url).path
                if page=='index.html': self.assertFalse(path.startswith('/'),url)
                target=(self.out/path.lstrip('/')) if path.startswith('/') else (parent/path)
                self.assertTrue(target.is_file() or (target.is_dir() and (target/'index.html').is_file()),url)
    def test_manifest_covers_deployed_files(self):
        manifest=json.loads((self.out/'manifest.json').read_text())
        for name,digest in manifest.items():
            self.assertEqual(hashlib.sha256((self.out/name).read_bytes()).hexdigest(),digest)
    def test_no_workspace_secrets_or_node_tests_deployed(self):
        paths=[str(p.relative_to(self.out)) for p in self.out.rglob('*') if p.is_file()]
        self.assertFalse(any(any(word in p for word in('.env','workspace','sqlite','test.mjs')) for p in paths))
    def test_known_results_are_never_captioned_early(self):
        for audience in ('fan','analyst'):
            for p in self.original['possessions']:
                a=next(a for a in self.bundle['analyses'][audience]['possessions'] if a['id']==p['id'])
                for cue in a['cues']:
                    if f"{p['id']}:result" in cue['evidence_ids']:
                        self.assertGreaterEqual(cue['start'],p['result_time'])
    def test_missing_deck_does_not_advertise_a_download(self):
        self.assertFalse(self.bundle['publication']['presentation_available'])
        self.assertFalse((self.out/'presentation.pptx').exists())
    def test_build_rejects_media_input_mismatch(self):
        with patch('build_site.hashlib.sha256',return_value=Mock(hexdigest=lambda:'f'*64)):
            with self.assertRaisesRegex(ValueError,'input digest differ'):
                build(Path(self.tmp.name)/'mismatched-site-dist')
    def test_build_refuses_unrelated_output_without_deleting_it(self):
        output=Path(self.tmp.name)/'stale-site-dist'
        output.mkdir()
        marker=output/'unrelated-private-note.txt'
        marker.write_text('must not be published or deleted')
        with self.assertRaisesRegex(ValueError,'Unexpected publication output'):
            build(output)
        self.assertEqual(marker.read_text(),'must not be published or deleted')
        self.assertFalse((output/'index.html').exists())
    def test_build_refuses_symlink_inside_allowed_directory(self):
        output=Path(self.tmp.name)/'linked-site-dist'
        (output/'data').mkdir(parents=True)
        target=Path(self.tmp.name)/'external-note'
        target.write_text('private')
        (output/'data/demo.json').symlink_to(target)
        with self.assertRaisesRegex(ValueError,'Unexpected publication output'):
            build(output)
        self.assertEqual(target.read_text(),'private')
if __name__=='__main__':unittest.main()
