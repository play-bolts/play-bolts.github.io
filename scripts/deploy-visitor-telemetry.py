#!/usr/bin/env python3
"""Prepare/install the isolated telemetry build on the current Oregon host only.

Default performs read-only inspection and prepares a pinned archive. Only
--apply installs. No CloudFormation, WAF, California or GameLift capacity changes.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = '7fa4e4ab209ad103978eaafcba709eee56a3127d5f95a17f7d89bccdc53dd226'
INSTANCE = 'i-0bd1adb3fc8b01688'
VPC_ORIGIN = 'vo_6FCxsGVvm9nEDkf6vuFEbs'
EDGE = 'E1MT909KTPVXKW'
LOBBIES = [(f'Deathmatch {n}', 6) for n in range(1, 4)] + [('1v1 Alpha', 2), ('1v1 Beta', 2), ('1v1 Delta', 2)]
PROTECTED = ['/etc/bolts.env', '/etc/bolts-gamelift.json', '/etc/systemd/system/bolts.service.d/gamelift.conf', '/etc/systemd/system/bolts.service', '/etc/systemd/system/bolts-backup.service', '/etc/systemd/system/bolts-backup.timer', '/usr/local/libexec/bolts-backup']
INPUTS = {'server/Cargo.toml','server/Cargo.lock','server/schema.sql','src/generated/hitboxData.json','src/generated/handCollisionData.json','shared/actor-fields.json','shared/features.json','infra/gamelift/Dockerfile','scripts/benchmark-lobby-capacity.rs'}


def validate_inventory(deploy, source, commit, provenance, gateway_sha):
    expected = INPUTS | {str(path.relative_to(source)) for path in (source/'server/src').glob('*.rs')}
    preserved = provenance.get('preservedGateway', {})
    if (set(provenance.get('sourceFiles', {})) != expected or provenance.get('commit') != commit
            or preserved.get('release') != EXPECTED or preserved.get('sha256') != gateway_sha):
        raise deploy.DeploymentError('Incomplete committed Rust input inventory or preserved gateway provenance')


def guard_target(deploy, aws):
    stack = deploy.describe_stack(aws, 'bolts-backend', 'us-west-2')
    if not stack or stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        raise deploy.DeploymentError('Backend stack changed or is migrating')
    outputs = {row['OutputKey']: row['OutputValue'] for row in stack['Outputs']}
    response = aws.call('cloudfront', 'get-distribution', '--id', EDGE, region='us-east-1')
    edge = response['Distribution']
    origins = edge['DistributionConfig']['Origins']['Items']
    if (outputs.get('InstanceId') != INSTANCE or outputs.get('VpcOriginId') != VPC_ORIGIN
            or edge['Status'] != 'Deployed' or len(origins) != 1
            or origins[0].get('VpcOriginConfig', {}).get('VpcOriginId') != VPC_ORIGIN
            or not edge['DistributionConfig'].get('WebACLId')):
        raise deploy.DeploymentError('Production ingress changed; inspect concurrent migration before deploying')
    return {'instance': INSTANCE, 'region': 'us-west-2', 'vpcOrigin': VPC_ORIGIN,
            'webAclId': edge['DistributionConfig']['WebACLId'], 'distribution': EDGE,
            'etag': response['ETag'],
            'distributionConfigSha256': hashlib.sha256(json.dumps(edge['DistributionConfig'],sort_keys=True).encode()).hexdigest()}


def enhance_inspection(base):
    addition = "migrations=[r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')]\n"
    addition += "counts={name:db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in ['players','connections','events','visitors','visitor_activity']}\n"
    addition += 'protected={name:{"sha256":hashlib.sha256(Path(name).read_bytes()).hexdigest(),"mode":Path(name).stat().st_mode & 0o777} for name in ' + repr(PROTECTED) + '}\n'
    assert base.count('db.close()') == 1 and base.count("'schemaDigest':schema_digest,") == 1
    return base.replace('db.close()', addition + 'db.close()').replace(
        "'schemaDigest':schema_digest,", "'schemaDigest':schema_digest,'migrations':migrations,'counts':counts,'protected':protected,")


def validate_observed(deploy, before, after):
    if after is None:
        env = before['environment']
        if before['humans'] or env['maxRooms'] != '6' or not env['adminKeyConfigured'] or env['mode'] != '0o600':
            raise deploy.DeploymentError('Expected empty six-room host with private admin configuration')
        if [(r['name'], r['capacity']) for r in before['catalog']['lobbies']] != LOBBIES or before['catalog']['locations']:
            raise deploy.DeploymentError('Local lobby inventory changed')
        return
    if after['environment'] != before['environment'] or after['config'] != before['config'] or after['protected'] != before['protected']:
        raise deploy.DeploymentError('Protected host configuration changed')
    if after['credentialsDigest'] != before['credentialsDigest']:
        raise deploy.DeploymentError('Human identity inventory changed during cutover; inspect the retained checkpoint')
    if not set(before['migrations']).issubset(after['migrations']) or 5 not in after['migrations']:
        raise deploy.DeploymentError('Telemetry migration missing or prior migration lost')
    if any(after['counts'][name] < count for name, count in before['counts'].items()):
        raise deploy.DeploymentError('Existing records were removed')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--commit', required=True, help='Exact committed build input snapshot')
    parser.add_argument('--state-root', type=Path, default=ROOT / 'temp/visitor-telemetry-release')
    parser.add_argument('--expected-release', default=EXPECTED)
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if not re.fullmatch('[a-f0-9]{40}', args.commit) or args.expected_release != EXPECTED:
        parser.error('The reviewed commit and expected live release are required')
    source = args.source.resolve(strict=True)
    spec = importlib.util.spec_from_file_location('telemetry_dedicated_release', source / 'scripts/deploy-dedicated-lobbies.py')
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    deploy = release.deploy
    release.ROOT, release.BUILD, release.OUT = source, source / 'artifacts/gamelift', args.state_root.resolve()
    release.OUT.mkdir(parents=True, exist_ok=True)
    release.EXPECTED, release.EXPECTED_LOBBIES = args.expected_release, LOBBIES
    release.INSTALLER = (ROOT / 'scripts/install-visitor-telemetry.sh').read_bytes()
    release.INSPECT = enhance_inspection(release.INSPECT)
    aws = deploy.AWS(apply=True)
    ingress = guard_target(deploy, aws)
    deploy.save(release.OUT / 'ingress-before.json', ingress)
    deploy.save(release.OUT / 'committed-source.json', {'commit': args.commit, 'source': str(source)})

    observed = {}
    def validate(before, after):
        validate_observed(deploy, before, after)
        if after is None:
            observed.update(before)
            if guard_target(deploy, aws) != ingress:
                raise deploy.DeploymentError('Ingress changed during inspection')
        elif guard_target(deploy, aws) != ingress:
            raise deploy.DeploymentError('Ingress changed during installation; inspect concurrent migration')
    release.VALIDATE_OBSERVED = validate

    def validate_build(provenance, files):
        validate_inventory(deploy, source, args.commit, provenance, observed['binaries']['bolts-host'])
        for name, digest in provenance['sourceFiles'].items():
            committed = subprocess.run(['git', 'show', args.commit + ':' + name], cwd=ROOT,
                                       capture_output=True, check=True).stdout
            if hashlib.sha256(committed).hexdigest() != digest:
                raise deploy.DeploymentError('Build input is not from the selected commit: ' + name)
        if deploy.digest(files['bolts-host']) != observed['binaries']['bolts-host']:
            raise deploy.DeploymentError('The current gateway binary must be preserved byte-for-byte')
        if deploy.digest(files['bolts-server']) == observed['binaries']['bolts-server']:
            raise deploy.DeploymentError('Rust binary still matches the prior release')
        if guard_target(deploy, aws) != ingress:
            raise deploy.DeploymentError('Ingress changed before install')
    release.VALIDATE_BUILD = validate_build
    # The reused helper calls remote_install after uploading the pinned archive,
    # immediately before submitting its SSM cutover. Recheck the complete edge
    # version here, beyond the earlier build/provenance inspection.
    remote_install = deploy.remote_install
    def guarded_remote_install(*arguments):
        if guard_target(deploy, aws) != ingress:
            raise deploy.DeploymentError('Ingress changed immediately before cutover; no installation submitted')
        return remote_install(*arguments)
    deploy.remote_install = guarded_remote_install
    sys.argv = [sys.argv[0]] + (['--inspect'] if args.inspect else []) + (['--apply'] if args.apply else [])
    release.main()


if __name__ == '__main__':
    main()
