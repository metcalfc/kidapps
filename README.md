# kidapps

Practice games for kids, built as installable web apps for iPad and Mac:

- **Pinehurst DM Academy** (`/dm/`): Dungeon Master training covering dice math, rules, encounter building, an initiative tracker and a dice lab. Its **Dungeon Forge** lets a kid build a dungeon on a gold budget, beat it, and share it with friends by code. The math is in the building (budgets, area, perimeter, splitting XP and treasure for the Guildmaster's commissions) and in the playing (saving throws, attack rolls, damage, counting loot). The story and signs are the builder's own writing, for friends to read.
- **Chain Reaction** (`/chain/`): times tables up to 12 × 12, where right answers earn screen time.
- **Signal** (`/signal/`): a reading mystery set in 1986. Each chapter is short documents (notebook pages, clippings, radio transcripts, a bus schedule, a receipt) and puzzles that need them: inference and detail questions, word meaning, story math (elapsed time, money, fractions of a mile), and codes with arithmetic in them (a cipher wheel, halved numbers, Morse, a grid code, phone keypad pairs). The story lives in the `CHAPTERS` array at the top of its script.

Live at https://kidapps.exe.xyz/.

## How saves work

There are no accounts. The first time a device opens an app, the server gives it a **save code** such as `OTTER-4821`. A parent finds it on the app's Parent / Grown-ups screen. Entering the same code on another device puts both devices on one save.

- Each app keeps its own codes in its own SQLite file (`dm.db`, `chain.db`, `signal.db`).
- Each device keeps a working copy in `localStorage` and syncs it to the server. The apps keep working offline and catch up when they reconnect. Another device's progress shows up within about 20 seconds, or as soon as the app comes back to the front.
- Each family chooses its own 4-digit parent PIN the first time they open the parent screen. The PIN is stored in their save. It keeps kids out of the settings; it is not real security.
- On iOS a home-screen app does not share storage with Safari. To carry the save across, the manifest's `start_url` includes the device's code, so the installed app opens on the same save.

### Sharing

Apps with `Shares: true` (DM Academy's Forge) can publish an item under its own share code: `POST /<app>/api/shares` with `{owner, data}`, where `owner` is the device's save code. `GET /<app>/api/shares/<code>` reads it back. `PUT` replaces it, but only for the save code that published it. A share code reveals nothing about the publisher's save code.

### Under the hood

The apps were first written as claude.ai artifacts, which save through `window.claude.use('db')`. `web/shared/save.js` provides that same small API against this server, so each app's own sync and merge code runs unchanged.

## Layout

```
main.go, store.go, misses.go   Go server: static files, save API, manifest, service worker, daily backups
web/dm/, web/chain/            the two apps (single-file HTML plus icons and launch screens)
web/shared/                    save.js, the service worker template, self-hosted fonts
deploy/                        Caddyfile, systemd units, deploy.sh
tools/gen-icons.sh             regenerates icons and iPad launch screens (needs rsvg-convert)
tools/gen-site.sh              landing page icons, favicons, and link-preview cards (run after gen-icons.sh)
```

## Running locally

```sh
go run . serve -addr 127.0.0.1:8765 -data ./data
open http://127.0.0.1:8765/
```

## Deploying

```sh
deploy/deploy.sh            # builds linux/amd64, installs kidapps + Caddy on kidapps.exe.xyz
```

Traffic goes exe.dev proxy (TLS) → Caddy on `:8000` → kidapps on `127.0.0.1:8080`.

Caddy handles:
- per-IP rate limits (`caddy-ratelimit`)
- a cap on request body size
- security headers and a CSP
- compression

The Go server separately limits guesses at codes that do not exist, which Caddy cannot see.

To make the site reachable by people without an exe.dev login (one-time):

```sh
ssh exe.dev share set-public kidapps
```

## Operations

Data lives in `/var/lib/kidapps/` on the VM. The server writes a daily snapshot of each database to `/var/lib/kidapps/backups/` and keeps 14 days.

Import a save from a JSON file (prints the new code):

```sh
sudo kidapps import -data /var/lib/kidapps -app chain -doc game-v2 save.json
```

Clear a family's forgotten parent PIN (they choose a new one on next open):

```sh
sudo sqlite3 /var/lib/kidapps/chain.db "UPDATE saves SET data = json_set(json_remove(data, '$.settings.pin'), '$.updatedAt', unixepoch() * 1000) WHERE code = 'OTTER-4821'"
sudo sqlite3 /var/lib/kidapps/dm.db    "UPDATE saves SET data = json_set(json_remove(data, '$.settings.pin'), '$.updatedAt', unixepoch() * 1000) WHERE code = 'OTTER-4821'"
```

Bumping `updatedAt` makes devices take the server copy at their next sync. Do it while the kid isn't playing: progress made on the device in the meantime can win the merge and bring the old PIN back.
