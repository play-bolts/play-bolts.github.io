package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/gamelift"
	"github.com/aws/aws-sdk-go-v2/service/gamelift/types"
	"github.com/aws/smithy-go"
	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

func testRuntime() *runtime {
	return &runtime{cfg: settings{Fleet: "fleet-test", API: "https://bolts-api.example.com", Origins: []string{"http://localhost:5173"}, Locations: []location{{"lon", "London", "eu-west-2", "lon-queue"}, {"sg", "Singapore", "ap-southeast-1", "sg-queue"}, {"sp", "São Paulo", "sa-east-1", "sp-queue"}}}, secret: []byte(strings.Repeat("secret", 8)), internal: randomToken(), http: &http.Client{Timeout: 3 * time.Second}}
}
func TestSettingsValidatePhysicalLocationsWithoutFixedCount(t *testing.T) {
	base := testRuntime().cfg
	base.Region = "us-east-1"
	base.FleetRole = "arn:aws:iam::123456789012:role/bolts-game-role"
	base.SecretParameter = "/bolts/gamelift/cluster-secret"
	base.API = "https://bolts-api.example.com"
	check := func(t *testing.T, locations []location, valid bool) {
		t.Helper()
		cfg := base
		cfg.Locations = locations
		data, err := json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "host.json")
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		_, err = loadSettings(path)
		if (err == nil) != valid {
			t.Fatalf("valid=%t: %v", valid, err)
		}
	}
	check(t, base.Locations, true)
	// The directory may retain Oregon locally, so configured managed locations
	// need not include an additional Oregon worker or a hardcoded total count.
	check(t, base.Locations[1:], true)
	for name, locations := range map[string][]location{
		"empty":         nil,
		"unknown":       {{"par", "Paris", "eu-west-3", "par-queue"}},
		"removed NYC":   {{"ny", "New York City", "us-east-1-nyc-2", "ny-queue"}},
		"city mismatch": {{"lon", "London", "us-east-1", "lon-queue"}},
		"duplicate":     {base.Locations[1], base.Locations[1]},
		"missing queue": {{"sg", "Singapore", "ap-southeast-1", ""}},
		"missing label": {{"lon", " ", "eu-west-2", "lon-queue"}},
	} {
		t.Run(name, func(t *testing.T) { check(t, locations, false) })
	}
}

func TestDirectoryPreservesVisitorTrackingAndPrivateRouteBoundary(t *testing.T) {
	r := testRuntime()
	calls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		calls++
		body, _ := io.ReadAll(q.Body)
		if q.Method != "POST" || q.URL.Path != "/api/visits" || string(body) != `{"visitorId":"anonymous-id"}` || q.Header.Get("Origin") != r.cfg.Origins[0] || q.Header.Get("X-Forwarded-For") != "203.0.113.9" {
			t.Errorf("visitor request changed: %s %s headers=%v body=%s", q.Method, q.URL.Path, q.Header, body)
		}
		respond(w, 202, map[string]bool{"ok": true})
	}))
	defer backend.Close()
	r.local = backend.URL
	d := &directory{r: r}
	handler := d.handler()
	request := func(method, path, origin string) *httptest.ResponseRecorder {
		q := httptest.NewRequest(method, path, strings.NewReader(`{"visitorId":"anonymous-id"}`))
		q.RemoteAddr = "10.0.0.1:54321"
		q.Header.Set("Origin", origin)
		q.Header.Set("X-Forwarded-For", "198.51.100.77, 203.0.113.9")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, q)
		return w
	}
	if w := request("POST", "/api/visits", r.cfg.Origins[0]); w.Code != 202 || w.Header().Get("Access-Control-Allow-Origin") != r.cfg.Origins[0] {
		t.Fatalf("visitor forwarding: %d %s", w.Code, w.Body.String())
	}
	if w := request("OPTIONS", "/api/visits", r.cfg.Origins[0]); w.Code != 204 {
		t.Fatalf("visitor preflight: %d", w.Code)
	}
	if w := request("POST", "/api/visits", "https://other.example"); w.Code != 403 {
		t.Fatalf("foreign origin: %d", w.Code)
	}
	if w := request("POST", "/internal/cluster", r.cfg.Origins[0]); w.Code != 404 {
		t.Fatalf("private route exposed: %d", w.Code)
	}
	if w := request("GET", "/api/visits", r.cfg.Origins[0]); w.Code != 405 {
		t.Fatalf("visitor read exposed: %d", w.Code)
	}
	if calls != 1 {
		t.Fatalf("unexpected backend calls: %d", calls)
	}
}

func TestAdmissionScopeAndExpiry(t *testing.T) {
	r := testRuntime()
	a := admission{Player: "p", Session: "s", PlayerSession: "ps", Expires: time.Now().Add(time.Minute).Unix()}
	ticket := r.ticket(a)
	if got, err := r.verify(ticket, "s"); err != nil || got.Player != "p" {
		t.Fatalf("ticket: %v", err)
	}
	for _, value := range []string{ticket + "x", r.ticket(admission{Player: "p", Session: "s", PlayerSession: "ps", Expires: 1}), r.ticket(admission{Player: "p", Session: "other", PlayerSession: "ps", Expires: a.Expires})} {
		if _, err := r.verify(value, "s"); err == nil {
			t.Fatal("accepted invalid admission")
		}
	}
	if _, err := endpoint("attacker.example", 8080, "/api/ws"); err == nil {
		t.Fatal("accepted untrusted host")
	}
}

type fakeFleet struct {
	gameAPI
	mu        sync.Mutex
	games     map[string][]types.GameSession
	errors    map[string]error
	placement *types.GameSessionPlacement
	starts    int
	queue     string
	name      string
	seats     map[string][]types.PlayerSession
	creates   int
	seatPages int
	racedFull string
}

func (f *fakeFleet) DescribeGameSessions(_ context.Context, q *gamelift.DescribeGameSessionsInput, _ ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionsOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.errors[*q.Location]; err != nil {
		return nil, err
	}
	return &gamelift.DescribeGameSessionsOutput{GameSessions: f.games[*q.Location]}, nil
}
func (f *fakeFleet) DescribeGameSessionPlacement(_ context.Context, q *gamelift.DescribeGameSessionPlacementInput, _ ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionPlacementOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.placement == nil {
		return nil, &smithy.GenericAPIError{Code: "NotFoundException"}
	}
	return &gamelift.DescribeGameSessionPlacementOutput{GameSessionPlacement: f.placement}, nil
}
func (f *fakeFleet) StartGameSessionPlacement(_ context.Context, q *gamelift.StartGameSessionPlacementInput, _ ...func(*gamelift.Options)) (*gamelift.StartGameSessionPlacementOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	f.queue = *q.GameSessionQueueName
	f.name = *q.GameSessionName
	f.placement = &types.GameSessionPlacement{Status: types.GameSessionPlacementStatePending}
	return &gamelift.StartGameSessionPlacementOutput{GameSessionPlacement: f.placement}, nil
}
func (f *fakeFleet) DescribePlayerSessions(_ context.Context, q *gamelift.DescribePlayerSessionsInput, _ ...func(*gamelift.Options)) (*gamelift.DescribePlayerSessionsOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	limit := int(aws.ToInt32(q.Limit))
	// Match the service constraint so admission tests cannot silently accept a
	// request that AWS rejects before it can reserve a seat.
	if limit < 1 || limit > 50 {
		return nil, &smithy.GenericAPIError{Code: "InvalidRequestException", Message: "Limit must be between 1 and 50"}
	}
	start := 0
	if q.NextToken != nil {
		var err error
		start, err = strconv.Atoi(*q.NextToken)
		if err != nil || start < 0 || start > len(f.seats[*q.GameSessionId]) {
			return nil, &smithy.GenericAPIError{Code: "InvalidRequestException", Message: "Invalid next token"}
		}
	}
	f.seatPages++
	seats := f.seats[*q.GameSessionId]
	end := min(start+limit, len(seats))
	response := &gamelift.DescribePlayerSessionsOutput{PlayerSessions: seats[start:end]}
	if end < len(seats) {
		response.NextToken = aws.String(strconv.Itoa(end))
	}
	return response, nil
}
func (f *fakeFleet) CreatePlayerSession(_ context.Context, q *gamelift.CreatePlayerSessionInput, _ ...func(*gamelift.Options)) (*gamelift.CreatePlayerSessionOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, games := range f.games {
		for i := range games {
			g := &games[i]
			if aws.ToString(g.GameSessionId) != *q.GameSessionId {
				continue
			}
			if f.racedFull == *q.GameSessionId {
				g.CurrentPlayerSessionCount = aws.Int32(6)
				f.racedFull = ""
			}
			if aws.ToInt32(g.CurrentPlayerSessionCount) >= 6 {
				return nil, &smithy.GenericAPIError{Code: "GameSessionFullException"}
			}
			if g.Status != types.GameSessionStatusActive {
				return nil, &smithy.GenericAPIError{Code: "InvalidGameSessionStatusException"}
			}
			f.creates++
			p := types.PlayerSession{PlayerSessionId: aws.String(fmt.Sprintf("ps-%d", f.creates)), PlayerId: q.PlayerId, GameSessionId: q.GameSessionId, DnsName: g.DnsName, Port: g.Port, Status: types.PlayerSessionStatusReserved}
			if f.seats == nil {
				f.seats = map[string][]types.PlayerSession{}
			}
			f.seats[*q.GameSessionId] = append(f.seats[*q.GameSessionId], p)
			g.CurrentPlayerSessionCount = aws.Int32(aws.ToInt32(g.CurrentPlayerSessionCount) + 1)
			return &gamelift.CreatePlayerSessionOutput{PlayerSession: &p}, nil
		}
	}
	return nil, &smithy.GenericAPIError{Code: "NotFoundException"}
}
func TestGlobalDirectoryAndColdPlacementDeduplication(t *testing.T) {
	r := testRuntime()
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/api/lobbies" {
			respond(w, 200, map[string]any{"lobbies": []lobby{}})
			return
		}
		respond(w, 200, map[string]string{"playerId": "player"})
	}))
	defer auth.Close()
	r.local = auth.URL
	api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": {{GameSessionId: aws.String("game-lon"), Name: aws.String("Alpha"), Location: aws.String("eu-west-2"), Status: types.GameSessionStatusActive, CurrentPlayerSessionCount: aws.Int32(2), DnsName: aws.String("lon.amazongamelift.com"), Port: aws.Int32(8080)}}}}
	d := &directory{r: r, api: api, pending: map[string]string{}, pendingFile: filepath.Join(t.TempDir(), "placements.json")}
	rows, err := d.catalog(context.Background(), false)
	if err != nil || len(rows) != 1 {
		t.Fatalf("global directory %v: %v", rows, err)
	}
	if rows[0].PingURL == "" || rows[0].Location != "lon" {
		t.Fatalf("missing direct probe: %+v", rows[0])
	}
	call := func() *httptest.ResponseRecorder {
		q := httptest.NewRequest("POST", "/api/join", strings.NewReader(`{"token":"`+strings.Repeat("a", 64)+`","lobbyId":"new:sp"}`))
		w := httptest.NewRecorder()
		d.join(w, q)
		return w
	}
	for i := 0; i < 3; i++ {
		if w := call(); w.Code != 202 {
			t.Fatalf("cold join: %d %s", w.Code, w.Body.String())
		}
	}
	if api.starts != 1 || api.queue != "sp-queue" {
		t.Fatalf("started %d on %q", api.starts, api.queue)
	}
	saved, err := os.ReadFile(d.pendingFile)
	if err != nil || !bytes.Contains(saved, []byte("sp")) {
		t.Fatal("placement not recoverable")
	}
	api.placement.Status = types.GameSessionPlacementStateFulfilled
	api.placement.GameSessionId = aws.String("game-sp")
	api.games["sa-east-1"] = []types.GameSession{{GameSessionId: aws.String("game-sp"), Location: aws.String("sa-east-1"), Status: types.GameSessionStatusActive, CurrentPlayerSessionCount: aws.Int32(0), DnsName: aws.String("sp.amazongamelift.com"), Port: aws.Int32(8080)}}
	if w := call(); w.Code != 200 || !strings.Contains(w.Body.String(), "wss://sp.amazongamelift.com:8080") {
		t.Fatalf("fulfilled join: %d %s", w.Code, w.Body.String())
	}
	if len(d.pending) != 0 {
		t.Fatal("completed placement retained")
	}
}

func directoryForTest(t *testing.T, api *fakeFleet) *directory {
	t.Helper()
	r := testRuntime()
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/api/lobbies" {
			respond(w, 200, map[string]any{"lobbies": []lobby{}})
			return
		}
		var body map[string]string
		json.NewDecoder(q.Body).Decode(&body)
		respond(w, 200, map[string]string{"playerId": body["token"]})
	}))
	t.Cleanup(auth.Close)
	r.local = auth.URL
	return &directory{r: r, api: api, pending: map[string]string{}, pendingFile: filepath.Join(t.TempDir(), "placements.json")}
}
func joinForTest(d *directory, target, player string) *httptest.ResponseRecorder {
	q := httptest.NewRequest("POST", "/api/join", strings.NewReader(`{"token":"`+strings.Repeat(player, 64)+`","lobbyId":"`+target+`"}`))
	w := httptest.NewRecorder()
	d.join(w, q)
	return w
}
func londonGame(id string, players int32) types.GameSession {
	return types.GameSession{GameSessionId: &id, Name: &id, Location: aws.String("eu-west-2"), Status: types.GameSessionStatusActive, CurrentPlayerSessionCount: &players, DnsName: aws.String("lon.amazongamelift.com"), Port: aws.Int32(8080)}
}
func TestAdmissionUsesValidPlayerSessionPagesAndReusesLaterReservation(t *testing.T) {
	for _, target := range []string{"Alpha", "new:lon"} {
		t.Run(target, func(t *testing.T) {
			player := strings.Repeat("a", 64)
			seats := make([]types.PlayerSession, 51)
			for i := range seats[:50] {
				seats[i] = types.PlayerSession{PlayerId: &player, Status: types.PlayerSessionStatusCompleted}
			}
			seats[50] = types.PlayerSession{PlayerId: &player, PlayerSessionId: aws.String("ps-existing"), GameSessionId: aws.String("Alpha"), Status: types.PlayerSessionStatusReserved, DnsName: aws.String("lon.amazongamelift.com"), Port: aws.Int32(8080)}
			api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": {londonGame("Alpha", 1)}}, seats: map[string][]types.PlayerSession{"Alpha": seats}}
			d := directoryForTest(t, api)
			w := joinForTest(d, target, "a")
			if w.Code != 200 {
				t.Fatalf("valid paginated admission rejected: HTTP %d", w.Code)
			}
			if api.seatPages != 2 || api.creates != 0 || api.starts != 0 {
				t.Fatalf("later reservation not reused: pages=%d seats=%d games=%d", api.seatPages, api.creates, api.starts)
			}
		})
	}
}
func TestDirectoryListsOnlyRealSessionsAndRetainsLocationsAtZero(t *testing.T) {
	api := &fakeFleet{games: map[string][]types.GameSession{}}
	d := directoryForTest(t, api)
	check := func(want int) {
		t.Helper()
		if _, err := d.catalog(context.Background(), true); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		d.list(w, httptest.NewRequest("GET", "/api/lobbies", nil))
		var body struct {
			Version   int
			Lobbies   []lobby
			Locations []string
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 || body.Version != 2 || len(body.Lobbies) != want || strings.Join(body.Locations, ",") != "lon,sg,sp" {
			t.Fatalf("directory: %d %s (%v)", w.Code, w.Body.String(), err)
		}
		if api.starts != 0 {
			t.Fatal("listing allocated a game")
		}
	}
	check(0)
	api.games["eu-west-2"] = []types.GameSession{londonGame("game-lon", 0)}
	check(1) // A real idle game is available during its shutdown grace period.
	api.games["eu-west-2"][0].Status = types.GameSessionStatusTerminating
	check(0)
	api.games["eu-west-2"][0].Status = types.GameSessionStatusTerminated
	check(0)
}
func TestLocationPacksBeforeExpandingAndSharesOverflowPlacement(t *testing.T) {
	api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": {londonGame("Alpha", 2), londonGame("Bravo", 5)}}}
	d := directoryForTest(t, api)
	for i := 0; i < 2; i++ {
		w := joinForTest(d, "new:lon", "a")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"lobbyId":"Bravo"`) {
			t.Fatalf("pack/retry: %d %s", w.Code, w.Body.String())
		}
	}
	if api.creates != 1 || api.starts != 0 {
		t.Fatal("retry created another reservation or game")
	}
	w := joinForTest(d, "new:lon", "b")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"lobbyId":"Alpha"`) || api.starts != 0 {
		t.Fatalf("remaining capacity: %d %s", w.Code, w.Body.String())
	}
	api.games["eu-west-2"][0].CurrentPlayerSessionCount = aws.Int32(6)
	// Multiple players arriving at a full location request one shared game.
	var group sync.WaitGroup
	for _, player := range []string{"c", "d", "e"} {
		group.Add(1)
		go func(player string) {
			defer group.Done()
			w := joinForTest(d, "new:lon", player)
			if w.Code != 202 {
				t.Errorf("overflow: %d %s", w.Code, w.Body.String())
			}
		}(player)
	}
	group.Wait()
	if api.starts != 1 || api.queue != "lon-queue" {
		t.Fatalf("overflow started %d on %s", api.starts, api.queue)
	}
	api.placement.Status = types.GameSessionPlacementStateFulfilled
	api.placement.GameSessionId = aws.String("Charlie")
	api.games["eu-west-2"] = append(api.games["eu-west-2"], londonGame("Charlie", 0))
	// Simulate a gateway restart: recover the placement rather than creating one.
	recovered := directoryForTest(t, api)
	recovered.pendingFile = d.pendingFile
	saved, err := os.ReadFile(d.pendingFile)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(saved, &recovered.pending); err != nil {
		t.Fatal(err)
	}
	for _, player := range []string{"c", "d", "e"} {
		w := joinForTest(recovered, "new:lon", player)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"lobbyId":"Charlie"`) {
			t.Fatalf("overflow admission: %d %s", w.Code, w.Body.String())
		}
	}
	if api.starts != 1 || api.creates != 5 {
		t.Fatalf("unneeded allocation: games %d seats %d", api.starts, api.creates)
	}
	if len(recovered.pending) != 0 {
		t.Fatal("fulfilled placement retained after admission")
	}
}
func TestLastSeatRaceUsesRemainingCapacityBeforeStartingGame(t *testing.T) {
	for _, otherRoom := range []bool{true, false} {
		t.Run(fmt.Sprint(otherRoom), func(t *testing.T) {
			games := []types.GameSession{londonGame("Bravo", 5)}
			if otherRoom {
				games = append(games, londonGame("Alpha", 1))
			}
			api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": games}, racedFull: "Bravo"}
			d := directoryForTest(t, api)
			w := joinForTest(d, "new:lon", "a")
			if otherRoom {
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"lobbyId":"Alpha"`) || api.starts != 0 {
					t.Fatalf("race fallback: %d %s", w.Code, w.Body.String())
				}
			} else if w.Code != 202 || api.starts != 1 || api.queue != "lon-queue" {
				t.Fatalf("race overflow: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

type fakeSessions struct {
	mu               sync.Mutex
	p                model.PlayerSession
	accepts, removes int
}

func (f *fakeSessions) player(string) (model.PlayerSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.p, nil
}
func (f *fakeSessions) accept(string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accepts++
	f.p = f.p.WithStatus(model.PlayerActive)
	return nil
}
func (f *fakeSessions) remove(string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removes++
	f.p = f.p.WithStatus(model.PlayerCompleted)
	return nil
}
func (f *fakeSessions) removed() int { f.mu.Lock(); defer f.mu.Unlock(); return f.removes }
func startRust(t *testing.T) *runtime {
	t.Helper()
	binary := os.Getenv("BOLTS_TEST_SERVER")
	if binary == "" {
		t.Skip("set BOLTS_TEST_SERVER to run real Rust/Go integration")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	r := testRuntime()
	r.local = "http://" + address
	cmd := exec.Command(binary)
	cmd.Env = append(os.Environ(), "BOLTS_BIND="+address, "BOLTS_DB="+filepath.Join(t.TempDir(), "bolts.sqlite"), "BOLTS_INTERNAL_TOKEN="+r.internal, "BOLTS_IDENTITY_SALT="+randomToken(), "BOLTS_ORIGINS=http://localhost:5173", "BOLTS_TRUST_PROXY=true")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	for i := 0; i < 100; i++ {
		response, err := r.http.Get(r.local + "/api/health")
		if err == nil {
			response.Body.Close()
			return r
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("Rust failed to start")
	return nil
}
func TestRealRustAdmissionHeartbeatReconnectAndReplication(t *testing.T) {
	central := startRust(t)
	remote := startRust(t)
	ctx := context.Background()
	response, err := central.http.Post(central.local+"/api/session", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	var identity struct {
		PlayerID string `json:"playerId"`
		Token    string `json:"token"`
	}
	json.NewDecoder(response.Body).Decode(&identity)
	response.Body.Close()
	if identity.PlayerID == "" {
		t.Fatal("no identity")
	}
	session := "arn:aws:gamelift:eu-west-2:123456789012:gamesession/fleet-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222"
	if err = remote.localCall(ctx, map[string]string{"op": "activate", "session": session, "name": "London"}, nil); err != nil {
		t.Fatal(err)
	}
	service := &fakeSessions{p: model.PlayerSession{PlayerID: identity.PlayerID, GameSessionID: session, PlayerSessionID: "ps-test"}.WithStatus(model.PlayerReserved)}
	g := newGame(remote, service)
	g.session = session
	g.grace = 150 * time.Millisecond
	host := httptest.NewServer(g.handler())
	defer host.Close()
	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/api/ws"
	probe, _, err := websocket.DefaultDialer.Dial(strings.Replace(wsURL, "/api/ws", "/api/ping", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		nonce := fmt.Sprint(i)
		if err = probe.WriteJSON(map[string]string{"type": "ping", "nonce": nonce}); err != nil {
			t.Fatal(err)
		}
		var pong map[string]string
		if err = probe.ReadJSON(&pong); err != nil || pong["type"] != "pong" || pong["nonce"] != nonce {
			t.Fatalf("probe: %v %v", pong, err)
		}
	}
	probe.Close()
	if service.accepts != 0 {
		t.Fatal("a probe reserved a player seat")
	}
	if c, response, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{"https://lookalike.example"}}); err == nil {
		c.Close()
		t.Fatal("bad origin accepted")
	} else if response == nil || response.StatusCode != 403 {
		t.Fatal("bad origin not rejected")
	}
	connect := func() *websocket.Conn {
		c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		c.SetReadDeadline(time.Now().Add(6 * time.Second))
		ticket := remote.ticket(admission{Player: identity.PlayerID, Session: session, PlayerSession: "ps-test", Expires: time.Now().Add(time.Minute).Unix()})
		if err = c.WriteJSON(map[string]any{"type": "hello", "version": 3, "token": ticket}); err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err = c.ReadJSON(&m); err != nil || (m["type"] != "welcome" || m["version"] != float64(3)) {
			t.Fatalf("welcome: %v %v", m, err)
		}
		c.WriteJSON(map[string]any{"type": "join", "lobbyId": session, "name": "Alice", "faction": "british"})
		for {
			if err = c.ReadJSON(&m); err != nil {
				t.Fatal(err)
			}
			if m["type"] == "joined" {
				break
			}
		}
		return c
	}
	c := connect()
	c.SetPingHandler(func(s string) error {
		time.Sleep(80 * time.Millisecond)
		return c.WriteControl(websocket.PongMessage, []byte(s), time.Now().Add(time.Second))
	})
	measured := false
	fieldBytes, err := os.ReadFile("../../shared/actor-fields.json")
	if err != nil {
		t.Fatal(err)
	}
	var fields []string
	if err = json.Unmarshal(fieldBytes, &fields); err != nil {
		t.Fatal(err)
	}
	nameIndex, pingIndex := -1, -1
	for i, field := range fields {
		if field == "name" {
			nameIndex = i
		}
		if field == "ping" {
			pingIndex = i
		}
	}
	if nameIndex < 0 || pingIndex < 0 {
		t.Fatal("missing actor fields")
	}
	for !measured {
		kind, data, err := c.ReadMessage()
		if err != nil {
			t.Fatal("no end-to-end heartbeat: ", err)
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		var snapshot []msgpack.RawMessage
		if err := msgpack.Unmarshal(data, &snapshot); err != nil || len(snapshot) != 11 {
			t.Fatalf("invalid binary snapshot: %v", err)
		}
		var version, messageKind uint64
		if msgpack.Unmarshal(snapshot[0], &version) != nil || msgpack.Unmarshal(snapshot[1], &messageKind) != nil || version != 3 || messageKind != 1 {
			t.Fatal("unexpected snapshot protocol")
		}
		var actors [][]msgpack.RawMessage
		if err := msgpack.Unmarshal(snapshot[10], &actors); err != nil {
			t.Fatal(err)
		}
		for _, actor := range actors {
			if len(actor) != len(fields) {
				t.Fatal("invalid actor tuple")
			}
			var name string
			// A nil MessagePack value becomes an empty RawMessage slice.
			if len(actor[pingIndex]) == 0 {
				continue
			}
			var ping *uint16
			nameErr := msgpack.Unmarshal(actor[nameIndex], &name)
			pingErr := msgpack.Unmarshal(actor[pingIndex], &ping)
			if nameErr != nil || pingErr != nil {
				t.Fatalf("invalid actor metadata: name=%v ping=%v raw=%x", nameErr, pingErr, actor[pingIndex])
			}
			if name == "Alice" && ping != nil && *ping >= 70 {
				measured = true
			}
		}
	}
	c.Close()
	time.Sleep(30 * time.Millisecond)
	reconnected := connect()
	time.Sleep(200 * time.Millisecond)
	if service.removed() != 0 {
		t.Fatal("old disconnect released a reconnected player")
	}
	reconnected.WriteJSON(map[string]string{"type": "leave"})
	reconnected.Close()
	for i := 0; i < 100 && service.removed() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if service.removed() != 1 {
		t.Fatal("explicit leave did not free GameLift seat")
	}
	ingest := httptest.NewServer(http.HandlerFunc(central.ingest))
	defer ingest.Close()
	remote.cfg.API = ingest.URL
	cursor, err := remote.replicate(ctx, 0)
	if err != nil || cursor < 1 {
		t.Fatalf("replicate: %d %v", cursor, err)
	}
	if _, err = remote.replicate(ctx, 0); err != nil {
		t.Fatal("duplicate batch:", err)
	}
	var verified struct {
		PlayerID string `json:"playerId"`
	}
	if err = central.localCall(ctx, map[string]string{"op": "authenticate", "token": identity.Token}, &verified); err != nil || verified.PlayerID != identity.PlayerID {
		t.Fatal("central identity lost")
	}
	t.Log(fmt.Sprintf("real Rust/Go: end-to-end RTT, reconnect, release, replication through event %d", cursor))
}
