# AGENTS.md — HomeDashboard

Guidance for AI coding agents (and humans) working in this repository.

## What this is

A self-hosted digital wall display appliance for a Raspberry Pi + landscape
monitor. It must boot into a fullscreen dashboard and run unattended for weeks:
clock, weather, calendar, photo slideshow. **Reliability > features.** The UI
is never touched by a user — no navigation, no settings screens, no login.

## Hard constraints (do not violate)

1. **Zero npm dependencies.** Node built-ins only (`node:http`, `node:fs`,
   `node:test`, global `fetch`/`WebSocket`). No build step for the frontend —
   plain ES modules in `public/`. This is what makes Pi deployment trivial.
2. **Loopback only.** The server binds `127.0.0.1`. Never expose it to the LAN.
3. **Secrets never in the repo.** API keys live in `/etc/homedashboard/env`
   (systemd `EnvironmentFile`, mode 600) or process env. `config.json` is
   gitignored; only `config.example.json` is committed.
4. **No panel may take down the dashboard.** Every external dependency
   (weather API, calendar feed, photo directory, even config parsing) can fail
   at any time and must degrade quietly: serve cached data with a subtle stale
   note, or hide that one panel. Uncaught server exceptions → log + `exit(1)`
   so systemd restarts cleanly; the browser keeps showing rendered content.
5. **Cache everything external.** Last successful weather/calendar responses go
   to disk (`cache/`, gitignored) and survive restarts *and* outages.

## Running & testing

```bash
npm test          # node --test 'test/*.test.js' — all logic tests, no Pi needed
npm start         # dev server on http://127.0.0.1:8787/ (uses ./config.json)
node scripts/screenshot.mjs [url] [w] [h] [waitMs] [out.png]   # headless Chrome shot + page console
node scripts/soak.mjs [url] [durationMs] [sampleEveryMs] [out.png]  # long run + JS heap samples
```

- Dev config is `config.json` (gitignored). Point `photoDirectory` at
  `./dev/photos`, calendar at `http://127.0.0.1:8787/dev/sample.ics`.
- **Restarting the dev server:** start it detached —
  `setsid nohup node server/index.js > /tmp/hd.log 2>&1 < /dev/null &`
  (plain backgrounding gets killed when a shell session ends). Kill with
  `pkill -f 'server/[i]ndex.js'` — the bracket trick avoids matching your own
  shell's command line.
- UI verification is screenshot-based: run the CDP script, look at the PNG.
  Use real-time waits (the old `--virtual-time-budget` flag does not let image
  decoding finish).

## Architecture map

```
server/index.js        routes + global crash handlers; TTL caches for weather/calendar
server/config.js       DEFAULTS ← config.json deep-merge, validation, hot reload (30s poll)
                       invalid edits are rejected — previous good config is kept
server/cache.js        DiskCache: atomic tmp+rename JSON files under cache/
server/photos.js       scanPhotos (extension allowlist, top-level only),
                       resolvePhotoPath (traversal guard), stream serving
server/ical-time.js    pure RFC-5545 date parsing; TZID resolved via Intl offsets
server/weather/*       provider interface: fetchWeather(cfg, env) → normalized shape
server/calendar/ics.js tolerant ICS parser (RRULE expansion, EXDATE,
                       RECURRENCE-ID overrides) + feed fetcher

public/app.js          bootstraps panels, each wrapped in safeStart (try/catch)
public/photos.js       two-canvas crossfade; decode once → draw to viewport-sized
                       canvas (memory bounded by display resolution, not source size);
                       loadAnyPhoto() skips corrupt files on first paint AND rotation
public/weather.js      renders normalized weather; stale note when body.stale
public/calendar.js     selectEvents/buildGroups are PURE (imported by node tests)
scripts/kiosk-watchdog.mjs  loopback CDP tab guard (shipped to /opt): re-navigates
                       the kiosk tab off error/blank pages, escalates to
                       Browser.close; runs as homedashboard-watchdog.service
```

### Normalized shapes (the seams — keep them stable)

- Weather: `{ temperature, feelsLike, condition, iconKey, high, low,
  forecast: [{ day:'YYYY-MM-DD', high, low, iconKey }] }`
  `iconKey` ∈ the SVG files in `public/icons/`.
- Calendar events: `{ title, start: ISO, end: ISO|null, allDay }`

## Gotchas learned the hard way

- **OWM icon codes have no "00".** Clear sky is `01d`; clouds are `02–04`, fog
  `50`, drizzle `51–57`, rain `60–67`, snow `70–77`, showers `80–82`, storms
  `90–92`. Map by the two-digit prefix, not a "family digit".
- **OWM `/forecast` returns 40 entries (5 days × 8) in local-day order** — daily
  hi/lo come from grouping consecutive eights; don't re-bucket by UTC date.
- **ICS folding:** a continuation line's single leading space is the fold
  marker and is stripped on unfold. To keep a literal space at that position,
  the file must contain two spaces. Escapes: `\,` `\;` `\\` `\n`.
- **All-day ICS events use exclusive DTEND** (a one-day event ends at midnight
  of the next day). Selection logic relies on `[start, end)`.
- **Recurrence expansion is bounded**: `parseICS` expands RRULEs only within
  `[now-7d, now+90d]` so cached data stays useful through long outages.
  Unsupported RRULE features fall back to just the anchor occurrence — never throw.
- **TZID dates:** resolve wall-clock→UTC by iterating `Intl.DateTimeFormat`
  offsets (`wallToUtc` in `server/ical-time.js`). Don't hand-roll DST tables.
- **Canvas memory:** never keep full-resolution decoded images around — the
  canvas *is* the stored image; drop the `Image` reference after each fade.
- **Photo list refresh:** an empty `/api/photos` response must NOT clear the
  client's current list (directory temporarily unavailable → keep rotating).
- **A kiosk browser is not self-healing.** Chrome never retries a failed
  *initial* navigation (observed in the field: Chromium's network service
  crashed mid-load during the boot storm → white error page for days; the
  dashboard's own JS can't retry because it never loaded). `Restart=always`
  only helps if Chrome *exits*. Hence: the display unit's `ExecStartPre`
  waits for the X socket AND an HTTP 200 (`After=homedashboard.service`
  proves nothing — `Type=simple` is active at exec, before `listen()`), and
  kiosk-watchdog.mjs heals any later tab death via the loopback
  `--remote-debugging-port`. Keep both when touching deploy units.
- **Pi boot is a storm:** cloud-init + PackageKit + desktop session contend
  for a cold SD card; X here is Xwayland under labwc (`/tmp/.X11-unix/X0`
  appears ~+50s after power-on). Don't add more boot-time work to the
  critical path.

## Conventions

- Small files, one concern each; pure logic in functions that node tests can
  import from both `server/` and `public/`.
- No comments unless explaining *why* (non-obvious protocol behavior, etc.).
- Config changes must be validated (`validateConfig`) — bad values are rejected
  with a readable message, never crash the process.
- New external integrations: put them behind an interface like the weather
  providers, add unit tests with mocked `fetch`, and make failure return cached
  data or hide the panel — never throw into the UI.

## Current status

All core stages complete: scaffold, clock, slideshow, weather (OWM + open-meteo),
calendar (ICS), offline/cache hardening (verified via soak runs), deployment
(systemd units validated with `systemd-analyze verify`, install.sh). Remaining
real-world verification happens on the Pi itself: live OWM key test and a full
power-on-to-kiosk boot.
