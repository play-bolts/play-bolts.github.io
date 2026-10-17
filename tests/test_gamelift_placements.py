import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('placement_qa', ROOT / 'scripts/qa-gamelift-placements.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
FLEET = 'fleet-00000000-0000-0000-0000-000000000001'
OTHER_FLEET = 'fleet-00000000-0000-0000-0000-000000000002'


class FakeAWS:
    def __init__(self):
        self.calls = []
        self.stack = {'StackName': qa.STACK, 'StackId': f'arn:aws:cloudformation:{qa.REGION}:{qa.ACCOUNT}:stack/{qa.STACK}/test-stack',
                      'StackStatus': 'CREATE_COMPLETE', 'Outputs': [{'OutputKey': 'FleetId', 'OutputValue': FLEET},
                       {'OutputKey': 'FleetRoleArn', 'OutputValue': f'arn:aws:iam::{qa.ACCOUNT}:role/{qa.STACK}-game-role'}]}
        self.placements = {}
        self.games = []
        self.queues = [{'Name': city['queue'], 'Destinations': [{'DestinationArn': qa.fleet_arn(FLEET)}],
                        'FilterConfiguration': {'AllowedLocations': [city['location']]}}
                       for city in qa.CITIES.values()]
        self.bad_location = False
        self.start_timeout = False
        self.terminal_status = 'FULFILLED'

    def call(self, service, operation, **payload):
        self.calls.append((service, operation, copy.deepcopy(payload)))
        if operation == 'get-caller-identity':
            return {'Account': qa.ACCOUNT}
        if operation == 'describe-stacks':
            assert payload == {'StackName': qa.STACK}
            return {'Stacks': [self.stack]}
        if operation == 'describe-fleet-attributes':
            return {'FleetAttributes': [{'FleetId': FLEET, 'FleetArn': qa.fleet_arn(FLEET), 'Status': 'ACTIVE'}]}
        if operation == 'describe-fleet-location-attributes':
            return {'LocationAttributes': [{'LocationState': {'Location': city['location'], 'Status': 'ACTIVE'}} for city in qa.CITIES.values()]}
        if operation == 'describe-fleet-location-capacity':
            counts = {'MINIMUM': 1, 'MAXIMUM': 2, 'DESIRED': 1, 'ACTIVE': 1, 'PENDING': 0}
            if payload['Location'] == qa.REGION:
                counts = {field: 0 for field in counts}
            return {'FleetCapacity': {'InstanceCounts': counts}}
        if operation == 'describe-game-session-queues':
            return {'GameSessionQueues': self.queues}
        if operation == 'describe-game-sessions':
            games = self.games
            if 'GameSessionId' in payload:
                games = [game for game in games if game['GameSessionId'] == payload['GameSessionId']]
            elif 'Location' in payload:
                games = [game for game in games if game.get('Location') == payload['Location']]
            return {'GameSessions': games}
        if operation == 'describe-game-session-placement':
            if payload['PlacementId'] not in self.placements:
                raise qa.AwsError(operation, 'NotFoundException')
            return {'GameSessionPlacement': self.placements[payload['PlacementId']]}
        if operation == 'start-game-session-placement':
            key = payload['GameProperties'][0]['Value']
            placement = {**payload, 'Status': self.terminal_status,
                         'GameSessionId': f'arn:aws:gamelift:{qa.REGION}:{qa.ACCOUNT}:gamesession/{FLEET}/{key}'}
            self.placements[payload['PlacementId']] = placement
            self.games.append({'FleetId': FLEET, 'GameSessionId': placement['GameSessionId'],
                               'Name': payload['GameSessionName'], 'Status': 'ACTIVE',
                               'Location': qa.REGION if self.bad_location else qa.CITIES[key]['location'],
                               'MaximumPlayerSessionCount': 6, 'CurrentPlayerSessionCount': 0,
                               'PlayerSessionCreationPolicy': 'ACCEPT_ALL'})
            if self.start_timeout:
                self.start_timeout = False
                raise qa.AwsError(operation, 'Timeout')
            return {'GameSessionPlacement': placement}
        raise AssertionError(operation)

    def starts(self):
        return [payload for _, operation, payload in self.calls if operation == 'start-game-session-placement']


class PlacementTests(unittest.TestCase):
    def test_cli_requires_explicit_expected_fleet_before_any_aws_call(self):
        with patch.object(qa, 'AWS') as aws, patch('sys.stderr'):
            with self.assertRaises(SystemExit):
                qa.main(['--apply'])
            with self.assertRaisesRegex(qa.QAError, 'valid --fleet'):
                qa.main(['--apply', '--fleet', 'not-a-fleet'])
            aws.assert_not_called()

    def test_saved_state_cannot_be_retargeted_to_a_replacement_fleet(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            original = qa.load_state(path, FLEET)
            with self.assertRaisesRegex(qa.QAError, 'different rollout'):
                qa.load_state(path, OTHER_FLEET)
            self.assertEqual(json.loads(path.read_text()), original)

    def test_live_stack_must_match_explicit_fleet_account_role_and_stable_status(self):
        for failure in ('fleet', 'account', 'stack_name', 'role', 'rollback', 'in_progress'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'state.json'
                aws = FakeAWS()
                if failure == 'fleet':
                    aws.stack['Outputs'][0]['OutputValue'] = OTHER_FLEET
                elif failure == 'account':
                    aws.stack['StackId'] = aws.stack['StackId'].replace(qa.ACCOUNT, '111111111111')
                elif failure == 'stack_name':
                    aws.stack['StackName'] = 'other-stack'
                elif failure == 'role':
                    aws.stack['Outputs'][1]['OutputValue'] = 'arn:other-role'
                elif failure == 'rollback':
                    aws.stack['StackStatus'] = 'ROLLBACK_COMPLETE'
                else:
                    aws.stack['StackStatus'] = 'CREATE_IN_PROGRESS'
                with self.assertRaisesRegex(qa.QAError, 'stack outputs'):
                    qa.run(aws, qa.load_state(path, FLEET), path)
                self.assertEqual(aws.starts(), [])
                self.assertFalse(any(operation == 'describe-fleet-attributes' for _, operation, _ in aws.calls))

    def test_three_exact_games_have_no_player_reservations_and_resume_without_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            state = qa.load_state(path, FLEET)
            aws = FakeAWS()
            qa.run(aws, state, path)
            self.assertEqual(len(aws.starts()), 3)
            for start in aws.starts():
                self.assertEqual(start['MaximumPlayerSessionCount'], 6)
                self.assertNotIn('DesiredPlayerSessions', start)
            self.assertEqual({start['GameSessionQueueName'] for start in aws.starts()}, {city['queue'] for city in qa.CITIES.values()})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            loaded = qa.load_state(path, FLEET)
            qa.run(aws, loaded, path)
            self.assertEqual(len(aws.starts()), 3)
            self.assertTrue(all(row['actualLocation'] == row['location'] for row in loaded['cities'].values()))

    def test_wrong_queue_destination_or_filter_blocks_every_creation(self):
        for field in ('destination', 'filter'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'state.json'
                aws = FakeAWS()
                if field == 'destination':
                    aws.queues[2]['Destinations'][0]['DestinationArn'] = 'arn:other-fleet'
                else:
                    aws.queues[2]['FilterConfiguration']['AllowedLocations'].append(qa.REGION)
                with self.assertRaisesRegex(qa.QAError, 'destination or allowed location'):
                    qa.run(aws, qa.load_state(path, FLEET), path)
                self.assertEqual(aws.starts(), [])

    def test_name_collision_in_last_city_blocks_all_creations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            aws = FakeAWS()
            aws.games = [{'Name': qa.CITIES['sp']['name'], 'GameSessionId': 'someone-elses-session',
                          'Location': qa.CITIES['sp']['location']}]
            with self.assertRaisesRegex(qa.QAError, 'already in use'):
                qa.run(aws, qa.load_state(path, FLEET), path)
            self.assertEqual(aws.starts(), [])
            locations = {payload['Location'] for _, operation, payload in aws.calls
                         if operation == 'describe-game-sessions' and 'Location' in payload}
            self.assertEqual(locations, {qa.REGION, *(city['location'] for city in qa.CITIES.values())})

    def test_ambiguous_create_response_resumes_existing_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            aws = FakeAWS()
            aws.start_timeout = True
            with self.assertRaisesRegex(qa.AwsError, 'Timeout'):
                qa.run(aws, qa.load_state(path, FLEET), path)
            original = aws.starts()[0]['PlacementId']
            qa.run(aws, qa.load_state(path, FLEET), path)
            self.assertEqual(len(aws.starts()), 3)
            self.assertEqual(aws.starts()[0]['PlacementId'], original)

    def test_ambiguous_missing_create_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            state = qa.load_state(path, FLEET)
            state['cities']['lon']['attemptedAt'] = 1
            qa.save(path, state)
            aws = FakeAWS()
            with self.assertRaisesRegex(qa.QAError, 'earlier create attempt'):
                qa.run(aws, qa.load_state(path, FLEET), path)
            self.assertEqual(aws.starts(), [])

    def test_fulfilled_in_wrong_physical_location_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            aws = FakeAWS()
            aws.bad_location = True
            with self.assertRaisesRegex(qa.QAError, 'requested location'):
                qa.run(aws, qa.load_state(path, FLEET), path)
            state = json.loads(path.read_text())
            self.assertTrue(state['cities']['lon']['gameSessionId'])
            self.assertNotIn('verifiedAt', state['cities']['lon'])

    def test_failed_placement_keeps_session_id_for_log_diagnosis(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            aws = FakeAWS()
            aws.terminal_status = 'FAILED'
            with self.assertRaisesRegex(qa.QAError, 'ended FAILED'):
                qa.run(aws, qa.load_state(path, FLEET), path)
            state = json.loads(path.read_text())
            self.assertEqual(state['cities']['lon']['status'], 'FAILED')
            self.assertTrue(state['cities']['lon']['gameSessionId'])

    def test_aws_transport_rejects_mutation_without_apply_and_never_outputs_raw_error(self):
        with patch.object(qa.subprocess, 'run') as command:
            with self.assertRaisesRegex(qa.QAError, 'requires --apply'):
                qa.AWS().call('gamelift', 'start-game-session-placement')
            with self.assertRaisesRegex(qa.QAError, 'outside'):
                qa.AWS(apply=True).call('gamelift', 'create-player-session')
            with self.assertRaisesRegex(qa.QAError, 'reviewed regional stack'):
                qa.AWS().call('cloudformation', 'describe-stacks', StackName='unrelated-stack')
            command.assert_not_called()
            command.return_value.returncode = 1
            command.return_value.stderr = 'An error occurred (Denied) secret=do-not-print'
            with self.assertRaises(qa.AwsError) as caught:
                qa.AWS().call('gamelift', 'describe-fleet-attributes')
            self.assertNotIn('do-not-print', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
