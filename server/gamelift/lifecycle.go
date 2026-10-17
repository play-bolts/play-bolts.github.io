package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/request"
	sdk "github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
	"github.com/aws/aws-sdk-go-v2/aws"
)

type processService interface {
	ready(sdk.ProcessParameters) error
	credentials(string) (aws.Credentials, error)
	certificate() (tls.Certificate, error)
	activate() error
	ending() error
}

type managedProcessService struct{}

func (managedProcessService) ready(p sdk.ProcessParameters) error { return sdk.ProcessReady(p) }
func (managedProcessService) activate() error                     { return sdk.ActivateGameSession() }
func (managedProcessService) ending() error                       { return sdk.ProcessEnding() }
func (managedProcessService) credentials(role string) (aws.Credentials, error) {
	q := request.NewGetFleetRoleCredentials()
	q.RoleArn, q.RoleSessionName = role, "bolts-host"
	c, err := sdk.GetFleetRoleCredentials(q)
	return aws.Credentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken}, err
}
func (managedProcessService) certificate() (tls.Certificate, error) {
	c, err := sdk.GetComputeCertificate()
	if err != nil {
		return tls.Certificate{}, err
	}
	pem, err := os.ReadFile(filepath.Join(c.CertificatePath, "certificate.pem"))
	if err != nil {
		return tls.Certificate{}, err
	}
	chain, err := os.ReadFile(filepath.Join(c.CertificatePath, "certificateChain.pem"))
	if err != nil {
		return tls.Certificate{}, err
	}
	key, err := os.ReadFile(filepath.Join(c.CertificatePath, "privateKey.pem"))
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(append(append(pem, '\n'), chain...), key)
}

// The SDK sends its first heartbeat immediately inside ProcessReady, before
// credentials and certificates can be fetched. Startup is live for a bounded
// interval; gameplay assignments still wait until Rust and TLS both listen.
const managedStartupTimeout = 120 * time.Second

type gameProcess struct {
	ctx             context.Context
	stop            context.CancelFunc
	g               *gameHost
	api             processService
	certificate     tls.Certificate
	listening       chan struct{}
	registered      atomic.Bool
	listenOnce      sync.Once
	endOnce         sync.Once
	activation      sync.Mutex
	endError        error
	startupMu       sync.Mutex
	startupTimeout  time.Duration
	startupDeadline time.Time
	startupTimer    *time.Timer
}

func newGameProcess(ctx context.Context, stop context.CancelFunc, r *runtime, api processService) *gameProcess {
	return &gameProcess{ctx: ctx, stop: stop, g: newGame(r, managedSessions{}), api: api, listening: make(chan struct{}), startupTimeout: managedStartupTimeout}
}
func (p *gameProcess) start(port int, dataPath string) (creds aws.Credentials, err error) {
	defer func() {
		if err != nil {
			log.Printf("Managed startup failed: %v", err)
			err = errors.Join(err, p.close())
		}
	}()
	p.startupMu.Lock()
	p.startupDeadline = time.Now().Add(p.startupTimeout)
	p.startupTimer = time.AfterFunc(p.startupTimeout, p.startupTimedOut)
	p.startupMu.Unlock()
	if err = p.ctx.Err(); err != nil {
		return creds, err
	}
	err = p.api.ready(sdk.ProcessParameters{
		Port: port, LogParameters: sdk.LogParameters{LogPaths: []string{filepath.Dir(dataPath)}},
		OnStartGameSession: p.activate, OnUpdateGameSession: func(model.UpdateGameSession) {},
		OnProcessTerminate: func() { log.Print("GameLift requested process termination"); p.stop() }, OnHealthCheck: p.healthy,
	})
	if err != nil {
		return creds, fmt.Errorf("GameLift process registration: %w", err)
	}
	p.registered.Store(true)
	log.Print("GameLift process registered; application initialization pending")
	if err = p.ctx.Err(); err != nil {
		return creds, err
	}
	creds, err = p.api.credentials(p.g.r.cfg.FleetRole)
	if err != nil {
		return creds, fmt.Errorf("GameLift fleet credentials: %w", err)
	}
	if err = p.ctx.Err(); err != nil {
		return creds, err
	}
	p.certificate, err = p.api.certificate()
	if err != nil {
		return creds, fmt.Errorf("GameLift TLS certificate: %w", err)
	}
	if err = p.ctx.Err(); err != nil {
		return creds, err
	}
	log.Print("GameLift credentials and TLS certificate loaded")
	return creds, nil
}
func (p *gameProcess) startupTimedOut() {
	p.startupMu.Lock()
	if p.startupTimer == nil {
		p.startupMu.Unlock()
		return
	}
	p.startupTimer = nil
	p.g.stopping.Store(true)
	p.stop()
	p.startupMu.Unlock()
	log.Print("Managed startup exceeded its deadline; ending process")
	if err := p.close(); err != nil {
		log.Printf("Startup deadline cleanup failed: %v", err)
	}
}
func (p *gameProcess) stopStartupTimer() {
	p.startupMu.Lock()
	if p.startupTimer != nil {
		p.startupTimer.Stop()
		p.startupTimer = nil
	}
	p.startupMu.Unlock()
}
func (p *gameProcess) listenerReady() {
	p.startupMu.Lock()
	if p.ctx.Err() != nil || p.g.stopping.Load() {
		p.startupMu.Unlock()
		p.stopStartupTimer()
		return
	}
	if !time.Now().Before(p.startupDeadline) {
		p.startupMu.Unlock()
		p.startupTimedOut()
		return
	}
	if p.startupTimer != nil {
		p.startupTimer.Stop()
		p.startupTimer = nil
	}
	p.listenOnce.Do(func() { close(p.listening) })
	p.startupMu.Unlock()
}
func (p *gameProcess) healthy() bool {
	if p.ctx.Err() != nil || p.g.stopping.Load() {
		return false
	}
	select {
	case <-p.listening:
	default:
		p.startupMu.Lock()
		live := time.Now().Before(p.startupDeadline) && p.ctx.Err() == nil && !p.g.stopping.Load()
		p.startupMu.Unlock()
		return live
	}
	var status struct {
		OK bool `json:"ok"`
	}
	return p.ctx.Err() == nil && !p.g.stopping.Load() && p.g.r.localCall(p.ctx, map[string]string{"op": "status"}, &status) == nil && status.OK
}
func (p *gameProcess) activate(s model.GameSession) {
	select {
	case <-p.listening:
	case <-p.ctx.Done():
		return
	}
	p.activation.Lock()
	defer p.activation.Unlock()
	if p.ctx.Err() != nil || p.g.stopping.Load() {
		return
	}
	if err := p.g.r.localCall(p.ctx, map[string]string{"op": "activate", "session": s.GameSessionID, "name": s.Name}, nil); err != nil {
		log.Printf("activation failed: %v", err)
		p.stop()
		return
	}
	if p.ctx.Err() != nil || p.g.stopping.Load() {
		return
	}
	p.g.mu.Lock()
	p.g.session = s.GameSessionID
	p.g.mu.Unlock()
	if err := p.api.activate(); err != nil {
		log.Printf("GameLift activation failed: %v", err)
		p.stop()
	}
}
func (p *gameProcess) close() error {
	p.g.stopping.Store(true)
	p.stop()
	p.stopStartupTimer()
	// A timeout can precede the ProcessReady response. Do not consume endOnce
	// until registration succeeds; start() then notices cancellation and ends it.
	if !p.registered.Load() {
		return nil
	}
	p.endOnce.Do(func() {
		// Cancel bridge requests and let any SDK activation finish before ending
		// this process or destroying the SDK state used by the callback.
		p.activation.Lock()
		defer p.activation.Unlock()
		if err := p.api.ending(); err != nil {
			p.endError = fmt.Errorf("GameLift process ending: %w", err)
		}
	})
	return p.endError
}
