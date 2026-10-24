import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regional_qa_events', ROOT / 'scripts/verify-regional-qa-events.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class RegionalQAEventsTests(unittest.TestCase):
    def fixture(self):
        db = sqlite3.connect(':memory:')
        db.executescript((ROOT / 'server/schema.sql').read_text())
        lobby = 'arn:aws:gamelift:us-east-1:780705957578:gamesession/fleet-test/session'
        names = {role: f'QA {role} lon abcde' for role in ('Alpha', 'Beta', 'Observer')}
        db.execute('INSERT INTO lobbies VALUES(?,?,?,NULL,NULL)', (lobby, 'QA room', 900))
        db.execute('INSERT INTO matches VALUES(?,?,1,?,NULL,NULL,NULL)', ('match', lobby, 900))
        db.execute('INSERT INTO cluster_cursors VALUES(?,?)', (lobby, 30))
        def event(identifier, kind, player, target=None, connection=None, data=None):
            db.execute('INSERT INTO events(id,event_type,at,lobby_id,match_id,connection_id,actor_player_id,target_player_id,data) VALUES(?,?,1050,?,?,?,?,?,?)', (identifier, kind, lobby, 'match', connection, player, target, json.dumps(data or {})))
        for index, (role, name) in enumerate(names.items()):
            db.execute('INSERT INTO players(id,credential_hash,display_name,created_at,last_seen) VALUES(?,?,?,900,1100)', (role, 'private-' + role, name))
            db.execute('INSERT INTO memberships VALUES(?,?,?,?,?,?,1000,1100,?)', ('member-' + role, lobby, role, index, name, 'british', 'leave'))
            for connection_number in range(2 if role == 'Observer' else 1):
                connection = f'connection-{role}-{connection_number}'
                db.execute('INSERT INTO connections VALUES(?,?,1000,1100,?,?,?)', (connection, role, 'leave', 'private-ip', 'private-ua'))
                db.execute('INSERT INTO cluster_connection_owners VALUES(?,?)', (connection, lobby))
            event('enter-' + role, 'player_enter', role, connection=f'connection-{role}-0', data={'membershipId': 'member-' + role, 'spectator': True})
            event('leave-' + role, 'player_leave', role, data={'membershipId': 'member-' + role})
            if role == 'Observer':
                event('reconnect', 'player_reconnect', role, connection='connection-Observer-1')
            else:
                event('chat-' + role, 'chat', role)
                body = name + (': temporary QA <b>literal</b> ^3hello' if role == 'Alpha' else ': temporary QA reply')
                db.execute('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,1050)', ('chat-' + role, lobby, 'match', role, name, body))
                db.execute('INSERT INTO leaderboard_names VALUES(?,?,900,1100,1,1)', (name.lower(), name))
        for killer, victim in [('Alpha', 'Beta'), ('Beta', 'Alpha')]:
            combat_id = 'combat-' + killer
            event('kill-' + killer, 'player_kill', killer, victim, data={'combatId': combat_id})
            event('death-' + victim, 'player_death', victim, killer, data={'combatId': combat_id})
            db.execute('INSERT INTO combat_events VALUES(?,?,?,?,?,?,?,1,1050)', (combat_id, 'kill-' + killer, 'death-' + victim, 'match', killer, victim, 'rifle'))
            for role, player in [('kill', killer), ('death', victim)]:
                db.execute('INSERT INTO leaderboard_events VALUES(?,?,?,?,1050)', (combat_id, role, player, names[player].lower()))
        specification = {'runs': [{'location': 'lon', 'lobby': lobby, 'names': names, 'window': [900, 1200]}], 'tour': None}
        return db, specification

    def test_completed_imports_prove_counts_without_exposing_payloads(self):
        db, specification = self.fixture()
        result = verify.audit(db, specification)
        self.assertTrue(result['passed'], result)
        city = result['cities'][0]
        self.assertEqual(city['combatRows'], 2)
        self.assertEqual(city['linkedCombatRows'], 2)
        self.assertEqual(city['leaderboardRoleRows'], 4)
        self.assertEqual(city['roles']['Observer']['reconnectEvents'], 1)
        output = json.dumps(result)
        for private in ('QA Alpha', '<b>literal</b>', 'private-', specification['runs'][0]['lobby'], 'member-'):
            self.assertNotIn(private, output)
        db.close()

    def test_missing_or_wrong_replication_is_detected(self):
        cases = [
            ("DELETE FROM chat_messages WHERE player_id='Alpha'", 'AlphaChat'),
            ("DELETE FROM events WHERE id='leave-Beta'", 'BetaMembership'),
            ("UPDATE connections SET closed_at=NULL WHERE player_id='Observer'", 'ObserverConnections'),
            ("DELETE FROM cluster_connection_owners WHERE connection_id='connection-Alpha-0'", 'AlphaConnections'),
            ("DELETE FROM leaderboard_events WHERE role='kill'", 'leaderboardLinks'),
            ("UPDATE combat_events SET headshot=0 WHERE killer_id='Beta'", 'reciprocalCombat'),
            ("UPDATE events SET target_player_id='Observer' WHERE id='kill-Alpha'", 'combatEventLinks'),
        ]
        for sql, check in cases:
            with self.subTest(check=check):
                db, specification = self.fixture()
                db.execute(sql)
                result = verify.audit(db, specification)
                self.assertFalse(result['passed'])
                self.assertFalse(result['cities'][0]['checks'][check])
                db.close()

    def test_remote_payload_is_read_only_and_release_guarded(self):
        db, specification = self.fixture()
        script = verify.remote_script(specification, 'a' * 64)
        payload = script.split("python3 - <<'BOLTS_QA_AUDIT'\n", 1)[1].rsplit('\nBOLTS_QA_AUDIT', 1)[0]
        compile(payload, '<readonly-qa-audit>', 'exec')
        self.assertIn("?mode=ro", payload)
        self.assertIn("PRAGMA query_only=ON", payload)
        self.assertIn('Release changed before QA audit', payload)
        for forbidden in ('credential_hash', 'IDENTITY_SALT', 'systemctl', 'INSERT INTO', 'UPDATE ', 'DELETE FROM'):
            self.assertNotIn(forbidden, payload)
        db.close()

    def test_generated_payload_reads_snapshot_without_changing_database(self):
        db, specification = self.fixture()
        script = verify.remote_script(specification, 'a' * 64)
        payload = script.split("python3 - <<'BOLTS_QA_AUDIT'\n", 1)[1].rsplit('\nBOLTS_QA_AUDIT', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'qa.sqlite'
            target = sqlite3.connect(path)
            db.commit()
            db.backup(target)
            target.close()
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            output = io.StringIO()
            with patch('os.readlink', return_value='/opt/bolts/releases/' + 'a' * 64), patch.object(Path, 'read_text', return_value='BOLTS_DB=' + str(path)), contextlib.redirect_stdout(output):
                exec(compile(payload, '<readonly-qa-audit>', 'exec'), {})
            self.assertTrue(json.loads(output.getvalue())['passed'])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        db.close()

    def test_identity_tour_requires_closed_spectator_membership(self):
        db, specification = self.fixture()
        specification['tour'] = {'player': 'Observer', 'window': [900, 1200], 'stages': [{'location': 'lon', 'lobby': specification['runs'][0]['lobby']}]}
        self.assertTrue(verify.audit(db, specification)['identityTour'][0]['passed'])
        db.execute("UPDATE memberships SET left_at=NULL WHERE player_id='Observer'")
        self.assertFalse(verify.audit(db, specification)['identityTour'][0]['passed'])
        db.close()

    def test_local_plan_requires_four_complete_reports_and_never_calls_aws(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for location in verify.LOCATIONS:
                names = {role: f'QA {role} {location} abcde' for role in ('Alpha', 'Beta', 'Observer')}
                report = {'passed': True, 'mode': 'production QA', 'endpoint': verify.ORIGIN, 'location': location,
                          'lobbyId': 'room' if location == 'or' else f'arn:aws:gamelift:us-east-1:780705957578:gamesession/fleet-test/{location}',
                          'startedAt': '2026-10-17T14:00:00Z', 'durationSeconds': 120,
                          'authoritativeEffects': [{'actor': names[role], 'observer': names['Observer']} for role in ('Alpha', 'Beta')],
                          'combat': [{'part': 'head', 'headshot': True, 'shooter': names[a], 'victim': names[b]} for a, b in [('Alpha', 'Beta'), ('Beta', 'Alpha')]]}
                path = Path(directory) / (location + '.json')
                path.write_text(json.dumps(report))
                paths.append(path)
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                verify.load_reports(paths[:-1])
            args = [value for path in paths for value in ['--report', str(path)]] + ['--fleet', 'fleet-' + 'a' * 8 + ('-' + 'a' * 4) * 3 + '-' + 'a' * 12, '--expected-release', 'a' * 64]
            output = io.StringIO()
            with patch.object(verify.importlib.util, 'spec_from_file_location', side_effect=AssertionError('AWS helper must not load')), contextlib.redirect_stdout(output):
                verify.main(args)
            self.assertEqual(json.loads(output.getvalue())['mode'], 'local plan only')


if __name__ == '__main__':
    unittest.main()
