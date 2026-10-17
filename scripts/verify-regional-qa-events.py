#!/usr/bin/env python3
"""Read-only central persistence audit of completed regional QA reports.

Default validates local reports and prints an aggregate plan. --aws verifies
GameLift session locations and runs a fixed read-only SQLite audit through SSM.
No chat text, names, credentials, identity salts or UUIDs appear in the output.
This complements verify-regional-backend.py; it does not replace its baseline,
integrity, credential-continuity and backup checks.
"""
import argparse
import datetime
import importlib.util
import inspect
import json
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://bolts-api.christopherkrapu.com'
LOCATIONS = {'or': 'us-west-2', 'lon': 'eu-west-2', 'sg': 'ap-southeast-1', 'sp': 'sa-east-1'}
INSTANCE = 'i-0bd1adb3fc8b01688'
FLEET = re.compile(r'fleet-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
SHA = re.compile(r'[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def window(report):
    start = int(datetime.datetime.fromisoformat(report['startedAt'].replace('Z', '+00:00')).timestamp() * 1000)
    duration = report['durationSeconds']
    if not isinstance(duration, (int, float)) or not 0 < duration <= 2100:
        raise ValueError('QA duration is invalid')
    return [start - 2000, start + int(duration * 1000) + 30000]


def load_reports(paths, identity_path=None):
    runs = []
    for path in paths:
        report = json.loads(path.read_text())
        location = report.get('location')
        if report.get('passed') is not True or report.get('mode') != 'production QA' or report.get('endpoint') != ORIGIN or location not in LOCATIONS:
            raise ValueError('Only successful production combat reports from the reviewed endpoint are accepted')
        roles = {}
        for row in report.get('authoritativeEffects', []):
            for field in ('actor', 'observer'):
                name = row.get(field, '')
                match = re.fullmatch(r'QA (Alpha|Beta|Observer) ' + location + r' ([a-z0-9]{5})', name)
                if not match or (match[1] in roles and roles[match[1]] != name):
                    raise ValueError('Combat report does not contain the expected isolated QA identities')
                roles[match[1]] = name
        if set(roles) != {'Alpha', 'Beta', 'Observer'} or len({name.rsplit(' ', 1)[-1] for name in roles.values()}) != 1:
            raise ValueError('Exactly one matched Alpha, Beta and Observer QA set is required')
        heads = [row for row in report.get('combat', []) if row.get('part') == 'head' and row.get('headshot') is True]
        if sorted((row.get('shooter'), row.get('victim')) for row in heads) != sorted([(roles['Alpha'], roles['Beta']), (roles['Beta'], roles['Alpha'])]):
            raise ValueError('Report must verify both reciprocal headshot kills')
        lobby = report.get('lobbyId', '')
        if not isinstance(lobby, str) or not lobby or len(lobby) > 512 or lobby.startswith('new:'):
            raise ValueError('An actual bounded lobby identifier is required')
        if location != 'or' and not lobby.startswith('arn:aws:gamelift:'):
            raise ValueError('Regional report must identify its GameLift game session')
        runs.append({'location': location, 'lobby': lobby, 'names': roles, 'window': window(report)})
    if len(runs) != 4 or {run['location'] for run in runs} != set(LOCATIONS):
        raise ValueError('Supply exactly one successful combat report for each of or, lon, sg and sp')
    tour = None
    if identity_path:
        report = json.loads(identity_path.read_text())
        if report.get('passed') is not True or report.get('mode') != 'production spectator identity QA' or report.get('endpoint') != ORIGIN or not UUID.fullmatch(report.get('playerId', '')):
            raise ValueError('Only a successful production identity-tour report is accepted')
        stages = report.get('stages', [])
        if len(stages) != 4 or {stage.get('location') for stage in stages} != set(LOCATIONS):
            raise ValueError('The identity tour must visit exactly all four locations')
        for stage in stages:
            if stage.get('playerId') != report['playerId'] or not all(stage.get(key) is True for key in ('spectator', 'credentialUnchanged', 'sessionApiVerified', 'workerIdentityVerified')):
                raise ValueError('Identity tour did not preserve the same spectator identity')
            if not isinstance(stage.get('lobbyId'), str) or not 1 <= len(stage['lobbyId']) <= 512 or stage['lobbyId'].startswith('new:'):
                raise ValueError('Identity tour must contain actual lobby identifiers')
        tour = {'player': report['playerId'], 'window': window(report), 'stages': [{'location': row['location'], 'lobby': row['lobbyId']} for row in stages]}
    return {'runs': sorted(runs, key=lambda run: run['location']), 'tour': tour}


def audit(db, specification):
    """Only parameterized SELECTs. Returns city/role aggregates, never row data."""
    def count(sql, parameters=()):
        return db.execute(sql, parameters).fetchone()[0]

    def membership(lobby, player, start, end):
        rows = db.execute('SELECT id,left_at FROM memberships WHERE lobby_id=? AND player_id=? AND joined_at BETWEEN ? AND ?', (lobby, player, start, end)).fetchall()
        enters = leaves = linked = closed = 0
        for membership_id, left_at in rows:
            closed += left_at is not None
            enter = count("SELECT count(*) FROM events WHERE lobby_id=? AND actor_player_id=? AND event_type='player_enter' AND json_extract(data,'$.membershipId')=?", (lobby, player, membership_id))
            leave = count("SELECT count(*) FROM events WHERE lobby_id=? AND actor_player_id=? AND event_type='player_leave' AND json_extract(data,'$.membershipId')=?", (lobby, player, membership_id))
            enters += enter
            leaves += leave
            linked += enter == 1 and leave == 1
        return {'memberships': len(rows), 'closedMemberships': closed, 'enterEvents': enters, 'leaveEvents': leaves, 'exactlyLinkedMemberships': linked}

    result = {'cities': [], 'identityTour': []}
    for run in specification['runs']:
        lobby, start, end = run['lobby'], *run['window']
        managed = run['location'] != 'or'
        cursor = db.execute('SELECT through FROM cluster_cursors WHERE session=?', (lobby,)).fetchone()
        city = {'location': run['location'], 'importedSession': cursor is not None, 'replicationAdvanced': cursor is not None and cursor[0] > 0, 'roles': {}, 'checks': {}}
        city['checks']['correctImportOwnership'] = bool(cursor and cursor[0] > 0) if managed else cursor is None
        ids = {}
        for role, name in run['names'].items():
            players = [row[0] for row in db.execute('SELECT DISTINCT m.player_id FROM memberships m JOIN players p ON p.id=m.player_id WHERE m.lobby_id=? AND m.name_at_join=? AND m.joined_at BETWEEN ? AND ? AND p.is_bot=0', (lobby, name, start, end))]
            data = {'matchingHumanIdentities': len(players)}
            city['roles'][role] = data
            if len(players) != 1:
                city['checks'][role + 'Identity'] = False
                continue
            player = players[0]
            ids[role] = player
            data.update(membership(lobby, player, start, end))
            event_counts = dict(db.execute('SELECT event_type,count(*) FROM events WHERE lobby_id=? AND actor_player_id=? AND at BETWEEN ? AND ? GROUP BY event_type', (lobby, player, start, end)))
            data['killEvents'] = event_counts.get('player_kill', 0)
            data['deathEvents'] = event_counts.get('player_death', 0)
            data['reconnectEvents'] = event_counts.get('player_reconnect', 0)
            data['chatEvents'] = event_counts.get('chat', 0)
            data['chatRows'] = count('SELECT count(*) FROM chat_messages WHERE lobby_id=? AND player_id=? AND created_at BETWEEN ? AND ?', (lobby, player, start, end))
            data['linkedChatRows'] = count("SELECT count(*) FROM chat_messages c JOIN events e ON e.id=c.id WHERE c.lobby_id=? AND c.player_id=? AND c.created_at BETWEEN ? AND ? AND e.event_type='chat' AND e.actor_player_id=c.player_id AND e.lobby_id=c.lobby_id AND e.match_id=c.match_id", (lobby, player, start, end))
            expected_body = name + (': temporary QA <b>literal</b> ^3hello' if role == 'Alpha' else ': temporary QA reply')
            data['expectedChatMatches'] = count('SELECT count(*) FROM chat_messages WHERE lobby_id=? AND player_id=? AND created_at BETWEEN ? AND ? AND body=?', (lobby, player, start, end, expected_body))
            data['connections'] = count('SELECT count(*) FROM connections WHERE player_id=? AND opened_at BETWEEN ? AND ?', (player, start, end))
            data['openConnections'] = count('SELECT count(*) FROM connections WHERE player_id=? AND opened_at BETWEEN ? AND ? AND closed_at IS NULL', (player, start, end))
            data['ownedConnections'] = count('SELECT count(*) FROM connections c JOIN cluster_connection_owners o ON o.connection_id=c.id WHERE c.player_id=? AND c.opened_at BETWEEN ? AND ? AND o.session=?', (player, start, end, lobby))
            scored = role != 'Observer'
            city['checks'][role + 'Membership'] = all(data[key] == 1 for key in ('memberships', 'closedMemberships', 'enterEvents', 'leaveEvents', 'exactlyLinkedMemberships'))
            city['checks'][role + 'Chat'] = all(data[key] == int(scored) for key in ('chatEvents', 'chatRows', 'linkedChatRows', 'expectedChatMatches'))
            city['checks'][role + 'Combat'] = data['killEvents'] == int(scored) and data['deathEvents'] == int(scored)
            city['checks'][role + 'Connections'] = data['connections'] >= (2 if role == 'Observer' else 1) and data['openConnections'] == 0 and data['ownedConnections'] == (data['connections'] if managed else 0)
            if role == 'Observer':
                city['checks']['durableReconnect'] = data['reconnectEvents'] >= 1
        if len(ids) == 3 and len(set(ids.values())) == 3:
            placeholders = ','.join('?' for _ in ids)
            parameters = [lobby, *ids.values(), *ids.values(), start, end]
            combat_sql = f'SELECT c.id,c.killer_id,c.victim_id,c.headshot,c.kill_event_id,c.death_event_id,c.match_id FROM combat_events c JOIN matches m ON m.id=c.match_id WHERE m.lobby_id=? AND c.killer_id IN ({placeholders}) AND c.victim_id IN ({placeholders}) AND c.created_at BETWEEN ? AND ?'
            combats = db.execute(combat_sql, parameters).fetchall()
            city['combatRows'] = len(combats)
            city['headshotRows'] = sum(row[3] == 1 for row in combats)
            city['checks']['reciprocalCombat'] = len(combats) == 2 and {(row[1], row[2]) for row in combats} == {(ids['Alpha'], ids['Beta']), (ids['Beta'], ids['Alpha'])} and city['headshotRows'] == 2
            linked = scores = 0
            for combat_id, killer, victim, _, kill_id, death_id, match_id in combats:
                linked += count("SELECT count(*) FROM events k JOIN events d ON d.id=? WHERE k.id=? AND k.event_type='player_kill' AND d.event_type='player_death' AND k.actor_player_id=? AND k.target_player_id=? AND d.actor_player_id=? AND d.target_player_id=? AND k.lobby_id=? AND d.lobby_id=? AND k.match_id=? AND d.match_id=? AND json_extract(k.data,'$.combatId')=? AND json_extract(d.data,'$.combatId')=?", (death_id, kill_id, killer, victim, victim, killer, lobby, lobby, match_id, match_id, combat_id, combat_id))
                for role, player in [('kill', killer), ('death', victim)]:
                    scores += count('SELECT count(*) FROM leaderboard_events WHERE combat_id=? AND role=? AND player_id=?', (combat_id, role, player))
            city['linkedCombatRows'], city['leaderboardRoleRows'] = linked, scores
            city['checks']['combatEventLinks'] = linked == 2
            city['checks']['leaderboardLinks'] = scores == 4
        else:
            city['checks']['threeDistinctHumans'] = False
        city['passed'] = all(city['checks'].values())
        result['cities'].append(city)
    tour = specification.get('tour')
    if tour:
        for stage in tour['stages']:
            lobby, player = stage['lobby'], tour['player']
            start, end = tour['window']
            row = {'location': stage['location'], **membership(lobby, player, start, end)}
            row['spectatorEnterEvents'] = count("SELECT count(*) FROM events WHERE lobby_id=? AND actor_player_id=? AND at BETWEEN ? AND ? AND event_type='player_enter' AND json_extract(data,'$.spectator')=1", (lobby, player, start, end))
            row['combatEvents'] = count("SELECT count(*) FROM events WHERE lobby_id=? AND actor_player_id=? AND at BETWEEN ? AND ? AND event_type IN ('player_kill','player_death')", (lobby, player, start, end))
            row['passed'] = all(row[key] == 1 for key in ('memberships', 'closedMemberships', 'enterEvents', 'leaveEvents', 'exactlyLinkedMemberships', 'spectatorEnterEvents')) and row['combatEvents'] == 0
            result['identityTour'].append(row)
    result['passed'] = all(row['passed'] for row in result['cities'] + result['identityTour'])
    return result


def remote_script(specification, release):
    encoded = json.dumps(json.dumps(specification, separators=(',', ':')))
    return "set -euo pipefail\npython3 - <<'BOLTS_QA_AUDIT'\n" + inspect.getsource(audit) + f'''
import json,os,shlex,sqlite3,time
from pathlib import Path
assert os.readlink('/opt/bolts/current').rsplit('/',1)[-1]=={release!r}, 'Release changed before QA audit'
db_path=None
for line in Path('/etc/bolts.env').read_text().splitlines():
 key,sep,value=line.partition('=')
 if sep and key=='BOLTS_DB':
  parts=shlex.split(value)
  assert len(parts)==1
  db_path=parts[0]
assert db_path
db=sqlite3.connect(Path(db_path).as_uri()+'?mode=ro',uri=True,timeout=15)
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
try:
 result=audit(db,json.loads({encoded}))
 result['capturedAt']=int(time.time()*1000)
 print(json.dumps(result,separators=(',',':')))
finally:
 db.rollback();db.close()
BOLTS_QA_AUDIT
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', action='append', type=Path, required=True)
    parser.add_argument('--identity-report', type=Path)
    parser.add_argument('--fleet', required=True)
    parser.add_argument('--expected-release', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'temp/regional-backend-verification/qa-events.json')
    parser.add_argument('--aws', action='store_true')
    args = parser.parse_args(argv)
    if not FLEET.fullmatch(args.fleet) or not SHA.fullmatch(args.expected_release):
        raise ValueError('Explicit valid fleet and release identifiers are required')
    specification = load_reports(args.report, args.identity_report)
    if not args.aws:
        print(json.dumps({'mode': 'local plan only', 'locations': sorted(LOCATIONS), 'identityTour': specification['tour'] is not None, 'remoteActions': ['DescribeGameSessions for reported regional games', 'Read-only aggregate SQLite inspection through SSM']}, indent=2))
        return
    if args.output.exists():
        raise ValueError('Output exists; choose a new report path to preserve prior evidence')
    module = importlib.util.spec_from_file_location('regional_deploy', ROOT / 'scripts/deploy-gamelift.py')
    deploy = importlib.util.module_from_spec(module)
    module.loader.exec_module(deploy)
    aws = deploy.AWS(apply=True)
    mappings = {(run['location'], run['lobby']) for run in specification['runs']}
    if specification['tour']:
        mappings.update((stage['location'], stage['lobby']) for stage in specification['tour']['stages'])
    for location, lobby in sorted(mappings):
        if location == 'or':
            continue
        games = aws.call('gamelift', 'describe-game-sessions', '--game-session-id', lobby).get('GameSessions', [])
        if len(games) != 1 or games[0].get('GameSessionId') != lobby or games[0].get('FleetId') != args.fleet or games[0].get('Location') != LOCATIONS[location]:
            raise ValueError('AWS did not confirm the reported game session in its expected fleet and city')
    # Only SSM records are created; the remote payload performs SELECTs only.
    command = deploy.ssm(aws, INSTANCE, remote_script(specification, args.expected_release), args.output.parent, 'Bolts read-only QA event persistence audit')
    result = json.loads(deploy.wait_ssm(aws, INSTANCE, command))
    result.update({'commandId': command, 'awsSessionLocationsVerified': True, 'expectedReleaseVerified': True})
    deploy.save(args.output, result)
    print(json.dumps(result, indent=2))
    if not result.get('passed'):
        raise ValueError('QA event persistence checks failed; allow replication to finish and inspect the aggregate report')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo raw report rows, AWS responses, SQL parameters or secrets.
        print('QA event audit stopped: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
