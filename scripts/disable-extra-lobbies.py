#!/usr/bin/env python3
"""Disable only Bolts' three optional GameLift locations, preserving resources.

Default is a read-only plan. --apply blocks new placements/admissions, checks
active and reserved seats, stops autoscaling, then sets all capacity bounds to
zero. --verify confirms completion. Prior settings are retained under temp/.
No fleet, build, session, database or Oregon resource is deleted.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regional_deploy', ROOT / 'scripts/deploy-gamelift.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
LOCATIONS = deploy.LOCATIONS
REGION = deploy.REGION
Error = deploy.DeploymentError


def sessions(aws, fleet):
    result = []
    for location in LOCATIONS.values():
        rows = aws.call('gamelift', 'describe-game-sessions', '--fleet-id', fleet, '--location', location)['GameSessions']
        for row in rows:
            if row['Status'] not in {'ACTIVE', 'ACTIVATING'}:
                continue
            if row.get('Location') != location or row.get('FleetId') != fleet:
                raise Error('Unexpected session fleet/location; refusing changes')
            if row['Status'] == 'ACTIVATING':
                raise Error('A regional session is still activating; retry when stable')
            seats = aws.call('gamelift', 'describe-player-sessions', '--game-session-id', row['GameSessionId'])['PlayerSessions']
            if row.get('CurrentPlayerSessionCount', 0) or any(p['Status'] in {'ACTIVE', 'RESERVED'} for p in seats):
                raise Error('A regional human seat is active or reserved; no scale-down is allowed')
            result.append(row)
    return result


def inspect(aws, fleet):
    attrs = aws.call('gamelift', 'describe-fleet-attributes', '--fleet-ids', fleet)['FleetAttributes']
    if len(attrs) != 1 or attrs[0].get('Name') != 'bolts-gamelift-games' or attrs[0].get('Status') != 'ACTIVE' or attrs[0].get('NewGameSessionProtectionPolicy') != 'FullProtection':
        raise Error('Expected the active, protected Bolts regional fleet')
    fleet_arn = attrs[0]['FleetArn']
    locations = aws.call('gamelift', 'describe-fleet-location-attributes', '--fleet-id', fleet)['LocationAttributes']
    stopped = {r['LocationState']['Location']: r.get('StoppedActions', []) for r in locations}
    if not set(LOCATIONS.values()).issubset(stopped) or set(stopped) - {REGION, *LOCATIONS.values()}:
        raise Error('Unexpected fleet locations; refusing changes')
    queues = aws.call('gamelift', 'describe-game-session-queues', '--names', *['bolts-gamelift-' + k for k in LOCATIONS])['GameSessionQueues']
    if {q['Name'] for q in queues} != {'bolts-gamelift-' + k for k in LOCATIONS}:
        raise Error('Missing or unexpected regional queues')
    for queue in queues:
        key = queue['Name'].removeprefix('bolts-gamelift-')
        if queue.get('FilterConfiguration', {}).get('AllowedLocations') != [LOCATIONS[key]] or queue.get('Destinations') not in ([], [{'DestinationArn': fleet_arn}]):
            raise Error('Queue contains a different fleet/location; refusing changes')
    capacity = {loc: aws.call('gamelift', 'describe-fleet-location-capacity', '--fleet-id', fleet, '--location', loc)['FleetCapacity'] for loc in [REGION, *LOCATIONS.values()]}
    if any(capacity[REGION]['InstanceCounts'].get(k) != 0 for k in ('MINIMUM', 'MAXIMUM', 'DESIRED', 'ACTIVE')):
        raise Error('Home region has unexpected capacity; refusing changes')
    return {'fleetId': fleet, 'queues': queues, 'stoppedActions': stopped, 'capacity': capacity, 'sessions': sessions(aws, fleet)}


def restore_admissions(aws, snapshot):
    failures = []
    for row in snapshot['sessions']:
        try:
            aws.call('gamelift', 'update-game-session', '--game-session-id', row['GameSessionId'], '--player-session-creation-policy', row['PlayerSessionCreationPolicy'], mutation=True)
        except Error as error:
            failures.append(str(error))
    for queue in snapshot['queues']:
        try:
            aws.call('gamelift', 'update-game-session-queue', '--name', queue['Name'], '--destinations', json.dumps(queue['Destinations']), mutation=True)
        except Error as error:
            failures.append(str(error))
    if failures:
        raise Error('Admission rollback incomplete; inspect saved before.json: ' + '; '.join(failures))


def disable(aws, snapshot, folder):
    fleet = snapshot['fleetId']
    # Recheck immediately before the first write; preserve recovery evidence.
    snapshot['sessions'] = sessions(aws, fleet)
    deploy.save(folder / 'before.json', snapshot)
    try:
        for queue in snapshot['queues']:
            aws.call('gamelift', 'update-game-session-queue', '--name', queue['Name'], '--destinations', '[]', mutation=True)
        current = sessions(aws, fleet)
        known = {row['GameSessionId'] for row in snapshot['sessions']}
        snapshot['sessions'].extend(row for row in current if row['GameSessionId'] not in known)
        deploy.save(folder / 'before.json', snapshot)
        for row in current:
            aws.call('gamelift', 'update-game-session', '--game-session-id', row['GameSessionId'], '--player-session-creation-policy', 'DENY_ALL', mutation=True)
        after = sessions(aws, fleet)
        if any(row['GameSessionId'] not in {r['GameSessionId'] for r in current} or row.get('PlayerSessionCreationPolicy') != 'DENY_ALL' for row in after):
            raise Error('Regional admissions changed while draining; retry when stable')
    except Exception:
        restore_admissions(aws, snapshot)
        raise
    # From this point, interrupted runs remain safely disabled and resumable.
    # FullProtection is retained; sessions drain via their normal shutdown path.
    for location in LOCATIONS.values():
        aws.call('gamelift', 'stop-fleet-actions', '--fleet-id', fleet, '--location', location, '--actions', 'AUTO_SCALING', mutation=True)
        aws.call('gamelift', 'update-fleet-capacity', '--fleet-id', fleet, '--location', location,
                 '--min-size', '0', '--desired-instances', '0', '--max-size', '0',
                 '--managed-capacity-configuration', 'ZeroCapacityStrategy=MANUAL', mutation=True)
    deploy.save(folder / 'applied.json', {'fleetId': fleet, 'extraLobbies': False})


def verify(snapshot):
    for location in LOCATIONS.values():
        capacity = snapshot['capacity'][location]
        counts = capacity['InstanceCounts']
        if any(counts.get(k, 0) != 0 for k in ('MINIMUM', 'MAXIMUM', 'DESIRED', 'ACTIVE', 'PENDING', 'TERMINATING')):
            raise Error('Regional capacity is still draining; repeat --verify')
        if 'AUTO_SCALING' not in snapshot['stoppedActions'][location] or capacity.get('ManagedCapacityConfiguration', {}).get('ZeroCapacityStrategy') != 'MANUAL':
            raise Error('Regional autoscaling is not fully disabled')
    if any(queue['Destinations'] for queue in snapshot['queues']):
        raise Error('Regional placement queues still have destinations')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fleet-id', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--state-root', type=Path, default=ROOT / 'temp/extra-lobbies-disabled')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'fleet-[a-f0-9-]{36}', args.fleet_id):
        raise Error('Invalid fleet ID')
    if deploy.extra_lobbies_enabled():
        raise Error('Set shared/features.json extraLobbies to false before disabling capacity')
    folder = args.state_root / args.fleet_id
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / '.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        aws = deploy.AWS(args.apply)
        snapshot = inspect(aws, args.fleet_id)
        deploy.save(folder / 'observed.json', snapshot)
        if args.apply:
            if (folder / 'before.json').exists():
                # Never overwrite the original restoration settings on retry.
                previous = json.loads((folder / 'before.json').read_text())
                retry = folder / 'retries'
                retry.mkdir(exist_ok=True)
                disable(aws, snapshot, retry)
                deploy.save(folder / 'before.json', previous)
            else:
                disable(aws, snapshot, folder)
            print('Extra regional admissions blocked and capacity set to zero; repeat --verify until drained.')
        elif args.verify:
            verify(snapshot)
            deploy.save(folder / 'verified.json', dict(snapshot, verifiedAt=datetime.now(timezone.utc).isoformat()))
            print('Verified: all extra locations have zero running/pending/terminating instances and no autoscaling or placement destinations.')
        else:
            print(json.dumps({'fleetId': args.fleet_id, 'locations': LOCATIONS,
                              'currentCapacity': {loc: row['InstanceCounts'] for loc, row in snapshot['capacity'].items()},
                              'activeOrReservedHumanSeats': 0, 'action': 'Block regional placements/admissions, stop autoscaling, set all regional capacity bounds to zero',
                              'state': str(folder), 'apply': False}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (Error, OSError, ValueError, KeyError) as error:
        print('Disable stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
