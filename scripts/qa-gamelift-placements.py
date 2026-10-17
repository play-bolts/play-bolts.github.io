#!/usr/bin/env python3
"""One-off, resumable empty-session smoke test for the reviewed regional fleet.

Default prints the local plan. --check performs read-only preflight. --apply
creates at most one six-seat game in each of the three exact city queues, then
verifies SDK activation and actual location. It never reserves player sessions,
changes capacity, or deletes games. --fleet is an explicit expected fleet ID;
remote preflight also resolves that ID from the stable bolts-gamelift stack.
Keep the state file to resume safely.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
REGION = 'us-east-1'
ACCOUNT = '780705957578'
STACK = 'bolts-gamelift'
FLEET_ID = re.compile(r'fleet-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
CITIES = {
    'lon': {'location': 'eu-west-2', 'queue': 'bolts-gamelift-lon', 'name': 'Rommel Alpha'},
    'sg': {'location': 'ap-southeast-1', 'queue': 'bolts-gamelift-sg', 'name': 'Guderian Alpha'},
    'sp': {'location': 'sa-east-1', 'queue': 'bolts-gamelift-sp', 'name': 'Manstein Alpha'},
}


class QAError(RuntimeError):
    pass


class AwsError(QAError):
    def __init__(self, operation, code):
        self.code = code
        super().__init__(f'{operation} failed ({code}); no raw AWS response printed')


class AWS:
    def __init__(self, apply=False):
        self.apply = apply

    def call(self, service, operation, **payload):
        if (service, operation) == ('gamelift', 'start-game-session-placement'):
            if not self.apply:
                raise QAError('Creating empty sessions requires --apply')
        elif service == 'gamelift' and operation not in {
            'describe-fleet-attributes', 'describe-fleet-location-attributes',
            'describe-fleet-location-capacity', 'describe-game-session-queues',
            'describe-game-sessions', 'describe-game-session-placement',
        }:
            raise QAError('AWS operation is outside this smoke test')
        elif service != 'gamelift' and (service, operation) not in {
            ('sts', 'get-caller-identity'), ('cloudformation', 'describe-stacks'),
        }:
            raise QAError('AWS service is outside this smoke test')
        if service == 'cloudformation' and payload != {'StackName': STACK}:
            raise QAError('Only the reviewed regional stack may be inspected')
        command = [sys.executable, str(ROOT / 'scripts/aws-command.py'), service, operation,
                   '--region', REGION, '--cli-connect-timeout', '5', '--cli-read-timeout', '20',
                   '--output', 'json', '--no-paginate', '--cli-input-json', json.dumps(payload)]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            raise AwsError(operation, 'Timeout') from None
        if result.returncode:
            code = re.search(r'An error occurred \(([A-Za-z0-9_.-]+)\)', result.stderr)
            raise AwsError(operation, code.group(1) if code else 'CLIError')
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise AwsError(operation, 'InvalidJSON') from None


def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.placements-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(state, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def fleet_arn(fleet):
    return f'arn:aws:gamelift:{REGION}:{ACCOUNT}:fleet/{fleet}'


def load_state(path, fleet):
    if not FLEET_ID.fullmatch(fleet):
        raise QAError('An explicit valid --fleet ID is required')
    if path.exists():
        state = json.loads(path.read_text())
        if (state.get('fleet') != fleet or state.get('stack') != STACK or state.get('account') != ACCOUNT or
                state.get('region') != REGION or state.get('version') != 2):
            raise QAError('State belongs to a different rollout')
        if set(state.get('cities', {})) != set(CITIES):
            raise QAError('State must contain exactly the three reviewed cities')
        for key, city in CITIES.items():
            row = state['cities'][key]
            if any(row.get(field) != value for field, value in city.items()):
                raise QAError(f'{key}: state target has changed')
            if not re.fullmatch(r'bolts-regional-qa-[a-f0-9]{32}-' + key, row.get('placementId', '')):
                raise QAError(f'{key}: invalid saved placement ID')
        return state
    run = uuid.uuid4().hex
    state = {'version': 2, 'fleet': fleet, 'stack': STACK, 'account': ACCOUNT, 'region': REGION,
             'createdAt': int(time.time()), 'cities': {
                 key: {**city, 'placementId': f'bolts-regional-qa-{run}-{key}', 'status': 'PREPARED'}
                 for key, city in CITIES.items()}}
    save(path, state)
    return state


def sessions(aws, **request):
    result, token = [], None
    while True:
        page = aws.call('gamelift', 'describe-game-sessions', **request, **({'NextToken': token} if token else {}))
        result.extend(page.get('GameSessions', []))
        following = page.get('NextToken')
        if not following:
            return result
        if following == token:
            raise QAError('Game session pagination did not advance')
        token = following


def describe_placement(aws, row):
    try:
        result = aws.call('gamelift', 'describe-game-session-placement', PlacementId=row['placementId'])
    except AwsError as error:
        if error.code == 'NotFoundException':
            return None
        raise
    placement = result.get('GameSessionPlacement')
    if not placement:
        raise QAError('AWS omitted the placement record')
    return placement


def record_placement(row, placement):
    if (placement.get('PlacementId') != row['placementId'] or
            placement.get('GameSessionQueueName') != row['queue'] or
            placement.get('GameSessionName') != row['name'] or
            placement.get('MaximumPlayerSessionCount') != 6 or placement.get('PlacedPlayerSessions')):
        raise QAError('Placement does not match the saved empty six-seat request')
    row['status'] = placement.get('Status', 'UNKNOWN')
    # Preserve identifiers even on failed placement for bounded session-log diagnosis.
    for source, target in [('GameSessionId', 'gameSessionId'), ('GameSessionArn', 'gameSessionArn'),
                           ('GameSessionRegion', 'placementRegion')]:
        if placement.get(source):
            row[target] = placement[source]


def preflight(aws, state):
    if aws.call('sts', 'get-caller-identity').get('Account') != ACCOUNT:
        raise QAError('Unexpected AWS account')
    stacks = aws.call('cloudformation', 'describe-stacks', StackName=STACK).get('Stacks', [])
    if len(stacks) != 1:
        raise QAError('Expected exactly the reviewed regional stack')
    stack = stacks[0]
    outputs = {row.get('OutputKey'): row.get('OutputValue') for row in stack.get('Outputs', [])}
    if (stack.get('StackName') != STACK or
            not stack.get('StackId', '').startswith(f'arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{STACK}/') or
            stack.get('StackStatus') not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'} or
            outputs.get('FleetId') != state['fleet'] or
            outputs.get('FleetRoleArn') != f'arn:aws:iam::{ACCOUNT}:role/{STACK}-game-role'):
        raise QAError('Stable regional stack outputs do not match the explicitly expected fleet and role')
    fleet = outputs['FleetId']
    attributes = aws.call('gamelift', 'describe-fleet-attributes', FleetIds=[fleet]).get('FleetAttributes', [])
    if (len(attributes) != 1 or attributes[0].get('FleetId') != fleet or
            attributes[0].get('FleetArn') != fleet_arn(fleet) or attributes[0].get('Status') != 'ACTIVE'):
        raise QAError('Reviewed fleet is not ACTIVE')
    locations = aws.call('gamelift', 'describe-fleet-location-attributes', FleetId=fleet).get('LocationAttributes', [])
    statuses = {row['LocationState']['Location']: row['LocationState']['Status'] for row in locations}
    if any(statuses.get(city['location']) != 'ACTIVE' for city in CITIES.values()):
        raise QAError('All three city locations must be ACTIVE')
    for location in [REGION, *(city['location'] for city in CITIES.values())]:
        counts = aws.call('gamelift', 'describe-fleet-location-capacity', FleetId=fleet, Location=location).get('FleetCapacity', {}).get('InstanceCounts', {})
        if location == REGION:
            if any(counts.get(field) != 0 for field in ['MINIMUM', 'DESIRED', 'MAXIMUM', 'ACTIVE', 'PENDING']):
                raise QAError('Home location must have zero configured, active and pending capacity')
        elif (counts.get('MINIMUM') != 1 or counts.get('MAXIMUM') != 2 or
              counts.get('DESIRED') not in (1, 2) or counts.get('ACTIVE', 0) < 1):
            raise QAError(f'{location}: expected a warm instance with maximum two')
    queues = aws.call('gamelift', 'describe-game-session-queues', Names=[city['queue'] for city in CITIES.values()]).get('GameSessionQueues', [])
    by_name = {queue.get('Name'): queue for queue in queues}
    if set(by_name) != {city['queue'] for city in CITIES.values()} or len(queues) != 3:
        raise QAError('Expected exactly the three reviewed queues')
    for city in CITIES.values():
        queue = by_name[city['queue']]
        if (queue.get('Destinations') != [{'DestinationArn': fleet_arn(fleet)}] or
                queue.get('FilterConfiguration', {}).get('AllowedLocations') != [city['location']]):
            raise QAError(f"{city['queue']}: destination or allowed location differs")
    # Enumerate locations explicitly so the audit proves all four were checked.
    # All collision checks finish before any mutation.
    current = []
    for location in [REGION, *(city['location'] for city in CITIES.values())]:
        current.extend(sessions(aws, FleetId=fleet, Location=location))
    for key, row in state['cities'].items():
        placement = describe_placement(aws, row)
        if placement:
            record_placement(row, placement)
        allowed = row.get('gameSessionId')
        for game in current:
            if game.get('Name') == row['name'] and game.get('GameSessionId') != allowed:
                raise QAError(f'{key}: requested lobby name is already in use')
        if placement is None and row.get('attemptedAt'):
            raise QAError(f'{key}: an earlier create attempt is not visible; preserve state and inspect before retrying')


def verify_session(aws, row, fleet):
    if not row.get('gameSessionId'):
        raise QAError('FULFILLED placement omitted its session identifier')
    found = sessions(aws, GameSessionId=row['gameSessionId'])
    if len(found) != 1:
        raise QAError('Expected exactly one placed game session')
    game = found[0]
    if (game.get('FleetId') != fleet or game.get('GameSessionId') != row['gameSessionId'] or
            game.get('Location') != row['location'] or game.get('Name') != row['name'] or
            game.get('MaximumPlayerSessionCount') != 6 or game.get('CurrentPlayerSessionCount') != 0 or
            game.get('Status') != 'ACTIVE' or game.get('PlayerSessionCreationPolicy') != 'ACCEPT_ALL'):
        raise QAError(f"{row['queue']}: placed game is not ACTIVE, empty, six-seat, and in the requested location")
    row['actualLocation'] = game['Location']
    row['verifiedAt'] = int(time.time())


def run(aws, state, path, timeout=720, poll=10):
    preflight(aws, state)
    save(path, state)
    for key, row in state['cities'].items():
        if row['status'] == 'PREPARED':
            # Persist intent before the network call. An ambiguous call cannot create
            # a duplicate on resume because its ID is retained and never replaced.
            row['attemptedAt'] = int(time.time())
            save(path, state)
            response = aws.call('gamelift', 'start-game-session-placement',
                                PlacementId=row['placementId'], GameSessionQueueName=row['queue'],
                                MaximumPlayerSessionCount=6, GameSessionName=row['name'],
                                GameProperties=[{'Key': 'boltsLocation', 'Value': key}])
            record_placement(row, response.get('GameSessionPlacement', {}))
            save(path, state)
    deadline = time.monotonic() + timeout
    remaining, last = set(CITIES), {}
    while remaining:
        for key in list(CITIES):
            if key not in remaining:
                continue
            row = state['cities'][key]
            placement = describe_placement(aws, row)
            if placement is None:
                raise QAError(f'{key}: saved placement disappeared; no replacement created')
            record_placement(row, placement)
            save(path, state)
            if last.get(key) != row['status']:
                print(f"{key}: {row['status']}", flush=True)
                last[key] = row['status']
            if row['status'] == 'FULFILLED':
                verify_session(aws, row, state['fleet'])
                save(path, state)
                remaining.remove(key)
                print(f"{key}: ACTIVE in {row['actualLocation']}; zero player seats reserved", flush=True)
            elif row['status'] != 'PENDING':
                raise QAError(f"{key}: placement ended {row['status']}; IDs retained for diagnosis")
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise QAError('Placement wait expired; resume with the same state file')
        time.sleep(min(poll, max(0, deadline - time.monotonic())))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Read-only AWS preflight; no placements')
    mode.add_argument('--apply', action='store_true', help='Create/resume exactly three empty games')
    parser.add_argument('--fleet', required=True, help='Expected FleetId output of the stable bolts-gamelift stack')
    parser.add_argument('--state', type=Path, default=ROOT / 'temp/regional-validation/placement-smoke.json')
    parser.add_argument('--timeout', type=int, default=720)
    parser.add_argument('--poll', type=int, default=10)
    args = parser.parse_args(argv)
    if not FLEET_ID.fullmatch(args.fleet):
        raise QAError('An explicit valid --fleet ID is required')
    if not 1 <= args.poll <= 60 or not 1 <= args.timeout <= 1800:
        raise QAError('Poll must be 1–60 seconds; timeout must be 1–1800 seconds')
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(str(args.state) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise QAError('Another smoke test owns this state file') from None
        state = load_state(args.state, args.fleet)
        if args.apply:
            run(AWS(apply=True), state, args.state, args.timeout, args.poll)
            print(f'All three placements verified. Session identifiers saved privately to {args.state}')
        elif args.check:
            preflight(AWS(), state)
            save(args.state, state)
            print('Read-only preflight passed. No game or player sessions created.')
        else:
            print(json.dumps({'fleet': args.fleet, 'stack': STACK, 'cities': CITIES, 'seatsPerGame': 6,
                              'playerReservations': 0, 'state': str(args.state), 'requires': '--apply'}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (QAError, OSError, ValueError, KeyError) as error:
        print(f'Placement QA stopped: {error}', file=sys.stderr)
        sys.exit(1)
