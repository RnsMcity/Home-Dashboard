# HomeDashboard

A lightweight, self-hosted digital wall display for a Raspberry Pi + landscape
monitor. It replaces DAKboard-style dashboards with something that feels like a
purpose-built appliance: a full-screen photo slideshow with the time, weather,
and calendar overlaid — no interaction required, ever.

![The dashboard: photo slideshow with clock, weather, and calendar overlays](docs/screenshot.jpg)

```
Raspberry Pi powers on → OS boots → dashboard service starts → Chrome launches
in kiosk mode → dashboard fills the display → runs indefinitely
```

## Features

- **Clock & date** — system timezone, updates live, works fully offline
- **Photo slideshow** — local directory, crossfade transitions, cover-crop with
  no distortion, bounded memory (photos are downscaled to viewport size),
  corrupt photos skipped automatically
- **Weather** — OpenWeatherMap by default (keyless Open-Meteo fallback
  available); last successful response is cached and shown during outages with
  a subtle "updated N min ago" note
- **Calendar** — any ICS/iCal feed URL (Google Calendar public feeds work
  without OAuth); today's events first, then upcoming; cached across failures
- **Reliability** — every panel degrades independently; the display keeps
  working with no internet, a dead weather API, an unreachable calendar, or a
  missing photo directory. systemd restarts everything after crashes and reboots

## Requirements

- Linux with systemd (Raspberry Pi OS recommended)
- Node.js >= 20 (no npm packages — the project has zero dependencies)
- Google Chrome or Chromium for kiosk mode
- A landscape display (tested at 1920×1080, 2560×1440, 3840×2160)

## Development quickstart

```bash
cp config.example.json config.json   # then edit it
npm start                            # serves http://127.0.0.1:8787/
npm test                             # unit tests (node:test, no deps)
```

Open `http://127.0.0.1:8787/` in a browser at 16:9 to see the dashboard.
Dev utilities (headless Chrome required):

```bash
node scripts/screenshot.mjs [url] [w] [h] [waitMs] [out.png]   # screenshot + page console
node scripts/soak.mjs [url] [durationMs] [sampleEveryMs] [out.png]  # long run + heap samples
```

## Configuration

`config.json` (next to `server/`; created from `config.example.json`). Edits are
picked up automatically within ~30s — no restart needed. Relative paths resolve
against the server's working directory (`/opt/homedashboard` when installed).

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8787` | Loopback-only HTTP port (never exposed to the network) |
| `photoDirectory` | `./photos` | Folder with photos (top level only; `.jpg .jpeg .png .webp`) |
| `photoIntervalSeconds` | `300` | Seconds between photo changes (min 5) |
| `weather.provider` | `openweathermap` | `openweathermap` or `open-meteo` |
| `weather.latitude` / `weather.longitude` | `null` | Location; weather panel stays hidden until set. Find yours at any "what's my lat/lng" site, or from a map provider |
| `weather.units` | `imperial` | `metric` (°C) or `imperial` (°F) |
| `calendar.feedUrl` | `""` | ICS feed URL; empty hides the calendar panel |
| `calendar.refreshMinutes` | `15` | How often the server re-fetches the feed |
| `calendar.maxEvents` | `6` | Max event rows shown (day headers don't count) |
| `display.theme` | `dark` | `dark` or `light` text/panel treatment |
| `display.marginPx` | `0` | Uniform inset (px) applied to every side of the panel area — for TV/monitor overscan. Photos stay full-bleed; applies on page load (`sudo systemctl restart homedashboard-display`) |
| `display.marginTopPx` / `marginLeftPx` / `marginRightPx` / `marginBottomPx` | `null` | Per-side override (px); when set, wins over `marginPx` for that side. `null` = use the uniform value |

### Weather provider setup

**OpenWeatherMap (default).** Free account at openweathermap.org → API keys.
The key is a secret: it goes in `/etc/homedashboard/env` (created by the
installer, mode 600), never in `config.json` or the repo:

```ini
OPENWEATHERMAP_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Open-Meteo (no key).** Set `"provider": "open-meteo"` and you're done — a
good fallback if you don't want to manage a key. Both providers feed the same
normalized UI, so switching is one config line.

### Calendar setup (Google)

1. Google Calendar → Settings → **Integrate calendar**
2. For each calendar: *From this calendar* → make it **Private – Only I can see
   events** with a shareable link, or **Public for everyone** — copy the
   "Calendar Address" (looks like
   `https://calendar.google.com/calendar/feeds/<id>/public/basic`)
3. Paste that URL into `calendar.feedUrl`

The feed is fetched server-side (browsers can't fetch Google ICS directly due
to CORS), parsed, and cached. The parser handles UTC, floating times,
IANA-timezone events (`TZID=...` via the system's timezone database), all-day
events, line folding, and text escaping; cancelled events are dropped.

## Raspberry Pi deployment

```bash
# 1. Base packages (Raspberry Pi OS)
sudo apt update && sudo apt install -y nodejs chromium   # or google-chrome if you prefer
#    (Debian's nodejs may be old — check `node --version` >= 20, else use NodeSource)

# 2. Get the code onto the Pi (git clone, scp, USB — your choice), then:
sudo ./deploy/install.sh /path/to/HomeDashboard

# 3. Configure
nano /opt/homedashboard/config.json          # photo dir, lat/lng, calendar feed
nano /etc/homedashboard/env                  # OPENWEATHERMAP_API_KEY=...
sudo timedatectl set-timezone America/Detroit   # your timezone — the clock uses it

# 4. Go
sudo systemctl restart homedashboard homedashboard-display
```

`install.sh` copies the app to `/opt/homedashboard`, writes the three systemd
units, and enables them at boot. From then on: power on → dashboard fills the
screen.

Building the physical display? `case/` has parametric generators and ready STLs
for a 3D-printed frame + Raspberry Pi mount around a monitor — see
`case/README.md`.

The display unit needs a graphical session to draw into: the Pi must boot to
the desktop (`sudo raspi-config` → *System* → *Boot Options* → **Desktop** or
**Desktop Autologin**). Booting to console leaves Chrome with no X server —
the service fails with "Missing X server or $DISPLAY". The unit sets
`DISPLAY=:0` and orders itself after `lightdm.service`; if X isn't up yet at
first start, the 5s restart loop picks it up on the next attempt.

### How the pieces fit

| Unit | What it runs | Restart policy |
| --- | --- | --- |
| `homedashboard.service` | Node server (static UI + photo/weather/calendar APIs) | always, 5s delay |
| `homedashboard-display.service` | Chrome `--kiosk http://127.0.0.1:8787/` with a dedicated profile; an `ExecStartPre` gate waits for X **and** an HTTP 200 from the server before launching | always, 5s delay |
| `homedashboard-watchdog.service` | `scripts/kiosk-watchdog.mjs`: watches the kiosk tab over the loopback DevTools port; re-navigates (or force-restarts Chrome) if the tab ever ends up off the dashboard | always, 5s delay |

Why the watchdog exists: a browser never retries a failed *initial* navigation
— if Chrome's first page load dies mid-boot (its network service was seen
crashing under the boot storm on one Pi), `--kiosk` just sits on a white error
page forever, and `Restart=always` can't help because Chrome is still
"running". The watchdog closes that hole from outside, through the
loopback-only `--remote-debugging-port`.

If the server crashes, the browser keeps showing whatever is already rendered;
systemd brings the server back in ~5s and the next refresh cycle picks up. If
Chrome crashes or hangs into a restartable state, systemd relaunches it. The
server binds to loopback only — nothing is exposed on your network.

The mouse pointer is hidden everywhere: `cursor: none` in the dashboard CSS,
plus a blank X root cursor + `unclutter` set up by `deploy/hide-cursor.sh`
(install.sh runs it; it also registers itself in `~/.config/labwc/autostart`).

## Operations

```bash
systemctl status homedashboard homedashboard-display homedashboard-watchdog   # health
journalctl -u homedashboard -f                         # live server logs
journalctl -u homedashboard-watchdog -n 30             # recent watchdog heals
sudo systemctl restart homedashboard                   # after config edits (usually not needed)
ls /opt/homedashboard/cache/                           # last-good weather/calendar payloads
```

**Updating code:** copy new files over `/opt/homedashboard` (or git pull there),
then `sudo systemctl restart homedashboard`. The browser picks up UI changes on
its next launch; to force it now: `sudo systemctl restart homedashboard-display`.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Black screen, no clock | `systemctl status` both units; `journalctl -u homedashboard -n 50`; is the display actually on? |
| Blank **white** screen after a cold boot | Chrome's error page — the initial navigation failed. The watchdog should re-navigate within ~20s: `journalctl -u homedashboard-watchdog -n 30`. If it loops without healing, check `journalctl -u homedashboard-display` for "Network service crashed" or "Missing X server"; a one-off fix is `sudo systemctl restart homedashboard-display` |
| No photos | Is `photoDirectory` correct (absolute path recommended)? Files `.jpg/.jpeg/.png/.webp`, top level only. HEIC won't decode in Chrome |
| Weather panel missing | Location set in config? Key present in `/etc/homedashboard/env` and service restarted after editing it? Try `"provider": "open-meteo"` to isolate |
| Calendar empty | Feed URL reachable from the Pi (`curl -I <url>`)? Is the calendar actually shareable/public? |
| Wrong time/date | `timedatectl` — set timezone; ensure NTP is running (`systemd-timesyncd`) |

## Architecture

```
server/            zero-dependency Node.js (built-in http, fs)
├── index.js       routes: static UI, /api/config, /api/photos, /photos/*,
│                  /api/weather, /api/calendar; global crash handlers
├── config.js      defaults ← config.json merge + validation + hot reload
├── cache.js       atomic disk cache for last-successful responses
├── photos.js      directory scan (allowlist) + traversal-safe file serving
├── ical-time.js   pure RFC-5545 date parsing (UTC / floating / TZID via Intl)
├── weather/       provider interface + openweathermap + open-meteo
└── calendar/ics.js  ICS fetch + tolerant parser → normalized events

public/            vanilla ES modules, no build step, no framework
├── app.js         bootstraps panels; each panel isolated in try/catch
├── clock.js       system-timezone clock (offline-safe)
├── photos.js      two-canvas crossfade engine; decodes once, draws to a
│                  viewport-sized canvas (memory bounded by display resolution)
├── weather.js     renders normalized weather + subtle stale note
└── calendar.js    pure select/group logic (shared with tests) + rendering

deploy/            systemd units (server, display, watchdog) + install.sh
case/              parametric 3D-printable display frame + Pi mount
                   (Python generators; STLs + blend in case/out/)
test/              node:test suites: config, cache, photos, weather, calendar
scripts/           kiosk-watchdog.mjs (shipped, runs on the Pi) + CDP
                   screenshot/soak dev tools
```

Key decisions (also in `AGENTS.md`): zero npm dependencies; loopback-only
server; every external dependency is cached and degrades quietly; secrets live
in `/etc/homedashboard/env`, never in the repo.
