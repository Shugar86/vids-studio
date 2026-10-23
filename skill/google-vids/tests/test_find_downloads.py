import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('find_downloads',Path(__file__).resolve().parents[1]/'scripts/find_downloads.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class FindDownloadsTests(unittest.TestCase):
    def test_candidates_are_never_automatically_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in ['Ролик.mp4','Ролик (1).mp4','another.mp4','Ролик.mp4.crdownload']:(root/name).write_bytes(b'media')
            result=module.discover([root],'РОЛИК',0)
            self.assertEqual(len(result['candidates']),2)
            self.assertIsNone(result['selected'])
            self.assertEqual(result['provenance'],'unverified_candidates')
            self.assertEqual(module.discover([root],'ролик',10**12)['candidates'],[])
    def test_scan_is_bounded_and_does_not_recurse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'nested').mkdir();(root/'nested/a.mp4').write_bytes(b'x')
            self.assertEqual(module.discover([root],'a',0)['candidates'],[])
            for n in range(4):(root/f'a{n}.mp4').write_bytes(b'x')
            result=module.discover([root],'a',0,scan_limit=2)
            self.assertTrue(result['truncated']);self.assertEqual(result['scanned'],2)
    def test_missing_directory_reports_instead_of_requesting_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            result=module.discover([Path(tmp)/'missing'],'clip',0)
            self.assertEqual(result['candidates'],[]);self.assertEqual(len(result['unavailableDirectories']),1)
