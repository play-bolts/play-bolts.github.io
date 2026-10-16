#!/usr/bin/env python3
"""Prepare a GameLift build/configuration without changing AWS resources.

--preflight performs read-only AWS checks. --build builds native Linux binaries
with Docker using a positive allowlist as its context. No credentials or game
databases enter the image, uploaded build, template or manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/gamelift'
HOME_REGION = 'us-east-1'
LOCATIONS = {'ca': 'us-west-1', 'ny': 'us-east-1-nyc-2', 'sp': 'sa-east-1', 'par': 'eu-west-3'}


def aws(*args):
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/aws-command.py'),
                             '--region', HOME_REGION, *args, '--output', 'json'],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def template():
    ref = lambda key: {'Ref': key}
    sub = lambda text: {'Fn::Sub': text}
    secret_arn = sub('arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/bolts/gamelift/cluster-secret')
    parameters = {
        'BuildId': {'Type': 'String', 'AllowedPattern': 'build-[a-f0-9-]+'},
        'DirectoryRoleName': {'Type': 'String', 'Description': 'Existing EC2 instance role; preserve its current policies.'},
        'InstanceType': {'Type': 'String', 'Default': 'c7i.large', 'AllowedValues': ['c7i.large']},
        'MaximumInstancesPerLocation': {'Type': 'Number', 'Default': 2, 'MinValue': 1, 'MaxValue': 10},
    }
    role = {'Type': 'AWS::IAM::Role', 'Properties': {
        'RoleName': sub('${AWS::StackName}-game-role'),
        'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Principal': {'Service': 'gamelift.amazonaws.com'}, 'Action': 'sts:AssumeRole',
            'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
        'Policies': [{'PolicyName': 'ReadClusterSecret', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Action': 'ssm:GetParameter', 'Resource': secret_arn}]}}],
    }}
    locations = [{'Location': HOME_REGION, 'LocationCapacity': {'MinSize': 0, 'DesiredEC2Instances': 0, 'MaxSize': 0}}]
    policies = []
    for key, location in LOCATIONS.items():
        locations.append({'Location': location, 'LocationCapacity': {
            'MinSize': 0, 'DesiredEC2Instances': 0, 'MaxSize': ref('MaximumInstancesPerLocation'),
            'ManagedCapacityConfiguration': {'ZeroCapacityStrategy': 'SCALE_TO_AND_FROM_ZERO', 'ScaleInAfterInactivityMinutes': 5}}})
        policies.append({'Name': 'spare-capacity-' + key, 'Location': location, 'PolicyType': 'TargetBased',
                         'MetricName': 'PercentAvailableGameSessions', 'TargetConfiguration': {'TargetValue': 20}})
    fleet = {'Type': 'AWS::GameLift::Fleet', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain', 'Properties': {
        'Name': sub('${AWS::StackName}-games'), 'BuildId': ref('BuildId'), 'FleetType': 'ON_DEMAND',
        'EC2InstanceType': ref('InstanceType'), 'ComputeType': 'EC2',
        'CertificateConfiguration': {'CertificateType': 'GENERATED'},
        'InstanceRoleARN': {'Fn::GetAtt': ['GameRole', 'Arn']},
        'NewGameSessionProtectionPolicy': 'FullProtection',
        'EC2InboundPermissions': [{'FromPort': 8080, 'ToPort': 8081, 'IpRange': '0.0.0.0/0', 'Protocol': 'TCP'}],
        'RuntimeConfiguration': {'GameSessionActivationTimeoutSeconds': 120, 'MaxConcurrentGameSessionActivations': 2,
            'ServerProcesses': [{'ConcurrentExecutions': 1, 'LaunchPath': '/local/game/bolts-host',
                'Parameters': f'--mode=game --config=/local/game/host.json --server=/local/game/bolts-server --port={port}'} for port in (8080, 8081)]},
        'Locations': locations, 'ScalingPolicies': policies, 'ApplyCapacity': 'ON_CREATE_AND_UPDATE_WITH_AUTOSCALING',
    }}
    resources = {'GameRole': role, 'Fleet': fleet}
    for key, location in LOCATIONS.items():
        resources['Queue' + key.title()] = {'Type': 'AWS::GameLift::GameSessionQueue', 'Properties': {
            'Name': sub('${AWS::StackName}-' + key), 'TimeoutInSeconds': 600,
            'Destinations': [{'DestinationArn': {'Fn::GetAtt': ['Fleet', 'FleetArn']}}],
            'FilterConfiguration': {'AllowedLocations': [location]},
            'PriorityConfiguration': {'PriorityOrder': ['LOCATION', 'DESTINATION', 'COST', 'LATENCY'], 'LocationOrder': [location]},
        }}
    resources['DirectoryPolicy'] = {'Type': 'AWS::IAM::Policy', 'Properties': {
        'PolicyName': sub('${AWS::StackName}-directory'), 'Roles': [ref('DirectoryRoleName')],
        'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
            {'Effect': 'Allow', 'Action': 'ssm:GetParameter', 'Resource': secret_arn},
            {'Effect': 'Allow', 'Action': ['gamelift:DescribeGameSessions', 'gamelift:DescribePlayerSessions',
                'gamelift:CreatePlayerSession', 'gamelift:DescribeGameSessionPlacement'], 'Resource': '*'},
            {'Effect': 'Allow', 'Action': 'gamelift:StartGameSessionPlacement',
                'Resource': [{'Fn::GetAtt': ['Queue' + key.title(), 'Arn']} for key in LOCATIONS]},
        ]}}}
    return {'AWSTemplateFormatVersion': '2010-09-09', 'Description': 'Bolts global GameLift sessions, four exact locations, scale to zero',
            'Parameters': parameters, 'Resources': resources,
            'Outputs': {'FleetId': {'Value': ref('Fleet')}, 'FleetRoleArn': {'Value': {'Fn::GetAtt': ['GameRole', 'Arn']}}}}


def preflight():
    zone = aws('ec2', 'describe-availability-zones', '--all-availability-zones', '--filters', 'Name=group-name,Values=us-east-1-nyc-2')['AvailabilityZones']
    checks = [{'check': 'New York Local Zone enabled', 'ok': any(z.get('OptInStatus') == 'opted-in' for z in zone)}]
    for location in [HOME_REGION, *LOCATIONS.values()]:
        limits = aws('gamelift', 'describe-ec2-instance-limits', '--ec2-instance-type', 'c7i.large', '--location', location)['EC2InstanceLimits']
        limit = limits[0]['InstanceLimit'] if limits else 0
        checks.append({'check': location + ' c7i.large allowance', 'ok': limit >= 2, 'limit': limit})
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--stack', default='bolts-gamelift')
    parser.add_argument('--fleet-id', default='')
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'\d{12}', args.account_id) or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]{0,90}', args.stack):
        parser.error('Invalid account ID or stack name')
    OUT.mkdir(parents=True, exist_ok=True)
    config = json.loads((ROOT / 'infra/gamelift/host.example.json').read_text())
    config['fleetRole'] = f'arn:aws:iam::{args.account_id}:role/{args.stack}-game-role'
    config['fleet'] = args.fleet_id
    for loc in config['locations']:
        loc['queue'] = args.stack + '-' + loc['id']
    (OUT / 'host.json').write_text(json.dumps(config, indent=2) + '\n')
    (OUT / 'fleet.template.json').write_text(json.dumps(template(), indent=2) + '\n')
    files = [ROOT / 'server/Cargo.toml', ROOT / 'server/Cargo.lock', ROOT / 'server/schema.sql',
             *sorted((ROOT / 'server/src').glob('*.rs')), *sorted((ROOT / 'server/gamelift').glob('*.go')),
             ROOT / 'server/gamelift/go.mod', ROOT / 'server/gamelift/go.sum',
             ROOT / 'src/generated/hitboxData.json', ROOT / 'src/generated/handCollisionData.json', ROOT / 'infra/gamelift/Dockerfile']
    context = OUT / 'context'
    if context.exists():
        shutil.rmtree(context)
    for source in files:
        if not source.is_file() or source.is_symlink():
            raise ValueError('Invalid build input: ' + str(source))
        target = context / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    if args.preflight:
        checks = preflight()
        (OUT / 'preflight.json').write_text(json.dumps(checks, indent=2) + '\n')
        print(json.dumps(checks, indent=2))
    if args.build:
        subprocess.run(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--target', 'release',
                        '--output', 'type=local,dest=' + str(OUT / 'bundle'), '-f', str(context / 'infra/gamelift/Dockerfile'), str(context)], check=True)
        shutil.copyfile(OUT / 'host.json', OUT / 'bundle/host.json')
        shutil.copyfile(ROOT / 'infra/gamelift/install.sh', OUT / 'bundle/install.sh')
        for name in ['bolts-host', 'bolts-server', 'install.sh']:
            (OUT / 'bundle' / name).chmod(0o755)
        manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((OUT / 'bundle').iterdir()) if p.is_file()}
        (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Prepared GameLift configuration and allowlisted build context in ' + str(OUT))
    if args.preflight and not all(c['ok'] for c in checks):
        raise SystemExit('Deployment prerequisites are incomplete; no AWS resources were changed.')


if __name__ == '__main__':
    main()
