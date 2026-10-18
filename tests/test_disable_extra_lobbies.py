import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('disable_regions', ROOT / 'scripts/disable-extra-lobbies.py')
disable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disable)


class DisableExtraLobbiesTests(unittest.TestCase):
    def snapshot(self):
        return {'fleetId': 'fleet-reviewed', 'queues': [{'Name': 'bolts-gamelift-' + key, 'Destinations': [{'DestinationArn': 'reviewed-fleet'}]} for key in disable.LOCATIONS],
                'sessions': [], 'stoppedActions': {loc: ['AUTO_SCALING'] for loc in disable.LOCATIONS.values()},
                'capacity': {loc: {'InstanceCounts': {'MINIMUM': 0, 'MAXIMUM': 0, 'DESIRED': 0, 'ACTIVE': 0, 'PENDING': 0, 'TERMINATING': 0}, 'ManagedCapacityConfiguration': {'ZeroCapacityStrategy': 'MANUAL'}} for loc in disable.LOCATIONS.values()}}

    def test_only_extra_locations_are_scaled_after_admissions_are_blocked(self):
        aws = MagicMock()
        with tempfile.TemporaryDirectory() as folder, patch.object(disable, 'sessions', return_value=[]):
            disable.disable(aws, self.snapshot(), Path(folder))
            self.assertTrue((Path(folder) / 'before.json').is_file())
        calls = aws.call.call_args_list
        self.assertEqual([c.args[1] for c in calls[:3]], ['update-game-session-queue'] * 3)
        for call in calls[3:]:
            self.assertIn(call.args[call.args.index('--location') + 1], disable.LOCATIONS.values())
            self.assertTrue(call.kwargs['mutation'])
        updates = [c.args for c in calls if c.args[1] == 'update-fleet-capacity']
        self.assertEqual(len(updates), 3)
        for call in updates:
            for flag in ('--min-size', '--max-size', '--desired-instances'):
                self.assertEqual(call[call.index(flag) + 1], '0')
            self.assertIn('ZeroCapacityStrategy=MANUAL', call)
        self.assertFalse(any('delete' in c.args[1] for c in calls))

    def test_occupied_initial_snapshot_does_not_mutate(self):
        aws = MagicMock()
        with tempfile.TemporaryDirectory() as folder, patch.object(disable, 'sessions', side_effect=disable.Error('occupied')):
            with self.assertRaisesRegex(disable.Error, 'occupied'):
                disable.disable(aws, self.snapshot(), Path(folder))
        aws.call.assert_not_called()

    def test_join_race_restores_queue_destinations_without_scaling(self):
        aws = MagicMock()
        with tempfile.TemporaryDirectory() as folder, patch.object(disable, 'sessions', side_effect=[[], disable.Error('reserved seat')]):
            with self.assertRaisesRegex(disable.Error, 'reserved seat'):
                disable.disable(aws, self.snapshot(), Path(folder))
        calls = aws.call.call_args_list
        self.assertEqual([c.args[1] for c in calls], ['update-game-session-queue'] * 6)
        self.assertTrue(all(c.args[-1] == '[]' for c in calls[:3]))
        self.assertTrue(all('reviewed-fleet' in c.args[-1] for c in calls[3:]))

    def test_reserved_seats_block_shutdown_even_when_active_count_is_zero(self):
        aws = MagicMock()
        aws.call.side_effect = [
            {'GameSessions': [{'Status': 'ACTIVE', 'Location': 'eu-west-2', 'FleetId': 'fleet-reviewed', 'GameSessionId': 'session', 'CurrentPlayerSessionCount': 0}]},
            {'PlayerSessions': [{'Status': 'RESERVED'}]},
        ]
        with self.assertRaisesRegex(disable.Error, 'active or reserved'):
            disable.sessions(aws, 'fleet-reviewed')

    def test_verify_requires_no_running_instances_and_no_reactivation_path(self):
        snapshot = self.snapshot()
        for queue in snapshot['queues']:
            queue['Destinations'] = []
        disable.verify(snapshot)
        for field in ('MINIMUM', 'MAXIMUM', 'DESIRED', 'ACTIVE', 'PENDING', 'TERMINATING'):
            changed = copy.deepcopy(snapshot)
            changed['capacity']['eu-west-2']['InstanceCounts'][field] = 1
            with self.subTest(field=field), self.assertRaisesRegex(disable.Error, 'still draining'):
                disable.verify(changed)
        snapshot['capacity']['eu-west-2']['ManagedCapacityConfiguration']['ZeroCapacityStrategy'] = 'SCALE_TO_AND_FROM_ZERO'
        with self.assertRaisesRegex(disable.Error, 'not fully disabled'):
            disable.verify(snapshot)


if __name__ == '__main__':
    unittest.main()
