#!/usr/bin/env python3
"""Deploy a reviewed directory/backend build and private admin configuration.

Default prepares and inspects only. --apply uses the existing guarded installer;
no infrastructure or regional capacity is created. The secret travels separately
through a verified private bucket and its exact temporary object version is removed.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lobby_release', ROOT / 'scripts/deploy-dedicated-lobbies.py')
lobby = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lobby)
deploy = lobby.deploy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--expected-release', required=True)
    parser.add_argument('--admin-env-file', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{64}', args.expected_release):
        parser.error('Invalid expected release')
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path = args.state / 'release.json'
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if previous.get('commandId') or previous.get('submissionAttempted'):
        raise deploy.DeploymentError('Installation already submitted; inspect recorded command before retrying.')
    if previous.get('privateObject') and not previous.get('privateObjectRemoved'):
        raise deploy.DeploymentError('Recover the recorded private staging object before preparing another release.')
    aws = deploy.AWS(apply=True)
    existing = deploy.backend(aws, 'bolts-gamelift', {
        'fleetRole': 'arn:aws:iam::780705957578:role/bolts-gamelift-game-role'})
    if existing['account'] != '780705957578' or existing['instance'] != 'i-0bd1adb3fc8b01688':
        raise deploy.DeploymentError('Unexpected account or host')
    bucket = existing['bucket']
    block = aws.call('s3api', 'get-public-access-block', '--bucket', bucket,
                     '--expected-bucket-owner', existing['account'], region=deploy.BACKEND_REGION)
    policy = aws.call('s3api', 'get-bucket-policy-status', '--bucket', bucket,
                      '--expected-bucket-owner', existing['account'], region=deploy.BACKEND_REGION)
    if not all(block['PublicAccessBlockConfiguration'].values()) or policy['PolicyStatus']['IsPublic']:
        raise deploy.DeploymentError('Release bucket must remain private')
    versioning = aws.call('s3api', 'get-bucket-versioning', '--bucket', bucket,
                          '--expected-bucket-owner', existing['account'], region=deploy.BACKEND_REGION)
    if versioning.get('Status') != 'Enabled':
        raise deploy.DeploymentError('Release bucket must have versioning enabled')
    command = deploy.ssm(aws, existing['instance'], lobby.INSPECT, args.state, 'Read-only TODO release preflight')
    before = json.loads(deploy.wait_ssm(aws, existing['instance'], command))
    deploy.save(args.state / 'before.json', before)
    if before['release'] != args.expected_release or before['integrity'] != 'ok' or before['foreignKeyErrors']:
        raise deploy.DeploymentError('Current release or database integrity changed')
    config = before['config']
    if config.get('extraLobbiesEnabled') is not False or config['api'] != 'https://bolts-api.christopherkrapu.com':
        raise deploy.DeploymentError('Unexpected live hosting configuration')
    provenance = json.loads((ROOT / 'artifacts/gamelift/build-provenance.json').read_text())
    for name, digest in provenance['sourceFiles'].items():
        if deploy.digest((ROOT / name).read_bytes()) != digest:
            raise deploy.DeploymentError('Build input changed: ' + name)
    files = {}
    for name in ('bolts-host', 'bolts-server'):
        data = (ROOT / 'artifacts/gamelift/bundle' / name).read_bytes()
        if data[:6] != b'\x7fELF\x02\x01' or int.from_bytes(data[18:20], 'little') != 62 or deploy.digest(data) != provenance['outputs'][name]:
            raise deploy.DeploymentError('Linux binary provenance mismatch: ' + name)
        files[name] = data
    archive = args.state / 'directory.tar.gz'
    release = deploy.directory_archive(files, config, config['fleet'], archive)
    state = {'release': release, 'expectedRelease': args.expected_release, 'backend': existing,
             'binaries': {name: deploy.digest(data) for name, data in files.items()},
             'sourceFiles': provenance['sourceFiles']}
    deploy.save(state_path, state)
    print(json.dumps({'preparedRelease': release, 'humans': before['humans']}), flush=True)
    if not args.apply:
        return
    if before['humans']:
        raise deploy.DeploymentError('Cutover deferred: human seats occupied')
    entries = [line.split('=', 1)[1].strip() for line in args.admin_env_file.read_text().splitlines()
               if line.startswith('BOLTS_ADMIN_API_KEY=')]
    if len(entries) != 1 or not re.fullmatch('[A-Za-z0-9]{32,128}', entries[0]):
        raise deploy.DeploymentError('Expected one generated admin key in the private env file')
    runtime = ('BOLTS_ADMIN_API_KEY=' + entries[0] + '\nBOLTS_MAX_ROOMS=11\n').encode()
    release_key = 'releases/gamelift/' + release + '.tar.gz'
    aws.call('s3', 'cp', archive, 's3://' + bucket + '/' + release_key, '--sse', 'AES256',
             '--only-show-errors', region=deploy.BACKEND_REGION, mutation=True, raw=True)
    secret_key = 'releases/private-runtime/' + str(uuid.uuid4())
    # Record the unique object name before upload. If the response is lost,
    # recovery can list this exact key's versions without exposing its content.
    state['privateObject'] = {'key': secret_key}
    deploy.save(state_path, state)
    descriptor, private_path = tempfile.mkstemp(prefix='.admin-runtime-', dir=args.state)
    uploaded = None
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(runtime)
        uploaded = aws.call('s3api', 'put-object', '--bucket', bucket,
                            '--expected-bucket-owner', existing['account'], '--key', secret_key,
                            '--body', private_path, '--server-side-encryption', 'AES256',
                            region=deploy.BACKEND_REGION, mutation=True)
    finally:
        Path(private_path).unlink(missing_ok=True)
    if not uploaded or not uploaded.get('VersionId'):
        raise deploy.DeploymentError('Expected versioned private object; inspect staging before proceeding')
    state['privateObject'] = {'key': secret_key, 'versionId': uploaded['VersionId']}
    deploy.save(state_path, state)
    remote = deploy.remote_install(bucket, release_key, release, args.expected_release)
    prepare, install = remote.rsplit('\n', 1)
    quote = shlex.quote
    remote = prepare + '\n' + '\n'.join([
        'private_runtime=$(mktemp /run/bolts-admin.XXXXXX)',
        'trap \'rm -f -- "$private_runtime"\' EXIT',
        'aws s3 cp ' + quote('s3://' + bucket + '/' + secret_key) + ' "$private_runtime" --region us-west-2 --only-show-errors',
        'printf "%s  %s\\n" ' + quote(deploy.digest(runtime)) + ' "$private_runtime" | sha256sum --check --status',
        install + ' "$private_runtime"',
    ])
    state['submissionAttempted'] = True
    deploy.save(state_path, state)
    try:
        command = deploy.ssm(aws, existing['instance'], remote, args.state, 'Deploy completed TODO fixes and read-only admin API')
    except BaseException:
        # Even if the command response was lost, deletion makes an unfetched
        # update fail safely. Inspect SSM before retrying: it may have started.
        aws.call('s3api', 'delete-object', '--bucket', bucket, '--expected-bucket-owner', existing['account'],
                 '--key', secret_key, '--version-id', uploaded['VersionId'],
                 region=deploy.BACKEND_REGION, mutation=True)
        state['privateObjectRemoved'] = True
        deploy.save(state_path, state)
        raise
    state['commandId'] = command
    deploy.save(state_path, state)
    print(json.dumps({'installCommand': command}), flush=True)
    # Keep recovery coordinates if interrupted; never blindly submit another cutover.
    try:
        print(deploy.wait_ssm(aws, existing['instance'], command), flush=True)
    finally:
        result = aws.call('ssm', 'get-command-invocation', '--command-id', command,
                          '--instance-id', existing['instance'], region=deploy.BACKEND_REGION)
        deploy.save(args.state / 'install-result.json', result)
        if result['Status'] not in {'Pending', 'InProgress', 'Delayed'}:
            aws.call('s3api', 'delete-object', '--bucket', bucket, '--expected-bucket-owner', existing['account'],
                     '--key', secret_key, '--version-id', uploaded['VersionId'],
                     region=deploy.BACKEND_REGION, mutation=True)
            state['privateObjectRemoved'] = True
            deploy.save(state_path, state)
    command = deploy.ssm(aws, existing['instance'], lobby.INSPECT, args.state, 'Read-only postrelease integrity verification')
    after = json.loads(deploy.wait_ssm(aws, existing['instance'], command))
    deploy.save(args.state / 'after.json', after)
    if after['release'] != release or after['binaries'] != state['binaries'] or after['integrity'] != 'ok' or after['foreignKeyErrors']:
        raise deploy.DeploymentError('Postrelease verification failed; inspect recorded evidence')
    print(json.dumps({'verifiedRelease': release,
                      'existingCredentialsUnchanged': before['credentialsDigest'] == after['credentialsDigest']}), flush=True)


if __name__ == '__main__':
    main()
