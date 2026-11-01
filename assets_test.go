package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func TestInstalledPagesFetchMatchingReleaseScriptsAndPrecacheThem(t *testing.T) {
	web, _ := fs.Sub(webFS, "web")
	handler := newServer(web, map[string]*Store{})
	version := contentVersion(web)
	for _, app := range []string{"dm", "signal", "chain"} {
		page := syncRequest(handler, "GET", "/"+app+"/", "", nil)
		if page.Code != http.StatusOK {
			t.Fatalf("%s page: %d", app, page.Code)
		}
		worker := syncRequest(handler, "GET", "/"+app+"/sw.js", "", nil)
		match := regexp.MustCompile(`const PRECACHE = (\[[^\n]+\]);`).FindStringSubmatch(worker.Body.String())
		if len(match) != 2 {
			t.Fatalf("%s precache list missing", app)
		}
		var precache []string
		if err := json.Unmarshal([]byte(match[1]), &precache); err != nil {
			t.Fatal(err)
		}
		cached := map[string]bool{}
		for _, name := range precache {
			cached[name] = true
		}
		scripts := scriptSource.FindAllSubmatch(page.Body.Bytes(), -1)
		if len(scripts) == 0 {
			t.Fatalf("%s has no scripts", app)
		}
		for _, script := range scripts {
			url := string(script[2])
			prefix := "/assets/" + version + "/"
			if !strings.HasPrefix(url, prefix) {
				t.Fatalf("%s uses unpinned script %s", app, url)
			}
			// Installed older workers have cache-first entries at the original
			// paths (and ignore query strings). A different path bypasses them.
			name := strings.TrimPrefix(url, prefix)
			oldCachedPath := "/" + name
			if strings.Split(url, "?")[0] == oldCachedPath {
				t.Fatalf("old worker could supply stale %s", url)
			}
			if !cached[url] {
				t.Fatalf("offline %s page is missing %s", app, url)
			}
			asset := syncRequest(handler, "GET", url, "", nil)
			var want []byte
			var err error
			if name == "shared/dm-sync.js" {
				want, err = dmSyncBundle(web)
			} else {
				want, err = fs.ReadFile(web, name)
			}
			if err != nil || asset.Code != http.StatusOK || !bytes.Equal(asset.Body.Bytes(), want) {
				t.Fatalf("%s script does not match this release: %s, status %d, error %v", app, url, asset.Code, err)
			}
		}
		if app == "signal" && !strings.Contains(page.Body.String(), prefixFor(version, "signal/story-fr.js")) {
			t.Fatal("relative story paths must resolve inside Signal")
		}
	}
}

func prefixFor(version, name string) string { return "/assets/" + version + "/" + name }

func TestReleaseIdentityChangesScriptPathsAndRejectsInvalidAssets(t *testing.T) {
	makeWeb := func(script string) fstest.MapFS {
		return fstest.MapFS{
			"dm/index.html": {Data: []byte(`<script src="/shared/one.js"></script>`)},
			"shared/one.js": {Data: []byte(script)},
			"shared/sw.js":  {Data: []byte("// worker")},
		}
	}
	before, after := makeWeb("old script"), makeWeb("new script")
	oldVersion, newVersion := contentVersion(before), contentVersion(after)
	if oldVersion == newVersion {
		t.Fatal("script changes must create a new release")
	}
	handler := newServer(after, map[string]*Store{})
	for _, url := range []string{
		prefixFor(oldVersion, "shared/one.js"),
		prefixFor(newVersion, "shared/sw.js"),
		prefixFor(newVersion, "dm/index.html"),
		prefixFor(newVersion, "missing.js"),
	} {
		if w := syncRequest(handler, "GET", url, "", nil); w.Code != http.StatusNotFound {
			t.Fatalf("invalid asset %s: %d", url, w.Code)
		}
	}
}

func TestPageReceivedBeforeDeploymentCanFinishLoadingItsOriginalScripts(t *testing.T) {
	makeWeb := func(script string) fstest.MapFS {
		return fstest.MapFS{
			"dm/index.html":        {Data: []byte(`<script src="/shared/dm-sync.js"></script><script src="/shared/one.js"></script>`)},
			"dm/sync-scripts.json": {Data: []byte(`["shared/one.js"]`)},
			"shared/one.js":        {Data: []byte(script)},
			"shared/sw.js":         {Data: []byte("// worker")},
		}
	}
	directory := t.TempDir()
	before, after := makeWeb("release A code"), makeWeb("release B code")
	if err := preserveScriptAssets(before, directory); err != nil {
		t.Fatal(err)
	}
	first := newServerWithAssets(before, map[string]*Store{}, os.DirFS(directory))
	page := syncRequest(first, "GET", "/dm/", "", nil)
	// The server restarts between HTML delivery and blocking script requests.
	if err := preserveScriptAssets(after, directory); err != nil {
		t.Fatal(err)
	}
	second := newServerWithAssets(after, map[string]*Store{}, os.DirFS(directory))
	for _, script := range scriptSource.FindAllSubmatch(page.Body.Bytes(), -1) {
		url := string(script[2])
		old := syncRequest(first, "GET", url, "", nil)
		current := syncRequest(second, "GET", url, "", nil)
		if current.Code != http.StatusOK || !bytes.Equal(old.Body.Bytes(), current.Body.Bytes()) {
			t.Fatalf("previous HTML lost its exact script after deployment: %s, status %d", url, current.Code)
		}
		if !strings.Contains(current.Body.String(), "release A code") {
			t.Fatal("previous release path must not serve replacement code")
		}
	}
	current := syncRequest(second, "GET", prefixFor(contentVersion(after), "shared/one.js"), "", nil)
	if current.Body.String() != "release B code" {
		t.Fatal("new HTML must use the new release")
	}
}
