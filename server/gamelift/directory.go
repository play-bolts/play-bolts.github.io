package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/gamelift"
	"github.com/aws/aws-sdk-go-v2/service/gamelift/types"
	"github.com/aws/smithy-go"
)

type gameAPI interface {
	DescribeGameSessions(context.Context, *gamelift.DescribeGameSessionsInput, ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionsOutput, error)
	DescribePlayerSessions(context.Context, *gamelift.DescribePlayerSessionsInput, ...func(*gamelift.Options)) (*gamelift.DescribePlayerSessionsOutput, error)
	CreatePlayerSession(context.Context, *gamelift.CreatePlayerSessionInput, ...func(*gamelift.Options)) (*gamelift.CreatePlayerSessionOutput, error)
	DescribeGameSessionQueues(context.Context, *gamelift.DescribeGameSessionQueuesInput, ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionQueuesOutput, error)
	DescribeGameSessionPlacement(context.Context, *gamelift.DescribeGameSessionPlacementInput, ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionPlacementOutput, error)
	StartGameSessionPlacement(context.Context, *gamelift.StartGameSessionPlacementInput, ...func(*gamelift.Options)) (*gamelift.StartGameSessionPlacementOutput, error)
}

var invalidIdentity = errors.New("invalid identity")
var replicationSlots = make(chan struct{}, 4)

// Match the classic Rust lobby vocabulary. The random placement ID selects a
// stable starting name; active names are skipped, with a suffix after one cycle.
func regionalLobbyName(placementID string, rows []lobby) string {
	generals := [...]string{"Rommel", "Guderian", "Moltke", "Blücher", "Scharnhorst", "Clausewitz"}
	greek := [...]string{"Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega"}
	used := map[string]bool{}
	for _, row := range rows {
		used[row.Name] = true
	}
	digest := sha256.Sum256([]byte(placementID))
	total := len(generals) * len(greek)
	start := (int(digest[0])<<8 | int(digest[1])) % total
	for offset := 0; ; offset++ {
		n := (start + offset) % total
		name := generals[n/len(greek)] + " " + greek[n%len(greek)]
		if offset >= total {
			name += fmt.Sprintf(" %d", offset/total+1)
		}
		if !used[name] {
			return name
		}
	}
}

type lobby struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Location string `json:"location"`
	Players  int32  `json:"players"`
	Capacity int32  `json:"capacity"`
	Phase    string `json:"phase"`
	PingURL  string `json:"pingUrl,omitempty"`
	Managed  bool   `json:"managed"`
}

func (d *directory) legacy(ctx context.Context, path, viewer string, out any) error {
	q, err := http.NewRequestWithContext(ctx, "GET", d.r.local+path, nil)
	if err != nil {
		return err
	}
	if viewer != "" {
		q.Header.Set("X-Forwarded-For", viewer)
	}
	response, err := d.r.http.Do(q)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Oregon service: HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out)
}

type directory struct {
	r           *runtime
	api         gameAPI
	mu          sync.Mutex
	joinMu      sync.Mutex
	updated     time.Time
	games       map[string]types.GameSession
	rows        []lobby
	available   []string
	pending     map[string]string
	pendingFile string
	limits      rateLimits
}

func endpoint(dns string, port int32, path string) (string, error) {
	if port < 1024 || port > 60000 || !strings.HasSuffix(dns, ".amazongamelift.com") || strings.ContainsAny(dns, "/:@?# ") {
		return "", errors.New("invalid GameLift TLS endpoint")
	}
	return (&url.URL{Scheme: "wss", Host: fmt.Sprintf("%s:%d", dns, port), Path: path}).String(), nil
}
func (d *directory) catalog(ctx context.Context, force bool) ([]lobby, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !force && time.Since(d.updated) < 5*time.Second {
		return append([]lobby{}, d.rows...), nil
	}
	rows := []lobby{}
	games := map[string]types.GameSession{}
	// Oregon continues on the existing Rust process and database. These real
	// rooms use its original account admission, while managed rooms use tickets.
	var local struct {
		Lobbies []lobby `json:"lobbies"`
	}
	if err := d.legacy(ctx, "/api/lobbies", "", &local); err != nil {
		return nil, err
	}
	if local.Lobbies == nil {
		return nil, errors.New("invalid Oregon lobby list")
	}
	for _, row := range local.Lobbies {
		if row.ID == "" || strings.HasPrefix(row.ID, "new:") || (row.Capacity != 6 && row.Capacity != 2) || row.Players < 0 || row.Players > row.Capacity {
			return nil, errors.New("invalid Oregon lobby")
		}
		row.Location, row.Managed = "or", false
		row.PingURL = strings.Replace(strings.TrimRight(d.r.cfg.API, "/"), "https:", "wss:", 1) + "/api/ping"
		rows = append(rows, row)
	}
	// Query locations independently: a slow API call must not consume the
	// browser's request budget before the other locations can even be queried.
	type regionalCatalog struct {
		rows    []lobby
		games   map[string]types.GameSession
		healthy bool
	}
	locations := d.r.cfg.Locations
	if !d.r.cfg.ExtraLobbiesEnabled {
		locations = nil
	}
	regions := make([]regionalCatalog, len(locations))
	var refresh sync.WaitGroup
	for i, loc := range locations {
		refresh.Add(1)
		go func() {
			defer refresh.Done()
			region := &regions[i]
			region.games = map[string]types.GameSession{}
			regionCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			var next *string
			for {
				response, err := d.api.DescribeGameSessions(regionCtx, &gamelift.DescribeGameSessionsInput{FleetId: &d.r.cfg.Fleet, Location: &loc.AWS, NextToken: next, Limit: aws.Int32(100)})
				if err != nil {
					log.Printf("directory location %s unavailable: %v", loc.ID, err)
					return
				}
				for _, g := range response.GameSessions {
					if g.Status != types.GameSessionStatusActive && g.Status != types.GameSessionStatusActivating {
						continue
					}
					phase := "playing"
					if g.Status == types.GameSessionStatusActivating {
						phase = "starting"
					}
					ping, _ := endpoint(aws.ToString(g.DnsName), aws.ToInt32(g.Port), "/api/ping")
					id := aws.ToString(g.GameSessionId)
					region.games[id] = g
					region.rows = append(region.rows, lobby{ID: id, Name: aws.ToString(g.Name), Location: loc.ID, Players: aws.ToInt32(g.CurrentPlayerSessionCount), Capacity: 6, Phase: phase, PingURL: ping, Managed: true})
				}
				next = response.NextToken
				if next == nil || *next == "" {
					region.healthy = true
					return
				}
			}
		}()
	}
	refresh.Wait()
	// A disconnected browser must not replace shared discovery with the empty
	// results of its cancelled requests, then cache them for other players.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	available := []string{}
	for i, region := range regions {
		if region.healthy {
			available = append(available, locations[i].ID)
			rows = append(rows, region.rows...)
			for id, game := range region.games {
				games[id] = game
			}
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Location != rows[j].Location {
			return rows[i].Location < rows[j].Location
		}
		if rows[i].Capacity != rows[j].Capacity {
			return rows[i].Capacity > rows[j].Capacity
		}
		return rows[i].Name < rows[j].Name
	})
	d.rows = rows
	d.games = games
	d.available = available
	d.updated = time.Now()
	return append([]lobby{}, rows...), nil
}
func (d *directory) list(w http.ResponseWriter, q *http.Request) {
	rows, err := d.catalog(q.Context(), false)
	if err != nil {
		log.Printf("directory query failed: %v", err)
		problem(w, 503, "Unable to load servers.")
		return
	}
	// Configuration controls the picker. A transient discovery error hides
	// unverified rooms, not whole cities; admission still checks their health.
	locations := []string{}
	if d.r.cfg.ExtraLobbiesEnabled {
		for _, loc := range d.r.cfg.Locations {
			locations = append(locations, loc.ID)
		}
	}
	respond(w, 200, map[string]any{"version": 2, "lobbies": rows, "locations": locations})
}

func (d *directory) placementReady(ctx context.Context, loc location) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	response, err := d.api.DescribeGameSessionQueues(ctx, &gamelift.DescribeGameSessionQueuesInput{Names: []string{loc.Queue}})
	if err != nil {
		return false, err
	}
	for _, queue := range response.GameSessionQueues {
		if aws.ToString(queue.Name) != loc.Queue && aws.ToString(queue.GameSessionQueueArn) != loc.Queue {
			continue
		}
		if filter := queue.FilterConfiguration; filter != nil && len(filter.AllowedLocations) > 0 {
			allowed := false
			for _, region := range filter.AllowedLocations {
				allowed = allowed || region == loc.AWS
			}
			if !allowed {
				return false, nil
			}
		}
		for _, destination := range queue.Destinations {
			arn := aws.ToString(destination.DestinationArn)
			if arn == d.r.cfg.Fleet || strings.HasSuffix(arn, ":fleet/"+d.r.cfg.Fleet) {
				return true, nil
			}
		}
	}
	return false, nil
}

func (d *directory) playerSession(ctx context.Context, id, player string) (*types.PlayerSession, error) {
	var next *string
	for {
		existing, err := d.api.DescribePlayerSessions(ctx, &gamelift.DescribePlayerSessionsInput{GameSessionId: &id, NextToken: next, Limit: aws.Int32(100)})
		if err != nil {
			return nil, err
		}
		for i := range existing.PlayerSessions {
			p := &existing.PlayerSessions[i]
			if aws.ToString(p.PlayerId) == player && (p.Status == types.PlayerSessionStatusActive || p.Status == types.PlayerSessionStatusReserved) {
				return p, nil
			}
		}
		next = existing.NextToken
		if next == nil || *next == "" {
			return nil, nil
		}
	}
}
func unavailableSession(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}
	switch apiError.ErrorCode() {
	case "GameSessionFullException", "InvalidGameSessionStatusException", "NotFoundException":
		return true
	}
	return false
}
func (d *directory) savePending() error {
	data, err := json.Marshal(d.pending)
	if err != nil {
		return err
	}
	if err = os.WriteFile(d.pendingFile+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(d.pendingFile+".tmp", d.pendingFile)
}
func (d *directory) authenticate(ctx context.Context, token string) (string, error) {
	if len(token) != 64 {
		return "", invalidIdentity
	}
	var value struct {
		PlayerID string `json:"playerId"`
	}
	err := d.r.localCall(ctx, map[string]string{"op": "authenticate", "token": token}, &value)
	if err != nil {
		return "", err
	}
	if value.PlayerID == "" {
		return "", invalidIdentity
	}
	return value.PlayerID, nil
}
func (d *directory) join(w http.ResponseWriter, q *http.Request) {
	if !d.r.cfg.ExtraLobbiesEnabled {
		problem(w, 503, "Extra regional lobbies are disabled.")
		return
	}
	if !d.limits.check(w, "join:"+clientIP(q, true), 300, time.Minute, "Too many join requests.") {
		return
	}
	var body struct {
		Token     string `json:"token"`
		LobbyID   string `json:"lobbyId"`
		RequestID string `json:"requestId"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, q.Body, 4096)).Decode(&body) != nil {
		problem(w, 400, "Invalid join request.")
		return
	}
	player, err := d.authenticate(q.Context(), body.Token)
	if err != nil {
		if errors.Is(err, invalidIdentity) {
			problem(w, 401, "Session expired. Please join again.")
		} else {
			problem(w, 503, "Unable to check your session. Please try again.")
		}
		return
	}
	d.joinMu.Lock()
	defer d.joinMu.Unlock()
	rows, err := d.catalog(q.Context(), false)
	if err != nil {
		problem(w, 503, "Unable to load servers.")
		return
	}
	id := body.LobbyID
	completedLocation := ""
	var session *types.PlayerSession
	if strings.HasPrefix(id, "new:") {
		locID := strings.TrimPrefix(id, "new:")
		var loc *location
		for i := range d.r.cfg.Locations {
			if d.r.cfg.Locations[i].ID == locID {
				loc = &d.r.cfg.Locations[i]
			}
		}
		if loc == nil {
			problem(w, 400, "Unknown location.")
			return
		}
		d.mu.Lock()
		available := false
		for _, id := range d.available {
			if id == locID {
				available = true
				break
			}
		}
		d.mu.Unlock()
		if !available {
			problem(w, 503, "This location is temporarily unavailable.")
			return
		}
		// Retry an existing reservation first, including a lobby whose final seat
		// was reserved by this player. Lost responses must not reserve two games.
		candidates := []lobby{}
		for _, row := range rows {
			if row.Location != locID || row.Phase != "playing" {
				continue
			}
			session, err = d.playerSession(q.Context(), row.ID, player)
			if err != nil && !unavailableSession(err) {
				problem(w, 503, "Unable to reserve a seat.")
				return
			}
			if session != nil {
				id = row.ID
				break
			}
			if err == nil && row.Players < row.Capacity {
				candidates = append(candidates, row)
			}
		}
		// Fill the busiest available game first. A stale listing or another
		// arrival taking its final seat must not force a manual refresh.
		sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Players > candidates[j].Players })
		if session == nil {
			for _, row := range candidates {
				created, err := d.api.CreatePlayerSession(q.Context(), &gamelift.CreatePlayerSessionInput{GameSessionId: &row.ID, PlayerId: &player})
				if unavailableSession(err) {
					continue
				}
				if err != nil || created == nil || created.PlayerSession == nil {
					problem(w, 503, "Unable to reserve a seat.")
					return
				}
				id, session = row.ID, created.PlayerSession
				break
			}
		}
		if strings.HasPrefix(id, "new:") {
			for _, row := range rows {
				if row.Location == locID && row.Phase == "starting" && row.Players < row.Capacity {
					respond(w, 202, map[string]string{"status": "starting"})
					return
				}
			}
		}
		if strings.HasPrefix(id, "new:") {
			// Empty queues accept placements that can never succeed, leaving the
			// client polling until the queue's ten-minute timeout. Check before
			// creating a placement or continuing one after hosting is disabled.
			ready, err := d.placementReady(q.Context(), *loc)
			if err != nil {
				log.Printf("directory location %s queue unavailable: %v", locID, err)
				problem(w, 503, "Unable to check regional server availability. Please try again.")
				return
			}
			if !ready {
				problem(w, 503, "Servers in this location are currently offline. Please choose another location.")
				return
			}
			placementID := d.pending[locID]
			if placementID == "" {
				placementID = "bolts-" + randomToken()[:32]
				d.pending[locID] = placementID
				if d.savePending() != nil {
					delete(d.pending, locID)
					problem(w, 503, "Unable to reserve a server.")
					return
				}
			}
			placement, err := d.api.DescribeGameSessionPlacement(q.Context(), &gamelift.DescribeGameSessionPlacementInput{PlacementId: &placementID})
			if err != nil {
				var apiError smithy.APIError
				if !errors.As(err, &apiError) || apiError.ErrorCode() != "NotFoundException" {
					problem(w, 503, "Unable to check server startup.")
					return
				}
				_, err = d.api.StartGameSessionPlacement(q.Context(), &gamelift.StartGameSessionPlacementInput{PlacementId: &placementID, GameSessionQueueName: &loc.Queue, MaximumPlayerSessionCount: aws.Int32(6), GameSessionName: aws.String(regionalLobbyName(placementID, rows)), GameProperties: []types.GameProperty{{Key: aws.String("boltsLocation"), Value: &loc.ID}}})
				if err != nil {
					problem(w, 503, "Unable to start this server.")
					return
				}
				respond(w, 202, map[string]string{"status": "starting"})
				return
			}
			p := placement.GameSessionPlacement
			if p == nil {
				problem(w, 503, "Unable to check server startup.")
				return
			}
			switch p.Status {
			case types.GameSessionPlacementStatePending:
				respond(w, 202, map[string]string{"status": "starting"})
				return
			case types.GameSessionPlacementStateFulfilled:
				id = aws.ToString(p.GameSessionId)
				completedLocation = locID
				// Keep the placement until at least one admission succeeds. A lost HTTP
				// response or gateway restart must not allocate another empty instance.
				_, err = d.catalog(q.Context(), true)
				if err != nil {
					problem(w, 503, "Server is still becoming available.")
					return
				}
				d.mu.Lock()
				placed, exists := d.games[id]
				d.mu.Unlock()
				if !exists || aws.ToInt32(placed.CurrentPlayerSessionCount) >= 6 {
					// The original caller may have cancelled, or a recovered
					// placement may already be full/finished. Do not get stuck
					// returning its ID forever after a directory restart.
					if exists || p.EndTime != nil && time.Since(*p.EndTime) > time.Minute {
						delete(d.pending, locID)
						_ = d.savePending()
					}
					respond(w, 202, map[string]string{"status": "starting"})
					return
				}
			default:
				delete(d.pending, locID)
				_ = d.savePending()
				problem(w, 503, "Server startup timed out. Please try again.")
				return
			}
		}
	}
	d.mu.Lock()
	game, ok := d.games[id]
	d.mu.Unlock()
	if !ok {
		problem(w, 409, "This lobby is no longer available.")
		return
	}
	if game.Status == types.GameSessionStatusActivating {
		respond(w, 202, map[string]string{"status": "starting"})
		return
	}
	if game.Status != types.GameSessionStatusActive {
		problem(w, 409, "This lobby is no longer available.")
		return
	}
	if strings.HasPrefix(body.LobbyID, "new:") {
		for _, loc := range d.r.cfg.Locations {
			if "new:"+loc.ID == body.LobbyID && aws.ToString(game.Location) != loc.AWS {
				problem(w, 503, "Server started in an unexpected location.")
				return
			}
		}
	}
	if session == nil {
		session, err = d.playerSession(q.Context(), id, player)
		if err != nil {
			problem(w, 503, "Unable to reserve a seat.")
			return
		}
	}
	if session == nil {
		created, e := d.api.CreatePlayerSession(q.Context(), &gamelift.CreatePlayerSessionInput{GameSessionId: &id, PlayerId: &player})
		if e != nil {
			if unavailableSession(e) {
				d.mu.Lock()
				d.updated = time.Time{}
				d.mu.Unlock()
				if strings.HasPrefix(body.LobbyID, "new:") {
					if completedLocation != "" {
						delete(d.pending, completedLocation)
						_ = d.savePending()
					}
					respond(w, 202, map[string]string{"status": "starting"})
					return
				}
				problem(w, 409, "Lobby full or unavailable. Choose a location and press Play.")
			} else {
				problem(w, 503, "Unable to reserve a seat.")
			}
			return
		}
		session = created.PlayerSession
	}
	if session == nil {
		problem(w, 503, "Unable to reserve a seat.")
		return
	}
	ws, err := endpoint(aws.ToString(session.DnsName), aws.ToInt32(session.Port), "/api/ws")
	if err != nil {
		problem(w, 503, "Secure server endpoint unavailable.")
		return
	}
	ticket := d.r.ticket(admission{Player: player, Session: id, PlayerSession: aws.ToString(session.PlayerSessionId), Expires: time.Now().Add(5 * time.Minute).Unix()})
	if completedLocation == "" && strings.HasPrefix(body.LobbyID, "new:") {
		locID := strings.TrimPrefix(body.LobbyID, "new:")
		if placementID := d.pending[locID]; placementID != "" {
			// A refreshed directory can expose the fulfilled game before its
			// waiting caller polls the placement. Clear only that game's record.
			placement, err := d.api.DescribeGameSessionPlacement(q.Context(), &gamelift.DescribeGameSessionPlacementInput{PlacementId: &placementID})
			if err == nil && placement.GameSessionPlacement != nil && placement.GameSessionPlacement.Status == types.GameSessionPlacementStateFulfilled && aws.ToString(placement.GameSessionPlacement.GameSessionId) == id {
				completedLocation = locID
			}
		}
	}
	if completedLocation != "" {
		delete(d.pending, completedLocation)
		_ = d.savePending()
	}
	d.mu.Lock()
	d.updated = time.Time{}
	d.mu.Unlock()
	respond(w, 200, map[string]string{"lobbyId": id, "websocketUrl": ws, "ticket": ticket})
}
func (r *runtime) ingest(w http.ResponseWriter, q *http.Request) {
	// Bound memory and concurrent readers on this larger, signed request path.
	select {
	case replicationSlots <- struct{}{}:
		defer func() { <-replicationSlots }()
	default:
		problem(w, 503, "Replication busy.")
		return
	}
	stamp := q.Header.Get("X-Bolts-Time")
	at, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil || time.Now().Unix()-at > 60 || at-time.Now().Unix() > 60 {
		problem(w, 403, "Invalid batch.")
		return
	}
	actual, err := hex.DecodeString(q.Header.Get("X-Bolts-Signature"))
	if err != nil || len(actual) != 32 {
		problem(w, 403, "Invalid batch.")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, q.Body, 16<<20))
	if err != nil {
		problem(w, 413, "Batch too large.")
		return
	}
	expected, _ := hex.DecodeString(sign(r.secret, append([]byte("replicate:"+stamp+":"), data...)))
	if !hmac.Equal(expected, actual) {
		problem(w, 403, "Invalid batch.")
		return
	}
	var batch json.RawMessage = data
	if r.localCall(q.Context(), map[string]any{"op": "import", "batch": batch}, nil) != nil {
		problem(w, 503, "Replication unavailable.")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (d *directory) limitRead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		// Enforce before serving cached results, and isolate each public endpoint
		// so polling one resource cannot consume another resource's allowance.
		if !d.limits.check(w, "read:"+q.URL.Path+":"+clientIP(q, true), 120, time.Minute, "Too many requests. Please try again shortly.") {
			return
		}
		next.ServeHTTP(w, q)
	})
}

func (d *directory) handler() http.Handler {
	r := d.r
	local, _ := url.Parse(r.local)
	proxy := &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.SetURL(local)
		p.Out.Header.Set("X-Forwarded-For", clientIP(p.In, true))
	}, ModifyResponse: func(response *http.Response) error {
		// The public gateway owns CORS. Rust also emits CORS headers, and
		// ReverseProxy appends them to ours, which browsers reject even when
		// both Allow-Origin values are identical. Keep Origin on the upstream
		// request so Rust still validates HTTP and WebSocket callers.
		for key := range response.Header {
			if strings.HasPrefix(strings.ToLower(key), "access-control-") {
				response.Header.Del(key)
			}
		}
		return nil
	}}
	mux := http.NewServeMux()
	mux.Handle("GET /api/lobbies", d.limitRead(http.HandlerFunc(d.list)))
	mux.Handle("GET /api/status", d.limitRead(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		rows, err := d.catalog(q.Context(), false)
		if err != nil {
			problem(w, 503, "Unable to load status.")
			return
		}
		var local struct {
			Online int32 `json:"online"`
		}
		// Rust applies its own per-client status limit. Preserve the trusted
		// viewer here rather than putting every browser in its unknown-IP bucket.
		if d.legacy(q.Context(), "/api/status", clientIP(q, true), &local) != nil {
			problem(w, 503, "Unable to load status.")
			return
		}
		count := local.Online
		for _, row := range rows {
			if row.Managed {
				count += row.Players
			}
		}
		respond(w, 200, map[string]int32{"online": count})
	})))
	mux.HandleFunc("POST /api/join", d.join)
	mux.HandleFunc("POST /api/cluster/replicate", r.ingest)
	mux.Handle("GET /api/health", d.limitRead(proxy))
	for _, route := range []string{"POST /api/session", "GET /api/leaderboard", "POST /api/feedback", "POST /api/visits", "GET /api/ws", "GET /api/ping"} {
		mux.Handle(route, proxy)
	}
	return r.cors(mux)
}
func (r *runtime) runDirectory(ctx context.Context, port int, awscfg aws.Config, dataPath string) error {
	d := &directory{r: r, api: gamelift.NewFromConfig(awscfg), pending: map[string]string{}, pendingFile: filepath.Join(filepath.Dir(dataPath), "gamelift-placements.json")}
	if data, err := os.ReadFile(d.pendingFile); err == nil {
		if err = json.Unmarshal(data, &d.pending); err != nil {
			return err
		}
	}
	httpServer := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: d.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	return httpServer.ListenAndServe()
}
