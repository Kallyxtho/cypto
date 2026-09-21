#!/usr/bin/env node
// Integration test for CyptoSim (server must be running on :3131).
// Run: node test-lifecycle.mjs   — prints PASS/FAIL per assertion, exits non-zero on failure.

const BASE = 'http://localhost:3131';
let failures = 0;

function ok(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const post = (path, data) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

async function main() {
  const health = await api('/api/health');
  ok('health ok', health.body.ok === true && health.status === 200);

  // clean slate (baseline aligned with config default capital)
  let r = await post('/api/reset', { startingCash: 100 });
  ok('reset to 100', r.status === 200 && r.body.portfolio.cash === 100);

  let st = await api('/api/state');
  ok('state cash 100', st.body.portfolio.cash === 100 && st.body.portfolio.equity === 100);
  ok('state has live prices', Object.keys(st.body.prices).length > 0, `got ${Object.keys(st.body.prices).length}`);

  const btcPrice = st.body.prices.BTCUSDT?.price;
  ok('BTC price present and positive', typeof btcPrice === 'number' && btcPrice > 0, String(btcPrice));

  // buy by explicit amount (within maxTradeUsd = 50)
  r = await post('/api/buy', { symbol: 'BTCUSDT', amountUsd: 40 });
  ok('buy 40 USD BTC accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  ok('buy qty positive', r.body.qty > 0);
  ok('buy price ~ market + slippage', approx(r.body.price, btcPrice * 1.0005, btcPrice * 0.001), `${r.body.price} vs ${btcPrice}`);
  ok('buy fee = 10 bps (0.1% of $40)', approx(r.body.feeUsd, 0.04, 0.005), String(r.body.feeUsd));
  ok('cash after buy = 60', approx(r.body.cashAfter, 60), String(r.body.cashAfter));

  st = await api('/api/state');
  const pos = st.body.portfolio.positions.BTCUSDT;
  ok('position recorded', pos && pos.qty > 0 && approx(pos.avgEntry, r.body.price, 0.01));
  ok('state cash = 60', approx(st.body.portfolio.cash, 60));

  // buy by percent of cash
  r = await post('/api/buy', { symbol: 'ETHUSDT', percentOfCash: 10 });
  ok('buy 10% of cash ETH accepted', r.status === 200, JSON.stringify(r.body));
  ok('percent buy spent ~6', approx(r.body.notionalUsd, 6, 0.5), String(r.body.notionalUsd));

  // sell half of BTC position
  st = await api('/api/state');
  const halfQty = st.body.portfolio.positions.BTCUSDT.qty / 2;
  const avgEntry = st.body.portfolio.positions.BTCUSDT.avgEntry;
  const cashBefore = st.body.portfolio.cash;
  r = await post('/api/sell', { symbol: 'BTCUSDT', percentOfPosition: 50 });
  ok('sell 50% BTC accepted', r.status === 200, JSON.stringify(r.body));
  ok('sell qty = half', approx(r.body.qty, halfQty, 1e-8), `${r.body.qty} vs ${halfQty}`);
  const expectedGross = halfQty * (btcPrice * (1 - 0.0005));
  const expectedCash = cashBefore + expectedGross * (1 - 0.001);
  ok('cash after sell matches price math', approx(r.body.cashAfter, expectedCash, 1), `${r.body.cashAfter} vs ${expectedCash}`);
  const expectedPnl = expectedGross * (1 - 0.001) - halfQty * avgEntry;
  ok('realizedPnl matches math', approx(r.body.realizedPnl, expectedPnl, 1), `${r.body.realizedPnl} vs ${expectedPnl}`);

  // full position close
  r = await post('/api/sell', { symbol: 'ETHUSDT', percentOfPosition: 100 });
  ok('sell 100% closes position', r.status === 200);
  st = await api('/api/state');
  ok('ETH position removed', !st.body.portfolio.positions.ETHUSDT);

  // error paths
  r = await post('/api/buy', { symbol: 'PEPEUSDT', amountUsd: 100 });
  ok('unknown symbol rejected', r.status === 400 && /unknown symbol/.test(r.body.error));
  r = await post('/api/sell', { symbol: 'SOLUSDT', percentOfPosition: 100 });
  ok('sell without position rejected', r.status === 400 && /no open position/.test(r.body.error));
  r = await post('/api/buy', { symbol: 'BTCUSDT', amountUsd: 99999 });
  ok('insufficient cash rejected', r.status === 400 && /insufficient cash/.test(r.body.error), JSON.stringify(r.body));
  r = await post('/api/buy', { symbol: 'BTCUSDT', amountUsd: 60 });
  ok('amount above maxTradeUsd rejected', r.status === 400 && /maxTradeUsd/.test(r.body.error), JSON.stringify(r.body));
  r = await post('/api/buy', { symbol: 'BTCUSDT', percentOfCash: 150 });
  ok('percentOfCash >100 rejected', r.status === 400);

  // history + trades + agent-log routes
  const hist = await api('/api/history?symbol=BTCUSDT&points=50');
  ok('price history has points', hist.status === 200 && hist.body.points.length > 0);
  const tr = await api('/api/trades?limit=10');
  ok('trades logged', tr.body.trades.length >= 4);

  // candles (real Binance klines)
  const cd = await api('/api/candles?symbol=BTCUSDT&limit=50');
  ok(
    'candles: real OHLC structure',
    cd.status === 200 &&
      cd.body.candles.length > 10 &&
      cd.body.candles.every((c) => c.o > 0 && c.h >= c.l && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)),
    JSON.stringify(cd.body).slice(0, 120)
  );
  ok(
    'candles: last close tracks live ticker',
    approx(cd.body.candles[cd.body.candles.length - 1].c, btcPrice, btcPrice * 0.01),
    `close ${cd.body.candles[cd.body.candles.length - 1]?.c} vs ticker ${btcPrice}`
  );
  const cdAll = await api('/api/candles');
  ok(
    'candles: bulk returns all symbols',
    cdAll.status === 200 && Object.keys(cdAll.body.candles).length >= 8 && cdAll.body.candles.BTCUSDT.length > 10
  );
  const cdBad = await api('/api/candles?symbol=PEPEUSDT');
  ok('candles: unknown symbol rejected', cdBad.status === 400 && /symbol required/.test(cdBad.body.error));

  // agent-log write path
  r = await post('/api/agent-log', { model: 'test', action: 'hold', confidence: 0.7, reason: 'test', result: 'HOLD' });
  ok('agent-log accepted', r.status === 200);
  const al = await api('/api/agent-log?limit=5');
  ok('agent-log readable', al.body.decisions.length > 0 && al.body.decisions[0].model === 'test');

  // final reset
  r = await post('/api/reset', {});
  ok('final reset ok (config default)', r.status === 200 && r.body.portfolio.cash === 100);
  const tradesAfter = await api('/api/trades');
  ok('trades cleared after reset', tradesAfter.body.trades.length === 0);

  console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 100);
}

main().catch((e) => {
  console.error('test crashed:', e.message);
  process.exit(1);
});
