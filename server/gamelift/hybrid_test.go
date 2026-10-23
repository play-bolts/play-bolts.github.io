package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/gamelift/types"
	"github.com/gorilla/websocket"
)

func TestRegionalLobbyNamesUseClassicVocabularyAndAvoidActiveCollisions(t *testing.T) {
	pattern := regexp.MustCompile(`^(Rommel|Guderian|Moltke|Blücher|Scharnhorst|Clausewitz) (Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega)$`)
	var occupied []lobby
	first := regionalLobbyName("stable-placement", nil)
	for i := 0; i < 144; i++ {
		name := regionalLobbyName("stable-placement", occupied)
		if !pattern.MatchString(name) {
			t.Fatalf("nonclassic lobby name %q", name)
		}
		for _, row := range occupied {
			if row.Name == name {
				t.Fatalf("active name collision %q", name)
			}
		}
		occupied = append(occupied, lobby{Name: name})
	}
	if name := regionalLobbyName("stable-placement", occupied); name != first+" 2" {
		t.Fatalf("cycle suffix: %q", name)
	}
	varied := map[string]bool{}
	for i := 0; i < 100; i++ {
		name := regionalLobbyName(fmt.Sprint(i), nil)
		varied[name] = true
		if name != regionalLobbyName(fmt.Sprint(i), nil) {
			t.Fatal("retry changed its lobby name")
		}
	}
	if len(varied) < 50 {
		t.Fatalf("placements produced only %d distinct names", len(varied))
	}
}

func TestFailedLocationDoesNotHideHealthyRoomsOrAdmitStaleGames(t *testing.T) {
	r := testRuntime()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/api/lobbies" {
			respond(w, 200, map[string]any{"lobbies": []lobby{{ID: "oregon", Name: "Rommel Alpha", Capacity: 6, Players: 1, Phase: "playing"}}})
			return
		}
		respond(w, 200, map[string]string{"playerId": "player"})
	}))
	defer local.Close()
	r.local = local.URL
	api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": {londonGame("london-game", 1)}, "ap-southeast-1": {{GameSessionId: aws.String("singapore-game"), Name: aws.String("Guderian Delta"), Location: aws.String("ap-southeast-1"), Status: types.GameSessionStatusActive, CurrentPlayerSessionCount: aws.Int32(2), DnsName: aws.String("sg.amazongamelift.com"), Port: aws.Int32(8080)}}}, errors: map[string]error{}}
	d := &directory{r: r, api: api}
	if rows, err := d.catalog(context.Background(), true); err != nil || len(rows) != 3 {
		t.Fatalf("initial rooms: %+v %v", rows, err)
	}
	api.errors["ap-southeast-1"] = errors.New("regional API unavailable")
	rows, err := d.catalog(context.Background(), true)
	if err != nil || len(rows) != 2 {
		t.Fatalf("partial region failure: %+v %v", rows, err)
	}
	for _, row := range rows {
		if row.Location == "sg" {
			t.Fatal("stale failed-region endpoint remained listed")
		}
	}
	w := httptest.NewRecorder()
	d.list(w, httptest.NewRequest("GET", "/api/lobbies", nil))
	var listed struct{ Locations []string }
	json.Unmarshal(w.Body.Bytes(), &listed)
	if strings.Join(listed.Locations, ",") != "lon,sp" {
		t.Fatalf("unhealthy location still selectable: %s", w.Body.String())
	}
	if w := joinForTest(d, "new:sg", "a"); w.Code != 503 {
		t.Fatalf("failed-region placement accepted: %d %s", w.Code, w.Body.String())
	}
	if w := joinForTest(d, "singapore-game", "a"); w.Code != 409 {
		t.Fatalf("stale endpoint admitted: %d %s", w.Code, w.Body.String())
	}
	if api.starts != 0 || api.creates != 0 {
		t.Fatal("unavailable region allocated capacity or seats")
	}
	if w := joinForTest(d, "new:lon", "a"); w.Code != 200 {
		t.Fatalf("healthy-region admission failed: %d %s", w.Code, w.Body.String())
	}
	delete(api.errors, "ap-southeast-1")
	if rows, err := d.catalog(context.Background(), true); err != nil || len(rows) != 3 {
		t.Fatalf("recovered region did not return: %+v %v", rows, err)
	}
	for _, loc := range r.cfg.Locations {
		api.errors[loc.AWS] = errors.New("regional API unavailable")
	}
	if rows, err := d.catalog(context.Background(), true); err != nil || len(rows) != 1 || rows[0].Location != "or" || len(d.available) != 0 {
		t.Fatalf("Oregon must survive all managed-region failures: %+v %v", rows, err)
	}
}

func TestHybridDirectoryKeepsOregonAndEveryManagedCity(t *testing.T) {
	r := testRuntime()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		switch q.URL.Path {
		case "/api/lobbies":
			// A disconnected reservation is still a seat, but is not online.
			respond(w, 200, map[string]any{"lobbies": []lobby{{ID: "local-room", Name: "Rommel Alpha", Players: 2, Capacity: 6, Phase: "playing"}}})
		case "/api/status":
			respond(w, 200, map[string]int{"online": 1})
		default:
			t.Errorf("unexpected local route %s", q.URL.Path)
		}
	}))
	defer local.Close()
	r.local = local.URL
	api := &fakeFleet{games: map[string][]types.GameSession{}}
	for _, loc := range r.cfg.Locations {
		api.games[loc.AWS] = []types.GameSession{{GameSessionId: aws.String("game-" + loc.ID), Name: aws.String("Guderian Beta"), Location: &loc.AWS, Status: types.GameSessionStatusActive, CurrentPlayerSessionCount: aws.Int32(2), DnsName: aws.String(loc.ID + ".amazongamelift.com"), Port: aws.Int32(8080)}}
	}
	d := &directory{r: r, api: api}
	rows, err := d.catalog(context.Background(), true)
	if err != nil || len(rows) != 4 {
		t.Fatalf("global list: %+v %v", rows, err)
	}
	found := map[string]bool{}
	for _, row := range rows {
		found[row.Location] = true
		if row.Location == "or" {
			if row.Managed || row.ID != "local-room" || row.PingURL != "wss://bolts-api.example.com/api/ping" {
				t.Fatalf("Oregon routing changed: %+v", row)
			}
		} else if !row.Managed {
			t.Fatalf("regional admission missing: %+v", row)
		}
	}
	for _, id := range []string{"or", "lon", "sg", "sp"} {
		if !found[id] {
			t.Fatalf("missing %s", id)
		}
	}
	w := httptest.NewRecorder()
	d.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/status", nil))
	var status struct{ Online int }
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || w.Code != 200 || status.Online != 7 {
		t.Fatalf("global online count: %d %s %v", w.Code, w.Body.String(), err)
	}
	if api.starts != 0 || api.creates != 0 {
		t.Fatal("listing or status allocated a server or seat")
	}
}

func TestRealRustOregonAdmissionAndProbeThroughDirectory(t *testing.T) {
	r := startRust(t)
	d := &directory{r: r, api: &fakeFleet{games: map[string][]types.GameSession{}}}
	host := httptest.NewServer(d.handler())
	defer host.Close()
	response, err := http.Get(host.URL + "/api/lobbies")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Lobbies   []lobby
		Locations []string
	}
	err = json.NewDecoder(response.Body).Decode(&list)
	response.Body.Close()
	if err != nil || len(list.Lobbies) != 4 || list.Lobbies[0].Name != "Deathmatch" || list.Lobbies[0].Location != "or" || list.Lobbies[0].Managed {
		t.Fatalf("Oregon list: %+v %v", list, err)
	}
	for i, name := range []string{"1v1 Alpha", "1v1 Beta", "1v1 Delta"} {
		row := list.Lobbies[i+1]
		if row.Name != name || row.Capacity != 2 || row.Managed || row.Location != "or" {
			t.Fatalf("dedicated duel room: %+v", row)
		}
	}
	if strings.Join(list.Locations, ",") != "lon,sg,sp" {
		t.Fatalf("managed picker: %+v", list.Locations)
	}
	request, _ := http.NewRequest("POST", host.URL+"/api/session", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", r.cfg.Origins[0])
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if origins := response.Header.Values("Access-Control-Allow-Origin"); len(origins) != 1 || origins[0] != r.cfg.Origins[0] {
		t.Fatalf("browser session rejected by CORS: %+v", origins)
	}
	var identity struct{ Token string }
	err = json.NewDecoder(response.Body).Decode(&identity)
	response.Body.Close()
	if err != nil || identity.Token == "" {
		t.Fatalf("identity: %v", err)
	}
	ws := "ws" + strings.TrimPrefix(host.URL, "http")
	headers := http.Header{"Origin": []string{r.cfg.Origins[0]}}
	probe, _, err := websocket.DefaultDialer.Dial(ws+"/api/ping", headers)
	if err != nil {
		t.Fatal(err)
	}
	probe.SetReadDeadline(time.Now().Add(2 * time.Second))
	probe.WriteJSON(map[string]string{"type": "ping", "nonce": "oregon-test"})
	var pong map[string]string
	err = probe.ReadJSON(&pong)
	probe.Close()
	if err != nil || pong["nonce"] != "oregon-test" || pong["type"] != "pong" {
		t.Fatalf("Oregon ping: %+v %v", pong, err)
	}
	connection, _, err := websocket.DefaultDialer.Dial(ws+"/api/ws", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	connection.WriteJSON(map[string]any{"type": "hello", "version": 3, "token": identity.Token})
	var message map[string]any
	if err = connection.ReadJSON(&message); err != nil || message["type"] != "welcome" {
		t.Fatalf("central-token admission: %+v %v", message, err)
	}
	connection.WriteJSON(map[string]any{"type": "join", "lobbyId": list.Lobbies[0].ID, "name": "Hybrid Alice", "faction": "british"})
	for {
		if err = connection.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message["type"] == "joined" {
			break
		}
	}
	response, err = http.Get(host.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct{ Online int }
	err = json.NewDecoder(response.Body).Decode(&status)
	response.Body.Close()
	if err != nil || status.Online != 1 {
		t.Fatalf("Oregon player not counted: %+v %v", status, err)
	}
	connection.WriteJSON(map[string]string{"type": "leave"})
}
