import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gamelift_prepare', ROOT / 'scripts/prepare-gamelift.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class GameLiftConfigurationTests(unittest.TestCase):
    def test_queues_never_fall_back_to_a_different_city(self):
        resources = prepare.template()['Resources']
        config = json.loads((ROOT / 'infra/gamelift/host.example.json').read_text())
        self.assertEqual({l['id']: l['aws'] for l in config['locations']}, prepare.LOCATIONS)
        queues = [r['Properties'] for r in resources.values() if r['Type'] == 'AWS::GameLift::GameSessionQueue']
        self.assertEqual(len(queues), 4)
        self.assertEqual({q['FilterConfiguration']['AllowedLocations'][0] for q in queues}, set(prepare.LOCATIONS.values()))
        self.assertTrue(all(len(q['FilterConfiguration']['AllowedLocations']) == 1 for q in queues))
        self.assertTrue(all(q['TimeoutInSeconds'] == 600 for q in queues))

    def test_capacity_is_bounded_protected_and_can_reach_zero(self):
        template = prepare.template()
        fleet = template['Resources']['Fleet']['Properties']
        self.assertEqual(template['Parameters']['MaximumInstancesPerLocation']['Default'], 2)
        self.assertEqual(fleet['NewGameSessionProtectionPolicy'], 'FullProtection')
        self.assertEqual(fleet['CertificateConfiguration']['CertificateType'], 'GENERATED')
        self.assertEqual(len(fleet['RuntimeConfiguration']['ServerProcesses']), 2)
        for loc in fleet['Locations']:
            capacity = loc['LocationCapacity']
            self.assertEqual(capacity['DesiredEC2Instances'], 0)
            if loc['Location'] == prepare.HOME_REGION:
                self.assertEqual(capacity['MaxSize'], 0)
            else:
                self.assertEqual(capacity['ManagedCapacityConfiguration']['ZeroCapacityStrategy'], 'SCALE_TO_AND_FROM_ZERO')
        self.assertEqual({s['Location'] for s in fleet['ScalingPolicies']}, set(prepare.LOCATIONS.values()))


if __name__ == '__main__':
    unittest.main()
