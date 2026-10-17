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
	mu              sync.Mutex
	parameters      sdk.ProcessParameters
	calls           []string
	fail            string
	registered      bool
	activating      chan struct{}
	finish          chan struct{}
	readyHook       func(sdk.ProcessParameters)
	credentialsHook func()
	ended           chan struct{}
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
	err := f.step("ready")
	if err == nil && f.readyHook != nil {
		f.readyHook(p)
	}
	return err
}
func (f *fakeProcessService) credentials(string) (aws.Credentials, error) {
	err := f.step("credentials")
	if err == nil && f.credentialsHook != nil {
		f.credentialsHook()
	}
	return aws.Credentials{AccessKeyID: "test", SecretAccessKey: "test", SessionToken: "test"}, err
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
func (f *fakeProcessService) ending() error {
	err := f.step("ending")
	if f.ended != nil {
		close(f.ended)
	}
	return err
}
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
	var initialHeartbeat bool
	fake := &fakeProcessService{readyHook: func(parameters sdk.ProcessParameters) {
		// SDK5.6 launches its first heartbeat before ProcessReady returns.
		// Model the service terminating a process that immediately reports false.
		initialHeartbeat = parameters.OnHealthCheck()
		if !initialHeartbeat {
			parameters.OnProcessTerminate()
		}
	}}
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
	if !initialHeartbeat || ctx.Err() != nil || !fake.parameters.OnHealthCheck() || requests.Load() != 0 {
		t.Fatal("bounded startup liveness must survive the immediate heartbeat without accessing Rust")
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

func TestManagedDelayedDependenciesStayLiveAndGateAssignments(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	r := testRuntime()
	var requests atomic.Int32
	r.http = &http.Client{Transport: startupTransport(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})}
	entered, proceed := make(chan struct{}), make(chan struct{})
	fake := &fakeProcessService{credentialsHook: func() { close(entered); <-proceed }}
	p := newGameProcess(ctx, stop, r, fake)
	defer p.close()
	started := make(chan error, 1)
	go func() { _, err := p.start(8080, "/game/session/bolts.sqlite"); started <- err }()
	<-entered
	if !fake.parameters.OnHealthCheck() || requests.Load() != 0 || ctx.Err() != nil {
		t.Fatal("delayed startup dependency was treated as unhealthy or queried Rust")
	}
	assigned := make(chan struct{})
	go func() {
		fake.parameters.OnStartGameSession(model.GameSession{GameSessionID: "queued"})
		close(assigned)
	}()
	select {
	case <-assigned:
		t.Fatal("assignment bypassed delayed application startup")
	case <-time.After(30 * time.Millisecond):
	}
	close(proceed)
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	if !fake.parameters.OnHealthCheck() || requests.Load() != 0 {
		t.Fatal("startup health accessed Rust before the listener was ready")
	}
	p.listenerReady()
	select {
	case <-assigned:
	case <-time.After(time.Second):
		t.Fatal("ready listener did not release the assignment")
	}
	if requests.Load() != 1 || p.g.sessionID() != "queued" {
		t.Fatal("queued assignment did not activate exactly once")
	}
}

func TestManagedStartupDeadlineCancelsBlockedDependencyAndCleansUp(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	entered, proceed := make(chan struct{}), make(chan struct{})
	fake := &fakeProcessService{credentialsHook: func() { close(entered); <-proceed }, ended: make(chan struct{})}
	p := newGameProcess(ctx, stop, testRuntime(), fake)
	if p.startupTimeout != 120*time.Second {
		t.Fatal("production startup deadline changed")
	}
	p.startupTimeout = 100 * time.Millisecond // Per-instance budget; no global clock mutation.
	started := make(chan error, 1)
	go func() { _, err := p.start(8080, "/game/session/bolts.sqlite"); started <- err }()
	<-entered
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("startup watchdog did not cancel the blocked startup")
	}
	select {
	case <-fake.ended:
	case <-time.After(time.Second):
		t.Fatal("startup watchdog did not clean up the registered process")
	}
	if p.healthy() {
		t.Fatal("expired startup remained healthy")
	}
	close(proceed)
	if err := <-started; !errors.Is(err, context.Canceled) {
		t.Fatalf("late dependency success continued cancelled startup: %v", err)
	}
	p.listenerReady()
	select {
	case <-p.listening:
		t.Fatal("late listener readiness reopened an expired startup")
	default:
	}
	p.close()
	if !reflect.DeepEqual(fake.trace(), []string{"ready", "credentials", "ending"}) {
		t.Fatalf("timeout continued initialization or ended more than once: %v", fake.trace())
	}
}

func TestManagedStartupDeadlineBeforeReadyResponseEndsLateRegistrationOnce(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	entered, proceed := make(chan struct{}), make(chan struct{})
	fake := &fakeProcessService{readyHook: func(sdk.ProcessParameters) { close(entered); <-proceed }, ended: make(chan struct{})}
	p := newGameProcess(ctx, stop, testRuntime(), fake)
	p.startupTimeout = 100 * time.Millisecond
	started := make(chan error, 1)
	go func() { _, err := p.start(8080, "/game/session/bolts.sqlite"); started <- err }()
	<-entered
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("watchdog did not cancel a blocked ProcessReady")
	}
	// Complete pre-registration cleanup before delivering the late ready result.
	if err := p.close(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fake.trace(), []string{"ready"}) {
		t.Fatalf("unregistered process was ended: %v", fake.trace())
	}
	close(proceed)
	if err := <-started; !errors.Is(err, context.Canceled) {
		t.Fatalf("late ProcessReady success continued startup: %v", err)
	}
	p.close()
	if !reflect.DeepEqual(fake.trace(), []string{"ready", "ending"}) {
		t.Fatalf("late registration was not ended exactly once: %v", fake.trace())
	}
}

func TestManagedStartupTimerStopsAtReadinessAndClose(t *testing.T) {
	for _, ready := range []bool{true, false} {
		ctx, stop := context.WithCancel(context.Background())
		fake := &fakeProcessService{}
		p := newGameProcess(ctx, stop, testRuntime(), fake)
		if _, err := p.start(8080, "/game/session/bolts.sqlite"); err != nil {
			t.Fatal(err)
		}
		if ready {
			p.listenerReady()
		} else {
			p.close()
		}
		p.startupMu.Lock()
		timerStopped := p.startupTimer == nil
		p.startupMu.Unlock()
		if !timerStopped {
			t.Fatal("completed startup retained its watchdog")
		}
		// A timer callback already queued when Stop won must also be harmless.
		p.startupTimedOut()
		if ready && ctx.Err() != nil {
			t.Fatal("stale watchdog callback cancelled a ready process")
		}
		p.close()
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
