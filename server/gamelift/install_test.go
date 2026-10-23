package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
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
	rollbackStart := strings.Index(source, "rollback_release() {")
	rollbackEnd := strings.Index(source, `install -d -m 0755 "/opt/bolts/releases/$release"`)
	if rollbackStart < 0 || rollbackEnd < rollbackStart {
		t.Fatal("missing rollback trap")
	}
	branch = source[rollbackStart:rollbackEnd] + branch
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
runtime_env=
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

// Run the complete installer against a temporary filesystem. Only service
// control, locking, curl and Linux mv's -T flag are replaced; environment file
// validation, atomic writes, checkpoints and rollback execute unchanged.
func TestDirectoryInstallerRuntimeEnvironment(t *testing.T) {
	data, err := os.ReadFile("../../infra/gamelift/install-directory.sh")
	if err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("a1", 32)
	valid := "BOLTS_ADMIN_API_KEY=" + key + "\nBOLTS_MAX_ROOMS=11\n"
	cases := []struct {
		name, update string
		mode         os.FileMode
		invalid      bool
	}{
		{"success", valid, 0600, false},
		{"legacy", valid, 0600, false},
		{"restart_failure", valid, 0600, false},
		{"health_failure", valid, 0600, false},
		{"admin_failure", valid, 0600, false},
		{"cacheable_admin", valid, 0600, false},
		{"sql_failure", valid, 0600, false},
		{"activation_failure", valid, 0600, false},
		{"short_key", "BOLTS_ADMIN_API_KEY=short\nBOLTS_MAX_ROOMS=11\n", 0600, true},
		{"long_key", "BOLTS_ADMIN_API_KEY=" + strings.Repeat("a", 129) + "\nBOLTS_MAX_ROOMS=11\n", 0600, true},
		{"space_in_key", strings.Replace(valid, key, key+" ", 1), 0600, true},
		{"non_ascii_key", strings.Replace(valid, key, key+"é", 1), 0600, true},
		{"wrong_capacity", strings.Replace(valid, "ROOMS=11", "ROOMS=32", 1), 0600, true},
		{"extra_setting", valid + "BOLTS_IDENTITY_SALT=changed\n", 0600, true},
		{"duplicate_key", valid + "BOLTS_ADMIN_API_KEY=" + key + "\n", 0600, true},
		{"public_file", valid, 0644, true},
		{"symlink", valid, 0600, true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			write := func(name, content string, mode os.FileMode) {
				t.Helper()
				path := filepath.Join(dir, name)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(content), mode); err != nil {
					t.Fatal(err)
				}
			}
			oldRelease := filepath.Join(dir, "opt/bolts/releases", strings.Repeat("a", 64))
			newRelease := filepath.Join(dir, "opt/bolts/releases", strings.Repeat("b", 64))
			oldEnv := "# preserve comments and CRLF\r\nBOLTS_IDENTITY_SALT=stable-secret\r\nBOLTS_ADMIN_API_KEY=old-key\nBOLTS_MAX_ROOMS=32\nBOLTS_DB=/unchanged/path"
			write("etc/bolts.env", oldEnv, 0600)
			write("etc/bolts-gamelift.json", "old-config\n", 0600)
			write("etc/systemd/system/bolts.service.d/gamelift.conf", "old-dropin\n", 0600)
			write("var/lib/bolts-bootstrap.ready", "ready", 0600)
			write("var/lock/placeholder", "", 0600)
			write("var/lib/bolts/placeholder", "", 0600)
			write("opt/bolts/releases/"+strings.Repeat("a", 64)+"/bolts-host", "old-binary", 0700)
			write("bundle/bolts-host", "#!/bin/sh\nexit 0\n", 0700)
			write("bundle/bolts-server", "new-binary", 0700)
			write("config.json", `{"locations":[],"extraLobbiesEnabled":false}`, 0600)
			write("runtime.env", test.update, test.mode)
			if test.name == "symlink" {
				if err := os.Rename(filepath.Join(dir, "runtime.env"), filepath.Join(dir, "runtime-target.env")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(dir, "runtime-target.env"), filepath.Join(dir, "runtime.env")); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(oldRelease, filepath.Join(dir, "opt/bolts/current")); err != nil {
				t.Fatal(err)
			}
			var adminCalls atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				adminCalls.Add(1)
				installed, err := os.ReadFile(filepath.Join(dir, "etc/bolts.env"))
				if err != nil || !strings.Contains(string(installed), "BOLTS_ADMIN_API_KEY="+key+"\n") || r.Header.Get("Authorization") != "Bearer "+key {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				w.Header().Set("Cache-Control", "no-store")
				if test.name == "cacheable_admin" {
					w.Header().Set("Cache-Control", "public")
				}
				if r.URL.Path == "/api/admin/status" && r.Method == "GET" && r.URL.Query().Get("minutes") == "1" {
					minutes := 1
					if test.name == "admin_failure" {
						minutes = 60
					}
					_ = json.NewEncoder(w).Encode(map[string]int{"minutes": minutes})
				} else if r.URL.Path == "/api/admin/query" && r.Method == "POST" {
					var body struct {
						SQL string `json:"sql"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || body.SQL != "SELECT 1" {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					value := 1
					if test.name == "sql_failure" {
						value = 2
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"rows": [][]int{{value}}})
				} else {
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer api.Close()
			source := strings.NewReplacer("/opt/", dir+"/opt/", "/etc/", dir+"/etc/", "/var/", dir+"/var/").Replace(string(data))
			source = strings.ReplaceAll(source, "http://127.0.0.1:8080", api.URL)
			prefix := `
flock() { :; }
mv() { if [ "$1" = -Tf ]; then shift; python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$@"; else command mv "$@"; fi; }
ln() {
 if [ "$SCENARIO" = activation_failure ] && [ ! -f "$CASE_DIR/link_failed" ]; then touch "$CASE_DIR/link_failed"; return 19; fi
 command ln "$@"
}
systemctl() {
 printf '%s\n' "$*" >> "$CASE_DIR/trace"
 if [ "$*" = 'restart bolts.service' ] && [ "$SCENARIO" = restart_failure ] && [ ! -f "$CASE_DIR/restart_failed" ]; then touch "$CASE_DIR/restart_failed"; return 17; fi
}
curl() {
 if [ "$SCENARIO" = health_failure ] && [ -f "$CASE_DIR/etc/bolts.env" ] && [ "$(readlink "$CASE_DIR/opt/bolts/current")" = "$NEW_RELEASE" ]; then
   printf '{"version":1,"locations":[],"lobbies":[]}\n'
 else
   printf '{"version":2,"locations":[],"lobbies":[{"id":"local-room","location":"or","managed":false,"players":0}]}\n'
 fi
}
sleep() { :; }
`
			args := []string{"-c", prefix + source, "--", strings.Repeat("b", 64), filepath.Join(dir, "bundle"), filepath.Join(dir, "config.json"), strings.Repeat("a", 64)}
			if test.name != "legacy" {
				args = append(args, filepath.Join(dir, "runtime.env"))
			}
			cmd := exec.Command("bash", args...)
			cmd.Env = append(os.Environ(), "CASE_DIR="+dir, "SCENARIO="+test.name, "NEW_RELEASE="+newRelease)
			output, runErr := cmd.CombinedOutput()
			if strings.Contains(string(output), key) {
				t.Fatal("installer disclosed the admin key")
			}
			current, err := os.Readlink(filepath.Join(dir, "opt/bolts/current"))
			if err != nil {
				t.Fatal(err)
			}
			env, err := os.ReadFile(filepath.Join(dir, "etc/bolts.env"))
			if err != nil {
				t.Fatal(err)
			}
			info, _ := os.Stat(filepath.Join(dir, "etc/bolts.env"))
			if info.Mode().Perm() != 0600 {
				t.Fatalf("environment permissions: %v", info.Mode())
			}
			trace, _ := os.ReadFile(filepath.Join(dir, "trace"))
			if test.name == "success" || test.name == "legacy" {
				if runErr != nil || current != newRelease || strings.Count(string(trace), "restart bolts.service\n") != 1 {
					t.Fatalf("cutover failed: %v %s %s", runErr, output, trace)
				}
				want := oldEnv
				if test.name == "success" {
					want = "# preserve comments and CRLF\r\nBOLTS_IDENTITY_SALT=stable-secret\r\nBOLTS_DB=/unchanged/path\n" + valid
					if adminCalls.Load() != 2 {
						t.Fatalf("expected status and SQL activation checks, got %d", adminCalls.Load())
					}
				} else if adminCalls.Load() != 0 {
					t.Fatal("legacy install must not require admin API")
				}
				if string(env) != want {
					t.Fatal("environment did not preserve unrelated settings")
				}
			} else {
				if runErr == nil || current != oldRelease || string(env) != oldEnv {
					t.Fatalf("failed release did not preserve/restore prior state: %v %s", runErr, output)
				}
				for name, want := range map[string]string{"etc/bolts-gamelift.json": "old-config\n", "etc/systemd/system/bolts.service.d/gamelift.conf": "old-dropin\n"} {
					got, _ := os.ReadFile(filepath.Join(dir, name))
					if string(got) != want {
						t.Fatalf("failed release changed %s", name)
					}
				}
				if test.invalid && len(trace) != 0 {
					t.Fatalf("invalid environment reached service operations: %s", trace)
				}
				if !test.invalid && !strings.Contains(string(output), "restored") {
					t.Fatalf("missing successful rollback confirmation: %s", output)
				}
			}
			checkpoints, _ := filepath.Glob(filepath.Join(dir, "var/lib/bolts/gamelift-cutover.*/bolts.env"))
			if !test.invalid && test.name != "legacy" {
				if len(checkpoints) != 1 {
					t.Fatalf("missing environment checkpoint: %v", checkpoints)
				}
				backup, _ := os.ReadFile(checkpoints[0])
				backupInfo, _ := os.Stat(checkpoints[0])
				if string(backup) != oldEnv || backupInfo.Mode().Perm() != 0600 {
					t.Fatal("checkpoint must preserve exact bytes privately")
				}
			}
		})
	}
}
