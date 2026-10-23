#!/usr/bin/env python3
"""Prepare or deploy the reviewed Bolts CloudFormation stack and Rust release.

Default operation is local-only preparation. --apply explicitly creates/updates
AWS resources, uploads the allowlisted source archive, and deploys using SSM.
All AWS access goes through aws-command.py; credentials are never copied/logged.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'infra/.state'
HELPER = ROOT / 'scripts/aws-command.py'
REGION = 'us-west-2'
EDGE_REGION = 'us-east-1'
CUSTOM_DOMAIN = 'bolts-api.christopherkrapu.com'
CUSTOM_ZONE = 'Z00983602PMUH0CDXDTFC'
DEFAULT_ORIGINS = 'https://play-bolts.github.io,http://127.0.0.1:5173,http://localhost:5173'


class DeploymentError(RuntimeError):
    pass


def aws(*arguments, json_output=True, region=REGION):
    command = [sys.executable, str(HELPER), '--region', region, *arguments]
    if json_output:
        command += ['--output', 'json']
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        # No operation in this helper passes a secret in argv or a request body.
        raise DeploymentError(result.stderr.strip() or 'AWS command failed')
    return json.loads(result.stdout) if json_output and result.stdout.strip() else result.stdout


def prepare():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    template = json.loads((ROOT / 'infra/backend.template.json').read_text())
    template['Resources']['GameServer']['Properties']['UserData'] = {
        'Fn::Base64': {'Fn::Sub': (ROOT / 'infra/bootstrap.sh').read_text()}
    }
    rendered = STATE / 'backend.rendered.json'
    rendered.write_text(json.dumps(template, indent=2) + '\n')
    allowlist = [
        ROOT / 'server/Cargo.toml', ROOT / 'server/Cargo.lock', ROOT / 'server/schema.sql',
        ROOT / 'scripts/benchmark-lobby-capacity.rs',
        *sorted((ROOT / 'server/src').glob('*.rs')),
        ROOT / 'src/generated/hitboxData.json',
        ROOT / 'src/generated/handCollisionData.json',
        ROOT / 'shared/actor-fields.json', ROOT / 'shared/wire-schema.json',
        *[ROOT / 'infra' / name for name in [
            'install-release.sh', 'backup.py', 'bolts.service', 'bolts-backup.service', 'bolts-backup.timer',
        ]],
    ]
    # Positive allowlist excludes credentials, databases, assets, .tools, target,
    # node_modules and every symlink. Normalize metadata for a reproducible hash.
    archive = STATE / 'release.tar.gz'
    import gzip
    with archive.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for path in allowlist:
                if not path.is_file() or path.is_symlink():
                    raise DeploymentError(f'Invalid release input: {path.relative_to(ROOT)}')
                info = tar.gettarinfo(str(path), arcname=str(path.relative_to(ROOT)))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode = 0o644
                with path.open('rb') as source:
                    tar.addfile(info, source)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = {'sha256': digest, 'files': [str(p.relative_to(ROOT)) for p in allowlist]}
    (STATE / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared {len(allowlist)} allowlisted files; release {digest[:12]}.', flush=True)
    return rendered, archive, digest


def describe(stack, region=REGION):
    try:
        return aws('cloudformation', 'describe-stacks', '--stack-name', stack, region=region)['Stacks'][0]
    except DeploymentError as error:
        if 'does not exist' in str(error):
            return None
        raise


def wait_stack(stack, timeout=2400, region=REGION):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        state = describe(stack, region=region)
        if not state:
            raise DeploymentError('Stack disappeared during deployment')
        status = state['StackStatus']
        if status != previous:
            print(f'CloudFormation: {status}', flush=True)
            previous = status
        if status in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
            return state
        if not status.endswith('_IN_PROGRESS'):
            events = aws('cloudformation', 'describe-stack-events', '--stack-name', stack, region=region)['StackEvents']
            failures = [{'resource': e.get('LogicalResourceId'), 'reason': e.get('ResourceStatusReason')}
                        for e in events if e.get('ResourceStatus', '').endswith('FAILED')][:5]
            raise DeploymentError(f'CloudFormation {status}: {json.dumps(failures)}')
        time.sleep(15)
    raise DeploymentError('CloudFormation is still running; inspect the stack before retrying')


def require_web_acl_preserved(stack, template, values, region=REGION):
    """An independently attached edge WAF must survive every stack update.

    CloudFormation's previous template does not include out-of-band WAF
    associations. Compare the candidate with CloudFront itself, not merely with
    that previous template. Never silently modify the reviewed source template.
    """
    current = describe(stack, region=region)
    if not current:
        return
    outputs = {item['OutputKey']: item['OutputValue'] for item in current.get('Outputs', [])}
    distribution_id = outputs.get('DistributionId')
    if not distribution_id:
        return  # Certificate and other stacks without the backend distribution.
    observed = aws('cloudfront', 'get-distribution', '--id', distribution_id,
                   region=EDGE_REGION)['Distribution']['DistributionConfig']
    active_acl = observed.get('WebACLId', '')
    if not active_acl:
        return
    candidate = json.loads(template.read_text())
    resource = candidate.get('Resources', {}).get('Distribution', {})
    config = resource.get('Properties', {}).get('DistributionConfig', {})
    requested_acl = config.get('WebACLId')
    if isinstance(requested_acl, dict) and set(requested_acl) == {'Ref'}:
        requested_acl = values.get(requested_acl['Ref'])
    if resource.get('Type') != 'AWS::CloudFront::Distribution' or requested_acl != active_acl:
        raise DeploymentError(
            'Deployment would remove or change the active CloudFront WAF. '
            'Preserve Distribution.DistributionConfig.WebACLId as the current ARN '
            '(literal or a Ref supplied through deployment parameters): ' + active_acl)


def apply_stack(stack, template, values, exists, region=REGION):
    if exists:
        require_web_acl_preserved(stack, template, values, region=region)
    parameters = [{'ParameterKey': key, 'ParameterValue': value} for key, value in values.items()]
    path = STATE / 'parameters.json'
    path.write_text(json.dumps(parameters))
    operation = 'update-stack' if exists else 'create-stack'
    try:
        aws('cloudformation', operation, '--stack-name', stack,
            '--template-body', 'file://' + str(template), '--parameters', 'file://' + str(path),
            '--capabilities', 'CAPABILITY_IAM',
            *(['--disable-rollback'] if not exists else []), region=region)
    except DeploymentError as error:
        if exists and 'No updates are to be performed' in str(error):
            return describe(stack, region=region)
        raise
    return wait_stack(stack, region=region)


def configure_domain(args, template):
    """Certificate + guarded DNS/CloudFront-only change; never deploy the app."""
    previous = describe(args.stack)
    if not previous:
        raise DeploymentError('--domain-only requires the existing backend stack')
    if previous['StackStatus'].endswith('_IN_PROGRESS'):
        previous = wait_stack(args.stack)
    values = {p['ParameterKey']: p['ParameterValue'] for p in previous['Parameters']}
    require_web_acl_preserved(args.stack, template, values)
    zone = aws('route53', 'get-hosted-zone', '--id', CUSTOM_ZONE)
    if zone['HostedZone']['Name'] != 'christopherkrapu.com.' or zone['HostedZone']['Config'].get('PrivateZone'):
        raise DeploymentError('Custom domain must use the reviewed public hosted zone')
    delegated = subprocess.run(['dig', '+short', 'NS', 'christopherkrapu.com'],
                               check=True, capture_output=True, text=True).stdout.split()
    normalize = lambda names: {name.lower().rstrip('.') for name in names}
    if normalize(delegated) != normalize(zone['DelegationSet']['NameServers']):
        raise DeploymentError('Public NS delegation does not match the reviewed hosted zone')
    outputs = {item['OutputKey']: item['OutputValue'] for item in previous['Outputs']}
    distribution = aws('cloudfront', 'get-distribution', '--id', outputs['DistributionId'])['Distribution']
    if not distribution['DistributionConfig']['IsIPV6Enabled']:
        raise DeploymentError('Reviewed A/AAAA setup requires the existing IPv6-enabled distribution')
    records = aws('route53', 'list-resource-record-sets', '--hosted-zone-id', CUSTOM_ZONE,
                  '--query', f"ResourceRecordSets[?Name == '{CUSTOM_DOMAIN}.']")
    for record in records:
        target = record.get('AliasTarget', {})
        if (record['Type'] not in {'A', 'AAAA'} or
                target.get('DNSName', '').rstrip('.') != distribution['DomainName']):
            raise DeploymentError('Exact custom subdomain already has a conflicting DNS record')

    certificate_template = ROOT / 'infra/edge-certificate.template.json'
    certificate_stack = args.stack + '-edge-certificate'
    certificate_state = describe(certificate_stack, region=EDGE_REGION)
    if certificate_state and certificate_state['StackStatus'].endswith('_IN_PROGRESS'):
        certificate_state = wait_stack(certificate_stack, region=EDGE_REGION)
    aws('cloudformation', 'validate-template', '--template-body', 'file://' + str(certificate_template), region=EDGE_REGION)
    certificate_state = apply_stack(certificate_stack, certificate_template,
                                    {'DomainName': CUSTOM_DOMAIN, 'HostedZoneId': CUSTOM_ZONE},
                                    bool(certificate_state), region=EDGE_REGION)
    certificate_outputs = {item['OutputKey']: item['OutputValue'] for item in certificate_state['Outputs']}
    certificate_arn = certificate_outputs['CertificateArn']
    certificate = aws('acm', 'describe-certificate', '--certificate-arn', certificate_arn, region=EDGE_REGION)['Certificate']
    if certificate['Status'] != 'ISSUED' or certificate['SubjectAlternativeNames'] != [CUSTOM_DOMAIN]:
        raise DeploymentError('The issued certificate must cover exactly the reviewed custom domain')

    # Compare deployed resource definitions before even proposing the change set.
    # Only the distribution's alias/certificate and exact A/AAAA records may differ.
    old = aws('cloudformation', 'get-template', '--stack-name', args.stack)['TemplateBody']
    if isinstance(old, str):
        old = json.loads(old)
    new = json.loads(template.read_text())
    allowed = {'Distribution', 'BackendAliasA', 'BackendAliasAAAA'}
    for logical_id in set(old['Resources']) | set(new['Resources']):
        if logical_id not in allowed and old['Resources'].get(logical_id) != new['Resources'].get(logical_id):
            raise DeploymentError(f'Domain-only deployment would modify unrelated resource {logical_id}')
    for candidate in (old, new):
        candidate['Resources']['Distribution']['Properties']['DistributionConfig'].pop('Aliases', None)
        candidate['Resources']['Distribution']['Properties']['DistributionConfig'].pop('ViewerCertificate', None)
    if old['Resources']['Distribution'] != new['Resources']['Distribution']:
        raise DeploymentError('Domain-only deployment would change unrelated CloudFront settings')
    values.update({'CustomDomainName': CUSTOM_DOMAIN, 'CustomDomainCertificateArn': certificate_arn,
                   'CustomDomainHostedZoneId': CUSTOM_ZONE})
    parameters = STATE / 'domain-parameters.json'
    parameters.write_text(json.dumps([{'ParameterKey': key, 'ParameterValue': value} for key, value in values.items()]))
    aws('cloudformation', 'validate-template', '--template-body', 'file://' + str(template))
    change_name = f'bolts-custom-domain-{time.time_ns()}'
    require_web_acl_preserved(args.stack, template, values)
    aws('cloudformation', 'create-change-set', '--stack-name', args.stack, '--change-set-name', change_name,
        '--change-set-type', 'UPDATE', '--template-body', 'file://' + str(template),
        '--parameters', 'file://' + str(parameters), '--capabilities', 'CAPABILITY_IAM')
    deadline = time.monotonic() + 180
    while True:
        change = aws('cloudformation', 'describe-change-set', '--stack-name', args.stack, '--change-set-name', change_name)
        if change['Status'] not in {'CREATE_PENDING', 'CREATE_IN_PROGRESS'}:
            break
        if time.monotonic() > deadline:
            raise DeploymentError('Domain change set is still being prepared; inspect it before retrying')
        time.sleep(5)
    if change['Status'] == 'FAILED' and "didn't contain changes" in change.get('StatusReason', ''):
        state = previous
    else:
        if change['Status'] != 'CREATE_COMPLETE':
            raise DeploymentError('Domain change set failed: ' + change.get('StatusReason', 'unknown'))
        summary = []
        for item in change['Changes']:
            resource = item['ResourceChange']
            logical_id = resource['LogicalResourceId']
            if (logical_id not in allowed or resource['Action'] not in {'Add', 'Modify'} or
                    resource.get('Replacement', 'False') != 'False' or
                    (logical_id == 'Distribution' and resource['Action'] != 'Modify')):
                raise DeploymentError('Refusing unrelated/replacing domain change: ' + json.dumps(resource))
            summary.append({'resource': logical_id, 'action': resource['Action'], 'replacement': resource.get('Replacement', 'False')})
        print('Reviewed domain-only changes: ' + json.dumps(summary), flush=True)
        (STATE / 'domain-change-set.json').write_text(json.dumps(change, indent=2) + '\n')
        require_web_acl_preserved(args.stack, template, values)
        aws('cloudformation', 'execute-change-set', '--stack-name', args.stack, '--change-set-name', change_name)
        state = wait_stack(args.stack)
    outputs.update({item['OutputKey']: item['OutputValue'] for item in state['Outputs']})
    outputs.update({'CertificateArn': certificate_arn, 'CertificateStack': certificate_stack,
                    'CustomDomainHostedZoneId': CUSTOM_ZONE})
    (STATE / 'domain-outputs.json').write_text(json.dumps(outputs, indent=2) + '\n')
    verify_edge(outputs['BackendUrl'])
    print('Custom domain ready; no instance changes or application restart.', flush=True)
    return outputs


def provision(args, template):
    previous = describe(args.stack)
    if previous and previous['StackStatus'].endswith('_IN_PROGRESS'):
        previous = wait_stack(args.stack)
    values = {p['ParameterKey']: p['ParameterValue'] for p in previous.get('Parameters', [])} if previous else {}
    values.setdefault('VpcId', 'vpc-b000bdd5')
    values.setdefault('SubnetId', 'subnet-239e3554')
    values.setdefault('CloudFrontServiceSecurityGroup', '')
    values['AllowedOrigins'] = args.origins
    subnet = aws('ec2', 'describe-subnets', '--subnet-ids', values['SubnetId'])['Subnets'][0]
    if (subnet['VpcId'], subnet['AvailabilityZone'], subnet['AvailabilityZoneId']) != (values['VpcId'], 'us-west-2a', 'usw2-az2'):
        raise DeploymentError('Subnet must be the reviewed VPC in us-west-2a / usw2-az2')
    if not values.get('AmiId'):
        values['AmiId'] = aws('ssm', 'get-parameter', '--name',
            '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64')['Parameter']['Value']
    # Preserve an existing AMI, avoiding implicit instance/data replacement.
    prefix = aws('ec2', 'describe-managed-prefix-lists', '--filters',
        'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing')['PrefixLists']
    if len(prefix) != 1:
        raise DeploymentError('Could not uniquely identify the AWS CloudFront prefix list')
    values['CloudFrontPrefixList'] = prefix[0]['PrefixListId']
    aws('cloudformation', 'validate-template', '--template-body', 'file://' + str(template))
    state = apply_stack(args.stack, template, values, bool(previous))
    if not values['CloudFrontServiceSecurityGroup']:
        groups = aws('ec2', 'describe-security-groups', '--filters',
            f'Name=vpc-id,Values={values["VpcId"]}',
            'Name=group-name,Values=CloudFront-VPCOrigins-Service-SG*')['SecurityGroups']
        if len(groups) != 1:
            raise DeploymentError('VPC origin exists, but its service SG was not unique; inspect before continuing')
        values['CloudFrontServiceSecurityGroup'] = groups[0]['GroupId']
        print('Restricting origin ingress to the CloudFront-managed service security group.', flush=True)
        state = apply_stack(args.stack, template, values, True)
    outputs = {value['OutputKey']: value['OutputValue'] for value in state['Outputs']}
    instance = aws('ec2', 'describe-instances', '--instance-ids', outputs['InstanceId'])['Reservations'][0]['Instances'][0]
    root_volume = next((mapping['Ebs']['VolumeId'] for mapping in instance['BlockDeviceMappings']
                        if mapping['DeviceName'] == instance['RootDeviceName'] and 'Ebs' in mapping), None)
    if root_volume:
        # Keep an exact recovery/cleanup identifier in addition to propagated tags.
        outputs['RootVolumeId'] = root_volume
    (STATE / 'outputs.json').write_text(json.dumps(outputs, indent=2) + '\n')
    return outputs


def wait_ssm(instance):
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        result = aws('ssm', 'describe-instance-information', '--filters', f'Key=InstanceIds,Values={instance}')
        if any(i.get('PingStatus') == 'Online' for i in result['InstanceInformationList']):
            return
        print('Waiting for the managed instance to register with SSM.', flush=True)
        time.sleep(15)
    raise DeploymentError('Instance did not register with SSM; inspect cloud-init and the instance role')


def deploy_release(args, outputs, archive, digest):
    bucket = outputs['StorageBucket']
    instance = outputs['InstanceId']
    key = f'releases/{digest}.tar.gz'
    aws('s3', 'cp', str(archive), f's3://{bucket}/{key}', '--sse', 'AES256', '--only-show-errors', json_output=False)
    wait_ssm(instance)
    source_dir = f'/opt/bolts-build/sources/{digest}'
    remote_archive = f'/opt/bolts-build/{digest}.tar.gz'
    quote = shlex.quote
    script = '\n'.join([
        'set -euo pipefail', 'umask 077',
        'for n in $(seq 1 180); do test -f /var/lib/bolts-bootstrap.ready && break; sleep 5; done',
        'test -f /var/lib/bolts-bootstrap.ready',
        f'aws s3 cp {quote(f"s3://{bucket}/{key}")} {quote(remote_archive)} --region {REGION} --only-show-errors',
        f'printf "%s  %s\\n" {quote(digest)} {quote(remote_archive)} | sha256sum --check --status',
        f'install -d -m 0700 -o bolts-build -g bolts-build {quote(source_dir)}',
        f'tar --extract --gzip --no-same-owner --no-same-permissions --file {quote(remote_archive)} --directory {quote(source_dir)}',
        f'bash {quote(source_dir + "/infra/install-release.sh")} {quote(digest)} {quote(source_dir)} {quote(args.origins)} {quote(args.expected_release or "")}',
    ])
    parameters = STATE / 'ssm-parameters.json'
    parameters.write_text(json.dumps({'commands': [script], 'executionTimeout': ['3600']}))
    sent = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
        '--comment', f'Bolts release {digest[:12]}', '--timeout-seconds', '3600',
        '--parameters', 'file://' + str(parameters))
    command = sent['Command']['CommandId']
    (STATE / 'last-command.json').write_text(json.dumps({'instanceId': instance, 'commandId': command, 'release': digest}) + '\n')
    print(f'SSM build/deploy started: {command}', flush=True)
    deadline = time.monotonic() + 3900
    while time.monotonic() < deadline:
        try:
            state = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instance)
        except DeploymentError as error:
            if 'InvocationDoesNotExist' in str(error):
                time.sleep(5)
                continue
            raise
        status = state['Status']
        if status == 'Success':
            print('Rust release built, service healthy, and first database backup completed.', flush=True)
            return
        if status not in {'Pending', 'InProgress', 'Delayed'}:
            # Build/service errors contain no environment values or database rows.
            raise DeploymentError(f'SSM {status}: {state.get("StandardErrorContent", "")[-5000:]}')
        print(f'Remote build/deploy: {status}', flush=True)
        time.sleep(15)
    raise DeploymentError('Remote deployment is still running; inspect the recorded SSM command before retrying')


def verify_edge(url):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url + '/api/health', timeout=10) as response:
                result = json.load(response)
                if result.get('ok') is True and result.get('version') == 3:
                    print(f'Backend ready: {url}', flush=True)
                    return
        except (OSError, ValueError):
            pass
        time.sleep(5)
    raise DeploymentError('Local service is healthy, but CloudFront health verification failed')


def update_origins(args):
    """Restart only the current binary with a reviewed browser-origin allowlist."""
    state = describe(args.stack)
    if not state or state['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
        raise DeploymentError('--origins-only requires a stable existing backend stack')
    outputs = {value['OutputKey']: value['OutputValue'] for value in state['Outputs']}
    instance = outputs['InstanceId']
    wait_ssm(instance)
    script = (ROOT / 'infra/update-origins.py').read_text()
    command_text = "set -eu\numask 077\npython3 - " + shlex.quote(args.origins) + " <<'BOLTS_ORIGIN_UPDATE'\n" + script + '\nBOLTS_ORIGIN_UPDATE\n'
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    parameters = STATE / 'origins-ssm-parameters.json'
    parameters.write_text(json.dumps({'commands': [command_text], 'executionTimeout': ['240']}))
    sent = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
               '--comment', 'Bolts browser-origin configuration only', '--timeout-seconds', '240',
               '--parameters', 'file://' + str(parameters))
    command = sent['Command']['CommandId']
    (STATE / 'last-origins-command.json').write_text(json.dumps({'instanceId': instance, 'commandId': command}) + '\n')
    print(f'Origin-only update started: {command}', flush=True)
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            invocation = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instance)
        except DeploymentError as error:
            if 'InvocationDoesNotExist' in str(error):
                time.sleep(2)
                continue
            raise
        if invocation['Status'] == 'Success':
            verify_edge(outputs['BackendUrl'])
            for origin in args.origins.split(','):
                request = urllib.request.Request(outputs['BackendUrl'] + '/api/lobbies', headers={'Origin': origin})
                with urllib.request.urlopen(request, timeout=10) as response:
                    if response.headers.get('Access-Control-Allow-Origin') != origin:
                        raise DeploymentError('Updated browser-origin CORS verification failed')
            print('Origin-only update verified; binary and infrastructure unchanged.', flush=True)
            return
        if invocation['Status'] not in {'Pending', 'InProgress', 'Delayed'}:
            raise DeploymentError(f'Origin-only SSM {invocation["Status"]}: {invocation.get("StandardErrorContent", "")[-1000:]}')
        time.sleep(2)
    raise DeploymentError('Origin update is still running; inspect last-origins-command.json before retrying')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Create/update AWS resources and deploy the release')
    parser.add_argument('--provision-only', action='store_true', help='With --apply, provision infrastructure without building the release')
    parser.add_argument('--domain-only', action='store_true', help='With --apply, configure only the reviewed custom domain, certificate and DNS; never deploy/restart the application')
    parser.add_argument('--origins-only', action='store_true', help='With --apply, atomically change browser origins and restart the existing binary; no build or infrastructure update')
    parser.add_argument('--application-only', action='store_true', help='Update the Rust application on the existing instance without provisioning infrastructure')
    parser.add_argument('--expected-release', help='Require this current backend release SHA-256 before building and immediately before replacement')
    parser.add_argument('--custom-domain', choices=[CUSTOM_DOMAIN], help='Exact approved custom backend domain; requires --domain-only')
    parser.add_argument('--stack', default='bolts-backend')
    parser.add_argument('--origins', default=DEFAULT_ORIGINS)
    args = parser.parse_args()
    if args.domain_only != bool(args.custom_domain) or (args.domain_only and args.provision_only):
        raise DeploymentError('Use --domain-only --custom-domain ' + CUSTOM_DOMAIN + ' together, without --provision-only')
    if args.origins_only and (args.domain_only or args.provision_only):
        raise DeploymentError('--origins-only cannot be combined with other deployment modes')
    if args.application_only and (args.origins_only or args.domain_only or args.provision_only):
        raise DeploymentError('--application-only cannot be combined with other deployment modes')
    import re
    if args.expected_release and not re.fullmatch(r'[a-f0-9]{64}', args.expected_release):
        raise DeploymentError('Expected release must be a lowercase SHA-256')
    if args.application_only and args.apply and not args.expected_release:
        raise DeploymentError('--application-only --apply requires --expected-release')
    if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]{0,127}', args.stack):
        raise DeploymentError('Invalid CloudFormation stack name')
    if not re.fullmatch(r'[A-Za-z0-9:/.,_-]+', args.origins):
        raise DeploymentError('Invalid origin allowlist')
    if args.origins_only:
        import runpy
        runpy.run_path(str(ROOT / 'infra/update-origins.py'))['validate_origins'](args.origins)
        if args.apply:
            update_origins(args)
        else:
            print('Origin-only plan: update BOLTS_ORIGINS and restart the existing service; pass --apply to execute.')
        return
    template, archive, digest = prepare()
    if not args.apply:
        print('Local preparation only. Review infra/backend.template.json and the release manifest before --apply.')
        return
    if args.domain_only:
        configure_domain(args, template)
        return
    if args.application_only:
        existing = describe(args.stack)
        if not existing or existing['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
            raise DeploymentError('--application-only requires a stable existing backend stack')
        outputs = {item['OutputKey']: item['OutputValue'] for item in existing['Outputs']}
    else:
        outputs = provision(args, template)
    if args.provision_only:
        print(f'Infrastructure ready; no application release deployed. Endpoint: {outputs["BackendUrl"]}')
        return
    deploy_release(args, outputs, archive, digest)
    verify_edge(outputs['BackendUrl'])


if __name__ == '__main__':
    try:
        main()
    except (DeploymentError, OSError, ValueError) as error:
        print(f'Deployment stopped: {error}', file=sys.stderr)
        sys.exit(1)
