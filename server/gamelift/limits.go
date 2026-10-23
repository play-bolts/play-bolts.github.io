package main

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type window struct {
	expires time.Time
	count   int
}
type rateLimits struct {
	mu      sync.Mutex
	entries map[string]window
	now     func() time.Time
}

const rateLimitEntries = 4096

// Each entry keeps its own expiry: a short-window request must not evict an
// unrelated client's still-active longer window when the bounded table fills.
// Denied requests never extend a window or grow its counter.
func (l *rateLimits) retryAfter(key string, limit int, duration time.Duration) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	if l.entries == nil {
		l.entries = map[string]window{}
	}
	v, exists := l.entries[key]
	if !exists && len(l.entries) >= rateLimitEntries {
		var earliest time.Time
		for k, v := range l.entries {
			if !now.Before(v.expires) {
				delete(l.entries, k)
			} else if earliest.IsZero() || v.expires.Before(earliest) {
				earliest = v.expires
			}
		}
		if len(l.entries) >= rateLimitEntries {
			return earliest.Sub(now)
		}
	}
	if !exists || !now.Before(v.expires) {
		v = window{expires: now.Add(duration)}
	}
	if v.count >= limit {
		return v.expires.Sub(now)
	}
	v.count++
	l.entries[key] = v
	return 0
}

func (l *rateLimits) check(w http.ResponseWriter, key string, limit int, duration time.Duration, message string) bool {
	if wait := l.retryAfter(key, limit, duration); wait > 0 {
		seconds := (wait + time.Second - 1) / time.Second
		w.Header().Set("Retry-After", strconv.FormatInt(int64(seconds), 10))
		problem(w, http.StatusTooManyRequests, message)
		return false
	}
	return true
}
func clientIP(q *http.Request, cloudFront bool) string {
	// The directory listener is private to CloudFront's VPC origin. CloudFront
	// appends the viewer address; never trust a caller-supplied first entry.
	if cloudFront {
		parts := strings.Split(strings.Join(q.Header.Values("X-Forwarded-For"), ","), ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if ip := net.ParseIP(last); ip != nil {
			return ip.String()
		}
	}
	host, _, err := net.SplitHostPort(q.RemoteAddr)
	if err == nil {
		if ip := net.ParseIP(host); ip != nil {
			return ip.String()
		}
	}
	return "unknown"
}
