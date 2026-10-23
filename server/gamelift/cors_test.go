package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDirectoryProxyEmitsOneCORSOriginOnSuccessAndErrors(t *testing.T) {
	r := testRuntime()
	calls := 0
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		calls++
		if q.Header.Get("Origin") != r.cfg.Origins[0] {
			t.Error("proxy removed the origin Rust must validate")
		}
		w.Header().Set("Access-Control-Allow-Origin", q.Header.Get("Origin"))
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if q.URL.Path == "/api/session" {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer local.Close()
	r.local = local.URL
	handler := (&directory{r: r}).handler()
	for _, path := range []string{"/api/session", "/api/feedback", "/api/visits", "/api/health", "/api/leaderboard"} {
		method := "POST"
		if path == "/api/health" || path == "/api/leaderboard" {
			method = "GET"
		}
		request := httptest.NewRequest(method, path, strings.NewReader("{}"))
		request.Header.Set("Origin", r.cfg.Origins[0])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, request)
		wantStatus := 200
		if path == "/api/session" {
			wantStatus = 401
		}
		if w.Code != wantStatus {
			t.Fatalf("%s: status %d", path, w.Code)
		}
		for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"} {
			if values := w.Header().Values(header); len(values) != 1 || strings.Contains(values[0], r.cfg.Origins[0]+",") {
				t.Fatalf("%s: duplicate %s: %v", path, header, values)
			}
		}
		if w.Header().Get("Access-Control-Allow-Origin") != r.cfg.Origins[0] {
			t.Fatal("wrong allowed origin")
		}
	}
	before := calls
	for _, origin := range []string{r.cfg.Origins[0], "https://untrusted.example"} {
		request := httptest.NewRequest("OPTIONS", "/api/session", nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Access-Control-Request-Method", "POST")
		request.Header.Set("Access-Control-Request-Headers", "content-type")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, request)
		if origin == r.cfg.Origins[0] {
			if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != origin {
				t.Fatal("preflight rejected")
			}
		} else if w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("untrusted origin admitted")
		}
	}
	if calls != before {
		t.Fatal("preflight reached Rust")
	}
}
