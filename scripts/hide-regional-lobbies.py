#!/usr/bin/env python3
"""Disable production regional discovery using the tested directory-only release.

Default: inspect the host and prepare a checksum-pinned archive locally.
--apply: install through the existing guarded S3/SSM release path, only if empty.
Never changes fleet capacity, queues, IAM, workers, frontend, or the Rust binary.
"""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/hide-regional-lobbies'
OLD = ROOT / 'temp/regional-release-v22/artifacts/gamelift/bundle'
NEW = ROOT / 'temp/regional-fix-release'
FLEET = 'fleet-84aaebc2-b484-4822-83c1-3efefb720c06'
EXPECTED = 'd9ec241535a5586dabc1981ca9a64cdae522ba343bd4e8a8a0e4de302d50ee67'
spec = importlib.util.spec_from_file_location('directory_deploy', ROOT / 'scripts/deploy-gamelift.py')
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
qa=db.execute("SELECT count(*) FROM memberships m JOIN players p ON p.id=m.player_id WHERE m.left_at IS NULL AND p.is_bot=0 AND m.name_at_join LIKE 'QA Regions %' AND m.joined_at BETWEEN 1792642871349 AND 1792642886349").fetchone()[0]
db.close()
print(json.dumps({'release':path.rsplit('/',1)[1],'humans':sum(r['players'] for r in rooms),'initialQaMembershipsStillOpen':qa,'config':config,'catalog':catalog,'rustSha256':hashlib.sha256(Path(path,'bolts-server').read_bytes()).hexdigest()}))
BOLTS_INSPECT
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if json.loads((ROOT / 'shared/features.json').read_text()).get('extraLobbies') is not False:
        raise deploy.DeploymentError('The source release must keep extra lobbies disabled')
    validation = json.loads((NEW / 'validation.json').read_text())
    host = (NEW / 'bolts-host').read_bytes()
    if deploy.digest(host) != validation['binarySha256'] or not host.startswith(b'\x7fELF'):
        raise deploy.DeploymentError('The tested Linux gateway changed')
    if validation['commit'] != '25ba13f3718b34acbe5f87a77a8169665d18f446':
        raise deploy.DeploymentError('Unexpected gateway source commit')
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    aws = deploy.AWS(apply=True)
    existing = deploy.backend(aws, 'bolts-gamelift', json.loads((OLD / 'host.json').read_text()))
    command = deploy.ssm(aws, existing['instance'], INSPECT, OUT,
                         'Bolts read-only regional-discovery deployment inspection')
    observed = json.loads(deploy.wait_ssm(aws, existing['instance'], command))
    deploy.save(OUT / 'inspection.json', dict(observed, commandId=command))
    rust = (OLD / 'bolts-server').read_bytes()
    config = observed['config']
    if observed['release'] != EXPECTED or deploy.digest(rust) != observed['rustSha256']:
        raise deploy.DeploymentError('Live release/Rust differs; refusing replacement')
    if config['fleet'] != FLEET or config['api'] != 'https://bolts-api.christopherkrapu.com':
        raise deploy.DeploymentError('Unexpected fleet/API configuration')
    config = dict(config, extraLobbiesEnabled=False)
    files = {'bolts-host': host, 'bolts-server': rust}
    archive = OUT / 'directory.tar.gz'
    release = deploy.directory_archive(files, config, FLEET, archive)
    state = {'mode': 'hide-disabled-regions', 'gatewayCommit': validation['commit'],
             'directoryRelease': release, 'expectedRelease': EXPECTED,
             'fleetId': FLEET, 'rustSha256': observed['rustSha256'],
             'extraLobbiesEnabled': False}
    state_path = OUT / 'release.json'
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if previous.get('directoryCommandId'):
        raise deploy.DeploymentError('An install was submitted already; inspect its recorded result')
    deploy.save(state_path, state)
    print(json.dumps({'preparedRelease': release, 'humans': observed['humans'],
                      'initialQaMembershipsStillOpen': observed['initialQaMembershipsStillOpen'],
                      'extraLobbiesEnabled': False, 'rustUnchanged': True}), flush=True)
    if not args.apply:
        return
    if observed['humans'] != 0:
        raise deploy.DeploymentError('Cutover deferred: a human seat is occupied')
    key = 'releases/gamelift/' + release + '.tar.gz'
    aws.call('s3', 'cp', archive, f"s3://{existing['bucket']}/{key}", '--sse', 'AES256',
             '--only-show-errors', region=deploy.BACKEND_REGION, mutation=True, raw=True)
    command = deploy.ssm(aws, existing['instance'],
                         deploy.remote_install(existing['bucket'], key, release, EXPECTED),
                         OUT, 'Bolts hide disabled regional lobby options')
    state['directoryCommandId'] = command
    deploy.save(state_path, state)
    print(deploy.wait_ssm(aws, existing['instance'], command), flush=True)


if __name__ == '__main__':
    main()
