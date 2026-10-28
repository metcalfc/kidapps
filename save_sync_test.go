package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func openSyncStore(t *testing.T, file string) *Store {
	t.Helper()
	st, err := OpenStore(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Error(err)
		}
	})
	return st
}

func syncCode(t *testing.T, st *Store) string {
	t.Helper()
	code, err := st.NewCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func TestConditionalSaveCreationAndPreconditions(t *testing.T) {
	ctx := context.Background()
	st := openSyncStore(t, filepath.Join(t.TempDir(), "chain.db"))
	code := syncCode(t, st)
	first := []byte(`{"n":1}`)
	if _, err := st.PutConditional(ctx, code, "game-v2", first, "create-0001", SaveETag([]byte(`{}`))); !errors.Is(err, ErrConflict) {
		t.Fatalf("If-Match on a missing document: %v", err)
	}
	got, err := st.PutConditional(ctx, code, "game-v2", first, "create-0001", "*")
	if err != nil || !bytes.Equal(got, first) {
		t.Fatalf("create: got %s, error %v", got, err)
	}
	if _, err := st.PutConditional(ctx, code, "game-v2", []byte(`{"n":2}`), "create-0002", "*"); !errors.Is(err, ErrConflict) {
		t.Fatalf("If-None-Match on an existing document: %v", err)
	}
	if _, err := st.PutConditional(ctx, code, "game-v2", []byte(`{"n":2}`), "update-0001", SaveETag([]byte(`{}`))); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale ETag: %v", err)
	}
	stored, err := st.Get(ctx, code, "game-v2")
	if err != nil || !bytes.Equal(stored, first) {
		t.Fatalf("conflicts changed stored data: %s, %v", stored, err)
	}
	if _, err := st.PutConditional(ctx, "ZZZZZZZZ-0000", "game-v2", first, "create-0003", "*"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown code: %v", err)
	}
	if _, err := st.PutConditional(ctx, code, "game-v2", first, "short", SaveETag(first)); !errors.Is(err, ErrInvalidMutation) {
		t.Fatalf("invalid mutation: %v", err)
	}
}

func TestConditionalConcurrentWritersAndRetry(t *testing.T) {
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "chain.db")
	firstStore := openSyncStore(t, file)
	secondStore := openSyncStore(t, file) // Different database handles must still compare atomically.
	code := syncCode(t, firstStore)
	base := []byte(`{"correct":0}`)
	if err := firstStore.Put(ctx, code, "game-v2", base); err != nil {
		t.Fatal(err)
	}
	type result struct {
		writer int
		err    error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, st := range []*Store{firstStore, secondStore} {
		go func(i int, st *Store) {
			<-start
			id := []string{"writer-0001", "writer-0002"}[i]
			_, err := st.PutConditional(ctx, code, "game-v2", []byte(`{"correct":1}`), id, SaveETag(base))
			results <- result{i, err}
		}(i, st)
	}
	close(start)
	wins, conflicts, loser := 0, 0, -1
	for range 2 {
		r := <-results
		switch {
		case r.err == nil:
			wins++
		case errors.Is(r.err, ErrConflict):
			conflicts++
			loser = r.writer
		default:
			t.Fatalf("concurrent write failed unexpectedly: %v", r.err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wanted one winner and one conflict, got %d and %d", wins, conflicts)
	}
	latest, err := firstStore.Get(ctx, code, "game-v2")
	if err != nil {
		t.Fatal(err)
	}
	merged := []byte(`{"correct":2}`)
	id := []string{"writer-0001", "writer-0002"}[loser]
	got, err := secondStore.PutConditional(ctx, code, "game-v2", merged, id, SaveETag(latest))
	if err != nil || !bytes.Equal(got, merged) {
		t.Fatalf("retry with the latest ETag: %s, %v", got, err)
	}
}

func TestMutationReplayReturnsLatestWithoutReapplying(t *testing.T) {
	ctx := context.Background()
	st := openSyncStore(t, filepath.Join(t.TempDir(), "chain.db"))
	code := syncCode(t, st)
	first, latest := []byte(`{"n":1}`), []byte(`{"n":2}`)
	if _, err := st.PutConditional(ctx, code, "game-v2", first, "mutation-0001", "*"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PutConditional(ctx, code, "game-v2", latest, "mutation-0002", SaveETag(first)); err != nil {
		t.Fatal(err)
	}
	// The first reply was lost. Its retry can carry a stale ETag and a body that
	// has since changed locally; neither may replace the later committed save.
	got, err := st.PutConditional(ctx, code, "game-v2", []byte(`{"n":999}`), "mutation-0001", "*")
	if err != nil || !bytes.Equal(got, latest) {
		t.Fatalf("replay: %s, %v", got, err)
	}
	stored, err := st.Get(ctx, code, "game-v2")
	if err != nil || !bytes.Equal(stored, latest) {
		t.Fatalf("replay overwrote later progress: %s, %v", stored, err)
	}
	// A write whose JSON is unchanged still records its mutation for recovery.
	if _, err := st.PutConditional(ctx, code, "game-v2", latest, "mutation-noop", SaveETag(latest)); err != nil {
		t.Fatal(err)
	}
	var writes int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM save_writes WHERE code = ? AND doc = ?`, code, "game-v2").Scan(&writes); err != nil || writes != 3 {
		t.Fatalf("mutation records: %d, %v", writes, err)
	}
}

func TestLegacyWritesCannotOverwriteConditionalHistory(t *testing.T) {
	ctx := context.Background()
	st := openSyncStore(t, filepath.Join(t.TempDir(), "app.db"))
	code := syncCode(t, st)
	first := []byte(`{"n":1}`)
	if err := st.Put(ctx, code, "game-v2", first); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PutConditional(ctx, code, "game-v2", []byte(`{"n":2}`), "protect-0001", SaveETag(first)); err != nil {
		t.Fatal(err)
	}
	if err := st.Put(ctx, code, "game-v2", []byte(`{"n":999}`)); !errors.Is(err, ErrConditionalRequired) {
		t.Fatalf("legacy overwrite: %v", err)
	}
	// Protection is per document, so imports into new documents and DM's legacy
	// save path continue working without adopting the conditional protocol.
	for _, doc := range []string{"game", "pda-save"} {
		if err := st.Put(ctx, code, doc, first); err != nil {
			t.Fatalf("new legacy document %s: %v", doc, err)
		}
		if err := st.Put(ctx, code, doc, []byte(`{"n":2}`)); err != nil {
			t.Fatalf("existing legacy document %s: %v", doc, err)
		}
	}
}

func syncHTTPServer(t *testing.T) (http.Handler, map[string]*Store) {
	t.Helper()
	stores := map[string]*Store{}
	for _, app := range apps {
		stores[app.ID] = openSyncStore(t, filepath.Join(t.TempDir(), app.ID+".db"))
	}
	web := fstest.MapFS{
		"index.html":   {Data: []byte("home")},
		"shared/sw.js": {Data: []byte("service worker")},
	}
	return newServer(web, stores), stores
}

func syncRequest(handler http.Handler, method, url, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestSaveHTTPConditionalRoundTripAndLegacyProtection(t *testing.T) {
	handler, stores := syncHTTPServer(t)
	code := syncCode(t, stores["chain"])
	url := "/chain/api/saves/" + code + "/game-v2"
	if w := syncRequest(handler, "GET", url, "", nil); w.Code != http.StatusNotFound {
		t.Fatalf("missing GET: %d", w.Code)
	}
	first := "{\n  \"n\": 1\n}\n"
	createHeaders := map[string]string{"X-Kidapps-Mutation": "http-create-0001", "If-None-Match": "*"}
	w := syncRequest(handler, "PUT", url, first, createHeaders)
	if w.Code != http.StatusOK || w.Body.String() != first || w.Header().Get("ETag") != SaveETag([]byte(first)) {
		t.Fatalf("conditional create: %d, headers %v, body %q", w.Code, w.Header(), w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store, no-transform" {
		t.Fatalf("conditional response headers: %v", w.Header())
	}
	etag := w.Header().Get("ETag")
	w = syncRequest(handler, "GET", url, "", nil)
	if w.Code != http.StatusOK || w.Header().Get("ETag") != etag || w.Body.String() != first {
		t.Fatalf("GET round trip: %d, %v, %q", w.Code, w.Header(), w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store, no-transform" {
		t.Fatalf("GET must prevent proxy encoding from rewriting its strong ETag: %v", w.Header())
	}
	latest := `{"n":2}`
	w = syncRequest(handler, "PUT", url, latest, map[string]string{"X-Kidapps-Mutation": "http-update-0001", "If-Match": etag})
	if w.Code != http.StatusOK || w.Body.String() != latest {
		t.Fatalf("conditional update: %d, %s", w.Code, w.Body.String())
	}
	latestETag := w.Header().Get("ETag")
	w = syncRequest(handler, "PUT", url, `{"n":3}`, map[string]string{"X-Kidapps-Mutation": "http-stale-0001", "If-Match": etag})
	if w.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale update: %d, %s", w.Code, w.Body.String())
	}
	w = syncRequest(handler, "PUT", url, `{"n":999}`, createHeaders)
	if w.Code != http.StatusOK || w.Header().Get("ETag") != latestETag || w.Body.String() != latest {
		t.Fatalf("replay must return current data and ETag: %d, %v, %s", w.Code, w.Header(), w.Body.String())
	}
	w = syncRequest(handler, "PUT", url, `{"n":999}`, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("legacy overwrite after opt-in: %d", w.Code)
	}
	w = syncRequest(handler, "GET", url, "", nil)
	if w.Body.String() != latest {
		t.Fatalf("rejected legacy write changed save: %s", w.Body.String())
	}
	// A separate app that has not opted in retains the 204 legacy contract.
	dmCode := syncCode(t, stores["dm"])
	dmURL := "/dm/api/saves/" + dmCode + "/pda-save"
	for _, body := range []string{`{"xp":1}`, `{"xp":2}`} {
		w = syncRequest(handler, "PUT", dmURL, body, nil)
		if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
			t.Fatalf("DM legacy PUT: %d, %s", w.Code, w.Body.String())
		}
	}
}

func TestSaveHTTPValidationAndUnknownCode(t *testing.T) {
	handler, stores := syncHTTPServer(t)
	url := "/chain/api/saves/" + syncCode(t, stores["chain"]) + "/game-v2"
	for name, headers := range map[string]map[string]string{
		"missing precondition": {"X-Kidapps-Mutation": "validate-0001"},
		"empty mutation":       {"X-Kidapps-Mutation": "", "If-None-Match": "*"},
		"short mutation":       {"X-Kidapps-Mutation": "short", "If-None-Match": "*"},
		"long mutation":        {"X-Kidapps-Mutation": strings.Repeat("a", 129), "If-None-Match": "*"},
		"non ASCII mutation":   {"X-Kidapps-Mutation": "mutación-0001", "If-None-Match": "*"},
		"bad ETag":             {"X-Kidapps-Mutation": "validate-0001", "If-Match": "not-an-etag"},
		"two preconditions":    {"X-Kidapps-Mutation": "validate-0001", "If-None-Match": "*", "If-Match": SaveETag([]byte(`{}`))},
		"missing mutation":     {"If-None-Match": "*"},
	} {
		t.Run(name, func(t *testing.T) {
			w := syncRequest(handler, "PUT", url, `{}`, headers)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
		})
	}
	for _, body := range []string{"null", "[]", "1", "not JSON"} {
		w := syncRequest(handler, "PUT", url, body, map[string]string{"X-Kidapps-Mutation": "validate-json", "If-None-Match": "*"})
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %q: %d", body, w.Code)
		}
	}
	for _, header := range []string{"X-Kidapps-Mutation", "If-Match", "If-None-Match"} {
		r := httptest.NewRequest("PUT", url, strings.NewReader(`{}`))
		r.Header.Set("X-Kidapps-Mutation", "validate-duplicates")
		if header == "If-Match" {
			r.Header.Set("If-Match", SaveETag([]byte(`{}`)))
		} else {
			r.Header.Set("If-None-Match", "*")
		}
		r.Header.Add(header, r.Header.Get(header))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("duplicate %s: %d", header, w.Code)
		}
	}
	w := syncRequest(handler, "PUT", "/chain/api/saves/ZZZZZZZZ-0000/game-v2", `{}`, map[string]string{"X-Kidapps-Mutation": "unknown-0001", "If-None-Match": "*"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown code: %d, %s", w.Code, w.Body.String())
	}
	w = syncRequest(handler, "PUT", url, `{}`, map[string]string{"X-Kidapps-Mutation": "missing-0001", "If-Match": SaveETag([]byte(`{}`))})
	if w.Code != http.StatusPreconditionFailed {
		t.Fatalf("If-Match on missing document: %d", w.Code)
	}
	if _, err := stores["chain"].Get(context.Background(), strings.Split(url, "/")[4], "game-v2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invalid requests created a document: %v", err)
	}
}

func TestSaveETagUsesExactBytes(t *testing.T) {
	// A known SHA256 value also checks that quotes are part of the ETag.
	if got := SaveETag([]byte(`{}`)); got != `"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"` {
		t.Fatalf("unexpected ETag: %s", got)
	}
	if SaveETag([]byte(`{}`)) == SaveETag([]byte("{}\n")) {
		t.Fatal("ETag must preserve the distinction between different stored bytes")
	}
}
