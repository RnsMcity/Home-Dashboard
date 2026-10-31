// Kiosk self-heal: the dashboard tab is the only thing standing between the
// wall and a blank screen, and Chromium never retries a failed initial
// navigation (a net-service hiccup mid-load leaves an error page forever,
// and Restart=always only fires when Chrome exits). This loop watches the
// kiosk tab over the DevTools endpoint (loopback only) and heals it:
//
//   page gone           -> open the dashboard tab (/json/new)
//   tab off the dashboard (error page, blank, ...)
//                         -> Page.navigate back, then escalate to a full
//                            Chrome restart (Browser.close, or SIGKILL of
//                            the unit's MainPID) if navigate won't stick
//
// Health is decided by Runtime.evaluate(window.location.href), NOT by the
// /json/list url: a failed navigation keeps showing its *intended* URL in
// the target list while the committed document is chrome-error://...
//
// Node 20 needs --experimental-websocket for the gentle Page.navigate path
// (the shipped unit passes it); without it the watchdog still detects and
// heals via MainPID kill, just less gently.
//
// Usage: node [--experimental-websocket] scripts/kiosk-watchdog.mjs
// Env:   HD_URL (default http://127.0.0.1:8787/), HD_CDP_PORT (default 9223),
//        HD_DISPLAY_UNIT (default homedashboard-display.service),
//        HD_WATCH_INTERVAL_MS (default 20000)

import { execFileSync } from 'node:child_process';

const EXPECTED = process.env.HD_URL ?? 'http://127.0.0.1:8787/';
const PORT = Number(process.env.HD_CDP_PORT) || 9223;
const DISPLAY_UNIT = process.env.HD_DISPLAY_UNIT || 'homedashboard-display.service';
const INTERVAL = Number(process.env.HD_WATCH_INTERVAL_MS) || 20_000;
const ESCALATE_AFTER = 3; // consecutive ticks where healing didn't take effect
const HAS_WEBSOCKET = typeof WebSocket === 'function';

const cdp = (p) => `http://127.0.0.1:${PORT}${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDashboard = (url) => url === EXPECTED || url === EXPECTED.replace(/\/+$/, '');

async function cdpCall(webSocketUrl, method, params = {}) {
  const ws = new WebSocket(webSocketUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('websocket connect failed'));
      setTimeout(() => reject(new Error('websocket open timeout')), 10_000);
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15_000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      };
      ws.onclose = () => reject(new Error('websocket closed'));
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

// The committed document's URL, or null when it can't be determined.
async function committedUrl(pageTarget) {
  if (!HAS_WEBSOCKET) return pageTarget.url ?? null; // url-only fallback
  try {
    const res = await cdpCall(pageTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    if (res?.exceptionDetails) return null;
    return res?.result?.value ?? null;
  } catch {
    return null;
  }
}

async function killChrome() {
  try {
    const browser = await fetch(cdp('/json/version'), { signal: AbortSignal.timeout(5000) });
    const { webSocketDebuggerUrl } = await browser.json();
    await cdpCall(webSocketDebuggerUrl, 'Browser.close');
    return;
  } catch {}
  // No DevTools websocket (Node 20 without the flag) or Browser.close
  // refused: same-user SIGKILL of the unit's main process is allowed and
  // systemd's Restart=always brings up a pristine Chrome behind the gate.
  const pid = Number(
    execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', DISPLAY_UNIT], {
      encoding: 'utf8',
    }).trim(),
  );
  if (pid > 0) {
    console.warn(`[watchdog] SIGKILL Chrome (pid ${pid}) for a clean systemd restart`);
    process.kill(pid, 'SIGKILL');
  }
}

async function tick(state) {
  let targets;
  try {
    const res = await fetch(cdp('/json/list'), { signal: AbortSignal.timeout(5000) });
    targets = await res.json();
  } catch {
    // DevTools unreachable: Chrome is down or between restarts. Its own
    // unit's Restart=always handles that; do not turn a misconfigured flag
    // into an infinite kill loop — log only.
    state.devtoolsDownSince ??= Date.now();
    if (Date.now() - state.devtoolsDownSince > 120_000) {
      console.error('[watchdog] DevTools unreachable for over 2 minutes; is --remote-debugging-port set?');
    }
    return;
  }
  delete state.devtoolsDownSince;

  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    state.noTabs = (state.noTabs ?? 0) + 1;
    console.warn('[watchdog] no page tab present; opening the dashboard');
    try {
      // Modern Chrome requires PUT for /json/new.
      await fetch(cdp(`/json/new?${encodeURIComponent(EXPECTED)}`), { method: 'PUT' });
    } catch (err) {
      console.warn('[watchdog] could not open a tab:', err.message);
    }
    if (state.noTabs > ESCALATE_AFTER) {
      console.error('[watchdog] still tab-less after repeated attempts; restarting Chrome');
      state.noTabs = 0;
      try {
        await killChrome();
      } catch (err) {
        console.warn('[watchdog] Chrome restart escalation failed:', err.message);
      }
    }
    return;
  }
  state.noTabs = 0;

  const url = await committedUrl(page);
  if (url && isDashboard(url)) {
    if (state.navigations > 0) console.log('[watchdog] dashboard restored');
    state.navigations = 0;
    return;
  }

  state.navigations += 1;
  if (state.navigations > ESCALATE_AFTER) {
    console.error(
      `[watchdog] tab stuck at ${JSON.stringify(url)} after ${ESCALATE_AFTER} attempts; restarting Chrome`,
    );
    try {
      await killChrome();
    } catch (err) {
      console.warn('[watchdog] Chrome restart escalation failed:', err.message);
    }
    state.navigations = 0;
    return;
  }
  console.warn(
    `[watchdog] tab at ${JSON.stringify(url)} (attempt ${state.navigations}); navigating to ${EXPECTED}`,
  );
  if (!HAS_WEBSOCKET) return; // escalation (MainPID kill) covers it
  try {
    await cdpCall(page.webSocketDebuggerUrl, 'Page.navigate', { url: EXPECTED });
  } catch (err) {
    console.warn('[watchdog] navigate failed:', err.message);
  }
}

console.log(
  `[watchdog] watching kiosk tab: ${EXPECTED} (CDP ${PORT}, every ${INTERVAL}ms, websocket=${HAS_WEBSOCKET})`,
);
const state = { navigations: 0 };
for (;;) {
  await tick(state);
  await sleep(INTERVAL);
}
