#!/usr/bin/env python3
"""Install the dedicated-lobby release on the existing Oregon host only.

--inspect reads release, occupancy and persistence metadata through SSM.
Default prepares a checksum-pinned archive. --apply uses the existing guarded
installer, with empty-seat checks, backups and rollback. No infrastructure or
regional capacity is provisioned. Evidence and resumable state live in temp/.
"""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/dedicated-lobbies'
BUILD = ROOT / 'artifacts/gamelift'
EXPECTED = 'e3c3a4c105618faa13d89843566de75ae1f1a399364066f235349bde60bd6ae4'
FLEET = 'fleet-84aaebc2-b484-4822-83c1-3efefb720c06'
spec = importlib.util.spec_from_file_location('deploy', ROOT / 'scripts/deploy-gamelift.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

INSPECT = r'''set -euo pipefail
python3 - <<'BOLTS_INSPECT'
import hashlib,json,os,re,sqlite3,urllib.request
from pathlib import Path
path=os.readlink('/opt/bolts/current')
assert re.fullmatch(r'/opt/bolts/releases/[a-f0-9]{64}',path)
config=json.loads(Path('/etc/bolts-gamelift.json').read_text())
assert set(config)<=set(('extraLobbiesEnabled','region','fleet','fleetRole','secretParameter','api','origins','locations'))
with urllib.request.urlopen('http://127.0.0.1:8080/api/lobbies',timeout=10) as source: catalog=json.load(source)
rooms=catalog['lobbies']
assert isinstance(rooms,list) and all(type(r.get('players')) is int and r['players']>=0 for r in rooms)
db=sqlite3.connect('file:/var/lib/bolts/bolts.sqlite?mode=ro',uri=True)
db.execute('PRAGMA query_only=ON')
credentials=db.execute('SELECT id,credential_hash FROM players WHERE is_bot=0 ORDER BY id').fetchall()
integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
foreign_keys=len(db.execute('PRAGMA foreign_key_check').fetchall())
db.close()
print(json.dumps({'release':path.rsplit('/',1)[1],'humans':sum(r['players'] for r in rooms),'config':config,'catalog':catalog,'identities':len(credentials),'credentialsDigest':hashlib.sha256(json.dumps(credentials).encode()).hexdigest(),'integrity':integrity,'foreignKeyErrors':foreign_keys,'binaries':{name:hashlib.sha256(Path(path,name).read_bytes()).hexdigest() for name in ('bolts-host','bolts-server')}}))
BOLTS_INSPECT
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    aws = deploy.AWS(apply=True)
    existing = deploy.backend(aws, 'bolts-gamelift', {
        'fleetRole': 'arn:aws:iam::780705957578:role/bolts-gamelift-game-role'})
    command = deploy.ssm(aws, existing['instance'], INSPECT, OUT,
                         'Bolts dedicated lobby read-only inspection')
    observed = json.loads(deploy.wait_ssm(aws, existing['instance'], command))
    deploy.save(OUT / 'inspection.json', dict(observed, commandId=command, backend=existing))
    print(json.dumps({key: observed[key] for key in ('release', 'humans', 'identities', 'integrity', 'foreignKeyErrors', 'catalog')}), flush=True)
    if args.inspect:
        return
    if observed['release'] != EXPECTED or observed['integrity'] != 'ok' or observed['foreignKeyErrors']:
        raise deploy.DeploymentError('Unexpected live release or database health')
    config = observed['config']
    if config['fleet'] != FLEET or config['api'] != 'https://bolts-api.christopherkrapu.com' or config.get('extraLobbiesEnabled') is not False:
        raise deploy.DeploymentError('Unexpected live hosting configuration')
    provenance = json.loads((BUILD / 'build-provenance.json').read_text())
    for name, sha in provenance['sourceFiles'].items():
        if deploy.digest((ROOT / name).read_bytes()) != sha:
            raise deploy.DeploymentError('Build source changed: ' + name)
    files = {}
    for name in ('bolts-host', 'bolts-server'):
        data = (BUILD / 'bundle' / name).read_bytes()
        if deploy.digest(data) != provenance['outputs'][name] or data[:4] != b'\x7fELF':
            raise deploy.DeploymentError('Linux binary mismatch: ' + name)
        files[name] = data
    archive = OUT / 'directory.tar.gz'
    release = deploy.directory_archive(files, config, FLEET, archive)
    state_path = OUT / 'release.json'
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if previous.get('commandId'):
        raise deploy.DeploymentError('Install already submitted; inspect its recorded command before retrying')
    state = {'release': release, 'expectedRelease': EXPECTED, 'backend': existing,
             'binaries': {name: deploy.digest(data) for name, data in files.items()},
             'before': observed, 'sourceFiles': provenance['sourceFiles']}
    deploy.save(state_path, state)
    print(json.dumps({'preparedRelease': release, 'instance': existing['instance']}), flush=True)
    if not args.apply:
        return
    if observed['humans']:
        raise deploy.DeploymentError('Cutover deferred: a human seat is occupied')
    key = 'releases/gamelift/' + release + '.tar.gz'
    aws.call('s3', 'cp', archive, f"s3://{existing['bucket']}/{key}", '--sse', 'AES256',
             '--only-show-errors', region=deploy.BACKEND_REGION, mutation=True, raw=True)
    command = deploy.ssm(aws, existing['instance'],
                         deploy.remote_install(existing['bucket'], key, release, EXPECTED),
                         OUT, 'Bolts browser join fix and dedicated local duel rooms')
    state['commandId'] = command
    deploy.save(state_path, state)
    print(deploy.wait_ssm(aws, existing['instance'], command), flush=True)
    command = deploy.ssm(aws, existing['instance'], INSPECT, OUT,
                         'Bolts dedicated lobby postrelease integrity verification')
    after = json.loads(deploy.wait_ssm(aws, existing['instance'], command))
    deploy.save(OUT / 'postrelease.json', dict(after, commandId=command))
    if after['release'] != release or after['binaries'] != state['binaries'] or after['integrity'] != 'ok' or after['foreignKeyErrors']:
        raise deploy.DeploymentError('Postrelease verification failed; inspect evidence')
    expected = [('Deathmatch', 6), ('1v1 Alpha', 2), ('1v1 Beta', 2), ('1v1 Delta', 2)]
    if [(r['name'], r['capacity']) for r in after['catalog']['lobbies']] != expected or after['catalog']['locations']:
        raise deploy.DeploymentError('Unexpected dedicated lobby inventory')
    print(json.dumps({'verifiedRelease': release, 'lobbies': expected,
                      'existingCredentialsUnchanged': after['credentialsDigest'] == observed['credentialsDigest']}), flush=True)


if __name__ == '__main__':
    main()
