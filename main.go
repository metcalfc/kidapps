// Command kidapps serves the kids' web apps and keeps their saves, one SQLite file per app.
//
// It listens on localhost only. Caddy sits in front of it (deploy/Caddyfile) for rate
// limits, request size caps and security headers, and exe.dev's proxy terminates TLS.
//
//	kidapps serve  [-addr 127.0.0.1:8080] [-data /var/lib/kidapps]
//	kidapps import -app chain -doc game-v2 save.json   # prints the new save code
package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

//go:embed all:web
var webFS embed.FS

// App is one installable app under /<ID>/.
type App struct {
	ID         string
	Name       string
	ShortName  string
	Theme      string
	Background string
	// Docs are the document names the app saves; anything else is refused.
	Docs []string
	// Shares turns on /<ID>/api/shares, for publishing something friends open by code.
	Shares bool
}

var apps = []App{
	{ID: "dm", Name: "Pinehurst DM Academy", ShortName: "DM Academy", Theme: "#1A2622", Background: "#ECEFE4", Docs: []string{"pda-save"}, Shares: true},
	{ID: "chain", Name: "Chain Reaction", ShortName: "Chain Reaction", Theme: "#160d2c", Background: "#160d2c", Docs: []string{"game-v2", "game"}},
	{ID: "signal", Name: "Signal", ShortName: "Signal", Theme: "#0b1020", Background: "#0b1020", Docs: []string{"signal-save"}},
}

func init() {
	// Not in Go's built-in table, and the VM's /etc/mime.types may not have them either.
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".ico", "image/x-icon")
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	cmd := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "import":
		err = importSave(args)
	default:
		err = fmt.Errorf("unknown command %q (want serve or import)", cmd)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func serve(args []string) error {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fl.String("addr", "127.0.0.1:8080", "listen address")
	dataDir := fl.String("data", "data", "directory for the SQLite files and backups")
	fl.Parse(args)

	if err := os.MkdirAll(*dataDir, 0o750); err != nil {
		return err
	}
	stores := map[string]*Store{}
	for _, a := range apps {
		s, err := OpenStore(filepath.Join(*dataDir, a.ID+".db"))
		if err != nil {
			return fmt.Errorf("%s: %w", a.ID, err)
		}
		defer s.Close()
		stores[a.ID] = s
	}

	web, _ := fs.Sub(webFS, "web")
	srv := &http.Server{
		Addr:              *addr,
		Handler:           newServer(web, stores),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go backupLoop(ctx, *dataDir, stores)
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shut)
	}()
	log.Printf("listening on %s, data in %s", *addr, *dataDir)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type server struct {
	web     fs.FS
	stores  map[string]*Store
	version string
	sw      []byte
	misses  *misses
}

func newServer(web fs.FS, stores map[string]*Store) http.Handler {
	s := &server{web: web, stores: stores, version: contentVersion(web), misses: newMisses(20, 10*time.Minute)}
	s.sw, _ = fs.ReadFile(web, "shared/sw.js")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	for _, a := range apps {
		a := a
		st := stores[a.ID]
		p := "/" + a.ID
		mux.Handle("GET "+p, http.RedirectHandler(p+"/", http.StatusMovedPermanently))
		mux.HandleFunc("POST "+p+"/api/codes", func(w http.ResponseWriter, r *http.Request) { s.newCode(w, r, st) })
		mux.HandleFunc("GET "+p+"/api/codes/{code}", func(w http.ResponseWriter, r *http.Request) { s.checkCode(w, r, st) })
		mux.HandleFunc("GET "+p+"/api/saves/{code}/{doc}", func(w http.ResponseWriter, r *http.Request) { s.getSave(w, r, a, st) })
		mux.HandleFunc("PUT "+p+"/api/saves/{code}/{doc}", func(w http.ResponseWriter, r *http.Request) { s.putSave(w, r, a, st) })
		if a.Shares {
			mux.HandleFunc("POST "+p+"/api/shares", func(w http.ResponseWriter, r *http.Request) { s.publish(w, r, a, st) })
			mux.HandleFunc("GET "+p+"/api/shares/{code}", func(w http.ResponseWriter, r *http.Request) { s.getShare(w, r, a, st) })
			mux.HandleFunc("PUT "+p+"/api/shares/{code}", func(w http.ResponseWriter, r *http.Request) { s.republish(w, r, a, st) })
		}
		mux.HandleFunc("GET "+p+"/manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) { s.manifest(w, r, a) })
		mux.HandleFunc("GET "+p+"/sw.js", func(w http.ResponseWriter, r *http.Request) { s.serviceWorker(w, r, a) })
	}
	mux.Handle("GET /", s.static())
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *server) newCode(w http.ResponseWriter, r *http.Request, st *Store) {
	code, err := st.NewCode(r.Context())
	if err != nil {
		log.Printf("new code: %v", err)
		http.Error(w, "could not make a code", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": code})
}

// tooManyMisses answers 429 for a client that has asked about too many unknown codes.
func (s *server) tooManyMisses(w http.ResponseWriter, r *http.Request) bool {
	if !s.misses.blocked(r) {
		return false
	}
	w.Header().Set("Retry-After", "600")
	http.Error(w, "too many unknown codes; try again later", http.StatusTooManyRequests)
	return true
}

func (s *server) checkCode(w http.ResponseWriter, r *http.Request, st *Store) {
	if s.tooManyMisses(w, r) {
		return
	}
	code := r.PathValue("code")
	ok, err := st.CodeExists(r.Context(), code)
	switch {
	case err != nil:
		log.Printf("check code: %v", err)
		http.Error(w, "error", http.StatusInternalServerError)
	case !ok:
		s.misses.record(r)
		writeJSON(w, http.StatusNotFound, map[string]bool{"exists": false})
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"exists": true})
	}
}

func docAllowed(a App, doc string) bool {
	for _, d := range a.Docs {
		if d == doc {
			return true
		}
	}
	return false
}

func (s *server) getSave(w http.ResponseWriter, r *http.Request, a App, st *Store) {
	if s.tooManyMisses(w, r) {
		return
	}
	code, doc := r.PathValue("code"), r.PathValue("doc")
	if !validCode(code) || !docAllowed(a, doc) {
		s.misses.record(r)
		http.NotFound(w, r)
		return
	}
	data, err := st.Get(r.Context(), code, doc)
	if errors.Is(err, ErrNotFound) {
		// A new code has no save yet; only a code that does not exist counts as a guess.
		if ok, _ := st.CodeExists(r.Context(), code); !ok {
			s.misses.record(r)
		}
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("get %s/%s: %v", a.ID, doc, err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// MaxSave bounds one save document. The largest real save is a few KB.
const MaxSave = 256 << 10

func (s *server) putSave(w http.ResponseWriter, r *http.Request, a App, st *Store) {
	if s.tooManyMisses(w, r) {
		return
	}
	code, doc := r.PathValue("code"), r.PathValue("doc")
	if !validCode(code) || !docAllowed(a, doc) {
		s.misses.record(r)
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxSave))
	if err != nil {
		http.Error(w, "save too large", http.StatusRequestEntityTooLarge)
		return
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		http.Error(w, "save must be a JSON object", http.StatusBadRequest)
		return
	}
	// Stored byte for byte, so a reader sees exactly what the writer sent.
	err = st.Put(r.Context(), code, doc, body)
	if errors.Is(err, ErrNotFound) {
		s.misses.record(r)
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("put %s/%s: %v", a.ID, doc, err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MaxShare bounds one shared item. A full dungeon with every sign written is about 10 KB.
const MaxShare = 64 << 10

// shareBody is what a client sends to publish: its own save code, and the item itself.
type shareBody struct {
	Owner string          `json:"owner"`
	Data  json.RawMessage `json:"data"`
}

func readShare(w http.ResponseWriter, r *http.Request) (shareBody, bool) {
	var b shareBody
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxShare+1024))
	if err != nil {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return b, false
	}
	var obj map[string]any
	if json.Unmarshal(raw, &b) != nil || !validCode(b.Owner) || json.Unmarshal(b.Data, &obj) != nil || len(b.Data) > MaxShare {
		http.Error(w, "want {owner, data} with data a JSON object", http.StatusBadRequest)
		return b, false
	}
	return b, true
}

func (s *server) publish(w http.ResponseWriter, r *http.Request, a App, st *Store) {
	b, ok := readShare(w, r)
	if !ok {
		return
	}
	code, err := st.Publish(r.Context(), b.Owner, b.Data)
	if errors.Is(err, ErrNotFound) {
		s.misses.record(r)
		http.Error(w, "unknown save code", http.StatusForbidden)
		return
	}
	if err != nil {
		log.Printf("publish %s: %v", a.ID, err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": code})
}

func (s *server) republish(w http.ResponseWriter, r *http.Request, a App, st *Store) {
	code := r.PathValue("code")
	if !validCode(code) {
		http.NotFound(w, r)
		return
	}
	b, ok := readShare(w, r)
	if !ok {
		return
	}
	switch err := st.Republish(r.Context(), code, b.Owner, b.Data); {
	case errors.Is(err, ErrNotFound):
		http.NotFound(w, r)
	case errors.Is(err, ErrNotOwner):
		http.Error(w, "only the save that published this can change it", http.StatusForbidden)
	case err != nil:
		log.Printf("republish %s: %v", a.ID, err)
		http.Error(w, "error", http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *server) getShare(w http.ResponseWriter, r *http.Request, a App, st *Store) {
	if s.tooManyMisses(w, r) {
		return
	}
	code := r.PathValue("code")
	data, err := st.Shared(r.Context(), code)
	if errors.Is(err, ErrNotFound) || (err == nil && !validCode(code)) {
		s.misses.record(r)
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("share %s: %v", a.ID, err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

func (s *server) manifest(w http.ResponseWriter, r *http.Request, a App) {
	start := "/" + a.ID + "/"
	// iOS reads the manifest when "Add to Home Screen" is tapped, from the page the person is
	// on. Carrying the code in start_url hands the save to the installed app.
	if c := r.URL.Query().Get("code"); validCode(c) {
		start += "?code=" + c
	}
	icons := "/" + a.ID + "/icons/"
	m := map[string]any{
		"id":               "/" + a.ID + "/",
		"name":             a.Name,
		"short_name":       a.ShortName,
		"start_url":        start,
		"scope":            "/" + a.ID + "/",
		"display":          "standalone",
		"orientation":      "any",
		"theme_color":      a.Theme,
		"background_color": a.Background,
		"icons": []map[string]string{
			{"src": icons + "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
			{"src": icons + "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
			{"src": icons + "maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
		},
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(m)
}

// serviceWorker serves shared/sw.js with this app's precache list and a version that changes
// whenever any embedded file does, so each deploy installs a fresh worker.
func (s *server) serviceWorker(w http.ResponseWriter, r *http.Request, a App) {
	files := []string{"/" + a.ID + "/"}
	for _, root := range []string{a.ID, "shared"} {
		fs.WalkDir(s.web, root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			base := path.Base(p)
			if base == "index.html" || base == "sw.js" || strings.HasPrefix(base, ".") || strings.HasPrefix(p, a.ID+"/splash/") {
				return nil
			}
			files = append(files, "/"+p)
			return nil
		})
	}
	sort.Strings(files[1:])
	list, _ := json.Marshal(files)
	head := fmt.Sprintf("const VERSION = %q;\nconst APP = %q;\nconst PRECACHE = %s;\n", s.version, a.ID, list)
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Service-Worker-Allowed", "/"+a.ID+"/")
	io.WriteString(w, head)
	w.Write(s.sw)
}

func (s *server) static() http.Handler {
	files := http.FileServerFS(s.web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/") || strings.HasSuffix(p, ".html"):
			w.Header().Set("Cache-Control", "no-cache")
		case strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css"):
			w.Header().Set("Cache-Control", "no-cache")
		default:
			// Images and fonts never change in place.
			w.Header().Set("Cache-Control", "public, max-age=604800")
		}
		// Unknown API routes, and the worker template (served per app as /<app>/sw.js).
		if strings.Contains(p, "/api/") || p == "/shared/sw.js" {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func contentVersion(web fs.FS) string {
	h := sha256.New()
	fs.WalkDir(web, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(web, p)
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%s\x00%d\x00", p, len(b))
		h.Write(b)
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// backupLoop writes a consistent copy of each database once a day and keeps two weeks.
func backupLoop(ctx context.Context, dataDir string, stores map[string]*Store) {
	dir := filepath.Join(dataDir, "backups")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		log.Printf("backups: %v", err)
		return
	}
	run := func() {
		day := time.Now().Format("2006-01-02")
		for id, st := range stores {
			dst := filepath.Join(dir, id+"-"+day+".db")
			if _, err := os.Stat(dst); err == nil {
				continue
			}
			if err := st.Backup(ctx, dst); err != nil {
				log.Printf("backup %s: %v", id, err)
			}
			old, _ := filepath.Glob(filepath.Join(dir, id+"-*.db"))
			sort.Strings(old)
			for len(old) > 14 {
				os.Remove(old[0])
				old = old[1:]
			}
		}
	}
	run()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

func importSave(args []string) error {
	fl := flag.NewFlagSet("import", flag.ExitOnError)
	appID := fl.String("app", "", "app id: dm or chain")
	doc := fl.String("doc", "", "document name, e.g. pda-save or game-v2")
	dataDir := fl.String("data", "data", "data directory")
	code := fl.String("code", "", "existing save code to write into (default: make a new one)")
	fl.Parse(args)
	if fl.NArg() != 1 {
		return errors.New("usage: kidapps import -app <id> -doc <name> [-code CODE] file.json")
	}
	var a *App
	for i := range apps {
		if apps[i].ID == *appID {
			a = &apps[i]
		}
	}
	if a == nil || !docAllowed(*a, *doc) {
		return fmt.Errorf("unknown app %q or doc %q", *appID, *doc)
	}
	body, err := os.ReadFile(fl.Arg(0))
	if err != nil {
		return err
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return fmt.Errorf("%s: %w", fl.Arg(0), err)
	}
	compact, _ := json.Marshal(obj)
	st, err := OpenStore(filepath.Join(*dataDir, a.ID+".db"))
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	c := *code
	if c == "" {
		if c, err = st.NewCode(ctx); err != nil {
			return err
		}
	}
	if err := st.Put(ctx, c, *doc, compact); err != nil {
		return err
	}
	fmt.Println(c)
	return nil
}
