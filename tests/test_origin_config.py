import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('origin_update', ROOT / 'infra/update-origins.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
ORIGINS = 'https://play-bolts.github.io,http://127.0.0.1:5173,http://localhost:5173'


class OriginConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'bolts.env'
        self.original = 'BOLTS_DB=/private/game.sqlite\nBOLTS_ORIGINS=https://previous.example\nBOLTS_IDENTITY_SALT=test-only-sentinel\n'
        self.path.write_text(self.original)
        self.addCleanup(self.directory.cleanup)

    def test_exact_origin_validation_and_declarative_defaults(self):
        self.assertEqual(update.validate_origins(ORIGINS), ORIGINS.split(','))
        template = json.loads((ROOT / 'infra/backend.template.json').read_text())
        self.assertEqual(template['Parameters']['AllowedOrigins']['Default'], ORIGINS)
        deploy = (ROOT / 'scripts/deploy-backend.py').read_text()
        self.assertIn("DEFAULT_ORIGINS = '" + ORIGINS + "'", deploy)
        for invalid in ['', 'https://example.test/', 'http://example.test', 'https://user:pass@example.test',
                        'https://example.test?query=1', 'https://example.test#fragment',
                        'https://example.test,https://example.test', ' https://example.test',
                        'https://example.test\nBOLTS_OTHER=value']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                update.validate_origins(invalid)

    def test_atomic_update_changes_only_origins_and_keeps_private_permissions(self):
        with patch.object(update, 'local_json', return_value={'lobbies': []}), \
                patch.object(update, 'restart') as restart, patch.object(update, 'healthy'), \
                patch.object(update, 'origins_match', return_value=True):
            update.apply(ORIGINS, self.path)
        self.assertEqual(self.path.read_text(), self.original.replace('https://previous.example', ORIGINS))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        restart.assert_called_once_with()
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_occupied_lobby_is_rejected_without_changes_or_restart(self):
        with patch.object(update, 'local_json', return_value={'lobbies': [{'players': 1}]}), \
                patch.object(update, 'restart') as restart:
            with self.assertRaisesRegex(RuntimeError, 'empty lobbies'):
                update.apply(ORIGINS, self.path)
        self.assertEqual(self.path.read_text(), self.original)
        restart.assert_not_called()

    def test_failed_startup_restores_original_configuration_and_restarts_it(self):
        with patch.object(update, 'local_json', return_value={'lobbies': []}), \
                patch.object(update, 'restart') as restart, \
                patch.object(update, 'healthy', side_effect=[RuntimeError('unhealthy'), None]):
            with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
                update.apply(ORIGINS, self.path)
        self.assertEqual(self.path.read_text(), self.original)
        self.assertEqual(restart.call_count, 2)

    def test_matching_file_but_stale_running_origin_restarts_existing_service(self):
        self.path.write_text(update.replacement(self.original, ORIGINS))
        with patch.object(update, 'local_json', return_value={'lobbies': []}), \
                patch.object(update, 'restart') as restart, patch.object(update, 'healthy'), \
                patch.object(update, 'origins_match', side_effect=[False, True]):
            update.apply(ORIGINS, self.path)
        restart.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
