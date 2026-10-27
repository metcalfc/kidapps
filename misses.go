package main

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// misses counts requests for save codes that do not exist, per client, so nobody can walk
// the code space looking for other families' saves. Caddy limits overall request rates;
// this limits wrong guesses, which Caddy cannot see.
type misses struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	seen   map[string]*missCount
}

type missCount struct {
	n     int
	since time.Time
}

func newMisses(max int, window time.Duration) *misses {
	return &misses{max: max, window: window, seen: map[string]*missCount{}}
}

// clientIP is the address Caddy reports. The app listens on localhost only, so the header
// can only have come from Caddy.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func (m *misses) blocked(r *http.Request) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.seen[clientIP(r)]
	return c != nil && time.Since(c.since) < m.window && c.n >= m.max
}

func (m *misses) record(r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if len(m.seen) > 10000 {
		for k, c := range m.seen {
			if now.Sub(c.since) >= m.window {
				delete(m.seen, k)
			}
		}
	}
	ip := clientIP(r)
	c := m.seen[ip]
	if c == nil || now.Sub(c.since) >= m.window {
		c = &missCount{since: now}
		m.seen[ip] = c
	}
	c.n++
}
