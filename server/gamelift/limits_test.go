package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClientIPUsesCanonicalTrustedFinalAddress(t *testing.T) {
	for _, test := range []struct {
		name      string
		forwarded []string
		remote    string
		trusted   bool
		want      string
	}{
		{"spoofed prefix", []string{"198.51.100.1, 203.0.113.9"}, "10.0.0.1:9000", true, "203.0.113.9"},
		{"multiple header lines", []string{"198.51.100.1", "203.0.113.9"}, "10.0.0.1:9000", true, "203.0.113.9"},
		{"mapped IPv4", []string{"::ffff:203.0.113.9"}, "10.0.0.1:9000", true, "203.0.113.9"},
		{"canonical IPv6", []string{"2001:0db8:0000:0000:0000:0000:0000:0001"}, "10.0.0.1:9000", true, "2001:db8::1"},
		{"invalid final address", []string{"203.0.113.9, invalid"}, "10.0.0.1:9000", true, "10.0.0.1"},
		{"direct worker ignores forwarding", []string{"203.0.113.9"}, "[::ffff:198.51.100.1]:9000", false, "198.51.100.1"},
		{"canonical direct IPv6", nil, "[2001:0db8:0:0:0:0:0:1]:9000", false, "2001:db8::1"},
		{"invalid peer", []string{"invalid"}, "invalid", true, "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			q := httptest.NewRequest("GET", "/", nil)
			q.RemoteAddr = test.remote
			for _, value := range test.forwarded {
				q.Header.Add("X-Forwarded-For", value)
			}
			if got := clientIP(q, test.trusted); got != test.want {
				t.Fatalf("client IP = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRateLimitUsesEachEntriesOwnExpiryWhenTableFills(t *testing.T) {
	for _, expiredSlot := range []bool{false, true} {
		t.Run(fmt.Sprint(expiredSlot), func(t *testing.T) {
			now := time.Unix(1000, 0)
			limits := rateLimits{now: func() time.Time { return now }}
			for i := 0; i < rateLimitEntries; i++ {
				duration := time.Minute
				if expiredSlot && i == rateLimitEntries-1 {
					duration = time.Second
				}
				if wait := limits.retryAfter(strconv.Itoa(i), 1, duration); wait != 0 {
					t.Fatalf("initial capacity exhausted: %v", wait)
				}
			}
			now = now.Add(2 * time.Second)
			// A short request must not expire the minute-long entries. Conversely,
			// a new minute-long request must reclaim an expired one-second entry.
			duration := time.Second
			if expiredSlot {
				duration = time.Minute
			}
			wait := limits.retryAfter("new", 1, duration)
			if expiredSlot && wait != 0 || !expiredSlot && wait != 58*time.Second {
				t.Fatalf("mixed-duration cleanup = %v, expired slot=%t", wait, expiredSlot)
			}
			if len(limits.entries) != rateLimitEntries {
				t.Fatalf("limiter table changed bounds: %d", len(limits.entries))
			}
			if wait := limits.retryAfter("0", 1, time.Minute); wait != 58*time.Second {
				t.Fatalf("another client's active window was reset: %v", wait)
			}
		})
	}
}

func TestRateLimitRetryAfterAndRecoveryWithoutDenialExtension(t *testing.T) {
	now := time.Unix(1000, 0)
	limits := rateLimits{now: func() time.Time { return now }}
	if !limits.check(httptest.NewRecorder(), "client", 1, time.Minute, "Slow down.") {
		t.Fatal("initial request denied")
	}
	now = now.Add(59*time.Second + 100*time.Millisecond)
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		if limits.check(w, "client", 1, time.Minute, "Slow down.") || w.Code != 429 || w.Header().Get("Retry-After") != "1" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid limit response: %d %v", w.Code, w.Header())
		}
	}
	if limits.entries["client"].count != 1 {
		t.Fatal("denials grew the request counter")
	}
	now = now.Add(900 * time.Millisecond)
	if wait := limits.retryAfter("client", 1, time.Minute); wait != 0 {
		t.Fatalf("request did not recover at original expiry: %v", wait)
	}
}

func TestRateLimitConcurrentRequestsEnforceExactCapacity(t *testing.T) {
	limits := rateLimits{}
	var group sync.WaitGroup
	accepted := make(chan bool, 200)
	for i := 0; i < 200; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			accepted <- limits.retryAfter("client", 120, time.Minute) == 0
		}()
	}
	group.Wait()
	close(accepted)
	count := 0
	for allowed := range accepted {
		if allowed {
			count++
		}
	}
	if count != 120 {
		t.Fatalf("accepted %d simultaneous requests, want 120", count)
	}
}

func requestAsViewer(handler http.Handler, path, forwarded string) *httptest.ResponseRecorder {
	q := httptest.NewRequest("GET", path, nil)
	q.RemoteAddr = "10.0.0.1:9000"
	q.Header.Set("X-Forwarded-For", forwarded)
	q.Header.Set("Origin", "http://localhost:5173")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, q)
	return w
}

func TestDirectoryReadLimitsCountCacheHitsAndIsolateClientsAndEndpoints(t *testing.T) {
	r := testRuntime()
	r.cfg.ExtraLobbiesEnabled = false
	var mu sync.Mutex
	calls := map[string]int{}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		mu.Lock()
		calls[q.URL.Path]++
		mu.Unlock()
		switch q.URL.Path {
		case "/api/lobbies":
			respond(w, 200, map[string]any{"lobbies": []lobby{{ID: "oregon", Capacity: 6, Phase: "playing"}}})
		case "/api/status", "/api/health":
			if ip := q.Header.Get("X-Forwarded-For"); ip != "203.0.113.9" && ip != "203.0.113.10" {
				t.Errorf("upstream %s lost trusted viewer: %q", q.URL.Path, ip)
			}
			respond(w, 200, map[string]any{"online": 0, "ok": true})
		default:
			t.Errorf("unexpected upstream path %s", q.URL.Path)
		}
	}))
	defer local.Close()
	r.local = local.URL
	d := &directory{r: r} // Disabled regional hosting must never call GameLift.
	handler := d.handler()
	for _, path := range []string{"/api/lobbies", "/api/status", "/api/health"} {
		for i := 0; i < 120; i++ {
			w := requestAsViewer(handler, path, fmt.Sprintf("198.51.100.%d, 203.0.113.9", i))
			if w.Code != 200 {
				t.Fatalf("%s request %d: %d %s", path, i+1, w.Code, w.Body.String())
			}
			if path == "/api/lobbies" && !strings.Contains(w.Body.String(), `"locations":[]`) {
				t.Fatalf("disabled region appeared: %s", w.Body.String())
			}
		}
		w := requestAsViewer(handler, path, "198.51.100.250, ::ffff:203.0.113.9")
		if w.Code != 429 || w.Header().Get("Retry-After") == "" || len(w.Header().Values("Access-Control-Allow-Origin")) != 1 {
			t.Fatalf("%s spoofed/canonical address bypassed quota or lost CORS: %d %v", path, w.Code, w.Header())
		}
		if w := requestAsViewer(handler, path, "203.0.113.10"); w.Code != 200 {
			t.Fatalf("%s one viewer blocked another: %d %s", path, w.Code, w.Body.String())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls["/api/lobbies"] != 1 || calls["/api/status"] != 121 || calls["/api/health"] != 121 {
		t.Fatalf("cache or rejection reached upstream unexpectedly: %v", calls)
	}
}

func TestRealRustDirectoryStatusLimitsKeepViewersIndependent(t *testing.T) {
	r := startRust(t)
	r.cfg.ExtraLobbiesEnabled = false
	d := &directory{r: r}
	handler := d.handler()
	for _, viewer := range []string{"203.0.113.9", "203.0.113.10"} {
		for i := 0; i < 120; i++ {
			w := requestAsViewer(handler, "/api/status", "198.51.100.1, "+viewer)
			if w.Code != 200 {
				t.Fatalf("viewer %s request %d hit another viewer's Rust quota: %d %s", viewer, i+1, w.Code, w.Body.String())
			}
		}
		w := requestAsViewer(handler, "/api/status", "::ffff:"+viewer)
		if w.Code != 429 || w.Header().Get("Retry-After") == "" {
			t.Fatalf("viewer %s did not receive gateway rate limit: %d %s", viewer, w.Code, w.Body.String())
		}
	}
}
