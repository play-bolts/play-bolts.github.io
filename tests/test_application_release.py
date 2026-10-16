import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('application_release', ROOT / 'scripts/deploy-backend.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
DIGEST = 'a' * 64
OUTPUTS = {'InstanceId': 'test-instance', 'StorageBucket': 'test-bucket', 'BackendUrl': 'https://test.invalid'}


class ApplicationReleaseTests(unittest.TestCase):
    def test_application_release_never_provisions_infrastructure(self):
        args = ['deploy', '--apply', '--application-only', '--expected-release', DIGEST]
        stack = {'StackStatus': 'UPDATE_COMPLETE', 'Outputs': [
            {'OutputKey': key, 'OutputValue': value} for key, value in OUTPUTS.items()]}
        with patch('sys.argv', args), patch.object(deploy, 'prepare', return_value=('template', 'archive', 'b' * 64)), \
                patch.object(deploy, 'describe', return_value=stack), patch.object(deploy, 'provision') as provision, \
                patch.object(deploy, 'deploy_release') as release, patch.object(deploy, 'verify_edge') as verify:
            deploy.main()
        provision.assert_not_called()
        self.assertEqual(release.call_args.args[0].expected_release, DIGEST)
        self.assertEqual(release.call_args.args[1:], (OUTPUTS, 'archive', 'b' * 64))
        verify.assert_called_once_with(OUTPUTS['BackendUrl'])

    def test_missing_release_guard_or_conflicting_modes_cannot_touch_aws(self):
        for args in [
            ['--application-only', '--apply'],
            ['--application-only', '--origins-only'],
            ['--application-only', '--provision-only'],
            ['--application-only', '--apply', '--expected-release', 'not-a-digest'],
        ]:
            with self.subTest(args=args), patch('sys.argv', ['deploy', *args]), \
                    patch.object(deploy, 'aws') as aws, patch.object(deploy, 'prepare') as prepare:
                with self.assertRaises(deploy.DeploymentError):
                    deploy.main()
                aws.assert_not_called()
                prepare.assert_not_called()

    def test_in_progress_stack_defers_application_release(self):
        with patch('sys.argv', ['deploy', '--apply', '--application-only', '--expected-release', DIGEST]), \
                patch.object(deploy, 'prepare', return_value=('template', 'archive', 'b' * 64)), \
                patch.object(deploy, 'describe', return_value={'StackStatus': 'UPDATE_IN_PROGRESS'}), \
                patch.object(deploy, 'deploy_release') as release:
            with self.assertRaises(deploy.DeploymentError):
                deploy.main()
            release.assert_not_called()

    def test_reproducible_source_archive_contains_both_wire_schemas(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)):
            _, archive, digest = deploy.prepare()
            with tarfile.open(archive) as source:
                names = source.getnames()
            self.assertIn('shared/actor-fields.json', names)
            self.assertIn('shared/wire-schema.json', names)
            self.assertFalse(any(name.startswith(('temp/', '.aws/', 'server/data/', 'node_modules/')) for name in names))
            self.assertEqual(deploy.prepare()[2], digest)


if __name__ == '__main__':
    unittest.main()
