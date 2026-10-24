#!/usr/bin/env python3
"""Exercise application-only telemetry cutover against an isolated mock host."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('telemetry_deploy', ROOT / 'scripts/deploy-visitor-telemetry.py')
WRAPPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRAPPER)
PREVIOUS, NEXT = 'a' * 64, 'b' * 64
ENV = b'BOLTS_MAX_ROOMS=6\nBOLTS_IDENTITY_SALT=private-test-salt\nBOLTS_ADMIN_API_KEY=private-test-key\n'


class InstallerTests(unittest.TestCase):
    def run_installer(self, scenario):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = root / 'opt/bolts/releases' / PREVIOUS
            for name in [previous, root/'var/lock', root/'var/lib/bolts', root/'bin', root/'bundle']:
                name.mkdir(parents=True)
            current = root/'opt/bolts/current'
            current.symlink_to(previous)
            (root/'var/lib/bolts-bootstrap.ready').touch()
            for name in WRAPPER.PROTECTED:
                path = root/name.lstrip('/')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('preserved host file\n')
            environment = root/'etc/bolts.env'
            environment.write_bytes(ENV)
            environment.chmod(0o600)
            config = {'extraLobbiesEnabled': False, 'locations': []}
            for path in [root/'etc/bolts-gamelift.json', root/'bundle/host.json']:
                path.write_text(json.dumps(config))
            if scenario == 'config_drift':
                (root/'bundle/host.json').write_text(json.dumps(dict(config, extraLobbiesEnabled=True)))
            for folder in [previous, root/'bundle']:
                (folder/'bolts-host').write_text('#!/bin/bash\nexit 0\n')
                (folder/'bolts-host').chmod(0o755)
                (folder/'bolts-server').write_text('server')
                (folder/'bolts-server').chmod(0o755)
            if scenario == 'gateway_drift':
                (root/'bundle/bolts-host').write_text('#!/bin/bash\nexit 9\n')
            schema = (ROOT/'server/schema.sql').read_text()
            (root/'schema.sql').write_text(schema)
            database = root/'var/lib/bolts/bolts.sqlite'
            with sqlite3.connect(database) as db:
                db.executescript(schema.split('-- Private first-party network').pop(0))
                db.execute('INSERT OR IGNORE INTO schema_migrations VALUES(2,1)')
                db.execute("INSERT INTO players(id,credential_hash,created_at,last_seen) VALUES('original','original-credential',1,1)")
            command = r'''#!/usr/bin/env python3
import json,os,pathlib,sqlite3,sys
root=pathlib.Path(os.environ['CASE_DIR']); scenario=os.environ['SCENARIO']
name=pathlib.Path(sys.argv[0]).name
with (root/'trace').open('a') as out: out.write(name+' '+' '.join(sys.argv[1:])+'\n')
active=(root/'opt/bolts/current').resolve().name
if name=='systemctl':
 if sys.argv[1:]==['start','bolts-backup.service']:
  count=int((root/'backup-count').read_text()) if (root/'backup-count').exists() else 0
  (root/'backup-count').write_text(str(count+1))
  if scenario=='backup_failure' or scenario=='post_backup_failure' and active=='b'*64: sys.exit(20)
 if sys.argv[1:]==['show','bolts-backup.service','--property=Result','--value']: print('success')
 if sys.argv[1:]==['restart','bolts.service'] and active=='b'*64:
  if scenario=='restart_failure': sys.exit(17)
  with sqlite3.connect(root/'var/lib/bolts/bolts.sqlite') as db:
   if scenario!='migration_failure': db.executescript((root/'schema.sql').read_text())
   if scenario=='identity_failure': db.execute("UPDATE players SET credential_hash='changed' WHERE id='original'")
elif name=='curl':
 if sys.argv[-1].endswith('/health'):
  print(json.dumps({'ok':not(scenario=='health_failure' and active=='b'*64),'version':3}))
 else:
  occupied=scenario=='occupied' or scenario=='occupied_after_backup' and (root/'backup-count').exists()
  rows=[('Deathmatch 1',6),('Deathmatch 2',6),('Deathmatch 3',6),('1v1 Alpha',2),('1v1 Beta',2),('1v1 Delta',2)]
  print(json.dumps({'version':2,'locations':[],'lobbies':[{'name':n,'capacity':c,'location':'or','managed':False,'players':int(occupied)} for n,c in rows]}))
elif name=='mv':
 if scenario=='selection_failure' and not (root/'failed-once').exists():
  (root/'failed-once').touch(); sys.exit(18)
 assert sys.argv[1]=='-Tf'; os.replace(sys.argv[2],sys.argv[3])
elif name=='flock':
 if scenario=='locked': sys.exit(1)
elif name!='sleep': raise AssertionError(name)
'''
            for name in ['systemctl', 'curl', 'mv', 'flock', 'sleep']:
                path = root/'bin'/name
                path.write_text(command)
                path.chmod(0o755)
            script = (ROOT/'scripts/install-visitor-telemetry.sh').read_text()
            for prefix in ['/opt/bolts', '/etc/bolts', '/etc/systemd', '/var/lib/bolts', '/var/lock', '/usr/local/libexec']:
                script = script.replace(prefix, str(root)+prefix)
            (root/'install.sh').write_text(script)
            protected = {name: (root/name.lstrip('/')).read_bytes() for name in WRAPPER.PROTECTED}
            result = subprocess.run(['bash', str(root/'install.sh'), NEXT, str(root/'bundle'),
                                     str(root/'bundle/host.json'), PREVIOUS if scenario!='expected_release' else 'c'*64],
                                    env={**os.environ, 'CASE_DIR':str(root), 'SCENARIO':scenario,
                                         'PATH':str(root/'bin')+os.pathsep+os.environ['PATH']},
                                    capture_output=True, text=True, timeout=30)
            self.assertTrue(all((root/name.lstrip('/')).read_bytes()==data for name,data in protected.items()))
            self.assertEqual(environment.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('private-test-key', result.stdout+result.stderr)
            self.assertNotIn('private-test-salt', result.stdout+result.stderr)
            trace = (root/'trace').read_text() if (root/'trace').exists() else ''
            checkpoints=list((root/'var/lib/bolts').glob('visitor-telemetry.*/bolts.sqlite'))
            with sqlite3.connect(database) as db:
                migrated = db.execute('SELECT count(*) FROM schema_migrations WHERE version=5').fetchone()[0]
            return result,current.resolve().name,trace,len(checkpoints),migrated

    def test_success_preserves_configuration_admin_gateway_and_keeps_checkpoint(self):
        result,current,trace,checkpoints,migrated=self.run_installer('success')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(current,NEXT)
        self.assertEqual(trace.count('systemctl start bolts-backup.service'),2)
        self.assertEqual(checkpoints,1)
        self.assertEqual(migrated,1)
        self.assertNotIn('daemon-reload',trace)

    def test_pre_cutover_guards_never_restart_or_change_release(self):
        for scenario in ['occupied','occupied_after_backup','gateway_drift','config_drift','expected_release','locked','backup_failure']:
            with self.subTest(scenario=scenario):
                result,current,trace,_,_=self.run_installer(scenario)
                self.assertNotEqual(result.returncode,0,result.stdout)
                self.assertEqual(current,PREVIOUS)
                self.assertNotIn('systemctl restart',trace)

    def test_failed_cutovers_restore_and_verify_previous_binary_health(self):
        for scenario in ['restart_failure','health_failure','selection_failure','migration_failure','identity_failure','post_backup_failure']:
            with self.subTest(scenario=scenario):
                result,current,trace,checkpoints,migrated=self.run_installer(scenario)
                self.assertNotEqual(result.returncode,0,result.stdout)
                self.assertEqual(current,PREVIOUS)
                self.assertEqual(checkpoints,1)
                self.assertIn('previous binaries restored and healthy',result.stderr)
                self.assertIn('/api/health',trace)
                if scenario=='post_backup_failure': self.assertEqual(migrated,1)
                if scenario in ['identity_failure','migration_failure']: self.assertIn('Database was not restored',result.stderr)


class WrapperGuards(unittest.TestCase):
    def test_build_inventory_requires_every_rust_input_and_gateway_provenance(self):
        class Deploy: DeploymentError=RuntimeError
        expected=WRAPPER.INPUTS | {str(path.relative_to(ROOT)) for path in (ROOT/'server/src').glob('*.rs')}
        provenance={'commit':'selected','sourceFiles':dict.fromkeys(expected,'hash'),
                    'preservedGateway':{'release':WRAPPER.EXPECTED,'sha256':'gateway'}}
        WRAPPER.validate_inventory(Deploy,ROOT,'selected',provenance,'gateway')
        for changed in [dict(provenance,sourceFiles={}),dict(provenance,commit='other'),dict(provenance,preservedGateway={})]:
            with self.assertRaises(RuntimeError): WRAPPER.validate_inventory(Deploy,ROOT,'selected',changed,'gateway')

    def target(self, scenario):
        class Deploy:
            DeploymentError=RuntimeError
            @staticmethod
            def describe_stack(*args):
                return {'StackStatus':'UPDATE_IN_PROGRESS' if scenario=='migrating' else 'UPDATE_COMPLETE',
                        'Outputs':[{'OutputKey':'InstanceId','OutputValue':WRAPPER.INSTANCE},
                                   {'OutputKey':'VpcOriginId','OutputValue':WRAPPER.VPC_ORIGIN}]}
        class AWS:
            def call(self,*args,**kwargs):
                return {'ETag':'changed' if scenario=='same_ids_changed_version' else 'reviewed','Distribution':{'Status':'Deployed','DistributionConfig':{
                    'Origins':{'Items':[{'VpcOriginConfig':{'VpcOriginId':'california' if scenario=='california' else WRAPPER.VPC_ORIGIN}}]},
                    'WebACLId':'' if scenario=='missing_waf' else 'protected-acl'}}}
        return WRAPPER.guard_target(Deploy,AWS())

    def test_only_stable_oregon_with_waf_is_accepted(self):
        self.assertEqual(self.target('ok')['instance'],WRAPPER.INSTANCE)
        for scenario in ['migrating','california','missing_waf']:
            with self.subTest(scenario=scenario),self.assertRaises(RuntimeError): self.target(scenario)
        self.assertNotEqual(self.target('ok'),self.target('same_ids_changed_version'))

    def test_host_inspection_reports_aggregate_protection_without_secret_values(self):
        spec=importlib.util.spec_from_file_location('inspection_helper',ROOT/'scripts/deploy-dedicated-lobbies.py')
        helper=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        enhanced=WRAPPER.enhance_inspection(helper.INSPECT)
        self.assertIn("'protected':protected",enhanced)
        self.assertIn("'migrations':migrations",enhanced)
        self.assertNotIn('print(env_data)',enhanced)
        payload=enhanced.split("python3 - <<'BOLTS_INSPECT'\n",1)[1].rsplit('\nBOLTS_INSPECT',1)[0]
        compile(payload,'read-only-inspection','exec')


if __name__=='__main__':
    unittest.main(verbosity=2)
