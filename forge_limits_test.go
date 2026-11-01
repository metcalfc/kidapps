package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"testing"
)

func writtenForgeMap(id int) map[string]any {
	const w, h = 32, 24
	cells := bytes.Repeat([]byte("."), w*h)
	cells[0], cells[len(cells)-1] = 'S', 'E'
	things := map[string]any{}
	for i := 1; i <= 400; i++ {
		cells[i] = 's'
		// These legal characters are six bytes apiece in JSON.stringify/Go JSON.
		things[fmt.Sprint(i)] = map[string]string{"text": strings.Repeat("\u2028", 160)}
	}
	walls := bytes.Repeat([]byte("."), w*(h+1)+(w+1)*h)
	for x := 0; x < w; x++ {
		walls[x], walls[h*w+x] = 'K', 'K'
	}
	for y := 0; y < h; y++ {
		walls[w*(h+1)+y*(w+1)], walls[w*(h+1)+y*(w+1)+w] = 'K', 'K'
	}
	return map[string]any{"id": fmt.Sprint(id), "v": 2, "size": "large", "title": "Written map", "cells": string(cells), "ground": strings.Repeat("c", w*h), "walls": string(walls), "things": things, "rev": 1}
}

func TestForgeWrittenMapAndTwelveMapBackupFitHTTP(t *testing.T) {
	handler, stores := syncHTTPServer(t)
	code := syncCode(t, stores["dm"])
	dungeon := writtenForgeMap(1)
	data, _ := json.Marshal(dungeon)
	if len(data) <= 64<<10 || len(data) >= MaxShare {
		t.Fatalf("fixture should exceed the old share limit and fit the new one: %d", len(data))
	}
	request, _ := json.Marshal(map[string]any{"owner": code, "data": dungeon})
	w := syncRequest(handler, "POST", "/dm/api/shares", string(request), nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("written map publish: %d %s", w.Code, w.Body.String())
	}
	var published struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &published)
	w = syncRequest(handler, "GET", "/dm/api/shares/"+published.Code, "", nil)
	if w.Code != http.StatusOK || !bytes.Equal(bytes.TrimSpace(w.Body.Bytes()), data) {
		t.Fatalf("written map share did not round-trip: %d", w.Code)
	}
	maps := make([]map[string]any, 12)
	for i := range maps {
		maps[i] = writtenForgeMap(i)
	}
	backup, _ := json.Marshal(map[string]any{"forge": map[string]any{"dungeons": maps}})
	if len(backup) <= MaxSave || len(backup) >= MaxDMSave {
		t.Fatalf("fixture should exceed the ordinary save limit and fit DM: %d", len(backup))
	}
	url := "/dm/api/saves/" + code + "/pda-save"
	w = syncRequest(handler, "PUT", url, string(backup), map[string]string{"X-Kidapps-Mutation": "forge-size-create-0001", "If-None-Match": "*"})
	if w.Code != http.StatusOK || !bytes.Equal(bytes.TrimSpace(w.Body.Bytes()), backup) {
		t.Fatalf("twelve map backup: %d", w.Code)
	}
	w = syncRequest(handler, "GET", url, "", nil)
	if w.Code != http.StatusOK || !bytes.Equal(bytes.TrimSpace(w.Body.Bytes()), backup) {
		t.Fatalf("twelve map restore: %d", w.Code)
	}
}

func TestSaveSizeLimitsRemainBoundedPerApp(t *testing.T) {
	handler, stores := syncHTTPServer(t)
	for _, app := range []string{"chain", "dm"} {
		code := syncCode(t, stores[app])
		limit, doc := MaxSave, "game-v2"
		if app == "dm" {
			limit, doc = MaxDMSave, "pda-save"
		}
		w := syncRequest(handler, "PUT", "/"+app+"/api/saves/"+code+"/"+doc, `{"large":"`+strings.Repeat("x", limit)+`"}`, nil)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("%s over-limit backup: %d", app, w.Code)
		}
	}
}

func TestDMSyncBundleAndOfflinePrecache(t *testing.T) {
	web, _ := fs.Sub(webFS, "web")
	handler := newServer(web, map[string]*Store{})
	w := syncRequest(handler, "GET", "/shared/dm-sync.js", "", nil)
	var want []byte
	for _, name := range []string{"sync-store.js", "merge.js", "sync-storage.js", "sync.js"} {
		data, _ := fs.ReadFile(web, "shared/"+name)
		want = append(append(want, data...), '\n', ';', '\n')
	}
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), want) || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("DM bundle must serve current shared modules in order: %d", w.Code)
	}
	w = syncRequest(handler, "GET", "/dm/sw.js", "", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "/shared/dm-sync.js") {
		t.Fatal("offline DM worker must precache the new sync bundle")
	}
}
