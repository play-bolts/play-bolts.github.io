package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/request"
	sdk "github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
	"github.com/gorilla/websocket"
)

type sessionService interface {
	player(string) (model.PlayerSession, error)
	accept(string) error
	remove(string) error
}
type managedSessions struct{}

func (managedSessions) player(id string) (model.PlayerSession, error) {
	q := request.NewDescribePlayerSessions()
	q.PlayerSessionID = id
	result, err := sdk.DescribePlayerSessions(q)
	if err != nil {
		return model.PlayerSession{}, err
	}
	if len(result.PlayerSessions) != 1 {
		return model.PlayerSession{}, errors.New("unknown player session")
	}
	return result.PlayerSessions[0], nil
}
func (managedSessions) accept(id string) error { return sdk.AcceptPlayerSession(id) }
func (managedSessions) remove(id string) error { return sdk.RemovePlayerSession(id) }

type lease struct {
	conn  *websocket.Conn
	token string
	timer *time.Timer
}
type gameHost struct {
	r        *runtime
	sdk      sessionService
	mu       sync.Mutex
	session  string
	leases   map[string]*lease
	slots    chan struct{}
	limits   rateLimits
	stopping atomic.Bool
	grace    time.Duration
}

func newGame(r *runtime, service sessionService) *gameHost {
	return &gameHost{r: r, sdk: service, leases: map[string]*lease{}, slots: make(chan struct{}, 128), grace: 30 * time.Second}
}
func (g *gameHost) sessionID() string { g.mu.Lock(); defer g.mu.Unlock(); return g.session }
func (g *gameHost) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ping", g.probe)
	mux.HandleFunc("GET /api/ws", g.connect)
	return g.r.cors(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if g.stopping.Load() {
			problem(w, 503, "Server is closing.")
			return
		}
		if !g.limits.allow(clientIP(q, false), 90, time.Minute) {
			problem(w, 429, "Too many connections.")
			return
		}
		select {
		case g.slots <- struct{}{}:
			defer func() { <-g.slots }()
		default:
			problem(w, 503, "Server busy.")
			return
		}
		mux.ServeHTTP(w, q)
	}))
}
func (g *gameHost) upgrade(w http.ResponseWriter, q *http.Request) (*websocket.Conn, error) {
	u := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: g.r.originOK}
	return u.Upgrade(w, q, nil)
}

// Probes are read-only: no account, seat, game session or capacity is created.
func (g *gameHost) probe(w http.ResponseWriter, q *http.Request) {
	c, err := g.upgrade(w, q)
	if err != nil {
		return
	}
	defer c.Close()
	c.SetReadLimit(256)
	_ = c.SetReadDeadline(time.Now().Add(4 * time.Second))
	for i := 0; i < 3; i++ {
		var p struct {
			Type  string `json:"type"`
			Nonce string `json:"nonce"`
		}
		if c.ReadJSON(&p) != nil || p.Type != "ping" || len(p.Nonce) > 100 {
			return
		}
		_ = c.SetWriteDeadline(time.Now().Add(time.Second))
		if c.WriteJSON(map[string]string{"type": "pong", "nonce": p.Nonce}) != nil {
			return
		}
	}
}
func (g *gameHost) acquire(a admission, c *websocket.Conn) (*lease, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping.Load() {
		return nil, errors.New("server closing")
	}
	p, err := g.sdk.player(a.PlayerSession)
	if err != nil {
		return nil, err
	}
	if p.PlayerID != a.Player || p.GameSessionID != a.Session || p.PlayerSessionID != a.PlayerSession || p.Status == nil {
		return nil, errors.New("wrong player session")
	}
	l := g.leases[a.PlayerSession]
	switch p.GetStatus() {
	case model.PlayerReserved:
		if err = g.sdk.accept(a.PlayerSession); err != nil {
			return nil, err
		}
	case model.PlayerActive:
		if l == nil {
			return nil, errors.New("unrecognized active session")
		}
	default:
		return nil, errors.New("closed player session")
	}
	if l == nil {
		l = &lease{token: randomToken()}
		g.leases[a.PlayerSession] = l
	}
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
	if l.conn != nil {
		// Match the Rust server's terminal replacement code; another browser tab
		// must not keep reconnecting and take the seat back.
		_ = l.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "replaced"), time.Now().Add(time.Second))
		l.conn.Close()
	}
	l.conn = c
	return l, nil
}
func (g *gameHost) release(id string, l *lease, c *websocket.Conn, immediate bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.leases[id] != l || l.conn != c {
		return
	}
	l.conn = nil
	remove := func() {
		if g.leases[id] != l || l.conn != nil {
			return
		}
		if err := g.sdk.remove(id); err != nil {
			log.Printf("seat release failed: %v", err)
			// A transient SDK failure must not permanently consume one of six seats.
			l.timer = time.AfterFunc(5*time.Second, func() { g.mu.Lock(); defer g.mu.Unlock(); g.expire(id, l) })
			return
		}
		delete(g.leases, id)
	}
	if immediate {
		remove()
	} else {
		l.timer = time.AfterFunc(g.grace, func() { g.mu.Lock(); defer g.mu.Unlock(); g.expire(id, l) })
	}
}
func (g *gameHost) expire(id string, l *lease) {
	if g.leases[id] != l || l.conn != nil || g.stopping.Load() {
		return
	}
	if err := g.sdk.remove(id); err != nil {
		log.Printf("seat release failed: %v", err)
		l.timer = time.AfterFunc(5*time.Second, func() { g.mu.Lock(); defer g.mu.Unlock(); g.expire(id, l) })
		return
	}
	delete(g.leases, id)
}
func (g *gameHost) connect(w http.ResponseWriter, q *http.Request) {
	session := g.sessionID()
	if session == "" {
		problem(w, 503, "Game is starting.")
		return
	}
	c, err := g.upgrade(w, q)
	if err != nil {
		return
	}
	defer c.Close()
	c.SetReadLimit(4096)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var hello struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		Token   string `json:"token"`
	}
	if c.ReadJSON(&hello) != nil || hello.Type != "hello" || hello.Version != 1 {
		return
	}
	a, err := g.r.verify(hello.Token, session)
	if err != nil {
		_ = c.WriteJSON(map[string]string{"type": "error", "code": "admission_expired", "message": "Game reservation expired. Please reconnect."})
		return
	}
	l, err := g.acquire(a, c)
	if err != nil {
		_ = c.WriteJSON(map[string]string{"type": "error", "code": "admission_failed", "message": "Unable to enter this game. Please reconnect."})
		return
	}
	var left atomic.Bool
	defer func() { g.release(a.PlayerSession, l, c, left.Load()) }()
	if err = g.r.localCall(q.Context(), map[string]string{"op": "identity", "playerId": a.Player, "token": l.token}, nil); err != nil {
		left.Store(true)
		return
	}
	headers := http.Header{"X-Forwarded-For": []string{clientIP(q, false)}, "User-Agent": []string{q.UserAgent()}}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	local, _, err := dialer.DialContext(q.Context(), strings.Replace(g.r.local, "http:", "ws:", 1)+"/api/ws", headers)
	if err != nil {
		left.Store(true)
		return
	}
	defer local.Close()
	local.SetReadLimit(1 << 20)
	_ = local.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if local.WriteJSON(map[string]any{"type": "hello", "version": 1, "token": l.token}) != nil {
		left.Store(true)
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	bridgeControls(c, local)
	bridgeControls(local, c)
	done := make(chan struct{}, 2)
	go func() { pump(local, c, &left); done <- struct{}{} }()
	go func() { pump(c, local, nil); done <- struct{}{} }()
	<-done
	c.Close()
	local.Close()
	<-done
}

// Forward control frames too. Otherwise Gorilla answers Rust's heartbeat on
// localhost and everyone's scoreboard incorrectly reports a near-zero RTT.
func bridgeControls(source, destination *websocket.Conn) {
	source.SetPingHandler(func(s string) error {
		return destination.WriteControl(websocket.PingMessage, []byte(s), time.Now().Add(5*time.Second))
	})
	source.SetPongHandler(func(s string) error {
		return destination.WriteControl(websocket.PongMessage, []byte(s), time.Now().Add(5*time.Second))
	})
	source.SetCloseHandler(func(code int, text string) error {
		return destination.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(time.Second))
	})
}
func pump(destination, source *websocket.Conn, left *atomic.Bool) {
	for {
		kind, data, err := source.ReadMessage()
		if err != nil {
			return
		}
		if left != nil && kind == websocket.TextMessage {
			var m struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(data, &m) == nil && m.Type == "leave" {
				left.Store(true)
			}
		}
		_ = destination.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if destination.WriteMessage(kind, data) != nil {
			return
		}
	}
}
func (r *runtime) replicate(ctx context.Context, after int64) (int64, error) {
	var batch json.RawMessage
	if err := r.localCall(ctx, map[string]any{"op": "export", "after": after}, &batch); err != nil {
		return after, err
	}
	var cursor struct {
		Through int64 `json:"through"`
	}
	if err := json.Unmarshal(batch, &cursor); err != nil {
		return after, err
	}
	q, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(r.cfg.API, "/")+"/api/cluster/replicate", bytes.NewReader(batch))
	if err != nil {
		return after, err
	}
	stamp := strconv.FormatInt(time.Now().Unix(), 10)
	q.Header.Set("Content-Type", "application/json")
	q.Header.Set("X-Bolts-Time", stamp)
	q.Header.Set("X-Bolts-Signature", sign(r.secret, append([]byte("replicate:"+stamp+":"), batch...)))
	response, err := r.http.Do(q)
	if err != nil {
		return after, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != 200 {
		return after, fmt.Errorf("replication: HTTP %d", response.StatusCode)
	}
	return cursor.Through, nil
}
func (r *runtime) runGame(parent context.Context, port int, dataPath string) error {
	ctx, stop := context.WithCancel(parent)
	defer stop()
	g := newGame(r, managedSessions{})
	certificate, err := sdk.GetComputeCertificate()
	if err != nil {
		return err
	}
	pem, err := os.ReadFile(filepath.Join(certificate.CertificatePath, "certificate.pem"))
	if err != nil {
		return err
	}
	chain, err := os.ReadFile(filepath.Join(certificate.CertificatePath, "certificateChain.pem"))
	if err != nil {
		return err
	}
	key, err := os.ReadFile(filepath.Join(certificate.CertificatePath, "privateKey.pem"))
	if err != nil {
		return err
	}
	cert, err := tls.X509KeyPair(append(append(pem, '\n'), chain...), key)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return err
	}
	server := &http.Server{Handler: g.handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}}
	result := make(chan error, 1)
	go func() { result <- server.Serve(tls.NewListener(listener, server.TLSConfig)); stop() }()
	defer server.Close()
	err = sdk.ProcessReady(sdk.ProcessParameters{
		Port: port, LogParameters: sdk.LogParameters{LogPaths: []string{filepath.Dir(dataPath)}},
		OnStartGameSession: func(s model.GameSession) {
			if g.stopping.Load() {
				return
			}
			if e := r.localCall(ctx, map[string]string{"op": "activate", "session": s.GameSessionID, "name": s.Name}, nil); e != nil {
				log.Printf("activation failed: %v", e)
				stop()
				return
			}
			g.mu.Lock()
			g.session = s.GameSessionID
			g.mu.Unlock()
			if e := sdk.ActivateGameSession(); e != nil {
				log.Printf("GameLift activation failed: %v", e)
				stop()
			}
		}, OnUpdateGameSession: func(model.UpdateGameSession) {}, OnProcessTerminate: stop,
		OnHealthCheck: func() bool {
			var status struct {
				OK bool `json:"ok"`
			}
			return !g.stopping.Load() && r.localCall(ctx, map[string]string{"op": "status"}, &status) == nil && status.OK
		},
	})
	if err != nil {
		return err
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	var cursor int64
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-ticker.C:
			if g.sessionID() == "" {
				continue
			}
			var status struct {
				Active bool `json:"active"`
				OK     bool `json:"ok"`
			}
			if r.localCall(ctx, map[string]string{"op": "status"}, &status) != nil || !status.OK {
				stop()
				continue
			}
			if !status.Active {
				stop()
				continue
			}
			// This runs outside the simulation tick. Retrying the same events is safe.
			next, e := r.replicate(ctx, cursor)
			if e != nil {
				log.Printf("replication deferred: %v", e)
			} else {
				cursor = next
			}
		}
	}
	g.stopping.Store(true)
	_ = server.Close()
	g.mu.Lock()
	for _, l := range g.leases {
		if l.timer != nil {
			l.timer.Stop()
		}
		if l.conn != nil {
			l.conn.Close()
		}
	}
	g.mu.Unlock()
	final, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if g.sessionID() != "" {
		if e := r.localCall(final, map[string]string{"op": "shutdown"}, nil); e != nil {
			log.Printf("finalization failed: %v", e)
		}
		// GameLift retains this credential-free replay file alongside the SQLite
		// checkpoint if the directory was unreachable during termination.
		var batch json.RawMessage
		if e := r.localCall(final, map[string]any{"op": "export", "after": 0}, &batch); e == nil {
			if e = os.WriteFile(filepath.Join(filepath.Dir(dataPath), "final-replication.json"), batch, 0600); e != nil {
				log.Printf("recovery export failed: %v", e)
			}
		}
		if _, e := r.replicate(final, cursor); e != nil {
			log.Printf("final replication failed; recover from GameLift session logs: %v", e)
		}
	}
	ending := sdk.ProcessEnding()
	if ending != nil {
		return ending
	}
	select {
	case e := <-result:
		if !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	default:
	}
	return nil
}
