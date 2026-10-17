#!/usr/bin/env python3
"""Prepare or resume the reviewed three-city GameLift rollout.

Default: validate local artifacts and write a plan. --check adds read-only AWS
checks. Only --apply can mutate AWS; --phase selects build, fleet, directory or
all. The existing Oregon instance, database, identity salt and backups remain.
"""
import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REGION = 'us-east-1'
BACKEND_REGION = 'us-west-2'
LOCATIONS = {'lon': 'eu-west-2', 'sg': 'ap-southeast-1', 'sp': 'sa-east-1'}
BUNDLE_FILES = {'bolts-host', 'bolts-server', 'host.json', 'install.sh'}
SECRET = '/bolts/gamelift/cluster-secret'
SHA = re.compile(r'^[a-f0-9]{64}$')


class DeploymentError(RuntimeError):
    pass


class AwsError(DeploymentError):
    def __init__(self, service, operation, code):
        self.code = code
        super().__init__(f'AWS {service} {operation} failed ({code}); inspect AWS privately.')


class AWS:
    def __init__(self, apply=False):
        self.apply = apply

    def call(self, service, operation, *args, region=REGION, mutation=False, env=None, raw=False):
        if mutation and not self.apply:
            raise DeploymentError('AWS mutations require --apply')
        command = [sys.executable, str(ROOT / 'scripts/aws-command.py'), '--region', region,
                   service, operation, *map(str, args)]
        if not raw:
            command += ['--output', 'json']
        result = subprocess.run(command, capture_output=True, text=True, env=env)
        if result.returncode:
            # Never echo CLI output: create-build and upload requests can carry
            # temporary credentials, and put-parameter carries the cluster key.
            found = re.search(r'An error occurred \(([A-Za-z0-9_.-]+)\)', result.stderr)
            raise AwsError(service, operation, found.group(1) if found else 'CLIError')
        return result.stdout if raw else (json.loads(result.stdout) if result.stdout.strip() else {})


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.deploy-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_capacity(template):
    def reject_managed_capacity(value):
        if isinstance(value, dict):
            if 'ManagedCapacityConfiguration' in value:
                raise DeploymentError('ManagedCapacityConfiguration must be absent; automatic scale-to-zero is not allowed')
            for child in value.values(): reject_managed_capacity(child)
        elif isinstance(value, list):
            for child in value: reject_managed_capacity(child)
    reject_managed_capacity(template)
    fleet = template['Resources']['Fleet']['Properties']
    capacities = {loc['Location']: loc['LocationCapacity'] for loc in fleet['Locations']}
    if set(capacities) != {REGION, *LOCATIONS.values()} or len(fleet['Locations']) != 4:
        raise DeploymentError('Fleet template contains unexpected or duplicate locations')
    maximum = template.get('Parameters', {}).get('MaximumInstancesPerLocation', {}).get('Default')
    for location in LOCATIONS.values():
        capacity = capacities[location]
        if any(type(capacity.get(field)) is not int or capacity[field] != 1 for field in ('MinSize', 'DesiredEC2Instances')):
            raise DeploymentError('Each requested city must retain one warm instance')
        limit = capacity.get('MaxSize')
        if not (type(limit) is int and limit == 2) and not (limit == {'Ref': 'MaximumInstancesPerLocation'} and type(maximum) is int and maximum == 2):
            raise DeploymentError('Each requested city must be capped at two instances')
    if any(type(capacities[REGION].get(field)) is not int or capacities[REGION][field] != 0 for field in ('MinSize', 'DesiredEC2Instances', 'MaxSize')):
        raise DeploymentError('Fleet home region minimum, desired and maximum must all be zero')


def local_artifacts(build_dir, stack):
    bundle = build_dir / 'bundle'
    if not bundle.is_dir() or {p.name for p in bundle.iterdir()} != BUNDLE_FILES:
        raise DeploymentError('Build must contain exactly the four allowlisted bundle files; run prepare-gamelift.py --build')
    manifest = json.loads((build_dir / 'manifest.json').read_text())
    provenance = json.loads((build_dir / 'build-provenance.json').read_text())
    if set(manifest) != BUNDLE_FILES or provenance.get('outputs') != manifest:
        raise DeploymentError('Build provenance/manifest mismatch')
    files = {}
    for name in sorted(BUNDLE_FILES):
        path = bundle / name
        if not path.is_file() or path.is_symlink():
            raise DeploymentError('Bundle contains a non-regular file')
        files[name] = path.read_bytes()
        if not SHA.fullmatch(manifest[name]) or digest(files[name]) != manifest[name]:
            raise DeploymentError('Bundle checksum mismatch: ' + name)
    for name in ('bolts-host', 'bolts-server'):
        value = files[name]
        if len(value) < 20 or value[:6] != b'\x7fELF\x02\x01' or value[18:20] != b'\x3e\x00':
            raise DeploymentError(name + ' must be a Linux x86_64 executable')
    sources = provenance.get('sourceFiles', {})
    if not sources or digest(files['host.json']) != provenance.get('configSha256'):
        raise DeploymentError('Missing or invalid build source provenance')
    for name, expected in sources.items():
        path = ROOT / name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected:
            raise DeploymentError('Source changed after build: ' + name)
    config = json.loads(files['host.json'])
    if {loc['id']: loc['aws'] for loc in config['locations']} != LOCATIONS or len(config['locations']) != 3:
        raise DeploymentError('Deploy exactly London, Singapore and São Paulo; New York is excluded')
    if config.get('region') != REGION or config.get('secretParameter') != SECRET or config.get('api') != 'https://bolts-api.christopherkrapu.com':
        raise DeploymentError('Unexpected cluster region, secret parameter or central API')
    for loc in config['locations']:
        if loc['queue'] != stack + '-' + loc['id']:
            raise DeploymentError('Queue names do not match the deployment stack')
    template_path = build_dir / 'fleet.template.json'
    template = json.loads(template_path.read_text())
    if template != runpy.run_path(str(ROOT / 'scripts/prepare-gamelift.py'))['template']():
        raise DeploymentError('Generated fleet template differs from its reviewed source')
    validate_capacity(template)
    return files, config, template_path


def build_zip(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name in {'bolts-host', 'bolts-server', 'install.sh'} else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return output.getvalue()


def describe_stack(aws, name, region):
    try:
        return aws.call('cloudformation', 'describe-stacks', '--stack-name', name, region=region)['Stacks'][0]
    except AwsError as error:
        # ValidationError can also mean malformed input; names are checked before
        # calling, and create-stack still rejects conflicting existing stacks.
        if error.code == 'ValidationError':
            return None
        raise


def backend(aws, stack, config):
    account = aws.call('sts', 'get-caller-identity')['Account']
    if config.get('fleetRole') != f'arn:aws:iam::{account}:role/{stack}-game-role':
        raise DeploymentError('Bundle account/role does not match current AWS identity')
    state = describe_stack(aws, 'bolts-backend', BACKEND_REGION)
    if not state or state['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
        raise DeploymentError('The existing Oregon backend stack must be stable')
    outputs = {row['OutputKey']: row['OutputValue'] for row in state['Outputs']}
    role = aws.call('cloudformation', 'describe-stack-resource', '--stack-name', 'bolts-backend',
                    '--logical-resource-id', 'InstanceRole', region=BACKEND_REGION)['StackResourceDetail']['PhysicalResourceId']
    if not re.fullmatch(r'[A-Za-z0-9+=,.@_-]{1,64}', role) or not re.fullmatch(r'i-[a-f0-9]+', outputs.get('InstanceId', '')) or not re.fullmatch(r'[a-z0-9-]+', outputs.get('StorageBucket', '')):
        raise DeploymentError('Unexpected existing backend resource identifiers')
    return {'account': account, 'role': role, 'instance': outputs['InstanceId'], 'bucket': outputs['StorageBucket']}


def capacity_checks(aws):
    result = []
    for location in LOCATIONS.values():
        rows = aws.call('gamelift', 'describe-ec2-instance-limits', '--ec2-instance-type', 'c7i.large', '--location', location)['EC2InstanceLimits']
        limit = next((row.get('InstanceLimit', 0) for row in rows if row.get('EC2InstanceType') == 'c7i.large'), 0)
        result.append({'location': location, 'allowance': limit, 'ok': limit >= 2})
    return result


def ensure_secret(aws, directory):
    rows = aws.call('ssm', 'describe-parameters', '--parameter-filters', 'Key=Name,Option=Equals,Values=' + SECRET).get('Parameters', [])
    if rows:
        if len(rows) != 1 or rows[0].get('Type') != 'SecureString':
            raise DeploymentError('Existing cluster parameter must be SecureString')
        return
    descriptor, name = tempfile.mkstemp(prefix='.cluster-key-', suffix='.json', dir=directory)
    try:
        with os.fdopen(descriptor, 'w') as out:
            json.dump({'Name': SECRET, 'Type': 'SecureString', 'Tier': 'Standard', 'Value': secrets.token_hex(32), 'Overwrite': False}, out)
        try:
            aws.call('ssm', 'put-parameter', '--cli-input-json', 'file://' + name, mutation=True)
        except AwsError as error:
            if error.code != 'ParameterAlreadyExists':
                raise
            ensure_secret(aws, directory)
    finally:
        os.unlink(name)


def ensure_build(aws, archive, sha, state, state_path, stack):
    name = stack + '-' + sha
    if state.get('buildId'):
        build = aws.call('gamelift', 'describe-build', '--build-id', state['buildId'])['Build']
    else:
        matches = [b for b in aws.call('gamelift', 'list-builds').get('Builds', []) if b.get('Name') == name and b.get('Version') == sha]
        if len(matches) > 1:
            raise DeploymentError('Multiple matching builds exist; inspect before resuming')
        if matches:
            build = matches[0]
        else:
            if state.get('buildCreationStarted'):
                raise DeploymentError('An earlier build creation was interrupted and is not listed yet; inspect AWS before retrying instead of creating a duplicate')
            state['buildCreationStarted'] = True
            save(state_path, state)
            # Persist only the build identity, never UploadCredentials.
            build = aws.call('gamelift', 'create-build', '--name', name, '--build-version', sha,
                             '--operating-system', 'AMAZON_LINUX_2023', '--server-sdk-version', '5.6.0', mutation=True)['Build']
        state['buildId'] = build['BuildId']
        state.pop('buildCreationStarted', None)
        save(state_path, state)
    if build.get('Name') != name or build.get('Version') != sha or build.get('OperatingSystem') != 'AMAZON_LINUX_2023':
        raise DeploymentError('Persisted build does not match the reviewed artifact')
    if build['Status'] == 'FAILED':
        raise DeploymentError('Matching build failed; inspect it instead of creating duplicates')
    if build['Status'] == 'INITIALIZED' and not state.get('buildUploaded'):
        credentials = aws.call('gamelift', 'request-upload-credentials', '--build-id', state['buildId'], mutation=True)
        upload = credentials['UploadCredentials']
        location = credentials['StorageLocation']
        env = {key: value for key, value in os.environ.items() if not key.startswith('AWS_')}
        env.update({'AWS_ACCESS_KEY_ID': upload['AccessKeyId'], 'AWS_SECRET_ACCESS_KEY': upload['SecretAccessKey'],
                    'AWS_SESSION_TOKEN': upload['SessionToken'], 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null', 'AWS_CONFIG_FILE': '/dev/null'})
        aws.call('s3', 'cp', archive, f"s3://{location['Bucket']}/{location['Key']}", '--only-show-errors', mutation=True, env=env, raw=True)
        state['buildUploaded'] = True
        save(state_path, state)
    deadline = time.monotonic() + 900
    while build['Status'] != 'READY':
        if build['Status'] == 'FAILED' or time.monotonic() > deadline:
            raise DeploymentError('Build not ready; resume using the recorded build ID')
        time.sleep(10)
        build = aws.call('gamelift', 'describe-build', '--build-id', state['buildId'])['Build']
    print('GameLift build ready: ' + state['buildId'], flush=True)
    return state['buildId']


def wait_stack(aws, stack, timeout=3600):
    deadline = time.monotonic() + timeout
    last = ''
    while time.monotonic() < deadline:
        value = describe_stack(aws, stack, REGION)
        if not value:
            raise DeploymentError('Fleet stack disappeared; inspect AWS before retrying')
        status = value['StackStatus']
        if status != last:
            print('Fleet stack: ' + status, flush=True)
            last = status
        if status in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
            return value
        if not status.endswith('_IN_PROGRESS'):
            raise DeploymentError('Fleet stack ' + status + '; inspect stack events, no automatic delete or duplicate fleet')
        time.sleep(15)
    raise DeploymentError('Fleet stack still running; resume this state directory')


def ensure_fleet(aws, stack, template, build_id, existing, directory):
    checks = capacity_checks(aws)
    if not all(row['ok'] for row in checks):
        raise DeploymentError('GameLift allowance is insufficient: ' + json.dumps(checks))
    before = describe_stack(aws, stack, REGION)
    if before and before['StackStatus'].endswith('_IN_PROGRESS'):
        before = wait_stack(aws, stack)
    if before and before['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
        raise DeploymentError('Existing fleet stack is not stable; inspect it before retrying')
    previous_build = next((p['ParameterValue'] for p in (before or {}).get('Parameters', []) if p['ParameterKey'] == 'BuildId'), None)
    if previous_build and previous_build != build_id:
        raise DeploymentError('Fleet replacement requires a separate drained rollout; refusing to hide an existing fleet')
    aws.call('cloudformation', 'validate-template', '--template-body', 'file://' + str(template))
    ensure_secret(aws, directory)
    parameters = directory / 'fleet-parameters.json'
    save(parameters, [{'ParameterKey': 'BuildId', 'ParameterValue': build_id},
                      {'ParameterKey': 'DirectoryRoleName', 'ParameterValue': existing['role']},
                      {'ParameterKey': 'MaximumInstancesPerLocation', 'ParameterValue': '2'}])
    # Comparing exact templates/parameters avoids using stderr text to recognize
    # a no-op update while keeping all credential-bearing errors redacted.
    same = False
    if before:
        deployed = aws.call('cloudformation', 'get-template', '--stack-name', stack)['TemplateBody']
        if isinstance(deployed, str): deployed = json.loads(deployed)
        old_parameters = {p['ParameterKey']: p['ParameterValue'] for p in before.get('Parameters', [])}
        same = deployed == json.loads(template.read_text()) and all(old_parameters.get(p['ParameterKey']) == p['ParameterValue'] for p in json.loads(parameters.read_text()))
    if not same:
        aws.call('cloudformation', 'update-stack' if before else 'create-stack', '--stack-name', stack,
                 '--template-body', 'file://' + str(template), '--parameters', 'file://' + str(parameters),
                 '--capabilities', 'CAPABILITY_NAMED_IAM', mutation=True)
    result = wait_stack(aws, stack)
    outputs = {row['OutputKey']: row['OutputValue'] for row in result['Outputs']}
    fleet = outputs['FleetId']
    wait_fleet(aws, fleet)
    return fleet


def wait_fleet(aws, fleet, timeout=1800):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        attributes = aws.call('gamelift', 'describe-fleet-location-attributes', '--fleet-id', fleet)['LocationAttributes']
        states = {row['LocationState']['Location']: row['LocationState']['Status'] for row in attributes}
        if any(states.get(location) in {'ERROR', 'TERMINATED', 'DELETING'} for location in LOCATIONS.values()):
            raise DeploymentError('Fleet location failed: ' + json.dumps(states))
        ready = all(states.get(location) == 'ACTIVE' for location in LOCATIONS.values())
        if ready:
            for location in LOCATIONS.values():
                counts = aws.call('gamelift', 'describe-fleet-location-capacity', '--fleet-id', fleet, '--location', location)['FleetCapacity']['InstanceCounts']
                ready = ready and 1 <= counts.get('ACTIVE', 0) <= 2 and counts.get('MINIMUM') == 1 and counts.get('MAXIMUM') == 2 and 1 <= counts.get('DESIRED', 0) <= 2
            home = aws.call('gamelift', 'describe-fleet-location-capacity', '--fleet-id', fleet, '--location', REGION)['FleetCapacity']['InstanceCounts']
            ready = ready and all(home.get(field) == 0 for field in ('MINIMUM', 'DESIRED', 'MAXIMUM', 'ACTIVE'))
        if ready:
            print('All three cities have active warm capacity.', flush=True)
            return
        time.sleep(15)
    raise DeploymentError('Regional capacity still becoming ready; resume without another fleet')


def ssm(aws, instance, script, directory, comment, command_id=None):
    if command_id is None:
        parameters = directory / 'ssm-parameters.json'
        save(parameters, {'commands': [script], 'executionTimeout': ['1200']})
        command_id = aws.call('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
                              '--comment', comment, '--timeout-seconds', '1200', '--parameters', 'file://' + str(parameters),
                              region=BACKEND_REGION, mutation=True)['Command']['CommandId']
    return command_id


def wait_ssm(aws, instance, command_id):
    deadline = time.monotonic() + 1300
    while time.monotonic() < deadline:
        try:
            value = aws.call('ssm', 'get-command-invocation', '--instance-id', instance, '--command-id', command_id, region=BACKEND_REGION)
        except AwsError as error:
            if error.code == 'InvocationDoesNotExist':
                time.sleep(3)
                continue
            raise
        if value['Status'] == 'Success':
            return value.get('StandardOutputContent', '')
        if value['Status'] not in {'Pending', 'InProgress', 'Delayed'}:
            raise DeploymentError(f'SSM {command_id} ended {value["Status"]}; inspect command output privately before retrying')
        time.sleep(10)
    raise DeploymentError('SSM still running; resume the recorded command instead of sending another')


INSPECT = """set -euo pipefail
python3 - <<'BOLTS_INSPECT'
import json,os,re,urllib.request
path=os.readlink('/opt/bolts/current')
assert re.fullmatch(r'/opt/bolts/releases/[a-f0-9]{64}',path)
with urllib.request.urlopen('http://127.0.0.1:8080/api/lobbies',timeout=10) as source: rooms=json.load(source)['lobbies']
assert isinstance(rooms,list) and all(type(r.get('players')) is int and r['players']>=0 for r in rooms)
print(json.dumps({'release':path.rsplit('/',1)[1],'humans':sum(r['players'] for r in rooms)}))
BOLTS_INSPECT
"""


def directory_archive(files, config, fleet, destination):
    finalized = dict(config, fleet=fleet)
    payload = {name: files[name] for name in ('bolts-host', 'bolts-server')}
    payload['host.json'] = (json.dumps(finalized, indent=2) + '\n').encode()
    payload['install-directory.sh'] = (ROOT / 'infra/gamelift/install-directory.sh').read_bytes()
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as tar:
            for name, value in sorted(payload.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(value)
                entry.mode = 0o644 if name == 'host.json' else 0o755
                tar.addfile(entry, io.BytesIO(value))
    data = raw.getvalue()
    destination.write_bytes(data)
    return digest(data)


def remote_install(bucket, key, release, expected):
    quote = shlex.quote
    folder = '/opt/bolts-build/gamelift/' + release
    archive = folder + '.tar.gz'
    verify = """import sys,tarfile
with tarfile.open(sys.argv[1]) as archive:
 members=archive.getmembers()
 assert {m.name for m in members}=={'bolts-host','bolts-server','host.json','install-directory.sh'} and len(members)==4
 assert all(m.isfile() and m.size<200_000_000 for m in members)
 archive.extractall(sys.argv[2],members=members)
"""
    return '\n'.join(['set -euo pipefail', 'umask 077', 'install -d -m 0700 ' + quote(folder),
        f'aws s3 cp {quote("s3://"+bucket+"/"+key)} {quote(archive)} --region {BACKEND_REGION} --only-show-errors',
        f'printf "%s  %s\\n" {quote(release)} {quote(archive)} | sha256sum --check --status',
        f"python3 - {quote(archive)} {quote(folder)} <<'BOLTS_EXTRACT'\n{verify}BOLTS_EXTRACT",
        f'bash {quote(folder+"/install-directory.sh")} {quote(release)} {quote(folder)} {quote(folder+"/host.json")} {quote(expected)}'])


def deploy_directory(aws, existing, files, config, fleet, directory, state, state_path, expected=None):
    if state.get('directoryCommandId'):
        wait_ssm(aws, existing['instance'], state['directoryCommandId'])
        print('Recorded directory cutover completed.', flush=True)
        return
    wait_fleet(aws, fleet)
    inspect = ssm(aws, existing['instance'], INSPECT, directory, 'Bolts pre-cutover release and human occupancy check')
    observed = json.loads(wait_ssm(aws, existing['instance'], inspect))
    if observed['humans'] != 0 or not SHA.fullmatch(observed['release']):
        raise DeploymentError('Directory cutover deferred: a human seat is occupied or current release is invalid')
    if expected and observed['release'] != expected:
        raise DeploymentError('Current backend differs from the explicitly expected release')
    expected = expected or observed['release']
    archive = directory / 'directory.tar.gz'
    release = directory_archive(files, config, fleet, archive)
    key = 'releases/gamelift/' + release + '.tar.gz'
    aws.call('s3', 'cp', archive, f"s3://{existing['bucket']}/{key}", '--sse', 'AES256', '--only-show-errors', region=BACKEND_REGION, mutation=True, raw=True)
    state.update({'directoryRelease': release, 'expectedRelease': expected})
    save(state_path, state)
    command = ssm(aws, existing['instance'], remote_install(existing['bucket'], key, release, expected), directory,
                  'Bolts regional directory ' + release[:12])
    state['directoryCommandId'] = command
    save(state_path, state)
    wait_ssm(aws, existing['instance'], command)
    print('Directory installed with database/salt preserved; run regional gameplay smoke checks.', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check', action='store_true', help='Read-only AWS identity, existing backend and regional quota checks')
    parser.add_argument('--phase', choices=['build', 'fleet', 'directory', 'all'], default='all')
    parser.add_argument('--stack', default='bolts-gamelift')
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'artifacts/gamelift')
    parser.add_argument('--state-root', type=Path, default=ROOT / 'temp/gamelift-deploy')
    parser.add_argument('--expected-release')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,90}', args.stack) or args.expected_release and not SHA.fullmatch(args.expected_release):
        raise DeploymentError('Invalid stack name or expected release SHA256')
    files, config, template = local_artifacts(args.build_dir, args.stack)
    zipped = build_zip(files)
    sha = digest(zipped)
    directory = args.state_root / sha
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / '.lock').open('a') as lock:
        try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise DeploymentError('This artifact already has an operator deployment in progress')
        archive = directory / 'build.zip'
        archive.write_bytes(zipped)
        state_path = directory / 'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {'buildSha256': sha, 'stack': args.stack}
        if state.get('buildSha256') != sha or state.get('stack') != args.stack:
            raise DeploymentError('Deployment state does not match this build/stack')
        save(directory / 'plan.json', {'buildSha256': sha, 'stack': args.stack, 'locations': LOCATIONS,
                                      'minimumInstancesPerCity': 1, 'maximumInstancesPerCity': 2,
                                      'existingOregonBackend': 'preserved', 'phase': args.phase})
        print('Reviewed build/state: ' + str(directory), flush=True)
        if not args.apply and not args.check:
            print('Local preparation only; --check reads AWS, --apply performs the selected phase.')
            return
        aws = AWS(args.apply)
        existing = backend(aws, args.stack, config)
        if args.check:
            checks = capacity_checks(aws)
            save(directory / 'preflight.json', {'backend': existing, 'capacity': checks})
            print(json.dumps(checks, indent=2), flush=True)
            if not all(row['ok'] for row in checks): raise DeploymentError('Regional allowance checks failed; no rollout performed')
        if not args.apply: return
        if args.phase in {'build', 'all'}:
            ensure_build(aws, archive, sha, state, state_path, args.stack)
        if args.phase in {'fleet', 'all'}:
            if not state.get('buildId'): raise DeploymentError('Run --apply --phase build first')
            state['fleetId'] = ensure_fleet(aws, args.stack, template, state['buildId'], existing, directory)
            save(state_path, state)
        if args.phase in {'directory', 'all'}:
            if not state.get('fleetId'): raise DeploymentError('Run --apply --phase fleet first')
            deploy_directory(aws, existing, files, config, state['fleetId'], directory, state, state_path, args.expected_release)


if __name__ == '__main__':
    try: main()
    except (DeploymentError, OSError, ValueError, KeyError) as error:
        print('Deployment stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
