#!/usr/bin/env python3
"""Prepare/install three fixed Deathmatches on the existing Oregon host.

The isolated build preserves the exact deployed gateway. Changed inputs are
hub.rs and its Rust/Go inventory tests. --inspect reads live metadata. Default prepares a
checksum-pinned archive; --apply installs only with empty human seats. No
infrastructure, WAF, regional capacity, database or secrets are changed.
"""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dedicated_release', ROOT / 'scripts/deploy-dedicated-lobbies.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
deploy = release.deploy
SOURCE = ROOT / 'temp/three-deathmatches/source'
BASELINE_STATE = ROOT / 'temp/todo-deploy/release-state/release.json'
EXPECTED = '5bdd59c9933ede00c4af61db2199153c8d5949f9fd5a6308f1999530d45aab3a'
BASELINE_BINARIES = {
    'bolts-host': 'a31436c29f1772d763e9ad970a2197228651a84b5162cae03eed662d80a217da',
    'bolts-server': 'f8894b31005db8003a35c763bf2764011656d940435f52e4d63a43f8680e854f',
}
EXPECTED_LOBBIES = [(f'Deathmatch {n}', 6) for n in range(1, 4)] + [
    ('1v1 Alpha', 2), ('1v1 Beta', 2), ('1v1 Delta', 2)]
INSTALLER = ROOT / 'scripts/install-three-deathmatches.sh'


def validate_observed(before, after):
    if after is None:
        if before['binaries'] != BASELINE_BINARIES:
            raise deploy.DeploymentError('Live binaries do not match the reviewed baseline')
        env = before['environment']
        if env['maxRooms'] != '11' or not env['adminKeyConfigured'] or env['mode'] != '0o600':
            raise deploy.DeploymentError('Unexpected live room cap or private environment configuration')
        return
    expected = dict(before['environment'], maxRooms='6')
    if after['environment'] != expected:
        raise deploy.DeploymentError('Environment verification failed: only room cap may change')
    if after['config'] != before['config'] or after['schemaDigest'] != before['schemaDigest']:
        raise deploy.DeploymentError('Hosting configuration or database schema changed unexpectedly')


def validate_build(provenance, files):
    baseline = json.loads(BASELINE_STATE.read_text())
    if baseline['release'] != EXPECTED or baseline['binaries'] != BASELINE_BINARIES:
        raise deploy.DeploymentError('Baseline deployment evidence changed')
    old = baseline['sourceFiles']
    new = provenance['sourceFiles']
    allowed = {'server/src/hub.rs', 'server/src/hub_tests.rs', 'server/gamelift/hybrid_test.go'}
    changed = {path for path in old.keys() | new.keys() if old.get(path) != new.get(path)}
    if set(old) != set(new) or changed != allowed:
        raise deploy.DeploymentError('Build must change only the reviewed hub and inventory tests')
    if deploy.digest(files['bolts-host']) != BASELINE_BINARIES['bolts-host']:
        raise deploy.DeploymentError('The deployed Go gateway binary must be preserved exactly')
    if deploy.digest(files['bolts-server']) == BASELINE_BINARIES['bolts-server']:
        raise deploy.DeploymentError('Rust binary still matches the previous room inventory')


def main():
    release.OUT = ROOT / 'temp/three-deathmatches/backend'
    release.ROOT = SOURCE
    release.BUILD = SOURCE / 'artifacts/gamelift'
    release.EXPECTED = EXPECTED
    release.EXPECTED_LOBBIES = EXPECTED_LOBBIES
    release.INSTALLER = INSTALLER.read_bytes()
    release.VALIDATE_OBSERVED = validate_observed
    release.VALIDATE_BUILD = validate_build
    release.main()


if __name__ == '__main__':
    main()
