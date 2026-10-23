#!/usr/bin/env python3
"""Guarded WAF rollout for the existing Bolts API CloudFront distribution.

Default/--plan reads AWS and saves a reviewable plan in --state-dir. --apply
executes that exact plan; --check is read-only. Use a NEW state directory for
each update. --qa-ip IPv4/32 enables a temporary rule for one random QA path.
--probe-qa sends at most 180 harmless GETs, two seconds apart, to that path.
Re-plan WITHOUT --qa-ip and apply to remove the temporary rule/IP set.
--rollback restores only the saved WebACL association using the latest ETag;
it preserves other current distribution settings and leaves the WAF stack.
"""
import argparse
import base64
import copy
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
from http.client import HTTPSConnection
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'infra/abuse-protection.template.json'
REGION = 'us-east-1'
ACCOUNT = '780705957578'
DISTRIBUTION = 'E1MT909KTPVXKW'
HOST = 'bolts-api.christopherkrapu.com'
ORIGIN = 'https://play-bolts.github.io'
STACK = 'bolts-abuse-protection'
ACL_NAME = 'bolts-api-abuse'
TAG = {'Key': 'Component', 'Value': 'edge-abuse-protection'}


class Error(RuntimeError):
    pass


class AwsError(Error):
    def __init__(self, service, operation, code, missing=False, unchanged=False):
        self.missing, self.unchanged = missing, unchanged
        super().__init__(f'AWS {service} {operation} failed ({code}); inspect AWS privately.')


class AWS:
    def __init__(self, apply=False):
        self.apply = apply

    def call(self, service, operation, *args, mutation=False):
        if mutation and not self.apply:
            raise Error('AWS mutations require --apply or --rollback')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/aws-command.py'),
                                 '--region', REGION, service, operation, *map(str, args),
                                 '--output', 'json'], capture_output=True, text=True)
        if result.returncode:
            found = re.search(r'An error occurred \(([A-Za-z0-9_.-]+)\)', result.stderr)
            raise AwsError(service, operation, found.group(1) if found else 'CLIError',
                           'does not exist' in result.stderr,
                           'No updates are to be performed' in result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else {}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, indent=2)
        out.write('\n')
    temporary.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def parameters(qa_ip=None):
    if qa_ip:
        network = ipaddress.ip_network(qa_ip, strict=True)
        if network.version != 4 or network.prefixlen != 32 or not network.network_address.is_global:
            raise Error('QA requires exactly one globally routable IPv4 address with /32')
    return {'QaEnabled': 'true' if qa_ip else 'false',
            'QaSourceCidr': qa_ip or '192.0.2.1/32',
            'QaPath': '/api/waf-qa-' + (secrets.token_hex(16) if qa_ip else '0' * 32)}


def validate_template(template):
    resources = template.get('Resources', {})
    if set(resources) != {'ApiWebAcl', 'QaSource'}:
        raise Error('Only the isolated WebACL and optional QA IP set may be managed')
    if resources['ApiWebAcl']['Type'] != 'AWS::WAFv2::WebACL' or resources['QaSource']['Type'] != 'AWS::WAFv2::IPSet':
        raise Error('Unexpected resource types')
    acl = resources['ApiWebAcl']['Properties']
    if acl['Name'] != ACL_NAME or acl['Scope'] != 'CLOUDFRONT' or acl['DefaultAction'] != {'Allow': {}}:
        raise Error('Unexpected WebACL identity or default action')
    if resources['QaSource'].get('Condition') != 'QaEnabled':
        raise Error('QA IP set must remain conditional')
    rules = resolved_rules(template, parameters(), '')
    if [(r['Name'], r['Statement']['RateBasedStatement']['Limit']) for r in rules] != [
            ('BoltsFeedbackPerIp', 20), ('BoltsAdmissionPerIp', 120), ('BoltsApiPerIp', 600)]:
        raise Error('Unexpected production rule identities or thresholds')
    for rule in rules:
        rate = rule['Statement']['RateBasedStatement']
        if rate['AggregateKeyType'] != 'IP' or rate['EvaluationWindowSec'] != 60 or 'ForwardedIPConfig' in rate:
            raise Error('Rates must use actual viewer IP and a 60-second window')
        response = rule['Action']['Block']['CustomResponse']
        if response['ResponseCode'] != 429 or {'Name': 'Retry-After', 'Value': '60'} not in response['ResponseHeaders']:
            raise Error('Rate-limited responses must provide 429 and Retry-After')


def resolved_rules(template, values, qa_arn, encode=True):
    """Resolve only the deliberately small template's intrinsics for AWS checks."""
    missing = object()

    def resolve(value):
        if isinstance(value, list):
            rows = [resolve(row) for row in value]
            return [row for row in rows if row is not missing]
        if not isinstance(value, dict):
            return value
        if set(value) == {'Ref'}:
            return missing if value['Ref'] == 'AWS::NoValue' else values[value['Ref']]
        if set(value) == {'Fn::If'}:
            condition, yes, no = value['Fn::If']
            if condition != 'QaEnabled':
                raise Error('Unknown template condition')
            return resolve(yes if values['QaEnabled'] == 'true' else no)
        if set(value) == {'Fn::GetAtt'}:
            if value['Fn::GetAtt'] != ['QaSource', 'Arn']:
                raise Error('Unknown template resource reference')
            return qa_arn
        result = {key: resolve(item) for key, item in value.items()}
        if encode and 'ByteMatchStatement' in result:
            match = result['ByteMatchStatement']
            match['SearchString'] = base64.b64encode(match['SearchString'].encode()).decode()
        return result

    return resolve(template['Resources']['ApiWebAcl']['Properties']['Rules'])


def stack_state(aws):
    try:
        stack = aws.call('cloudformation', 'describe-stacks', '--stack-name', STACK)['Stacks'][0]
    except AwsError as error:
        if error.missing:
            return None
        raise
    if TAG not in stack.get('Tags', []):
        raise Error('Existing stack lacks the exact Bolts ownership tag; refusing to adopt it')
    if stack['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
        raise Error('Protection stack is not stable: ' + stack['StackStatus'])
    body = aws.call('cloudformation', 'get-template', '--stack-name', STACK)['TemplateBody']
    return {'id': stack['StackId'], 'template': json.loads(body) if isinstance(body, str) else body,
            'parameters': {p['ParameterKey']: p['ParameterValue'] for p in stack.get('Parameters', [])},
            'outputs': {p['OutputKey']: p['OutputValue'] for p in stack.get('Outputs', [])}}


def distribution(aws):
    value = aws.call('cloudfront', 'get-distribution', '--id', DISTRIBUTION)
    dist = value['Distribution']
    if dist['ARN'] != f'arn:aws:cloudfront::{ACCOUNT}:distribution/{DISTRIBUTION}':
        raise Error('Unexpected CloudFront account or distribution')
    config = dist['DistributionConfig']
    if HOST not in config.get('Aliases', {}).get('Items', []) or not config.get('Enabled'):
        raise Error('Expected enabled Bolts API alias is absent')
    if dist['Status'] != 'Deployed':
        raise Error('CloudFront update is already in progress; wait before proceeding')
    return {'ETag': value['ETag'], 'config': config}


def validate_association(observed, stack):
    existing = observed['config'].get('WebACLId', '')
    expected = stack['outputs'].get('WebAclArn') if stack else None
    if existing and existing != expected:
        raise Error('A different WebACL is already associated; refusing to replace protection')


def plan(aws, folder, qa_ip):
    if (folder / 'plan.json').exists():
        raise Error('Preserve the existing plan; use a new --state-dir for a new change')
    template = json.loads(TEMPLATE.read_text())
    validate_template(template)
    before, stack = distribution(aws), stack_state(aws)
    validate_association(before, stack)
    values = parameters(qa_ip)
    save(folder / 'template.json', template)
    save(folder / 'capacity-rules.json', resolved_rules(template, parameters(), ''))
    aws.call('cloudformation', 'validate-template', '--template-body', 'file://' + str(folder / 'template.json'))
    capacity = aws.call('wafv2', 'check-capacity', '--scope', 'CLOUDFRONT', '--rules', 'file://' + str(folder / 'capacity-rules.json'))['Capacity']
    if capacity > 1400:
        raise Error('Unexpected WAF capacity would risk additional request charges')
    value = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(), 'distribution': DISTRIBUTION,
             'account': ACCOUNT, 'stack': STACK, 'templateSha256': digest(template), 'template': template,
             'parameters': values, 'before': before, 'stackBefore': stack,
             'productionWcu': capacity, 'estimatedMonthlyFixedUSD': 8,
             'estimatedPerMillionRequestsUSD': 0.60, 'qaAdditionalMonthlyProratedUSD': 1 if qa_ip else 0}
    save(folder / 'plan.json', value)
    print(json.dumps({'plan': str(folder / 'plan.json'), 'productionWcu': capacity,
                      'qaEnabled': bool(qa_ip), 'changes': ['standalone WAF stack', 'CloudFront WebACLId only']}, indent=2))


def wait_stack(aws, timeout=900):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        stack = aws.call('cloudformation', 'describe-stacks', '--stack-name', STACK)['Stacks'][0]
        status = stack['StackStatus']
        if status in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
            return stack_state(aws)
        if not status.endswith('_IN_PROGRESS'):
            raise Error('Protection stack did not complete: ' + status)
        print('Waiting for WAF stack: ' + status, flush=True)
        time.sleep(15)
    raise Error('WAF stack remains in progress; inspect it before retrying')


def wait_distribution(aws, timeout=1200):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = aws.call('cloudfront', 'get-distribution', '--id', DISTRIBUTION)
        if value['Distribution']['Status'] == 'Deployed':
            return distribution(aws)
        print('Waiting for CloudFront propagation.', flush=True)
        time.sleep(20)
    raise Error('CloudFront remains in progress; inspect it before retrying')


def update_association(aws, folder, before, target):
    """Copy the complete configuration and change exactly WebACLId, guarded by ETag."""
    config = copy.deepcopy(before['config'])
    config['WebACLId'] = target
    save(folder / 'distribution-update.json', config)
    aws.call('cloudfront', 'update-distribution', '--id', DISTRIBUTION,
             '--if-match', before['ETag'], '--distribution-config',
             'file://' + str(folder / 'distribution-update.json'), mutation=True)
    after = wait_distribution(aws)
    if after['config'] != config:
        raise Error('CloudFront changed concurrently after update; inspect saved configuration')
    save(folder / 'distribution-after.json', after)


def check(aws, folder):
    observed, stack = distribution(aws), stack_state(aws)
    if not stack:
        raise Error('Protection stack is not deployed')
    outputs = stack['outputs']
    if observed['config'].get('WebACLId') != outputs['WebAclArn']:
        raise Error('Expected WAF is not attached to the API distribution')
    acl = aws.call('wafv2', 'get-web-acl', '--name', ACL_NAME, '--id', outputs['WebAclId'], '--scope', 'CLOUDFRONT')['WebACL']
    desired = stack['template']['Resources']['ApiWebAcl']['Properties']
    expected_rules = resolved_rules(stack['template'], stack['parameters'], outputs.get('QaSourceArn', ''))
    for key, expected in [('Name', ACL_NAME), ('Rules', expected_rules), ('DefaultAction', desired['DefaultAction']),
                          ('CustomResponseBodies', desired['CustomResponseBodies']), ('VisibilityConfig', desired['VisibilityConfig'])]:
        if acl.get(key) != expected:
            raise Error('Live WAF differs from its reviewed stack: ' + key)
    if acl['Capacity'] > 1500:
        raise Error('Unexpected WAF capacity surcharge')
    summary = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'distribution': DISTRIBUTION,
               'webAclArn': outputs['WebAclArn'], 'capacity': acl['Capacity'],
               'rules': [r['Name'] for r in acl['Rules']], 'qaEnabled': stack['parameters']['QaEnabled'] == 'true',
               'actualViewerIpAggregation': True, 'sampledRequests': False}
    save(folder / 'check.json', summary)
    print(json.dumps(summary, indent=2))
    return stack


def apply(aws, folder):
    value = json.loads((folder / 'plan.json').read_text())
    if value.get('version') != 1 or value.get('distribution') != DISTRIBUTION or value.get('account') != ACCOUNT or value.get('stack') != STACK:
        raise Error('Wrong rollout plan target')
    if digest(value['template']) != value['templateSha256'] or digest(json.loads(TEMPLATE.read_text())) != value['templateSha256']:
        raise Error('Reviewed template changed; make a new plan')
    validate_template(value['template'])
    current, stack = distribution(aws), stack_state(aws)
    validate_association(current, stack)
    desired_stack = stack and stack['template'] == value['template'] and stack['parameters'] == value['parameters']
    own_arn = stack['outputs']['WebAclArn'] if stack else ''
    already_attached = desired_stack and current['config'].get('WebACLId') == own_arn
    expected_config = copy.deepcopy(value['before']['config'])
    if already_attached:
        expected_config['WebACLId'] = own_arn
    if current['config'] != expected_config or (not already_attached and current['ETag'] != value['before']['ETag']):
        raise Error('CloudFront changed after planning; refusing to overwrite concurrent changes')
    if not desired_stack:
        if stack != value['stackBefore']:
            raise Error('WAF stack changed after planning; create a new plan')
        save(folder / 'parameters.json', [{'ParameterKey': k, 'ParameterValue': v} for k, v in value['parameters'].items()])
        save(folder / 'template.json', value['template'])
        args = ['--stack-name', STACK, '--template-body', 'file://' + str(folder / 'template.json'),
                '--parameters', 'file://' + str(folder / 'parameters.json')]
        if not stack:
            args += ['--tags', json.dumps([TAG, {'Key': 'Application', 'Value': 'bolts'}])]
        try:
            aws.call('cloudformation', 'update-stack' if stack else 'create-stack', *args, mutation=True)
        except AwsError as error:
            if not error.unchanged:
                raise
        stack = wait_stack(aws)
    target = stack['outputs']['WebAclArn']
    fresh = distribution(aws)
    if fresh != current:
        raise Error('CloudFront changed while WAF was being prepared; re-plan association')
    if fresh['config'].get('WebACLId') != target:
        update_association(aws, folder, fresh, target)
    check(aws, folder)
    save(folder / 'applied.json', {'webAclArn': target, 'completedAt': datetime.now(timezone.utc).isoformat()})


def rollback(aws, folder):
    value = json.loads((folder / 'plan.json').read_text())
    if value.get('distribution') != DISTRIBUTION or value.get('account') != ACCOUNT:
        raise Error('Wrong rollback plan target')
    current, stack = distribution(aws), stack_state(aws)
    validate_association(current, stack)
    target = value['before']['config'].get('WebACLId', '')
    save(folder / 'rollback-before.json', current)
    if current['config'].get('WebACLId', '') != target:
        update_association(aws, folder, current, target)
    print('Saved WebACL association restored; other current settings preserved. WAF stack retained and still billed.')


def connect_ipv4(address, timeout, source_address=None):
    """QA uses an IPv4 /32 rule, so both address discovery and probes must use IPv4."""
    failure = None
    for family, kind, protocol, _, target in socket.getaddrinfo(
            address[0], address[1], family=socket.AF_INET, type=socket.SOCK_STREAM):
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(timeout)
            if source_address:
                connection.bind(source_address)
            connection.connect(target)
            return connection
        except OSError as error:
            failure = error
            connection.close()
    raise failure or OSError('No IPv4 address is available for the QA endpoint')


class IPv4HTTPSConnection(HTTPSConnection):
    def __init__(self, host):
        # Standard HTTPSConnection still supplies the hostname for TLS SNI and
        # certificate verification. Only its TCP socket factory is constrained.
        super().__init__(host, timeout=10, context=ssl.create_default_context())
        self._create_connection = connect_ipv4


def read_ipv4_https(host, path, method='GET', headers=None):
    connection = IPv4HTTPSConnection(host)
    try:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.headers), response.read(8192)
    finally:
        connection.close()


def read_http(path, method='GET', headers=None):
    return read_ipv4_https(HOST, path, method, {'Origin': ORIGIN, **(headers or {})})


def probe_qa(aws, folder):
    stack = check(aws, folder)
    values = stack['parameters']
    if values['QaEnabled'] != 'true' or not re.fullmatch(r'/api/waf-qa-[a-f0-9]{32}', values['QaPath']):
        raise Error('An isolated QA rule must be deployed before probing')
    status, _, body = read_ipv4_https('checkip.amazonaws.com', '/')
    if status != 200:
        raise Error('Unable to verify the QA public IPv4 source')
    source = ipaddress.ip_address(body.decode().strip())
    if str(source) + '/32' != values['QaSourceCidr']:
        raise Error('QA source IP changed; refusing to probe a rule that cannot match this tester')
    started = datetime.now(timezone.utc)
    statuses, blocked = [], False
    for attempt in range(180):
        status, headers, body = read_http(values['QaPath'])
        lower = {key.lower(): item for key, item in headers.items()}
        statuses.append(status)
        if status == 429 and lower.get('x-bolts-rate-limit') == 'edge' and lower.get('retry-after') == '60' and lower.get('access-control-allow-origin') == ORIGIN:
            if json.loads(body).get('source') == 'edge-rate-limit':
                blocked = True
                break
        if attempt % 15 == 0:
            print(f'QA request {attempt + 1}/180: HTTP {status}; awaiting approximate WAF enforcement.', flush=True)
        time.sleep(2)
    # The QA rate scope must not block normal API paths or ordinary preflights.
    health = read_http('/api/health')
    cors = read_http('/api/session', 'OPTIONS', {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type'})
    normal = health[0] == 200 and cors[0] in {200, 204} and {k.lower(): v for k, v in cors[1].items()}.get('access-control-allow-origin') == ORIGIN
    metrics = aws.call('cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/WAFV2', '--metric-name', 'BlockedRequests',
                       '--dimensions', 'Name=WebACL,Value=BoltsApiWebAcl', 'Name=Rule,Value=BoltsQaRateProof',
                       '--start-time', (started - timedelta(minutes=2)).isoformat(), '--end-time', datetime.now(timezone.utc).isoformat(),
                       '--period', '60', '--statistics', 'Sum')
    save(folder / 'qa-probe.json', {'startedAt': started.isoformat(), 'requests': len(statuses), 'statuses': statuses,
                                  'transport': 'direct-https-ipv4',
                                  'waf429Observed': blocked, 'normalHealthAndCors': normal,
                                  'metrics': metrics, 'passed': blocked and normal,
                                  'cleanupRequired': 'Create a new plan without --qa-ip, apply, then --check confirms QA absent.'})
    if not blocked or not normal:
        raise Error('QA did not verify WAF blocking and healthy normal requests; see qa-probe.json')
    print('Verified real WAF 429 + Retry-After and unaffected health/CORS. Remove the temporary QA rule now.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for name in ('plan', 'apply', 'check', 'rollback', 'probe-qa'):
        mode.add_argument('--' + name, action='store_true')
    parser.add_argument('--qa-ip', help='One public IPv4 /32; plan only; omitted means no QA rule')
    parser.add_argument('--state-dir', type=Path, default=ROOT / 'temp/abuse-protection/rollout')
    args = parser.parse_args(argv)
    if args.qa_ip and any((args.apply, args.check, args.rollback, args.probe_qa)):
        raise Error('--qa-ip belongs only to a new plan')
    folder = args.state_dir.resolve()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder / '.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        aws = AWS(args.apply or args.rollback)
        if args.apply:
            apply(aws, folder)
        elif args.check:
            check(aws, folder)
        elif args.rollback:
            rollback(aws, folder)
        elif args.probe_qa:
            probe_qa(aws, folder)
        else:
            plan(aws, folder, args.qa_ip)


if __name__ == '__main__':
    try:
        main()
    except (Error, OSError, ValueError, KeyError) as error:
        print('Abuse protection stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
