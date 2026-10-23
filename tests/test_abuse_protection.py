import base64
import copy
import importlib.util
import json
from pathlib import Path
import posixpath
import re
import socket
import ssl
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('abuse_protection', ROOT / 'scripts/deploy-abuse-protection.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def matches(statement, path, method='GET', qa_ip=False):
    """Exercise the template's request scopes without pretending to emulate WAF rates."""
    if 'AndStatement' in statement:
        return all(matches(s, path, method, qa_ip) for s in statement['AndStatement']['Statements'])
    if 'OrStatement' in statement:
        return any(matches(s, path, method, qa_ip) for s in statement['OrStatement']['Statements'])
    if 'NotStatement' in statement:
        return not matches(statement['NotStatement']['Statement'], path, method, qa_ip)
    if 'IPSetReferenceStatement' in statement:
        return qa_ip
    match = statement['ByteMatchStatement']
    value = method if 'Method' in match['FieldToMatch'] else path
    for transform in sorted(match['TextTransformations'], key=lambda item: item['Priority']):
        if transform['Type'] == 'URL_DECODE':
            value = unquote(value)
        elif transform['Type'] == 'NORMALIZE_PATH':
            trailing = value.endswith('/')
            value = posixpath.normpath('/' + value.lstrip('/'))
            if trailing and value != '/':
                value += '/'
    expected = match['SearchString']
    return value.startswith(expected) if match['PositionalConstraint'] == 'STARTS_WITH' else value == expected


class AbuseProtectionTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads(deploy.TEMPLATE.read_text())
        self.values = deploy.parameters()
        self.rules = deploy.resolved_rules(self.template, self.values, '', encode=False)
        self.by_name = {r['Name']: r for r in self.rules}

    def scoped(self, name, path, method='GET', qa_ip=False, rules=None):
        rule = (rules or self.by_name)[name]
        return matches(rule['Statement']['RateBasedStatement']['ScopeDownStatement'], path, method, qa_ip)

    def test_template_changes_only_waf_resources_and_has_no_paid_bot_features(self):
        deploy.validate_template(self.template)
        self.assertEqual({v['Type'] for v in self.template['Resources'].values()}, {'AWS::WAFv2::WebACL', 'AWS::WAFv2::IPSet'})
        text = json.dumps(self.template)
        for forbidden in ('CAPTCHA', 'BotControl', 'ManagedRuleGroupStatement', 'AWS::CloudFront::Distribution', 'LoggingConfiguration'):
            self.assertNotIn(forbidden, text)
        self.assertEqual(self.template['Resources']['QaSource']['Condition'], 'QaEnabled')

    def test_waf_resource_descriptions_match_service_validation(self):
        for resource in self.template['Resources'].values():
            description = resource['Properties']['Description']
            self.assertGreaterEqual(len(description), 1)
            self.assertLessEqual(len(description), 256)
            self.assertRegex(description, r'^[\w+=:#@/\-,\.][\w+=:#@/\-,\.\s]+[\w+=:#@/\-,\.]$')

    def test_normal_requests_are_counted_in_expected_scopes_without_static_block_rule(self):
        for path in ('/api/health', '/api/lobbies', '/api/leaderboard', '/api/visits'):
            self.assertTrue(self.scoped('BoltsApiPerIp', path))
            self.assertFalse(self.scoped('BoltsAdmissionPerIp', path))
            self.assertFalse(self.scoped('BoltsFeedbackPerIp', path))
        for path in ('/', '/assets/game.js', '/apiary', '/other/api/ws'):
            self.assertFalse(self.scoped('BoltsApiPerIp', path))
        for rule in self.rules:
            self.assertEqual(set(rule['Statement']), {'RateBasedStatement'})
            self.assertTrue(rule['VisibilityConfig']['CloudWatchMetricsEnabled'])
            self.assertFalse(rule['VisibilityConfig']['SampledRequestsEnabled'])

    def test_websocket_handshakes_and_sessions_are_limited_not_messages_or_preflight(self):
        for path, method in (('/api/ws', 'GET'), ('/api/ping', 'GET'), ('/api/session', 'POST'), ('/api/join', 'POST')):
            self.assertTrue(self.scoped('BoltsAdmissionPerIp', path, method))
            self.assertFalse(self.scoped('BoltsAdmissionPerIp', path, 'OPTIONS'))
            self.assertTrue(self.scoped('BoltsApiPerIp', path, 'OPTIONS'))
        self.assertFalse(self.scoped('BoltsFeedbackPerIp', '/api/feedback', 'OPTIONS'))
        self.assertTrue(self.scoped('BoltsFeedbackPerIp', '/api/feedback', 'POST'))
        self.assertNotIn('"Body"', json.dumps([rule['Statement'] for rule in self.rules]))

    def test_rates_use_viewer_ip_no_spoofable_forwarded_header(self):
        for rule in self.rules:
            rate = rule['Statement']['RateBasedStatement']
            self.assertEqual(rate['AggregateKeyType'], 'IP')
            self.assertEqual(rate['EvaluationWindowSec'], 60)
            self.assertNotIn('ForwardedIPConfig', rate)
            self.assertNotIn('CustomKeys', rate)

    def test_percent_encoded_and_normalized_paths_cannot_bypass_scopes(self):
        for path in ('/a%70i/lobbies', '/api/./lobbies', '/api//lobbies', '/outside/../api/lobbies', '//api/lobbies'):
            self.assertTrue(self.scoped('BoltsApiPerIp', path), path)
        for path in ('/api/s%65ssion', '/api/%77s', '/api/./join', '/api//ping'):
            self.assertTrue(self.scoped('BoltsAdmissionPerIp', path), path)
        self.assertTrue(self.scoped('BoltsFeedbackPerIp', '/api/%66eedback', 'POST'))
        self.assertFalse(self.scoped('BoltsApiPerIp', '/api/../assets/test.js'))
        self.assertFalse(self.scoped('BoltsAdmissionPerIp', '/api/%2577s'))

    def test_429_has_retry_after_readable_production_cors_and_no_cache(self):
        for rule in self.rules:
            response = rule['Action']['Block']['CustomResponse']
            headers = {h['Name'].lower(): h['Value'] for h in response['ResponseHeaders']}
            self.assertEqual(response['ResponseCode'], 429)
            self.assertEqual(headers['retry-after'], '60')
            self.assertEqual(headers['access-control-allow-origin'], deploy.ORIGIN)
            self.assertIn('Retry-After', headers['access-control-expose-headers'])
            self.assertIn('OPTIONS', headers['access-control-allow-methods'])
            self.assertEqual(headers['cache-control'], 'no-store')

    def test_qa_requires_exact_public_ipv4_and_cannot_affect_normal_requests(self):
        for bad in ('0.0.0.0/0', '8.8.8.0/24', '127.0.0.1/32', '192.0.2.1/32', '::1/128'):
            with self.subTest(bad=bad), self.assertRaises((deploy.Error, ValueError)):
                deploy.parameters(bad)
        values = deploy.parameters('8.8.8.8/32')
        rules = {r['Name']: r for r in deploy.resolved_rules(self.template, values, 'arn:qa', encode=False)}
        qa = rules['BoltsQaRateProof']['Statement']['RateBasedStatement']
        self.assertEqual(qa['Limit'], 10)
        self.assertEqual(qa['EvaluationWindowSec'], 60)
        self.assertTrue(self.scoped('BoltsQaRateProof', values['QaPath'], qa_ip=True, rules=rules))
        self.assertFalse(self.scoped('BoltsQaRateProof', values['QaPath'], qa_ip=False, rules=rules))
        self.assertFalse(self.scoped('BoltsQaRateProof', values['QaPath'], 'POST', True, rules))
        for path in ('/api/health', '/api/ws', '/api/session', values['QaPath'] + '-other'):
            self.assertFalse(self.scoped('BoltsQaRateProof', path, qa_ip=True, rules=rules))
        self.assertNotIn('BoltsQaRateProof', self.by_name)

    def test_api_rule_bytes_are_base64_and_cfn_rule_text_stays_literal(self):
        rules = deploy.resolved_rules(self.template, self.values, '')
        match = rules[-1]['Statement']['RateBasedStatement']['ScopeDownStatement']['ByteMatchStatement']
        self.assertEqual(base64.b64decode(match['SearchString']).decode(), '/api/')
        self.assertEqual(self.rules[-1]['Statement']['RateBasedStatement']['ScopeDownStatement']['ByteMatchStatement']['SearchString'], '/api/')

    def test_different_existing_acl_is_never_replaced(self):
        with self.assertRaisesRegex(deploy.Error, 'different WebACL'):
            deploy.validate_association({'config': {'WebACLId': 'arn:someone-else'}}, None)
        deploy.validate_association({'config': {'WebACLId': ''}}, None)
        deploy.validate_association({'config': {'WebACLId': 'arn:ours'}}, {'outputs': {'WebAclArn': 'arn:ours'}})

    def test_mutation_requires_explicit_apply(self):
        with patch.object(deploy.subprocess, 'run') as run:
            with self.assertRaisesRegex(deploy.Error, 'mutations require'):
                deploy.AWS().call('cloudfront', 'update-distribution', mutation=True)
            run.assert_not_called()

    def test_association_preserves_every_other_config_field_and_uses_etag(self):
        before = {'ETag': 'original-version', 'config': {'WebACLId': '', 'Origins': {'Items': [{'VpcOriginConfig': {'VpcOriginId': 'private'}, 'CustomHeaders': {'Items': [{'HeaderName': 'secret', 'HeaderValue': 'preserve'}]}}]}, 'CallerReference': 'same', 'Aliases': {'Items': [deploy.HOST]}, 'Enabled': True, 'UnfamiliarFutureField': {'keep': 42}}}
        original = copy.deepcopy(before)
        after = copy.deepcopy(before)
        after['config']['WebACLId'] = 'arn:ours'
        aws = MagicMock()
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'wait_distribution', return_value=after):
            deploy.update_association(aws, Path(directory), before, 'arn:ours')
            saved = json.loads((Path(directory) / 'distribution-update.json').read_text())
            self.assertEqual(saved, after['config'])
        self.assertEqual(before, original)
        args = aws.call.call_args.args
        self.assertEqual(args[args.index('--if-match') + 1], 'original-version')
        self.assertTrue(aws.call.call_args.kwargs['mutation'])

    def test_plan_never_mutates_and_records_complete_rollback_snapshot(self):
        aws = MagicMock()
        aws.call.return_value = {'Capacity': 18}
        before = {'ETag': 'etag', 'config': {'WebACLId': '', 'Unknown': 'preserved'}}
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'distribution', return_value=before), patch.object(deploy, 'stack_state', return_value=None):
            folder = Path(directory)
            deploy.plan(aws, folder, None)
            value = json.loads((folder / 'plan.json').read_text())
            self.assertEqual(value['before'], before)
            self.assertEqual(value['parameters']['QaEnabled'], 'false')
            self.assertEqual(value['estimatedMonthlyFixedUSD'], 8)
            self.assertTrue(all(not call.kwargs.get('mutation') for call in aws.call.call_args_list))
            with self.assertRaisesRegex(deploy.Error, 'Preserve the existing plan'):
                deploy.plan(aws, folder, None)

    def test_apply_rejects_concurrent_distribution_change_before_any_mutation(self):
        aws = MagicMock()
        before = {'ETag': 'before', 'config': {'WebACLId': '', 'Origins': {'private': True}}}
        value = {'version': 1, 'distribution': deploy.DISTRIBUTION, 'account': deploy.ACCOUNT,
                 'stack': deploy.STACK, 'template': self.template, 'templateSha256': deploy.digest(self.template),
                 'parameters': self.values, 'before': before, 'stackBefore': None}
        for changed in ({'ETag': 'after', 'config': before['config']}, {'ETag': 'before', 'config': {'WebACLId': '', 'Origins': {'private': False}}}):
            with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'distribution', return_value=changed), patch.object(deploy, 'stack_state', return_value=None):
                folder = Path(directory)
                deploy.save(folder / 'plan.json', value)
                with self.assertRaisesRegex(deploy.Error, 'CloudFront changed'):
                    deploy.apply(aws, folder)
                aws.call.assert_not_called()

    def test_rollback_uses_current_config_instead_of_replaying_stale_origin_fields(self):
        before = {'config': {'WebACLId': '', 'Origins': {'old': True}}}
        current = {'ETag': 'new', 'config': {'WebACLId': 'arn:ours', 'Origins': {'new': True}}}
        stack = {'outputs': {'WebAclArn': 'arn:ours'}}
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'distribution', return_value=current), patch.object(deploy, 'stack_state', return_value=stack), patch.object(deploy, 'update_association') as update:
            folder = Path(directory)
            deploy.save(folder / 'plan.json', {'distribution': deploy.DISTRIBUTION, 'account': deploy.ACCOUNT, 'before': before})
            deploy.rollback(MagicMock(), folder)
            self.assertEqual(update.call_args.args[2], current)
            self.assertEqual(update.call_args.args[3], '')

    def test_qa_socket_factory_requests_ipv4_without_global_network_changes(self):
        original_factory = socket.create_connection
        target = ('198.51.100.2', 443)
        connection = MagicMock()
        with patch.object(deploy.socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', target)]) as lookup, patch.object(deploy.socket, 'socket', return_value=connection) as factory:
            self.assertIs(deploy.connect_ipv4(('example.com', 443), 10), connection)
            lookup.assert_called_once_with('example.com', 443, family=socket.AF_INET, type=socket.SOCK_STREAM)
            factory.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            connection.settimeout.assert_called_once_with(10)
            connection.connect.assert_called_once_with(target)
        self.assertIs(socket.create_connection, original_factory)

    def test_qa_https_preserves_hostname_and_certificate_verification(self):
        connection = deploy.IPv4HTTPSConnection(deploy.HOST)
        try:
            self.assertEqual(connection.host, deploy.HOST)
            self.assertTrue(connection._context.check_hostname)
            self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertIs(connection._create_connection, deploy.connect_ipv4)
        finally:
            connection.close()

    def test_qa_http_uses_ipv4_transport_including_error_responses(self):
        response = MagicMock(status=404, headers={'x-test': 'value'})
        response.read.return_value = b'not found'
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch.object(deploy, 'IPv4HTTPSConnection', return_value=connection) as factory:
            self.assertEqual(deploy.read_http('/api/health'), (404, {'x-test': 'value'}, b'not found'))
            factory.assert_called_once_with(deploy.HOST)
            connection.request.assert_called_once_with('GET', '/api/health', headers={'Origin': deploy.ORIGIN})
            connection.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
