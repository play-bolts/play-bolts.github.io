package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/gamelift"
	"github.com/aws/aws-sdk-go-v2/service/gamelift/types"
	"github.com/gorilla/websocket"
)

type discoveryFleet struct {
	*fakeFleet
	describe func(context.Context, *gamelift.DescribeGameSessionsInput) (*gamelift.DescribeGameSessionsOutput, error)
}

func (f *discoveryFleet) DescribeGameSessions(ctx context.Context, q *gamelift.DescribeGameSessionsInput, _ ...func(*gamelift.Options)) (*gamelift.DescribeGameSessionsOutput, error) {
	return f.describe(ctx, q)
}

func TestDirectoryQueriesLocationsConcurrently(t *testing.T) {
	d := directoryForTest(t, &fakeFleet{})
	started := make(chan string, len(d.r.cfg.Locations))
	release := make(chan struct{})
	d.api = &discoveryFleet{describe: func(ctx context.Context, q *gamelift.DescribeGameSessionsInput) (*gamelift.DescribeGameSessionsOutput, error) {
		started <- *q.Location
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return &gamelift.DescribeGameSessionsOutput{}, nil
		}
	}}
	done := make(chan error, 1)
	go func() { _, err := d.catalog(context.Background(), true); done <- err }()
	allStarted := true
	for range d.r.cfg.Locations {
		select {
		case <-started:
		case <-time.After(time.Second):
			allStarted = false
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !allStarted {
		t.Fatal("regional requests waited for another region to finish")
	}
}

func TestCancelledDiscoveryDoesNotReplaceSharedCatalog(t *testing.T) {
	api := &fakeFleet{games: map[string][]types.GameSession{"eu-west-2": {londonGame("existing", 1)}}}
	d := directoryForTest(t, api)
	if _, err := d.catalog(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	updated := d.updated
	ctx, cancel := context.WithCancel(context.Background())
	d.api = &discoveryFleet{describe: func(ctx context.Context, q *gamelift.DescribeGameSessionsInput) (*gamelift.DescribeGameSessionsOutput, error) {
		cancel()
		return nil, ctx.Err()
	}}
	if _, err := d.catalog(ctx, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled refresh succeeded: %v", err)
	}
	if !d.updated.Equal(updated) || len(d.rows) != 1 || d.rows[0].ID != "existing" || len(d.games) != 1 || len(d.available) != 3 {
		t.Fatalf("cancelled request changed shared discovery: %+v", d)
	}
}

func TestUnavailableQueuesFailBeforeStartingOrPollingPlacement(t *testing.T) {
	for _, loc := range testRuntime().cfg.Locations {
		t.Run(loc.ID, func(t *testing.T) {
			for _, pending := range []bool{false, true} {
				api := &fakeFleet{queues: map[string]types.GameSessionQueue{loc.Queue: {Name: &loc.Queue}}}
				d := directoryForTest(t, api)
				if pending {
					d.pending[loc.ID] = "existing-placement"
					api.placement = &types.GameSessionPlacement{Status: types.GameSessionPlacementStatePending}
				}
				w := joinForTest(d, "new:"+loc.ID, "a")
				if w.Code != 503 || !strings.Contains(w.Body.String(), "currently offline") || api.starts != 0 || api.creates != 0 || api.queueReads != 1 {
					t.Fatalf("disabled queue (pending=%t): %d %s starts=%d seats=%d", pending, w.Code, w.Body.String(), api.starts, api.creates)
				}
				if !pending && len(d.pending) != 0 {
					t.Fatal("offline queue created a pending placement")
				}
				// A transient queue outage never removes the configured city.
				listed := httptest.NewRecorder()
				d.list(listed, httptest.NewRequest("GET", "/api/lobbies", nil))
				if !strings.Contains(listed.Body.String(), `"locations":["lon","sg","sp"]`) {
					t.Fatalf("offline queue removed the city: %s", listed.Body.String())
				}
			}
		})
	}
}

func TestQueueValidationRejectsMissingWrongFleetAndExcludedLocations(t *testing.T) {
	for name, queues := range map[string]map[string]types.GameSessionQueue{
		"missing":           {},
		"wrong fleet":       {"lon-queue": {Name: aws.String("lon-queue"), Destinations: []types.GameSessionQueueDestination{{DestinationArn: aws.String("arn:aws:gamelift:us-east-1:123456789012:fleet/fleet-other")}}}},
		"excluded location": {"lon-queue": {Name: aws.String("lon-queue"), Destinations: []types.GameSessionQueueDestination{{DestinationArn: aws.String("arn:aws:gamelift:us-east-1:123456789012:fleet/fleet-test")}}, FilterConfiguration: &types.FilterConfiguration{AllowedLocations: []string{"ap-southeast-1"}}}},
	} {
		t.Run(name, func(t *testing.T) {
			api := &fakeFleet{queues: queues}
			d := directoryForTest(t, api)
			if w := joinForTest(d, "new:lon", "a"); w.Code != 503 || api.starts != 0 {
				t.Fatalf("unusable queue accepted: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestQueueLookupFailureIsRetryableAndDoesNotAllocate(t *testing.T) {
	api := &fakeFleet{queueErr: errors.New("temporarily unavailable")}
	d := directoryForTest(t, api)
	if w := joinForTest(d, "new:lon", "a"); w.Code != 503 || api.starts != 0 || len(d.pending) != 0 {
		t.Fatalf("queue failure allocated: %d %s", w.Code, w.Body.String())
	}
	api.queueErr = nil
	if w := joinForTest(d, "new:lon", "a"); w.Code != 202 || api.starts != 1 {
		t.Fatalf("queue did not recover: %d %s", w.Code, w.Body.String())
	}
}

func TestExistingRegionalGamesRemainJoinableWhenQueueDisabled(t *testing.T) {
	for _, loc := range testRuntime().cfg.Locations {
		t.Run(loc.ID, func(t *testing.T) {
			game := londonGame("game-"+loc.ID, 0)
			game.Location = &loc.AWS
			game.DnsName = aws.String(loc.ID + ".amazongamelift.com")
			api := &fakeFleet{games: map[string][]types.GameSession{loc.AWS: {game}}, queues: map[string]types.GameSessionQueue{}}
			d := directoryForTest(t, api)
			if w := joinForTest(d, "new:"+loc.ID, "a"); w.Code != 200 || !strings.Contains(w.Body.String(), `"lobbyId":"game-`+loc.ID+`"`) || api.creates != 1 || api.starts != 0 || api.queueReads != 0 {
				t.Fatalf("active regional room could not admit: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestRealRustDirectoryAdmissionEachManagedLocation(t *testing.T) {
	central := startRust(t)
	response, err := central.http.Post(central.local+"/api/session", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	var identity struct{ PlayerID, Token string }
	err = json.NewDecoder(response.Body).Decode(&identity)
	response.Body.Close()
	if err != nil || identity.PlayerID == "" || identity.Token == "" {
		t.Fatalf("central identity: %+v %v", identity, err)
	}
	for _, loc := range central.cfg.Locations {
		t.Run(loc.ID, func(t *testing.T) {
			remote := startRust(t)
			id := fmt.Sprintf("arn:aws:gamelift:us-east-1:123456789012:gamesession/fleet-test/%s/session-test", loc.AWS)
			if err := remote.localCall(context.Background(), map[string]string{"op": "activate", "session": id, "name": loc.Name}, nil); err != nil {
				t.Fatal(err)
			}
			game := londonGame(id, 0)
			game.Location, game.DnsName = &loc.AWS, aws.String(loc.ID+".amazongamelift.com")
			api := &fakeFleet{games: map[string][]types.GameSession{loc.AWS: {game}}}
			d := &directory{r: central, api: api, pending: map[string]string{}, pendingFile: filepath.Join(t.TempDir(), "placements.json")}
			w := httptest.NewRecorder()
			q := httptest.NewRequest("POST", "/api/join", strings.NewReader(`{"token":"`+identity.Token+`","lobbyId":"new:`+loc.ID+`"}`))
			d.join(w, q)
			var reservation struct{ LobbyID, WebsocketURL, Ticket string }
			if err := json.Unmarshal(w.Body.Bytes(), &reservation); err != nil || w.Code != 200 || reservation.LobbyID != id || reservation.WebsocketURL != "wss://"+loc.ID+".amazongamelift.com:8080/api/ws" {
				t.Fatalf("regional reservation: %d %s %v", w.Code, w.Body.String(), err)
			}
			seat := api.seats[id][0]
			service := &fakeSessions{p: model.PlayerSession{PlayerID: identity.PlayerID, GameSessionID: id, PlayerSessionID: aws.ToString(seat.PlayerSessionId)}.WithStatus(model.PlayerReserved)}
			g := newGame(remote, service)
			g.session = id
			host := httptest.NewServer(g.handler())
			defer host.Close()
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(host.URL, "http")+"/api/ws", http.Header{"Origin": []string{central.cfg.Origins[0]}})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			ws.SetReadDeadline(time.Now().Add(5 * time.Second))
			if err := ws.WriteJSON(map[string]any{"type": "hello", "version": 3, "token": reservation.Ticket}); err != nil {
				t.Fatal(err)
			}
			var message map[string]any
			if err := ws.ReadJSON(&message); err != nil || message["type"] != "welcome" || message["playerId"] != identity.PlayerID {
				t.Fatalf("regional welcome: %+v %v", message, err)
			}
			if err := ws.WriteJSON(map[string]any{"type": "join", "lobbyId": reservation.LobbyID, "name": "Regional Tester", "faction": "british"}); err != nil {
				t.Fatal(err)
			}
			for {
				if err := ws.ReadJSON(&message); err != nil {
					t.Fatal(err)
				}
				if message["type"] == "joined" {
					if message["lobbyId"] != id || message["lobbyName"] != loc.Name {
						t.Fatalf("wrong regional lobby joined: %+v", message)
					}
					break
				}
			}
			ws.WriteJSON(map[string]string{"type": "leave"})
			t.Logf("%s: central identity, regional reservation, managed websocket, and lobby joined", loc.Name)
		})
	}
}
