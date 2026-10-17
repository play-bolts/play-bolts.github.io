package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	sdk "github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
	"github.com/aws/aws-sdk-go-v2/aws"
)

type fakeProcessService struct {
	mu         sync.Mutex
	parameters sdk.ProcessParameters
	calls      []string
	fail       string
	registered bool
	activating chan struct{}
	finish     chan struct{}
}

func (f *fakeProcessService) step(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	if name == f.fail {
		return errors.New("injected " + name + " failure")
	}
	if name == "ready" {
		f.registered = true
	} else if !f.registered {
		return errors.New("ProcessNotReady")
	}
	return nil
}
func (f *fakeProcessService) ready(p sdk.ProcessParameters) error {
	f.parameters = p
	return f.step("ready")
}
func (f *fakeProcessService) credentials(string) (aws.Credentials, error) {
	return aws.Credentials{AccessKeyID: "test", SecretAccessKey: "test", SessionToken: "test"}, f.step("credentials")
}
func (f *fakeProcessService) certificate() (tls.Certificate, error) {
	return tls.Certificate{}, f.step("certificate")
}
func (f *fakeProcessService) activate() error {
	if err := f.step("activate"); err != nil {
		return err
	}
	if f.activating != nil {
		close(f.activating)
		<-f.finish
	}
	return nil
}
func (f *fakeProcessService) ending() error { return f.step("ending") }
func (f *fakeProcessService) trace() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func TestManagedStartupOrdersSDKAndGatesEarlyAssignments(t *testing.T) {
	r := testRuntime()
	var requests, activations atomic.Int32
	var backendHealthy atomic.Bool
	backendHealthy.Store(true)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		requests.Add(1)
		if q.Header.Get("X-Bolts-Internal") != r.internal {
			t.Error("missing private bridge credential")
		}
		var body map[string]string
		if json.NewDecoder(q.Body).Decode(&body) != nil {
			t.Error("invalid bridge request")
		}
		if body["op"] == "activate" {
			if body["session"] != "session-test" || body["name"] != "Rommel Alpha" {
				t.Error("assignment changed")
			}
			activations.Add(1)
		}
		respond(w, 200, map[string]bool{"ok": backendHealthy.Load()})
	}))
	defer backend.Close()
	r.local = backend.URL
	ctx, stop := context.WithCancel(context.Background())
	fake := &fakeProcessService{}
	p := newGameProcess(ctx, stop, r, fake)
	defer p.close()
	if _, err := p.start(8081, "/game/logs/session/bolts.sqlite"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate"}) {
		t.Fatalf("SDK startup ordering: %v", fake.trace())
	}
	if fake.parameters.Port != 8081 || !reflect.DeepEqual(fake.parameters.LogParameters.LogPaths, []string{"/game/logs/session"}) {
		t.Fatal("registration lost port or private log directory")
	}
	if fake.parameters.OnHealthCheck() || requests.Load() != 0 {
		t.Fatal("health accessed an uninitialized backend")
	}
	done := make(chan struct{})
	go func() {
		fake.parameters.OnStartGameSession(model.GameSession{GameSessionID: "session-test", Name: "Rommel Alpha"})
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("early assignment completed before application readiness")
	case <-time.After(30 * time.Millisecond):
	}
	if requests.Load() != 0 || p.g.sessionID() != "" {
		t.Fatal("early assignment reached Rust or changed the session")
	}
	p.listenerReady()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ready application did not release the queued assignment")
	}
	if activations.Load() != 1 || p.g.sessionID() != "session-test" || !fake.parameters.OnHealthCheck() {
		t.Fatal("healthy initialized process did not activate exactly once")
	}
	backendHealthy.Store(false)
	if fake.parameters.OnHealthCheck() {
		t.Fatal("unhealthy Rust backend was advertised as healthy")
	}
	p.close()
	p.close()
	if fake.parameters.OnHealthCheck() || !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate", "activate", "ending"}) {
		t.Fatalf("shutdown must end exactly once and stop health: %v", fake.trace())
	}
}

func TestManagedStartupFailureEndsRegisteredProcess(t *testing.T) {
	for _, stage := range []string{"ready", "credentials", "certificate"} {
		t.Run(stage, func(t *testing.T) {
			ctx, stop := context.WithCancel(context.Background())
			fake := &fakeProcessService{fail: stage}
			p := newGameProcess(ctx, stop, testRuntime(), fake)
			_, err := p.start(8080, "/game/session/bolts.sqlite")
			p.close()
			if err == nil || !strings.Contains(err.Error(), "injected "+stage+" failure") || ctx.Err() == nil {
				t.Fatalf("startup failure not reported/cancelled: %v", err)
			}
			want := []string{"ready"}
			if stage != "ready" {
				want = append(want, "credentials")
				if stage == "certificate" {
					want = append(want, "certificate")
				}
				want = append(want, "ending")
			}
			if !reflect.DeepEqual(fake.trace(), want) {
				t.Fatalf("failed startup made unexpected calls: %v, want %v", fake.trace(), want)
			}
		})
	}
}

func TestManagedTerminationReleasesQueuedStartupAssignment(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	fake := &fakeProcessService{}
	p := newGameProcess(ctx, stop, testRuntime(), fake)
	if _, err := p.start(8080, "/game/session/bolts.sqlite"); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		fake.parameters.OnStartGameSession(model.GameSession{GameSessionID: "too-early"})
		close(done)
	}()
	fake.parameters.OnProcessTerminate()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("termination left an assignment callback blocked")
	}
	p.close()
	if p.g.sessionID() != "" || fake.parameters.OnHealthCheck() || !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate", "ending"}) {
		t.Fatalf("terminated startup must never activate: %v", fake.trace())
	}
}

type startupTransport func(*http.Request) (*http.Response, error)

func (f startupTransport) RoundTrip(q *http.Request) (*http.Response, error) { return f(q) }

type cancellingBody struct{ cancel context.CancelFunc }

func (b cancellingBody) Read([]byte) (int, error) { b.cancel(); return 0, io.EOF }
func (cancellingBody) Close() error               { return nil }

func TestManagedTerminationDuringRustActivationDoesNotActivateSDK(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	r := testRuntime()
	r.local = "http://unused.invalid"
	// The Rust response succeeds, but termination arrives as its body finishes.
	// This deterministically exercises the post-response cancellation guard.
	r.http = &http.Client{Transport: startupTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: cancellingBody{stop}}, nil
	})}
	fake := &fakeProcessService{}
	p := newGameProcess(ctx, stop, r, fake)
	if _, err := p.start(8080, "/game/session/bolts.sqlite"); err != nil {
		t.Fatal(err)
	}
	p.listenerReady()
	fake.parameters.OnStartGameSession(model.GameSession{GameSessionID: "cancelled"})
	p.close()
	if p.g.sessionID() != "" || !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate", "ending"}) {
		t.Fatalf("termination allowed a late SDK activation: %v", fake.trace())
	}
}

func TestManagedEndingWaitsForInFlightSDKActivation(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	r := testRuntime()
	r.local = "http://unused.invalid"
	r.http = &http.Client{Transport: startupTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	fake := &fakeProcessService{activating: make(chan struct{}), finish: make(chan struct{})}
	p := newGameProcess(ctx, stop, r, fake)
	if _, err := p.start(8080, "/game/session/bolts.sqlite"); err != nil {
		t.Fatal(err)
	}
	p.listenerReady()
	go fake.parameters.OnStartGameSession(model.GameSession{GameSessionID: "starting"})
	select {
	case <-fake.activating:
	case <-time.After(time.Second):
		t.Fatal("SDK activation did not begin")
	}
	done := make(chan struct{})
	go func() { p.close(); close(done) }()
	select {
	case <-done:
		t.Fatal("ProcessEnding raced with an in-flight SDK activation")
	case <-time.After(30 * time.Millisecond):
	}
	close(fake.finish)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ProcessEnding did not follow completed activation")
	}
	if !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate", "activate", "ending"}) {
		t.Fatalf("wrong termination ordering: %v", fake.trace())
	}
}

func TestManagedEndingFailurePropagates(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	fake := &fakeProcessService{fail: "ending"}
	p := newGameProcess(ctx, stop, testRuntime(), fake)
	if _, err := p.start(8080, "/game/session/bolts.sqlite"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := p.close(); err == nil || !strings.Contains(err.Error(), "injected ending failure") {
			t.Fatalf("ProcessEnding failure was hidden: %v", err)
		}
	}
	if !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "certificate", "ending"}) {
		t.Fatalf("ProcessEnding was repeated: %v", fake.trace())
	}
}
