package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDisabledExtraLobbiesKeepOregonWithoutCallingGameLift(t *testing.T) {
	r := testRuntime()
	r.cfg.ExtraLobbiesEnabled = false
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		respond(w, 200, map[string]any{"lobbies": []lobby{{ID: "oregon", Name: "Rommel Alpha", Capacity: 6, Phase: "playing"}}})
	}))
	defer local.Close()
	r.local = local.URL
	// A nil GameLift API panics if disabled discovery/admission makes any AWS call.
	d := &directory{r: r}
	rows, err := d.catalog(context.Background(), true)
	if err != nil || len(rows) != 1 || rows[0].Location != "or" || rows[0].Managed || len(d.available) != 0 {
		t.Fatalf("disabled regional catalog: %+v %v", rows, err)
	}
	for _, target := range []string{"new:lon", "new:sg", "new:sp", "previously-active-game"} {
		if w := joinForTest(d, target, "a"); w.Code != 503 {
			t.Fatalf("disabled admission %q: %d %s", target, w.Code, w.Body.String())
		}
	}
}

func TestOmittedFeatureFlagDefaultsToDisabled(t *testing.T) {
	cfg := map[string]any{
		"region": "us-east-1", "fleetRole": "test-role", "secretParameter": "/test/secret",
		"api": "https://api.example.com", "origins": []string{"https://example.com"}, "locations": []location{},
	}
	data, _ := json.Marshal(cfg)
	path := filepath.Join(t.TempDir(), "host.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadSettings(path)
	if err != nil || loaded.ExtraLobbiesEnabled {
		t.Fatalf("default flag: %+v %v", loaded, err)
	}
}

func TestDisabledDirectoryInstallerChecksOnlyOregon(t *testing.T) {
	source, err := os.ReadFile("../../infra/gamelift/install-directory.sh")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(source), "with open(sys.argv[1])")
	if start < 0 {
		t.Fatal("missing installer directory check")
	}
	end := strings.Index(string(source)[start:], "\n' \"$config\"")
	if end < 0 {
		t.Fatal("missing installer directory check")
	}
	script := "import json,sys\n" + string(source)[start:start+end]
	path := filepath.Join(t.TempDir(), "config.json")
	if err = os.WriteFile(path, []byte(`{"extraLobbiesEnabled":false,"locations":[{"id":"lon"},{"id":"sg"},{"id":"sp"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, regions := range []string{`[]`, `["lon"]`} {
		cmd := exec.Command("python3", "-c", script, path)
		cmd.Stdin = strings.NewReader(`{"version":2,"locations":` + regions + `,"lobbies":[{"id":"oregon","location":"or","managed":false}]}`)
		output, err := cmd.CombinedOutput()
		if (err == nil) != (regions == `[]`) {
			t.Fatalf("disabled directory health %s: %v %s", regions, err, output)
		}
	}
}
