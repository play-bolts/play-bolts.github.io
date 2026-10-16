import contextlib
from decimal import Decimal
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('user_analytics', ROOT / 'scripts/user-analytics.py')
analytics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analytics)
END = analytics.as_of_ms('2026-01-01T12:00:00Z')
START = END - 3_600_000


class UserAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'events ? #.sqlite'
        self.db = sqlite3.connect(self.path)
        self.db.executescript((ROOT / 'server/schema.sql').read_text())
        self.addCleanup(self.db.close)
        self.next_id = 0

    def player(self, name='Unknown Soldier', created=START - 1000, bot=False):
        self.next_id += 1
        player = str(UUID(int=self.next_id))
        self.db.execute('INSERT INTO players(id,credential_hash,display_name,created_at,last_seen,is_bot) VALUES(?,?,?,?,?,?)',
                        (player, 'test-only-' + player, name, created, END, int(bot)))
        self.db.commit()
        return player

    def connection(self, player, opened, closed=None):
        self.next_id += 1
        self.db.execute('INSERT INTO connections(id,player_id,opened_at,closed_at,ip_hash,ua_hash) VALUES(?,?,?,?,?,?)',
                        (str(UUID(int=self.next_id)), player, opened, closed, 'private-ip-sentinel', 'private-ua-sentinel'))
        self.db.commit()

    def count(self, excluded=()):
        return analytics.analyze(self.path, Decimal(1), END, excluded)

    def test_distinct_identity_counts_default_names_and_carryover_reconnects(self):
        first = self.player()
        self.connection(first, START - 1000)
        second = self.player('Named soldier', START + 100)
        self.connection(second, START + 100, END - 500)
        self.connection(second, END - 100)
        result = self.count()
        self.assertEqual(result['unique_players'], 2)
        self.assertEqual(result['connections'], 3)
        self.assertEqual(result['connected_at_end'], 2)
        self.assertEqual(result['carried_into_window'], 1)
        self.assertEqual(result['new_identities_in_window'], 1)

    def test_window_boundaries_and_connection_closed_at_end(self):
        ending_before_window = self.player()
        self.connection(ending_before_window, START - 100, START)
        beginning_at_start = self.player(created=START)
        self.connection(beginning_at_start, START, END)
        beginning_at_end = self.player(created=END)
        self.connection(beginning_at_end, END)
        future = self.player()
        self.connection(future, END + 1)
        result = self.count()
        self.assertEqual(result['unique_players'], 2)
        self.assertEqual(result['connected_at_end'], 1)
        self.assertEqual(result['carried_into_window'], 1)
        self.assertEqual(result['new_identities_in_window'], 1)

    def test_bot_sessions_and_leaderboard_seeds_do_not_create_users(self):
        bot = self.player('[AI] Rifleman', bot=True)
        self.connection(bot, START + 1)  # Even a malformed bot socket never counts.
        self.player('Only requested a session', START + 1)
        self.db.execute('INSERT INTO leaderboard_names VALUES(?,?,?,?,?,?)',
                        ('seed', 'Seed', START + 1, END, 300, 40))
        self.db.commit()
        self.assertEqual(self.count()['unique_players'], 0)

    def test_carryover_closed_inside_window_counts_and_last_seen_is_not_activity(self):
        carryover = self.player(created=START - 1_000_000)
        self.connection(carryover, START - 10_000, START + 1)
        stale = self.player()
        self.connection(stale, START - 10_000, START - 1)
        self.db.execute('UPDATE players SET last_seen=?', (END,))
        self.db.commit()
        result = self.count()
        self.assertEqual(result['unique_players'], 1)
        self.assertEqual(result['carried_into_window'], 1)
        self.assertEqual(result['connected_at_end'], 0)

    def test_explicit_exclusions_deduplicate_without_name_heuristics(self):
        qa = self.player('QA Alpha scripted')
        self.connection(qa, START + 10)
        real = self.player('QA Alpha real choice')
        self.connection(real, START + 10)
        absent = str(UUID(int=999))
        self.assertEqual(self.count()['unique_players'], 2)
        result = self.count([qa, qa, absent])
        self.assertEqual(result['unique_players'], 1)
        self.assertEqual(result['excluded_player_ids'], 2)
        self.assertEqual(result['excluded_active_players'], 1)

    def test_independent_browser_ids_are_not_merged_by_name_or_network_hashes(self):
        for _ in range(2):
            self.connection(self.player('Same name'), START + 10)
        self.assertEqual(self.count()['unique_players'], 2)

    def test_invalid_or_zero_length_intervals_do_not_count(self):
        bad = self.player()
        self.connection(bad, START + 100, START + 99)
        self.connection(bad, START + 100, START + 100)
        self.assertEqual(self.count()['unique_players'], 0)

    def test_read_only_query_includes_committed_wal_without_modifying_database(self):
        self.db.execute('PRAGMA wal_autocheckpoint=0')
        human = self.player()
        self.connection(human, START + 10)
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        with patch.object(analytics.sqlite3, 'connect', wraps=sqlite3.connect) as connect:
            self.assertEqual(self.count()['unique_players'], 1)
        self.assertTrue(connect.call_args.args[0].endswith('?mode=ro'))
        self.assertTrue(connect.call_args.kwargs['uri'])
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_missing_database_is_not_created(self):
        missing = self.path.with_name('missing.sqlite')
        with self.assertRaises(analytics.AnalyticsError):
            analytics.analyze(missing, Decimal(1), END)
        self.assertFalse(missing.exists())

    def test_json_cli_contains_no_names_ids_hashes_or_credentials(self):
        player = self.player('PRIVATE NAME')
        self.connection(player, START + 1)
        completed = subprocess.run([sys.executable, str(ROOT / 'scripts/user-analytics.py'), '--db', str(self.path),
                                    '--hours', '1', '--as-of', '2026-01-01T04:00:00-08:00', '--json'],
                                   capture_output=True, text=True, check=True)
        result = json.loads(completed.stdout)
        self.assertEqual(result['unique_players'], 1)
        self.assertEqual(result['window_end'], '2026-01-01T12:00:00.000Z')
        self.assertEqual(completed.stderr, '')
        for private in [player, 'PRIVATE NAME', 'private-ip-sentinel', 'private-ua-sentinel', 'test-only-']:
            self.assertNotIn(private, completed.stdout)

    def test_exclude_file_and_arguments_combine_and_report_matched_count(self):
        qa = self.player()
        self.connection(qa, START + 1)
        exclude = self.path.with_name('excluded.json')
        exclude.write_text(json.dumps([qa, str(UUID(int=999))]))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = analytics.main(['--db', str(self.path), '--hours', '1', '--as-of', '2026-01-01T12:00:00Z',
                                     '--exclude-file', str(exclude), '--exclude-player-id', qa, '--json'])
        self.assertEqual(result, 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report['unique_players'], 0)
        self.assertEqual(report['excluded_player_ids'], 2)
        self.assertEqual(report['excluded_active_players'], 1)
        for value in [{}, ['not-a-uuid'], [12]]:
            exclude.write_text(json.dumps(value))
            with self.assertRaises(analytics.AnalyticsError):
                analytics.exclusions_from_file(exclude)

    def test_hours_and_as_of_validation(self):
        self.assertEqual(analytics.positive_hours('1.5'), Decimal('1.5'))
        for hours in ['0', '-1', 'nan', 'inf', 'hello', '0.00000001']:
            with self.subTest(hours=hours), self.assertRaises(Exception):
                analytics.positive_hours(hours)
        for date in ['2026-01-01T12:00:00', 'yesterday', '2026-99-01T12:00:00Z']:
            with self.subTest(date=date), self.assertRaises(Exception):
                analytics.as_of_ms(date)

    def test_ssm_executes_same_source_locally_with_only_aggregate_output(self):
        import base64
        import re
        player = self.player()
        self.connection(player, START + 1)
        command = analytics.remote_command(Decimal(1), END, [])
        self.assertTrue(command.startswith('runuser -u bolts -- python3 -c '))
        bootstrap = shlex.split(command)[-1]
        encoded = re.search(r"sys.argv=json.loads\(base64.b64decode\('([^']+)'", bootstrap).group(1)
        argv = json.loads(base64.b64decode(encoded))
        self.assertEqual(argv[argv.index('--db') + 1], '/var/lib/bolts/bolts.sqlite')
        argv[argv.index('--db') + 1] = str(self.path)
        bootstrap = bootstrap.replace(encoded, base64.b64encode(json.dumps(argv).encode()).decode())
        result = subprocess.run([sys.executable, '-c', bootstrap], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['unique_players'], 1)
        self.assertEqual(result.stderr, '')

    def test_ssm_pending_then_success_does_not_resubmit_or_print_raw_output(self):
        report = self.count()
        responses = [
            {'Command': {'CommandId': 'command-id'}},
            {'CommandInvocations': []},
            {'CommandInvocations': [{'Status': 'InProgress'}]},
            {'CommandInvocations': [{'Status': 'Success'}]},
            {'StandardOutputContent': json.dumps(report)},
        ]
        with patch.object(analytics, 'aws', side_effect=responses) as aws, patch.object(analytics.time, 'sleep'):
            self.assertEqual(analytics.analyze_aws('i-00000000000000000', Decimal(1), END, []), report)
        self.assertEqual(sum(call.args[1] == 'send-command' for call in aws.call_args_list), 1)
        parameters = json.loads(aws.call_args_list[0].args[-1])
        self.assertEqual(len(parameters['commands']), 1)
        self.assertIn('runuser -u bolts -- python3', parameters['commands'][0])

    def test_ssm_failure_exposes_command_id_but_not_remote_error_payload(self):
        with patch.object(analytics, 'aws', side_effect=[{'Command': {'CommandId': 'command-id'}},
                {'CommandInvocations': [{'Status': 'Failed', 'private': 'do not print'}]}]):
            with self.assertRaisesRegex(analytics.AnalyticsError, 'inspect command command-id') as raised:
                analytics.analyze_aws('i-00000000000000000', Decimal(1), END, [])
        self.assertNotIn('do not print', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
