#!/usr/bin/env node
// Agent integration test: mock OpenAI-compatible LLM on :5199, simulator on :3131.
// Scenario 1: LLM answers with prose (no JSON)  -> agent must HOLD, no trade.
// Scenario 2: LLM answers with a typed decision -> agent must EXECUTE a buy.
// Run: node test-agent.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';

const SIM = 'http://localhost:3131';
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  }
};

let respondWith = '';
let lastBody = null; // last /chat/completions request captured from the agent
const mock = http.createServer((req, res) => {
  if (req.url && req.url.includes('/chat/completions')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: respondWith } }] }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => mock.listen(5199, r));

async function api(path, opts) {
  const res = await fetch(SIM + path, opts);
  return res.json();
}
const post = (path, data) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
// Async spawn keeps this process's event loop (and the mock server) alive while
// the agent runs; spawnSync would deadlock the in-process mock.
const runAgent = () =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['agent.mjs', '--once', '--base-url', 'http://localhost:5199/v1', '--model', 'mock'],
      { stdio: 'inherit' }
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

// Scenario 1: prose, no JSON
respondWith = 'I think bitcoin looks strong today, we should buy some!';
await post('/api/reset', {});
await runAgent();
let st = await api('/api/state');
ok('prose answer -> no position opened', Object.keys(st.portfolio.positions).length === 0, JSON.stringify(st.portfolio.positions));
let al = await api('/api/agent-log?limit=1');
ok('prose answer logged as hold', al.decisions?.[0]?.action === 'hold', JSON.stringify(al.decisions?.[0]));

// Scenario 2: valid typed decision
respondWith = JSON.stringify({
  action: 'buy',
  symbol: 'SOLUSDT',
  percentOfCash: 5,
  confidence: 0.9,
  reason: 'mock scenario buy',
});
await post('/api/reset', {});
await runAgent();
st = await api('/api/state');
const sol = st.portfolio.positions.SOLUSDT;
ok('typed decision opened SOLUSDT position', !!sol, JSON.stringify(st.portfolio.positions));
ok('position value ~5% of starting cash', sol && sol.value > 4.7 && sol.value < 5.1, sol ? String(sol.value) : 'no position');
al = await api('/api/agent-log?limit=1');
ok('agent log records executed buy', /EXECUTED/.test(al.decisions?.[0]?.result || ''), JSON.stringify(al.decisions?.[0]));
ok('agent log has model and reason', al.decisions?.[0]?.model === 'mock' && /mock scenario/.test(al.decisions?.[0]?.reason || ''));

// the agent must SEE the real market trend: candles + indicators in its prompt
const prompt = lastBody?.messages?.[1]?.content || '';
ok('prompt includes real candles section', /CANDLES \(real Binance 15m klines/.test(prompt), prompt.slice(0, 200));
ok('prompt includes indicators', /SMA20/.test(prompt) && /RSI14/.test(prompt) && /24h range/.test(prompt));
ok('prompt includes OHLC table for coins', /BTCUSDT now \$/.test(prompt) && /\d+\.\d+\/\d+\.\d+/.test(prompt));

// cleanup
await post('/api/reset', {});
mock.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL AGENT TESTS PASSED');
process.exitCode = failures ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 100);
