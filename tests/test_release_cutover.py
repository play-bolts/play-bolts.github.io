"""Execute the installer's real cutover branch without touching the host OS."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS = '/opt/bolts/releases/' + 'a' * 64
NEW = '/opt/bolts/releases/' + 'b' * 64

# Shell functions intercept every privileged operation. The production branch
# remains verbatim, including set -e behavior, pipelines, checks and rollback.
MOCK_COMMANDS = r'''
set -euo pipefail
release=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readlink() {
  test "$#" = 1 && test "$1" = /opt/bolts/current
  cat "$CASE_DIR/current"
}
ln() {
  test "$#" = 3 && test "$1" = -sfn && test "$3" = /opt/bolts/current.next
  printf '%s\n' "$2" > "$CASE_DIR/next"
  printf 'select %s\n' "$2" >> "$CASE_DIR/trace"
}
mv() {
  test "$#" = 3 && test "$1" = -Tf && test "$2" = /opt/bolts/current.next && test "$3" = /opt/bolts/current
  cat "$CASE_DIR/next" > "$CASE_DIR/current"
}
systemctl() {
  printf 'systemctl %s\n' "$*" >> "$CASE_DIR/trace"
  case "$*" in
    'restart bolts.service')
      if test "$SCENARIO" = restart_failure && ! test -f "$CASE_DIR/restart_failed"; then
        touch "$CASE_DIR/restart_failed"
        return 17
      fi
      ;;
    'stop bolts.service'|'start bolts-backup.timer'|'start bolts-backup.service') ;;
    *) printf 'Unexpected systemctl arguments\n' >&2; return 99 ;;
  esac
}
curl() {
  test "$*" = '--fail --silent --max-time 2 http://127.0.0.1:8080/api/health'
  printf 'health\n' >> "$CASE_DIR/trace"
  if test "$SCENARIO" = health_failure; then
    printf '{"ok":false,"version":3}\n'
  else
    printf '{"ok":true,"version":3}\n'
  fi
}
sleep() { test "$#" = 1 && test "$1" = 1; }
'''


class ReleaseCutoverTests(unittest.TestCase):
    def run_cutover(self, scenario):
        installer = (ROOT / 'infra/install-release.sh').read_text()
        marker = 'previous=$(readlink /opt/bolts/current || true)\n'
        self.assertEqual(installer.count(marker), 1)
        branch = marker + installer.split(marker, 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            location = Path(directory)
            (location / 'current').write_text(PREVIOUS + '\n')
            (location / 'trace').touch()
            result = subprocess.run(
                ['bash', '-c', MOCK_COMMANDS + '\n' + branch],
                env={**os.environ, 'CASE_DIR': directory, 'SCENARIO': scenario},
                text=True, capture_output=True, timeout=10,
            )
            return result, (location / 'current').read_text().strip(), (location / 'trace').read_text().splitlines()

    def assert_rolled_back(self, result, current, trace):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(current, PREVIOUS)
        self.assertEqual([line for line in trace if line.startswith('select ')],
                         ['select ' + NEW, 'select ' + PREVIOUS])
        self.assertEqual([line for line in trace if line.startswith('systemctl ')], [
            'systemctl restart bolts.service',
            'systemctl stop bolts.service',
            'systemctl restart bolts.service',
        ])
        self.assertIn('restored previous binary', result.stderr)
        self.assertNotIn('is healthy', result.stdout)

    def test_restart_failure_restores_previous_binary_instead_of_exiting_early(self):
        result, current, trace = self.run_cutover('restart_failure')
        self.assert_rolled_back(result, current, trace)
        self.assertNotIn('health', trace, 'a failed start must go directly to rollback')

    def test_health_failure_rolls_back_after_bounded_attempts(self):
        result, current, trace = self.run_cutover('health_failure')
        self.assert_rolled_back(result, current, trace)
        self.assertEqual(trace.count('health'), 30)

    def test_healthy_release_remains_selected_and_runs_post_cutover_backup(self):
        result, current, trace = self.run_cutover('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(current, NEW)
        self.assertEqual(trace, [
            'select ' + NEW,
            'systemctl restart bolts.service',
            'health',
            'systemctl start bolts-backup.timer',
            'systemctl start bolts-backup.service',
        ])
        self.assertIn('is healthy', result.stdout)
        self.assertNotIn('restored previous binary', result.stderr)


if __name__ == '__main__':
    unittest.main()
