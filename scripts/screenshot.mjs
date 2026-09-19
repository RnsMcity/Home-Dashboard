// Dev utility: screenshot the dashboard via Chrome DevTools Protocol.
// Captures page console output (so slideshow/weather/calendar warnings are
// visible) and waits in REAL time so async work settles before capturing.
//
// Usage: node scripts/screenshot.mjs [url] [width] [height] [waitMs] [out.png]

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8787/';
const width = Number(process.argv[3]) || 1920;
const height = Number(process.argv[4]) || 1080;
const waitMs = Number(process.argv[5]) || 6000;
const out = process.argv[6] ?? `/tmp/opencode/shots/shot-${Date.now()}.png`;

const port = 9300 + Math.floor(Math.random() * 100);
const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

async function getJSON(p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return res.json();
}

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await getJSON('/json/list');
    target = list.find((t) => t.type === 'page') ?? null;
  } catch {
    // devtools not up yet
  }
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error('Chrome DevTools endpoint never came up');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log(`[page:${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('[page:exception]', d?.exception?.description ?? d?.text ?? JSON.stringify(d));
  }
};

await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

const loaded = new Promise((resolve) => {
  const handler = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.loadEventFired') {
      ws.removeEventListener('message', handler);
      resolve();
    }
  };
  ws.addEventListener('message', handler);
  setTimeout(resolve, 15000); // give up waiting for load; capture anyway
});
await loaded;
await new Promise((r) => setTimeout(r, waitMs));

const { data } = await send('Page.captureScreenshot', { format: 'png' });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`saved ${out}`);

ws.close();
chrome.kill();
process.exit(0);
