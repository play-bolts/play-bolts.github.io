package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type window struct {
	start time.Time
	count int
}
type rateLimits struct {
	mu      sync.Mutex
	entries map[string]window
}

func (l *rateLimits) allow(key string, limit int, duration time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.entries == nil {
		l.entries = map[string]window{}
	}
	if len(l.entries) >= 4096 {
		for k, v := range l.entries {
			if now.Sub(v.start) >= duration {
				delete(l.entries, k)
			}
		}
	}
	v, exists := l.entries[key]
	if !exists && len(l.entries) >= 4096 {
		return false
	}
	if now.Sub(v.start) >= duration {
		v = window{start: now}
	}
	v.count++
	l.entries[key] = v
	return v.count <= limit
}
func clientIP(q *http.Request, cloudFront bool) string {
	// The directory listener is private to CloudFront's VPC origin. CloudFront
	// appends the viewer address; never trust a caller-supplied first entry.
	if cloudFront {
		parts := strings.Split(q.Header.Get("X-Forwarded-For"), ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if net.ParseIP(last) != nil {
			return last
		}
	}
	host, _, err := net.SplitHostPort(q.RemoteAddr)
	if err == nil {
		return host
	}
	return "unknown"
}
