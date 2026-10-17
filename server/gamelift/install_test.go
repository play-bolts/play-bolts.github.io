package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFleetInstallerUsesNoninteractivePrivilegeForOwnedPaths(t *testing.T) {
	data, err := os.ReadFile("../../infra/gamelift/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"success", "sudo_denied"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			for _, name := range []string{"bolts-server", "bolts-host"} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte("binary"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("bash", "-c", `
chmod() { printf 'unprivileged chmod\n' >&2; return 99; }
install() { printf 'unprivileged install\n' >&2; return 99; }
sudo() {
 printf '%s\n' "$*" >> "$CASE_DIR/trace"
 [ "$SCENARIO" != sudo_denied ] || return 1
 case "$*" in
 '-n chmod 0755 /local/game/bolts-server /local/game/bolts-host')
   command chmod 0755 "$CASE_DIR/bolts-server" "$CASE_DIR/bolts-host" ;;
 '-n install -d -m 1777 /local/game/sessionlogs')
   command install -d -m 1777 "$CASE_DIR/sessionlogs" ;;
 *) printf 'unexpected privileged request\n' >&2; return 98 ;;
 esac
}
`+string(data))
			cmd.Env = append(os.Environ(), "CASE_DIR="+dir, "SCENARIO="+scenario)
			output, runErr := cmd.CombinedOutput()
			trace, _ := os.ReadFile(filepath.Join(dir, "trace"))
			if scenario == "sudo_denied" {
				if runErr == nil || strings.Contains(string(trace), "install") {
					t.Fatalf("privilege failure must stop before creating log root: %v %s %s", runErr, output, trace)
				}
				return
			}
			if runErr != nil || strings.Count(string(trace), "\n") != 2 {
				t.Fatalf("installer failed or unexpected requests: %v %s %s", runErr, output, trace)
			}
			for _, name := range []string{"bolts-server", "bolts-host"} {
				info, err := os.Stat(filepath.Join(dir, name))
				if err != nil || info.Mode().Perm() != 0755 {
					t.Fatalf("%s must be executable: %v", name, err)
				}
			}
			logs, err := os.Stat(filepath.Join(dir, "sessionlogs"))
			if err != nil || !logs.IsDir() || logs.Mode().Perm() != 0777 || logs.Mode()&os.ModeSticky == 0 {
				t.Fatalf("shared log root must be a mode-1777 directory: %v", err)
			}
		})
	}
}

func TestDirectoryInstallerRejectsConcurrentOrStaleRelease(t *testing.T) {
	data, err := os.ReadFile("../../infra/gamelift/install-directory.sh")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	index := strings.Index(source, "test -f /var/lib/bolts-bootstrap.ready")
	if index < 0 {
		t.Fatal("missing initial release guards")
	}
	guards := strings.Replace(source[:index], "exec 9>/var/lock/bolts-release.lock", `exec 9>"$CASE_DIR/release.lock"`, 1)
	for _, scenario := range []string{"success", "concurrent", "stale"} {
		t.Run(scenario, func(t *testing.T) {
			expected := strings.Repeat("a", 64)
			if scenario == "stale" {
				expected = strings.Repeat("c", 64)
			}
			cmd := exec.Command("bash", "-c", `
flock() { [ "$SCENARIO" != concurrent ]; }
readlink() { printf '/opt/bolts/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
`+guards, "--", strings.Repeat("b", 64), "bundle", "config", expected)
			cmd.Env = append(os.Environ(), "CASE_DIR="+t.TempDir(), "SCENARIO="+scenario)
			output, err := cmd.CombinedOutput()
			if (err == nil) != (scenario == "success") {
				t.Fatalf("release guard %s: %v %s", scenario, err, output)
			}
			if scenario == "concurrent" && !strings.Contains(string(output), "Another Bolts release") {
				t.Fatalf("wrong lock failure: %s", output)
			}
			if scenario == "stale" && !strings.Contains(string(output), "Current release changed") {
				t.Fatalf("wrong stale-release failure: %s", output)
			}
		})
	}
}

// Execute the real installer's cutover branch with privileged operations
// replaced by shell functions. This catches set -e exits that bypass rollback.
func TestDirectoryInstallerRollsBackFailedStartAndHealth(t *testing.T) {
	data, err := os.ReadFile("../../infra/gamelift/install-directory.sh")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	marker := `ln -sfn "/opt/bolts/releases/$release" /opt/bolts/current.next`
	index := strings.Index(source, marker)
	if index < 0 {
		t.Fatal("missing cutover branch")
	}
	branch := source[index:]
	for _, scenario := range []string{"success", "restart_failure", "health_failure"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			previous := "/opt/bolts/releases/" + strings.Repeat("a", 64)
			for name, content := range map[string]string{
				"current": previous + "\n", "trace": "", "config.json": `{"locations":[{"id":"lon"},{"id":"sg"},{"id":"sp"}]}`,
			} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("bash", "-c", `
set -euo pipefail
release=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
previous=/opt/bolts/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
checkpoint="$CASE_DIR"
dropin=/etc/systemd/system/bolts.service.d/gamelift.conf
config="$CASE_DIR/config.json"
ln() { printf '%s\n' "$2" > "$CASE_DIR/next"; printf 'select %s\n' "$2" >> "$CASE_DIR/trace"; }
mv() { cat "$CASE_DIR/next" > "$CASE_DIR/current"; }
rm() { printf 'remove %s\n' "$*" >> "$CASE_DIR/trace"; }
systemctl() {
 printf 'systemctl %s\n' "$*" >> "$CASE_DIR/trace"
 if [ "$*" = 'restart bolts.service' ] && [ "$SCENARIO" = restart_failure ] && [ ! -f "$CASE_DIR/restart_failed" ]; then touch "$CASE_DIR/restart_failed"; return 17; fi
}
curl() {
 printf 'health\n' >> "$CASE_DIR/trace"
 if [ "$SCENARIO" = health_failure ]; then printf '{"version":1,"lobbies":[]}\n'; else
 printf '{"version":2,"locations":["lon","sg","sp"],"lobbies":[{"id":"local-room","location":"or","managed":false}]}\n'; fi
}
sleep() { :; }
`+branch)
			cmd.Env = append(os.Environ(), "CASE_DIR="+dir, "SCENARIO="+scenario)
			output, runErr := cmd.CombinedOutput()
			current, _ := os.ReadFile(filepath.Join(dir, "current"))
			traceData, _ := os.ReadFile(filepath.Join(dir, "trace"))
			trace := string(traceData)
			if scenario == "success" {
				if runErr != nil || strings.TrimSpace(string(current)) != "/opt/bolts/releases/"+strings.Repeat("b", 64) || !strings.Contains(trace, "systemctl start bolts-backup.service") {
					t.Fatalf("healthy cutover: %v %s\n%s", runErr, output, trace)
				}
			} else {
				if runErr == nil || strings.TrimSpace(string(current)) != previous || !strings.Contains(string(output), "restored") || strings.Count(trace, "systemctl restart bolts.service") != 2 {
					t.Fatalf("rollback: %v %s\n%s", runErr, output, trace)
				}
				if strings.Contains(trace, "systemctl start bolts-backup.service") {
					t.Fatal("failed release reported backup success")
				}
				if scenario == "restart_failure" && strings.Contains(trace, "health") {
					t.Fatal("failed restart must roll back immediately")
				}
				if scenario == "health_failure" && strings.Count(trace, "health\n") != 30 {
					t.Fatal("health retries must be bounded")
				}
			}
		})
	}
}

func TestDirectoryInstallerRechecksOccupancyAfterBackup(t *testing.T) {
	data, err := os.ReadFile("../../infra/gamelift/install-directory.sh")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	start, end := strings.Index(source, "verify_empty_lobbies() {"), strings.Index(source, "checkpoint=$(mktemp")
	if start < 0 || end < start {
		t.Fatal("missing guarded backup branch")
	}
	branch := source[start:end]
	dir := t.TempDir()
	cmd := exec.Command("bash", "-c", `
set -euo pipefail
curl() { if [ -f "$CASE_DIR/backed_up" ]; then printf '{"lobbies":[{"players":1}]}\n'; else printf '{"lobbies":[{"players":0}]}\n'; fi; }
systemctl() { touch "$CASE_DIR/backed_up"; }
verify_current_release() { touch "$CASE_DIR/reached_cutover"; }
`+branch)
	cmd.Env = append(os.Environ(), "CASE_DIR="+dir)
	output, runErr := cmd.CombinedOutput()
	if runErr == nil || !strings.Contains(string(output), "human seat is occupied") {
		t.Fatalf("late arrival was not protected: %v %s", runErr, output)
	}
	if _, err := os.Stat(filepath.Join(dir, "reached_cutover")); !os.IsNotExist(err) {
		t.Fatal("cutover continued with occupied lobby")
	}
}
