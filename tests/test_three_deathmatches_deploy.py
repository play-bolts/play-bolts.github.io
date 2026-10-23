"""Exercise the full application installer against an isolated mock host."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('three_deathmatches', ROOT / 'scripts/deploy-three-deathmatches.py')
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)
PREVIOUS = 'a' * 64
NEXT = 'b' * 64
ENV = b'BOLTS_MAX_ROOMS=11\nBOLTS_IDENTITY_SALT=private-test-salt\nBOLTS_ADMIN_API_KEY=private-test-key\n'


class ThreeDeathmatchesDeployTests(unittest.TestCase):
    def run_installer(self, scenario):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('opt/bolts/releases/' + PREVIOUS, 'var/lock', 'var/lib/bolts', 'etc', 'bin', 'bundle'):
                (root / name).mkdir(parents=True, exist_ok=True)
            previous = root / 'opt/bolts/releases' / PREVIOUS
            current = root / 'opt/bolts/current'
            current.symlink_to(previous)
            (root / 'var/lib/bolts-bootstrap.ready').touch()
            environment = root / 'etc/bolts.env'
            environment.write_bytes(ENV)
            environment.chmod(0o600)
            config = {'extraLobbiesEnabled': False, 'locations': []}
            for path in (root / 'etc/bolts-gamelift.json', root / 'bundle/host.json'):
                path.write_text(json.dumps(config))
            for folder in (previous, root / 'bundle'):
                (folder / 'bolts-host').write_text('#!/bin/bash\nexit 0\n')
                (folder / 'bolts-host').chmod(0o755)
                (folder / 'bolts-server').write_text('server')
                (folder / 'bolts-server').chmod(0o755)
            command = '''#!/usr/bin/env python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['CASE_DIR']); scenario=os.environ['SCENARIO']
name=pathlib.Path(sys.argv[0]).name
with (root/'trace').open('a') as out: out.write(name+' '+ ' '.join(sys.argv[1:])+'\\n')
if name=='systemctl':
 if sys.argv[1:] == ['start','bolts-backup.service']: (root/'backup-ran').touch()
 if sys.argv[1:] == ['restart','bolts.service'] and scenario=='restart_failure' and not (root/'failed-once').exists():
  (root/'failed-once').touch(); sys.exit(17)
elif name=='curl':
 active=(root/'opt/bolts/current').resolve().name
 occupied=scenario=='occupied' or (scenario=='occupied_after_backup' and (root/'backup-ran').exists())
 rows=[('Deathmatch',6),('1v1 Alpha',2),('1v1 Beta',2),('1v1 Delta',2)]
 if active=='b'*64 and scenario!='health_failure': rows=[('Deathmatch 1',6),('Deathmatch 2',6),('Deathmatch 3',6)]+rows[1:]
 print(json.dumps({'version':2,'locations':[],'lobbies':[{'name':name,'capacity':cap,'location':'or','managed':False,'players':int(occupied)} for name,cap in rows]}))
elif name=='mv':
 if scenario=='selection_failure' and not (root/'failed-once').exists():
  (root/'failed-once').touch(); sys.exit(18)
 assert sys.argv[1]=='-Tf'; os.replace(sys.argv[2],sys.argv[3])
elif name not in ('flock','sleep'): raise AssertionError(name)
'''
            for name in ('systemctl', 'curl', 'mv', 'flock', 'sleep'):
                path = root / 'bin' / name
                path.write_text(command)
                path.chmod(0o755)
            installer = (ROOT / 'scripts/install-three-deathmatches.sh').read_text()
            for prefix in ('/opt/bolts', '/etc/bolts', '/var/lib/bolts', '/var/lock'):
                installer = installer.replace(prefix, str(root) + prefix)
            script = root / 'install.sh'
            script.write_text(installer)
            result = subprocess.run(['bash', str(script), NEXT, str(root / 'bundle'),
                                     str(root / 'bundle/host.json'), PREVIOUS],
                                    env={**os.environ, 'CASE_DIR': str(root), 'SCENARIO': scenario,
                                         'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH']},
                                    capture_output=True, text=True, timeout=30)
            trace = (root / 'trace').read_text()
            return result, current.resolve().name, environment.read_bytes(), environment.stat().st_mode & 0o777, trace

    def test_success_installs_six_rooms_and_changes_only_room_cap(self):
        result, current, environment, mode, trace = self.run_installer('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(current, NEXT)
        self.assertEqual(environment, ENV.replace(b'=11\n', b'=6\n'))
        self.assertEqual(mode, 0o600)
        self.assertEqual(trace.count('systemctl restart bolts.service'), 1)
        self.assertIn('Six local rooms healthy', result.stdout)

    def test_occupied_seats_before_or_during_backup_leave_environment_and_release(self):
        for scenario in ('occupied', 'occupied_after_backup'):
            with self.subTest(scenario=scenario):
                result, current, environment, mode, trace = self.run_installer(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(current, PREVIOUS)
                self.assertEqual(environment, ENV)
                self.assertEqual(mode, 0o600)
                self.assertNotIn('systemctl restart', trace)
                self.assertIn('human seat is occupied', result.stderr)

    def test_restart_and_inventory_failures_restore_complete_environment_and_release(self):
        for scenario in ('restart_failure', 'health_failure', 'selection_failure'):
            with self.subTest(scenario=scenario):
                result, current, environment, mode, trace = self.run_installer(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(current, PREVIOUS)
                self.assertEqual(environment, ENV)
                self.assertEqual(mode, 0o600)
                self.assertEqual(trace.count('systemctl restart bolts.service'), 1 if scenario == 'selection_failure' else 2)
                self.assertIn('previous environment and binaries restored', result.stderr)

    def test_build_guard_allows_only_reviewed_inventory_sources_and_identical_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'baseline.json'
            old = {path: 'old' for path in ('server/src/hub.rs', 'server/src/hub_tests.rs',
                   'server/gamelift/hybrid_test.go', 'server/src/admin.rs')}
            binaries = {'bolts-host': wrapper.deploy.digest(b'gateway'),
                        'bolts-server': wrapper.deploy.digest(b'previous-server')}
            state.write_text(json.dumps({'release': wrapper.EXPECTED, 'binaries': binaries, 'sourceFiles': old}))
            new = dict(old, **{path: 'new' for path in old if path != 'server/src/admin.rs'})
            files = {'bolts-host': b'gateway', 'bolts-server': b'new-server'}
            with patch.object(wrapper, 'BASELINE_STATE', state), patch.object(wrapper, 'BASELINE_BINARIES', binaries):
                wrapper.validate_build({'sourceFiles': new}, files)
                drift = dict(new, **{'server/src/admin.rs': 'unexpected'})
                with self.assertRaises(wrapper.deploy.DeploymentError):
                    wrapper.validate_build({'sourceFiles': drift}, files)
                with self.assertRaises(wrapper.deploy.DeploymentError):
                    wrapper.validate_build({'sourceFiles': new}, dict(files, **{'bolts-host': b'rebuilt-gateway'}))

    def test_archive_hash_covers_the_custom_installer_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'release.tar.gz'
            files = {'bolts-host': b'host', 'bolts-server': b'server'}
            first = wrapper.deploy.directory_archive(files, {}, 'fleet', archive, installer=b'first')
            with tarfile.open(fileobj=io.BytesIO(archive.read_bytes())) as tar:
                self.assertEqual(tar.extractfile('install-directory.sh').read(), b'first')
            second = wrapper.deploy.directory_archive(files, {}, 'fleet', archive, installer=b'second')
            self.assertNotEqual(first, second)

    def test_postrelease_validation_rejects_changed_secret_or_hosting_metadata(self):
        before = {'binaries': wrapper.BASELINE_BINARIES, 'config': {'extraLobbiesEnabled': False},
                  'schemaDigest': 'schema', 'environment': {'maxRooms': '11', 'adminKeyConfigured': True,
                  'mode': '0o600', 'otherValuesDigest': 'unchanged'}}
        wrapper.validate_observed(before, None)
        after = copy.deepcopy(before)
        after['environment']['maxRooms'] = '6'
        wrapper.validate_observed(before, after)
        for key in ('otherValuesDigest', 'mode', 'adminKeyConfigured'):
            changed = copy.deepcopy(after)
            changed['environment'][key] = 'unexpected'
            with self.assertRaises(wrapper.deploy.DeploymentError):
                wrapper.validate_observed(before, changed)


if __name__ == '__main__':
    unittest.main()
