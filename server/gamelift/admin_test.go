package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminRoutesProxyAuthorizationAndNeverCacheResults(t *testing.T) {
	r := testRuntime()
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		calls++
		if q.Header.Get("Authorization") != "Bearer isolated-admin-test-key" {
			t.Error("admin authentication header was lost")
		}
		if q.URL.Path == "/api/admin/status" && q.URL.Query().Get("minutes") != "30" {
			t.Error("activity window was lost")
		}
		if q.URL.Path == "/api/admin/query" {
			body, _ := io.ReadAll(q.Body)
			if string(body) != `{"sql":"SELECT 1"}` {
				t.Error("query body was changed")
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstream.Close()
	r.local = upstream.URL
	handler := (&directory{r: r}).handler()
	for _, route := range []struct{ method, path string }{{"GET", "/api/admin/status?minutes=30"}, {"POST", "/api/admin/query"}} {
		request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{"sql":"SELECT 1"}`))
		request.Header.Set("Authorization", "Bearer isolated-admin-test-key")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("admin response was not preserved: %d", response.Code)
		}
	}
	if calls != 2 {
		t.Fatalf("admin requests did not reach Rust: %d", calls)
	}
}
