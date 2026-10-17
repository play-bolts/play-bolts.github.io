import importlib.util
import copy
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gamelift_deploy', ROOT / 'scripts/deploy-gamelift.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
HASH = 'a' * 64


class GameLiftDeployTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'source.rs'
        source.write_text('reviewed source')
        folder = root / 'build'
        bundle = folder / 'bundle'
        bundle.mkdir(parents=True)
        config = {'region': deploy.REGION, 'secretParameter': deploy.SECRET,
                  'api': 'https://bolts-api.christopherkrapu.com',
                  'locations': [{'id': key, 'aws': value, 'queue': 'bolts-gamelift-' + key} for key, value in deploy.LOCATIONS.items()]}
        binary = b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\x00'
        files = {'bolts-host': binary, 'bolts-server': binary, 'install.sh': b'#!/bin/sh\n', 'host.json': json.dumps(config).encode()}
        for name, data in files.items(): (bundle / name).write_bytes(data)
        manifest = {name: deploy.digest(data) for name, data in files.items()}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        (folder / 'build-provenance.json').write_text(json.dumps({'outputs': manifest, 'configSha256': manifest['host.json'], 'sourceFiles': {'source.rs': deploy.digest(source.read_bytes())}}))
        template = {'Parameters': {'MaximumInstancesPerLocation': {'Default': 2}}, 'Resources': {'Fleet': {'Properties': {'Locations': [
            {'Location': deploy.REGION, 'LocationCapacity': {'MinSize': 0, 'DesiredEC2Instances': 0, 'MaxSize': 0}},
            *[{'Location': value, 'LocationCapacity': {'MinSize': 1, 'DesiredEC2Instances': 1, 'MaxSize': {'Ref': 'MaximumInstancesPerLocation'}}} for value in deploy.LOCATIONS.values()]
        ]}}}}
        (folder / 'fleet.template.json').write_text(json.dumps(template))
        return folder, files, config, template

    def test_managed_capacity_is_rejected_anywhere_in_the_template(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, template = self.fixture(Path(directory))
            for target in ('regional', 'home', 'fleet', 'unrelated_metadata'):
                with self.subTest(target=target):
                    changed = copy.deepcopy(template)
                    fleet = changed['Resources']['Fleet']['Properties']
                    parent = {'regional': fleet['Locations'][1]['LocationCapacity'],
                              'home': fleet['Locations'][0]['LocationCapacity'],
                              'fleet': fleet, 'unrelated_metadata': changed.setdefault('Metadata', {})}[target]
                    parent['ManagedCapacityConfiguration'] = {'ZeroCapacityStrategy': 'SCALE_TO_AND_FROM_ZERO'}
                    with self.assertRaisesRegex(deploy.DeploymentError, 'must be absent'):
                        deploy.validate_capacity(changed)

    def test_regional_maximum_cannot_exceed_two_or_reference_another_parameter(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, template = self.fixture(Path(directory))
            deploy.validate_capacity(template)
            for limit in (0, 1, 3, True, {'Ref': 'UnboundedMaximum'}):
                with self.subTest(limit=limit):
                    changed = copy.deepcopy(template)
                    changed['Resources']['Fleet']['Properties']['Locations'][1]['LocationCapacity']['MaxSize'] = limit
                    with self.assertRaisesRegex(deploy.DeploymentError, 'capped at two'):
                        deploy.validate_capacity(changed)
            changed = copy.deepcopy(template)
            changed['Parameters']['MaximumInstancesPerLocation']['Default'] = 10
            with self.assertRaisesRegex(deploy.DeploymentError, 'capped at two'):
                deploy.validate_capacity(changed)

    def test_home_capacity_requires_zero_minimum_desired_and_maximum(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, template = self.fixture(Path(directory))
            for field in ('MinSize', 'DesiredEC2Instances', 'MaxSize'):
                for value in (1, False, None):
                    with self.subTest(field=field, value=value):
                        changed = copy.deepcopy(template)
                        changed['Resources']['Fleet']['Properties']['Locations'][0]['LocationCapacity'][field] = value
                        with self.assertRaisesRegex(deploy.DeploymentError, 'must all be zero'):
                            deploy.validate_capacity(changed)

    def test_default_is_local_only_and_zip_is_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder, files, config, template = self.fixture(root)
            with patch.object(deploy, 'ROOT', root), patch.object(deploy.runpy, 'run_path', return_value={'template': lambda: template}), patch.object(deploy, 'AWS') as aws:
                deploy.main(['--build-dir', str(folder), '--state-root', str(root / 'state')])
                aws.assert_not_called()
            zipped = deploy.build_zip(files)
            self.assertEqual(zipped, deploy.build_zip(dict(reversed(list(files.items())))))
            with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
                self.assertEqual(set(archive.namelist()), deploy.BUNDLE_FILES)
                self.assertEqual(archive.getinfo('bolts-server').external_attr >> 16 & 0o777, 0o755)

    def test_changed_source_hashes_files_and_extra_inputs_fail_closed(self):
        for corruption in ['source', 'binary', 'extra', 'symlink', 'template', 'new_york']:
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                folder, files, config, template = self.fixture(root)
                if corruption == 'source': (root / 'source.rs').write_text('new unbuilt source')
                if corruption == 'binary': (folder / 'bundle/bolts-server').write_bytes(b'wrong')
                if corruption == 'extra': (folder / 'bundle/credentials').write_text('must never upload')
                if corruption == 'symlink':
                    (folder / 'bundle/install.sh').unlink()
                    (folder / 'bundle/install.sh').symlink_to(root / 'source.rs')
                if corruption == 'template': (folder / 'fleet.template.json').write_text('{}')
                if corruption == 'new_york':
                    config['locations'].append({'id': 'ny', 'aws': 'us-east-1-nyc-2', 'queue': 'bolts-gamelift-ny'})
                    data = json.dumps(config).encode()
                    (folder / 'bundle/host.json').write_bytes(data)
                    manifest = json.loads((folder / 'manifest.json').read_text())
                    manifest['host.json'] = deploy.digest(data)
                    (folder / 'manifest.json').write_text(json.dumps(manifest))
                    provenance = json.loads((folder / 'build-provenance.json').read_text())
                    provenance.update(outputs=manifest, configSha256=manifest['host.json'])
                    (folder / 'build-provenance.json').write_text(json.dumps(provenance))
                with patch.object(deploy, 'ROOT', root), patch.object(deploy.runpy, 'run_path', return_value={'template': lambda: template}):
                    with self.assertRaises(deploy.DeploymentError): deploy.local_artifacts(folder, 'bolts-gamelift')

    def test_aws_mutations_require_apply_and_errors_never_echo_credentials(self):
        with patch.object(deploy.subprocess, 'run') as run:
            with self.assertRaises(deploy.DeploymentError): deploy.AWS().call('ssm', 'put-parameter', mutation=True)
            run.assert_not_called()
        result = subprocess.CompletedProcess([], 1, stdout='secret-output', stderr='An error occurred (AccessDeniedException) secret-request')
        with patch.object(deploy.subprocess, 'run', return_value=result):
            with self.assertRaises(deploy.AwsError) as caught: deploy.AWS(True).call('gamelift', 'create-build', mutation=True)
        self.assertNotIn('secret-', str(caught.exception))
        self.assertEqual(caught.exception.code, 'AccessDeniedException')

    def test_existing_secret_is_neither_read_nor_replaced(self):
        aws = MagicMock()
        aws.call.return_value = {'Parameters': [{'Name': deploy.SECRET, 'Type': 'SecureString'}]}
        deploy.ensure_secret(aws, Path('/unused'))
        self.assertEqual(aws.call.call_count, 1)
        self.assertEqual(aws.call.call_args.args[:2], ('ssm', 'describe-parameters'))

    def test_new_secret_uses_private_temporary_file_and_removes_it_even_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            seen = []
            def call(service, operation, *args, **kwargs):
                if operation == 'describe-parameters': return {'Parameters': []}
                self.assertEqual(operation, 'put-parameter')
                path = Path(args[1].removeprefix('file://'))
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                data = json.loads(path.read_text())
                self.assertEqual(data['Type'], 'SecureString')
                self.assertFalse(data['Overwrite'])
                self.assertEqual(len(data['Value']), 64)
                self.assertNotIn(data['Value'], str(args))
                seen.append(path)
                raise deploy.AwsError(service, operation, 'Denied')
            aws = MagicMock()
            aws.call.side_effect = call
            with self.assertRaises(deploy.AwsError): deploy.ensure_secret(aws, Path(directory))
            self.assertEqual(len(seen), 1)
            self.assertFalse(seen[0].exists())

    def test_build_upload_resumes_existing_identity_and_never_persists_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'build.zip'
            archive.write_bytes(b'zip')
            state, created = {}, []
            build = {'BuildId': 'build-example', 'Name': 'bolts-gamelift-' + HASH, 'Version': HASH, 'OperatingSystem': 'AMAZON_LINUX_2023', 'Status': 'INITIALIZED'}
            uploaded = False
            fail_upload = True
            def call(service, operation, *args, **kwargs):
                nonlocal uploaded, fail_upload
                if operation == 'list-builds': return {'Builds': []}
                if operation == 'create-build': created.append(True); return {'Build': build, 'UploadCredentials': {'SecretAccessKey': 'do-not-store'}}
                if operation == 'describe-build': return {'Build': dict(build, Status='READY' if uploaded else 'INITIALIZED')}
                if operation == 'request-upload-credentials': return {'UploadCredentials': {'AccessKeyId': 'temporary-id', 'SecretAccessKey': 'temporary-secret', 'SessionToken': 'temporary-token'}, 'StorageLocation': {'Bucket': 'gamelift-builds', 'Key': 'key'}}
                if operation == 'cp':
                    self.assertEqual(kwargs['env']['AWS_SECRET_ACCESS_KEY'], 'temporary-secret')
                    self.assertNotIn('temporary-secret', str(args))
                    if fail_upload: raise deploy.AwsError(service, operation, 'Interrupted')
                    uploaded = True
                    return ''
                self.fail((service, operation))
            aws = MagicMock()
            aws.call.side_effect = call
            state_path = root / 'state.json'
            with self.assertRaises(deploy.AwsError): deploy.ensure_build(aws, archive, HASH, state, state_path, 'bolts-gamelift')
            self.assertEqual(json.loads(state_path.read_text())['buildId'], 'build-example')
            self.assertNotIn('temporary', state_path.read_text())
            self.assertNotIn('do-not-store', state_path.read_text())
            fail_upload = False
            with patch.object(deploy.time, 'sleep'):
                self.assertEqual(deploy.ensure_build(aws, archive, HASH, state, state_path, 'bolts-gamelift'), 'build-example')
            self.assertEqual(len(created), 1)

    def test_discovery_recovers_build_if_process_died_before_saving_state(self):
        build = {'BuildId': 'build-recovered', 'Name': 'bolts-gamelift-' + HASH, 'Version': HASH, 'OperatingSystem': 'AMAZON_LINUX_2023', 'Status': 'READY'}
        aws = MagicMock()
        aws.call.return_value = {'Builds': [build]}
        with tempfile.TemporaryDirectory() as directory:
            state = {}
            self.assertEqual(deploy.ensure_build(aws, Path('unused'), HASH, state, Path(directory) / 'state.json', 'bolts-gamelift'), 'build-recovered')
        self.assertEqual(aws.call.call_count, 1)

    def test_unconfirmed_interrupted_creation_never_creates_a_second_build(self):
        aws = MagicMock()
        aws.call.return_value = {'Builds': []}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(deploy.DeploymentError, 'interrupted'):
                deploy.ensure_build(aws, Path('unused'), HASH, {'buildCreationStarted': True}, Path(directory) / 'state.json', 'bolts-gamelift')
        self.assertEqual(aws.call.call_count, 1)
        self.assertEqual(aws.call.call_args.args[:2], ('gamelift', 'list-builds'))

    def test_failed_stack_stops_without_automatic_resource_deletion(self):
        aws = MagicMock()
        with patch.object(deploy, 'describe_stack', return_value={'StackStatus': 'ROLLBACK_COMPLETE'}):
            with self.assertRaisesRegex(deploy.DeploymentError, 'ROLLBACK_COMPLETE'): deploy.wait_stack(aws, 'bolts-gamelift')
        aws.call.assert_not_called()

    def test_insufficient_quota_prevents_secret_and_stack_mutations(self):
        aws = MagicMock()
        with patch.object(deploy, 'capacity_checks', return_value=[{'ok': False}]), patch.object(deploy, 'ensure_secret') as secret:
            with self.assertRaises(deploy.DeploymentError): deploy.ensure_fleet(aws, 'bolts-gamelift', Path('unused'), 'build-a', {}, Path('unused'))
            secret.assert_not_called()
            aws.call.assert_not_called()

    def test_occupied_or_changed_release_cannot_upload_or_cut_over(self):
        for observed, expected in [({'humans': 1, 'release': HASH}, None), ({'humans': 0, 'release': HASH}, 'b' * 64)]:
            with self.subTest(observed=observed, expected=expected), tempfile.TemporaryDirectory() as directory:
                aws = MagicMock()
                with patch.object(deploy, 'wait_fleet'), patch.object(deploy, 'ssm', return_value='read-only-inspection') as ssm, patch.object(deploy, 'wait_ssm', return_value=json.dumps(observed)):
                    with self.assertRaises(deploy.DeploymentError): deploy.deploy_directory(aws, {'instance': 'i-test'}, {}, {}, 'fleet-test', Path(directory), {}, Path(directory) / 'state.json', expected)
                    self.assertEqual(ssm.call_count, 1)
                    aws.call.assert_not_called()

    def test_existing_cutover_command_is_resumed_not_sent_again(self):
        aws = MagicMock()
        with patch.object(deploy, 'wait_ssm') as wait, patch.object(deploy, 'ssm') as send, patch.object(deploy, 'wait_fleet') as fleet:
            deploy.deploy_directory(aws, {'instance': 'i-test'}, {}, {}, 'fleet-test', Path('unused'), {'directoryCommandId': 'previous-command'}, Path('unused'))
            wait.assert_called_once_with(aws, 'i-test', 'previous-command')
            send.assert_not_called()
            fleet.assert_not_called()

    def test_remote_install_checks_archive_and_passes_expected_release(self):
        script = deploy.remote_install('existing-bucket', 'releases/gamelift/test.tar.gz', HASH, 'b' * 64)
        self.assertIn('sha256sum --check --status', script)
        self.assertIn("m.isfile()", script)
        self.assertIn("'bolts-host','bolts-server','host.json','install-directory.sh'", script)
        self.assertIn('b' * 64, script.splitlines()[-1])
        self.assertNotIn('BOLTS_IDENTITY_SALT=', script)
        self.assertNotIn('DELETE', script)
        self.assertEqual(subprocess.run(['bash', '-n'], input=script, text=True).returncode, 0)

    def test_finalized_directory_archive_has_only_binaries_config_and_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'directory.tar.gz'
            config = {'fleet': '', 'locations': []}
            files = {'bolts-host': b'host', 'bolts-server': b'server'}
            first = deploy.directory_archive(files, config, 'fleet-final', path)
            self.assertEqual(first, deploy.directory_archive(files, config, 'fleet-final', path))
            with tarfile.open(path) as archive:
                self.assertEqual(set(archive.getnames()), {'bolts-host', 'bolts-server', 'host.json', 'install-directory.sh'})
                self.assertEqual(json.load(archive.extractfile('host.json'))['fleet'], 'fleet-final')
            self.assertEqual(config['fleet'], '')


if __name__ == '__main__': unittest.main()
