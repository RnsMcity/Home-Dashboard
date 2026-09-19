// Dev utility: long-running dashboard session with memory sampling.
// Keeps one headless Chrome open for a duration in REAL time, samples the page
// JS heap periodically (to spot leaks during slideshow rotation), logs all
// console output, and saves a final screenshot.
//
// Usage: node scripts/soak.mjs [url] [durationMs] [sampleEveryMs] [out.png]

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8787/';
const durationMs = Number(process.argv[3]) || 5 * 60_000;
const sampleEveryMs = Number(process.argv[4]) || 30_000;
const out = process.argv[5] ?? `/tmp/opencode/shots/soak-${Date.now()}.png`;

const port = 9400 + Math.floor(Math.random() * 100);
const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--window-size=1920,1080',
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
    // not up yet
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

const samples = [];
const startedAt = Date.now();
let lastSample = 0;

console.log(`soak: running for ${Math.round(durationMs / 1000)}s, sampling every ${sampleEveryMs}ms`);
while (Date.now() - startedAt < durationMs) {
  const wait = Math.min(sampleEveryMs, durationMs - (Date.now() - startedAt));
  await new Promise((r) => setTimeout(r, wait));
  if (Date.now() - lastSample >= sampleEveryMs / 2) {
    try {
      const { result } = await send('Runtime.evaluate', {
        expression: 'performance.memory ? performance.memory.usedJSHeapSize : null',
        returnByValue: true,
      });
      if (typeof result.value === 'number') {
        lastSample = Date.now();
        samples.push(result.value);
        console.log(
          `[heap] t=${Math.round((Date.now() - startedAt) / 1000)}s used=${(result.value / 1048576).toFixed(1)}MB`,
        );
      }
    } catch {
      // sampling is best-effort
    }
  }
}

const { data } = await send('Page.captureScreenshot', { format: 'png' });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(data, 'base64'));

if (samples.length > 1) {
  const mb = (v) => (v / 1048576).toFixed(1);
  console.log(
    `[heap] min=${mb(Math.min(...samples))}MB max=${mb(Math.max(...samples))}MB last=${mb(samples.at(-1))}MB over ${samples.length} samples`,
  );
} else {
  console.log('[heap] no samples captured (performance.memory unavailable)');
}
console.log(`saved ${out}`);

ws.close();
chrome.kill();
process.exit(0);
