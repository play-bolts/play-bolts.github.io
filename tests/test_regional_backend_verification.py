import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regional_verification', ROOT / 'scripts/verify-regional-backend.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class RegionalVerificationTests(unittest.TestCase):
    def report(self):
        return {'capturedAt': 1000, 'credentialCutoff': 1000, 'migrations': [1, 2, 3, 4],
                'integrityOk': True, 'foreignKeyViolations': 0, 'violations': {},
                'counts': {'players': 10, 'events': 20}, 'completedBackupsSinceBaseline': 1,
                'services': {'game': {'ActiveState': 'active'}, 'backupTimer': {'ActiveState': 'active'}, 'backup': {'Result': 'success'}},
                'private': {'saltSha256': 'private-salt-digest', 'credentialSha256': 'private-account-digest', 'credentialCount': 8}}

    def test_new_activity_preserves_baseline_credentials_and_records(self):
        before = self.report()
        after = copy.deepcopy(before)
        after['counts'] = {'players': 12, 'events': 35}
        self.assertTrue(all(verify.comparison(before, after).values()))

    def test_comparison_detects_secret_credential_record_and_migration_regressions(self):
        before = self.report()
        changes = [('private', 'saltSha256', 'changed', 'identitySaltPreserved'),
                   ('private', 'credentialSha256', 'changed', 'existingHumanCredentialsPreserved'),
                   ('private', 'credentialCount', 7, 'existingHumanCredentialsPreserved'),
                   ('counts', 'events', 19, 'recordCountsPreserved')]
        for group, key, value, result in changes:
            with self.subTest(result=result, key=key):
                after = copy.deepcopy(before)
                after[group][key] = value
                self.assertFalse(verify.comparison(before, after)[result])
        after = copy.deepcopy(before)
        after['migrations'] = [1, 2, 3]
        self.assertFalse(verify.comparison(before, after)['migrationsComplete'])

    def test_baseline_hides_private_digests_and_stores_them_only_in_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'baseline.json'
            output = io.StringIO()
            with patch.object(verify.deploy, 'AWS'), patch.object(verify.deploy, 'ssm', return_value='readonly-command'), \
                    patch.object(verify.deploy, 'wait_ssm', return_value=json.dumps(self.report())), contextlib.redirect_stdout(output):
                verify.main(['--baseline', str(target)])
            self.assertNotIn('private-salt-digest', output.getvalue())
            self.assertNotIn('private-account-digest', output.getvalue())
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(json.loads(target.read_text())['private'], self.report()['private'])
            with self.assertRaisesRegex(ValueError, 'already exists'):
                verify.main(['--baseline', str(target)])

    def test_remote_inspector_compiles_with_fixed_numeric_cutoffs(self):
        compile(verify.REMOTE.replace('CUTOFF_VALUE', 'None').replace('SINCE_VALUE', '1000'), '<remote-readonly-inspection>', 'exec')


if __name__ == '__main__': unittest.main()
