// bolts-host supervises the Rust simulation and supplies GameLift lifecycle,
// TLS, admission, global discovery, and asynchronous durable replication.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	sdk "github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

type location struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	AWS   string `json:"aws"`
	Queue string `json:"queue"`
}
type settings struct {
	Region          string     `json:"region"`
	Fleet           string     `json:"fleet"`
	FleetRole       string     `json:"fleetRole"`
	SecretParameter string     `json:"secretParameter"`
	API             string     `json:"api"`
	Origins         []string   `json:"origins"`
	Locations       []location `json:"locations"`
}
type runtime struct {
	cfg      settings
	secret   []byte
	internal string
	local    string
	http     *http.Client
}
type admission struct {
	Player        string `json:"player"`
	Session       string `json:"session"`
	PlayerSession string `json:"playerSession"`
	Expires       int64  `json:"expires"`
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func sign(secret []byte, data []byte) string {
	h := hmac.New(sha256.New, secret)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
func (r *runtime) ticket(a admission) string {
	b, _ := json.Marshal(a)
	p := base64.RawURLEncoding.EncodeToString(b)
	return p + "." + sign(r.secret, []byte("join:"+p))
}
func (r *runtime) verify(ticket, session string) (admission, error) {
	var a admission
	parts := strings.Split(ticket, ".")
	if len(parts) != 2 || len(ticket) > 2048 {
		return a, errors.New("invalid ticket")
	}
	expected, _ := hex.DecodeString(sign(r.secret, []byte("join:"+parts[0])))
	supplied, err := hex.DecodeString(parts[1])
	if err != nil || !hmac.Equal(expected, supplied) {
		return a, errors.New("invalid signature")
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return a, err
	}
	if err = json.Unmarshal(data, &a); err != nil {
		return a, err
	}
	now := time.Now().Unix()
	if a.Session != session || a.Player == "" || a.PlayerSession == "" || a.Expires <= now || a.Expires > now+900 {
		return a, errors.New("expired or wrong-session ticket")
	}
	return a, nil
}
func (r *runtime) localCall(ctx context.Context, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", r.local+"/internal/cluster", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bolts-Internal", r.internal)
	response, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("local bridge: HTTP %d", response.StatusCode)
	}
	if out == nil {
		_, err = io.Copy(io.Discard, response.Body)
		return err
	}
	return json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(out)
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func problem(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"message": message})
}
func (r *runtime) originOK(req *http.Request) bool {
	origin := req.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for _, allowed := range r.cfg.Origins {
		if origin == allowed {
			return true
		}
	}
	return false
}
func (r *runtime) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if !r.originOK(q) {
			problem(w, 403, "Origin not allowed.")
			return
		}
		if origin := q.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if q.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, q)
	})
}
func loadSettings(path string) (settings, error) {
	var c settings
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	if err != nil {
		return c, err
	}
	if c.Region == "" || c.SecretParameter == "" || len(c.Origins) == 0 || c.FleetRole == "" {
		return c, errors.New("missing GameLift configuration")
	}
	u, err := url.Parse(c.API)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, errors.New("directory API must use HTTPS")
	}
	expected := map[string]string{"or": "us-west-2", "lon": "eu-west-2", "sg": "ap-southeast-1", "sp": "sa-east-1"}
	seen := map[string]bool{}
	for _, loc := range c.Locations {
		expectedAWS, known := expected[loc.ID]
		if !known || expectedAWS != loc.AWS || strings.TrimSpace(loc.Name) == "" || loc.Queue == "" || seen[loc.ID] {
			return c, errors.New("invalid or duplicate GameLift location")
		}
		seen[loc.ID] = true
	}
	if len(seen) == 0 {
		return c, errors.New("configure at least one game location")
	}
	return c, nil
}
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func run() (runError error) {
	mode := flag.String("mode", "directory", "directory or game")
	cfgPath := flag.String("config", "/etc/bolts-gamelift.json", "configuration file")
	binary := flag.String("server", "/opt/bolts/current/bolts-server", "Rust executable")
	port := flag.Int("port", 8080, "public port")
	check := flag.Bool("check-config", false, "validate configuration without starting services")
	flag.Parse()
	if *port < 1024 || *port > 50000 {
		return errors.New("invalid port")
	}
	if *mode != "directory" && *mode != "game" {
		return errors.New("invalid mode")
	}
	c, err := loadSettings(*cfgPath)
	if err != nil {
		return err
	}
	if *mode == "directory" && c.Fleet == "" {
		return errors.New("directory needs a fleet ID")
	}
	if *check {
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	local := fmt.Sprintf("http://127.0.0.1:%d", *port+10000)
	r := &runtime{cfg: c, internal: randomToken(), local: local, http: &http.Client{Timeout: 12 * time.Second}}
	dataPath := os.Getenv("BOLTS_DB")
	if dataPath == "" {
		dataPath = "/var/lib/bolts/bolts.sqlite"
	}
	if *mode == "game" {
		root := os.Getenv("BOLTS_SESSION_ROOT")
		if root == "" {
			root = filepath.Join(filepath.Dir(*binary), "sessionlogs")
		}
		if e := os.MkdirAll(root, 0755); e != nil {
			return e
		}
		dir, e := os.MkdirTemp(root, "bolts-game-")
		if e != nil {
			return e
		}
		dataPath = filepath.Join(dir, "bolts.sqlite")
	}
	options := []func(*config.LoadOptions) error{config.WithRegion(c.Region)}
	var process *gameProcess
	var childStdout io.Writer = os.Stdout
	var childStderr io.Writer = os.Stderr
	if *mode == "game" {
		hostLog, e := os.OpenFile(filepath.Join(filepath.Dir(dataPath), "host.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if e != nil {
			return fmt.Errorf("startup log: %w", e)
		}
		previousOutput := log.Writer()
		childStdout = io.MultiWriter(os.Stdout, hostLog)
		childStderr = io.MultiWriter(os.Stderr, hostLog)
		log.SetOutput(childStderr)
		defer func() { log.SetOutput(previousOutput); _ = hostLog.Close() }()
		log.Print("Initializing GameLift SDK")
		if err = sdk.InitSDKFromEnvironment(); err != nil {
			log.Printf("GameLift SDK initialization failed: %v", err)
			return fmt.Errorf("GameLift SDK initialization: %w", err)
		}
		defer sdk.Destroy()
		process = newGameProcess(ctx, stop, r, managedProcessService{})
		creds, e := process.start(*port, dataPath)
		if e != nil {
			return e
		}
		defer func() {
			if runError != nil {
				log.Printf("Host failed: %v", runError)
			}
			runError = errors.Join(runError, process.close())
		}()
		options = append(options, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(creds.AccessKeyID, creds.SecretAccessKey, creds.SessionToken)))
	}
	awscfg, err := config.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return fmt.Errorf("AWS configuration: %w", err)
	}
	startup, cancelStartup := context.WithTimeout(ctx, 45*time.Second)
	secret, err := ssm.NewFromConfig(awscfg).GetParameter(startup, &ssm.GetParameterInput{Name: &c.SecretParameter, WithDecryption: aws.Bool(true)})
	cancelStartup()
	if err != nil {
		return fmt.Errorf("cluster secret retrieval: %w", err)
	}
	if secret.Parameter == nil || len(aws.ToString(secret.Parameter.Value)) < 32 {
		return errors.New("invalid cluster secret")
	}
	r.secret = []byte(aws.ToString(secret.Parameter.Value))
	child := exec.Command(*binary)
	child.Stdout = childStdout
	child.Stderr = childStderr
	child.Env = append(os.Environ(), fmt.Sprintf("BOLTS_BIND=127.0.0.1:%d", *port+10000), "BOLTS_INTERNAL_TOKEN="+r.internal, "BOLTS_DB="+dataPath, "BOLTS_ORIGINS="+strings.Join(c.Origins, ","), "BOLTS_TRUST_PROXY=true")
	if *mode == "game" {
		child.Env = append(child.Env, "BOLTS_IDENTITY_SALT="+randomToken(), "BOLTS_MAX_ROOMS=1", "BOLTS_EMPTY_SECONDS=300")
	}
	if err = child.Start(); err != nil {
		return fmt.Errorf("Rust process start: %w", err)
	}
	exited := make(chan struct{})
	var childError error
	go func() { childError = child.Wait(); close(exited); stop() }()
	defer func() {
		_ = child.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
			_ = child.Process.Kill()
		}
	}()
	ready := false
	healthContext, cancelHealth := context.WithTimeout(ctx, 8*time.Second)
	defer cancelHealth()
	for i := 0; i < 100; i++ {
		request, e := http.NewRequestWithContext(healthContext, "GET", local+"/api/health", nil)
		if e != nil {
			return e
		}
		response, e := r.http.Do(request)
		if e == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		select {
		case <-healthContext.Done():
			return fmt.Errorf("Rust service startup: %w", healthContext.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
	cancelHealth()
	if !ready {
		return errors.New("Rust service did not start")
	}
	if *mode == "game" {
		err = r.runGame(process, *port, dataPath)
	} else {
		err = r.runDirectory(ctx, *port, awscfg, dataPath)
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("host stopped: %w", err)
	}

	select {
	case <-exited:
		return fmt.Errorf("Rust service exited: %v", childError)
	default:
	}
	return nil
}
