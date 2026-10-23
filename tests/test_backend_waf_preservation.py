import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('backend_waf_guard', ROOT / 'scripts/deploy-backend.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
ACL = 'arn:aws:wafv2:us-east-1:780705957578:global/webacl/bolts-api-abuse/12345678'
STACK = {'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [], 'Outputs': [
    {'OutputKey': 'DistributionId', 'OutputValue': 'E1MT909KTPVXKW'},
    {'OutputKey': 'BackendUrl', 'OutputValue': 'https://' + deploy.CUSTOM_DOMAIN}]}


def template(acl=None):
    config = {'Enabled': True}
    if acl is not None:
        config['WebACLId'] = acl
    return {'Resources': {'Distribution': {'Type': 'AWS::CloudFront::Distribution',
                                         'Properties': {'DistributionConfig': config}}}}


class BackendWafPreservationTests(unittest.TestCase):
    def test_nonempty_live_acl_rejects_omission_change_and_unresolved_intrinsics(self):
        for requested in (None, '', 'arn:different', {'Ref': 'MissingParameter'}, {'Fn::ImportValue': 'SomeoneElse'}, {'Fn::GetAtt': ['OtherAcl', 'Arn']}):
            with self.subTest(requested=requested), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'template.json'
                path.write_text(json.dumps(template(requested)))
                with patch.object(deploy, 'describe', return_value=STACK), patch.object(deploy, 'aws', return_value={'Distribution': {'DistributionConfig': {'WebACLId': ACL}}}):
                    with self.assertRaisesRegex(deploy.DeploymentError, 'Preserve.*WebACLId'):
                        deploy.require_web_acl_preserved('bolts-backend', path, {})

    def test_live_acl_accepts_exact_literal_or_supplied_parameter(self):
        for requested, values in ((ACL, {}), ({'Ref': 'ExistingAcl'}, {'ExistingAcl': ACL})):
            with self.subTest(requested=requested), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'template.json'
                original = json.dumps(template(requested))
                path.write_text(original)
                with patch.object(deploy, 'describe', return_value=STACK), patch.object(deploy, 'aws', return_value={'Distribution': {'DistributionConfig': {'WebACLId': ACL}}}):
                    deploy.require_web_acl_preserved('bolts-backend', path, values)
                self.assertEqual(path.read_text(), original, 'Guard must not rewrite reviewed templates')

    def test_removing_distribution_cannot_remove_its_live_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'template.json'
            path.write_text('{"Resources":{}}')
            with patch.object(deploy, 'describe', return_value=STACK), patch.object(deploy, 'aws', return_value={'Distribution': {'DistributionConfig': {'WebACLId': ACL}}}):
                with self.assertRaisesRegex(deploy.DeploymentError, 'active CloudFront WAF'):
                    deploy.require_web_acl_preserved('bolts-backend', path, {})

    def test_no_live_acl_or_no_distribution_retains_previous_behavior(self):
        with patch.object(deploy, 'describe', return_value=STACK), patch.object(deploy, 'aws', return_value={'Distribution': {'DistributionConfig': {'WebACLId': ''}}}):
            deploy.require_web_acl_preserved('bolts-backend', Path('/unused/template'), {})
        for state in (None, {'Outputs': []}):
            with patch.object(deploy, 'describe', return_value=state), patch.object(deploy, 'aws') as aws:
                deploy.require_web_acl_preserved('certificate-stack', Path('/unused/template'), {})
                aws.assert_not_called()

    def test_existing_stack_update_fails_before_any_aws_mutation(self):
        with patch.object(deploy, 'require_web_acl_preserved', side_effect=deploy.DeploymentError('WAF must remain')), patch.object(deploy, 'aws') as aws:
            with self.assertRaisesRegex(deploy.DeploymentError, 'WAF must remain'):
                deploy.apply_stack('bolts-backend', Path('/unused/template'), {}, True)
            aws.assert_not_called()

    def test_new_stack_creation_does_not_need_a_live_distribution(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), patch.object(deploy, 'require_web_acl_preserved') as guard, patch.object(deploy, 'aws') as aws, patch.object(deploy, 'wait_stack', return_value={}):
            deploy.apply_stack('new-stack', Path('/unused/template'), {}, False)
            guard.assert_not_called()
            self.assertEqual(aws.call_args.args[:2], ('cloudformation', 'create-stack'))

    def run_domain(self, change_acl=False, active_acl=ACL):
        observed = {'WebACLId': active_acl, 'IsIPV6Enabled': True}
        reads, operations = 0, []
        old = template(active_acl or None)

        def aws(service, operation, *args, **kwargs):
            nonlocal reads
            operations.append((service, operation))
            if (service, operation) == ('cloudfront', 'get-distribution'):
                reads += 1
                value = copy.deepcopy(observed)
                if change_acl and reads == 4:
                    value['WebACLId'] = 'arn:new-protection'
                return {'Distribution': {'DistributionConfig': value}}
            if operation == 'get-hosted-zone':
                return {'HostedZone': {'Name': 'christopherkrapu.com.', 'Config': {'PrivateZone': False}}, 'DelegationSet': {'NameServers': ['ns1.example.com']}}
            if operation == 'list-resource-record-sets':
                return []
            if operation == 'describe-certificate':
                return {'Certificate': {'Status': 'ISSUED', 'SubjectAlternativeNames': [deploy.CUSTOM_DOMAIN]}}
            if operation == 'get-template':
                return {'TemplateBody': copy.deepcopy(old)}
            if operation == 'describe-change-set':
                return {'Status': 'CREATE_COMPLETE', 'Changes': [{'ResourceChange': {'LogicalResourceId': 'Distribution', 'Action': 'Modify', 'Replacement': 'False'}}]}
            return {}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'template.json'
            path.write_text(json.dumps(old))
            with patch.object(deploy, 'STATE', Path(directory)), patch.object(deploy, 'describe', side_effect=lambda name, **kw: STACK if name == 'bolts-backend' else None), patch.object(deploy, 'aws', side_effect=aws), patch.object(deploy, 'apply_stack', return_value={'Outputs': [{'OutputKey': 'CertificateArn', 'OutputValue': 'arn:certificate'}]}), patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(stdout='ns1.example.com.\n')), patch.object(deploy, 'wait_stack', return_value=STACK), patch.object(deploy, 'verify_edge'):
                if change_acl:
                    with self.assertRaisesRegex(deploy.DeploymentError, 'active CloudFront WAF'):
                        deploy.configure_domain(SimpleNamespace(stack='bolts-backend'), path)
                else:
                    deploy.configure_domain(SimpleNamespace(stack='bolts-backend'), path)
        return reads, operations

    def test_domain_change_rechecks_current_acl_immediately_before_execution(self):
        reads, operations = self.run_domain(change_acl=True)
        self.assertEqual(reads, 4)
        self.assertIn(('cloudformation', 'create-change-set'), operations)
        self.assertNotIn(('cloudformation', 'execute-change-set'), operations)

    def test_domain_changes_still_work_with_preserved_or_absent_acl(self):
        for active in (ACL, ''):
            with self.subTest(active=active):
                reads, operations = self.run_domain(active_acl=active)
                self.assertEqual(reads, 4)
                self.assertIn(('cloudformation', 'execute-change-set'), operations)


if __name__ == '__main__':
    unittest.main()
