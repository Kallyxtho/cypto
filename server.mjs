#!/usr/bin/env node
// CyptoSim — realistic crypto market simulator with a fake (paper) portfolio.
// Real market prices in near-real-time, fake money. Zero npm dependencies.
// Run:  node server.mjs   ->   dashboard on http://localhost:3131

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.jsonl');
const AGENT_LOG_FILE = path.join(DATA_DIR, 'agent-log.jsonl');
const NEWS_CACHE_FILE = path.join(DATA_DIR, 'news-cache.json');

// ---------------------------------------------------------------- config
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const COINS = CFG.coins;
const SYMBOLS = COINS.map((c) => c.symbol);
const SYMBOL_BY_ID = Object.fromEntries(COINS.map((c) => [c.coingeckoId, c.symbol]));
const P = CFG.portfolio;
const HISTORY_CAP = 4320; // 6h of 5s samples

const now = () => Date.now();
const round8 = (n) => Math.round(n * 1e8) / 1e8;

class ValidationError extends Error {}

// ---------------------------------------------------------------- state
const state = {
  portfolio: null,
  prices: {}, // SYM -> { price, change24hPct, high24h, low24h, volume24hUsd, ts }
  dataSource: 'booting', // 'binance' | 'coingecko' | 'stale'
  lastMarketFetchOk: 0,
  lastMarketError: '',
  equityHistory: [], // [{t, equity}]
  priceHistory: {}, // SYM -> [{t, price}]
  news: [], // [{t, source, title, link, coins:[SYM]}]
  candles: {}, // SYM -> [{t, o, h, l, c, v}] — real Binance klines
  candlesSource: 'booting', // 'binance' | last good kept on failure
  lastCandlesFetchOk: 0,
  trades: [], // in-memory mirror of trades.jsonl (last 200)
  agentLog: [], // last 100 AI decisions
  bootedAt: now(),
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- persistence
function savePortfolio() {
  const p = state.portfolio;
  const payload = {
    ...p,
    equityHistory: state.equityHistory,
    updatedAt: now(),
  };
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(payload, null, 2));
}

function appendJsonl(file, entry) {
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    const { equityHistory, ...portfolio } = raw;
    // The starting capital is configuration, not history: adopt the current
    // config value (baseline for P&L) even when a saved portfolio is restored.
    portfolio.startingCash = P.startingCashUsd;
    state.portfolio = portfolio;
    state.equityHistory = Array.isArray(equityHistory) ? equityHistory.slice(-HISTORY_CAP) : [];
    console.log(`[state] portfolio restored: cash $${portfolio.cash.toFixed(2)} (startingCash from config: $${P.startingCashUsd})`);
  } catch {
    state.portfolio = initPortfolio();
    savePortfolio();
    console.log('[state] new portfolio initialized');
  }
  try {
    const text = fs.readFileSync(TRADES_FILE, 'utf8').trim();
    state.trades = text ? text.split('\n').slice(-200).map((l) => JSON.parse(l)) : [];
  } catch {
    state.trades = [];
  }
  try {
    state.news = JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf8'));
  } catch {
    state.news = [];
  }
}

function saveNewsCache() {
  fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify(state.news));
}

function initPortfolio(startingCash) {
  const cash = startingCash ?? P.startingCashUsd;
  return {
    startingCash: cash,
    cash,
    positions: {},
    realizedPnl: 0,
    feesPaidUsd: 0,
    createdAt: now(),
  };
}

// ---------------------------------------------------------------- market feed
async function fetchBinance() {
  const url =
    'https://api.binance.com/api/v3/ticker/24hr?symbols=' +
    encodeURIComponent(JSON.stringify(SYMBOLS));
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const arr = await res.json();
  const out = {};
  for (const t of arr) {
    out[t.symbol] = {
      price: parseFloat(t.lastPrice),
      change24hPct: parseFloat(t.priceChangePercent),
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      volume24hUsd: parseFloat(t.quoteVolume),
    };
  }
  return out;
}

async function fetchCoinGecko() {
  const ids = COINS.map((c) => c.coingeckoId).join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h&per_page=50`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const arr = await res.json();
  const out = {};
  for (const m of arr) {
    const sym = SYMBOL_BY_ID[m.id];
    if (!sym) continue;
    out[sym] = {
      price: m.current_price,
      change24hPct: m.price_change_percentage_24h ?? 0,
      high24h: m.high_24h ?? m.current_price,
      low24h: m.low_24h ?? m.current_price,
      volume24hUsd: m.total_volume ?? 0,
    };
  }
  return out;
}

function snapshotEquity(t) {
  let eq = state.portfolio.cash;
  for (const [sym, pos] of Object.entries(state.portfolio.positions)) {
    const q = state.prices[sym];
    if (q) eq += pos.qty * q.price;
  }
  state.equityHistory.push({ t, equity: Math.round(eq * 100) / 100 });
  if (state.equityHistory.length > HISTORY_CAP) state.equityHistory.shift();
}

let lastPollFailed = false;
async function pollMarket() {
  let fresh = null;
  let source = '';
  try {
    fresh = await fetchBinance();
    source = 'binance';
  } catch (e1) {
    try {
      fresh = await fetchCoinGecko();
      source = 'coingecko';
    } catch (e2) {
      state.lastMarketError = `binance: ${e1.message}; coingecko: ${e2.message}`;
    }
  }
  const t = now();
  if (fresh) {
    for (const sym of SYMBOLS) {
      const q = fresh[sym];
      if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
      state.prices[sym] = { ...q, ts: t };
      const h = (state.priceHistory[sym] ||= []);
      h.push({ t, price: q.price });
      if (h.length > HISTORY_CAP) h.shift();
    }
    state.dataSource = source;
    state.lastMarketFetchOk = t;
    state.lastMarketError = '';
    if (lastPollFailed) console.log(`[market] recovered via ${source}`);
    lastPollFailed = false;
    snapshotEquity(t);
    savePortfolio();
  } else {
    if (t - state.lastMarketFetchOk > CFG.market.staleAfterMs) {
      state.dataSource = 'stale';
    }
    if (!lastPollFailed) console.log(`[market] poll failed: ${state.lastMarketError}`);
    lastPollFailed = true;
  }
}

// ---------------------------------------------------------------- candles (real OHLC klines)
async function fetchKlines(symbol) {
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url =
        `${host}/api/v3/klines?symbol=${symbol}` +
        `&interval=${CFG.candles.binanceInterval}&limit=${CFG.candles.limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
      const arr = await res.json();
      return arr.map((k) => ({
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

let candlesPollFailed = false;
async function pollCandles() {
  const results = await Promise.allSettled(SYMBOLS.map((s) => fetchKlines(s)));
  let okCount = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length) {
      state.candles[SYMBOLS[i]] = r.value;
      okCount++;
    }
  });
  const t = now();
  if (okCount > 0) {
    state.candlesSource = 'binance';
    state.lastCandlesFetchOk = t;
    if (candlesPollFailed) console.log(`[candles] recovered for ${okCount}/${SYMBOLS.length} symbols`);
    candlesPollFailed = false;
  } else {
    if (!candlesPollFailed) console.log('[candles] all klines fetches failed; keeping last good data');
    candlesPollFailed = true;
  }
}

// ---------------------------------------------------------------- news
const COIN_KEYWORDS = Object.fromEntries(
  COINS.map((c) => [c.symbol, [c.symbol.replace(/USDT$/, ''), c.name.toLowerCase()]])
);

function tagCoins(text) {
  const low = text.toLowerCase();
  const tags = [];
  for (const sym of SYMBOLS) {
    for (const kw of COIN_KEYWORDS[sym]) {
      if (new RegExp(`\\b${kw}\\b`).test(low)) {
        tags.push(sym);
        break;
      }
    }
  }
  return tags;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1].trim();
  return v;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseRss(xml, source) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 40) {
    const block = m[1];
    const title = decodeEntities(extractTag(block, 'title'));
    const link = decodeEntities(extractTag(block, 'link'));
    if (!title) continue;
    const pub = extractTag(block, 'pubDate');
    items.push({
      t: pub ? Date.parse(pub) || now() : now(),
      source,
      title,
      link,
      coins: tagCoins(title),
    });
  }
  return items;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': 'CyptoSim/1.0 (paper trading simulator)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRss(await res.text(), new URL(url).host);
}

let newsFailed = false;
async function pollNews() {
  const results = await Promise.allSettled(CFG.news.feeds.map((f) => fetchFeed(f)));
  const seen = new Set(state.news.map((n) => n.link));
  let added = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!item.link || seen.has(item.link)) continue;
      seen.add(item.link);
      state.news.push(item);
      added++;
    }
  }
  state.news.sort((a, b) => b.t - a.t);
  if (state.news.length > CFG.news.maxItems) state.news.length = CFG.news.maxItems;
  if (added) saveNewsCache();
  if (newsFailed && added) console.log(`[news] recovered, +${added} items`);
  newsFailed = !added && results.every((r) => r.status === 'rejected');
  if (newsFailed) console.log('[news] all feeds failed this round');
}

// ---------------------------------------------------------------- trading engine
function getPrice(sym) {
  const q = state.prices[sym];
  if (!q) throw new ValidationError(`no price available for ${sym} yet`);
  return q;
}

function requireLiveMarket() {
  if (state.dataSource === 'stale' || now() - state.lastMarketFetchOk > CFG.market.staleAfterMs) {
    throw new ValidationError('market data is stale; refusing to execute at an unknown price');
  }
}

function posOf(sym) {
  return state.portfolio.positions[sym] || null;
}

function recordTrade(trade) {
  state.trades.push(trade);
  if (state.trades.length > 200) state.trades.shift();
  appendJsonl(TRADES_FILE, trade);
  console.log(
    `[TRADE] ${trade.side.toUpperCase()} ${trade.qty} ${trade.symbol} @ $${trade.price} ` +
      `(fee $${trade.feeUsd.toFixed(2)}) — cash $${state.portfolio.cash.toFixed(2)}`
  );
}

function buy({ symbol, amountUsd, percentOfCash }) {
  requireLiveMarket();
  if (!SYMBOLS.includes(symbol)) throw new ValidationError(`unknown symbol ${symbol}; allowed: ${SYMBOLS.join(', ')}`);
  const q = getPrice(symbol);

  if (percentOfCash != null) {
    if (!(percentOfCash > 0 && percentOfCash <= 100)) throw new ValidationError('percentOfCash must be in (0, 100]');
    amountUsd = state.portfolio.cash * (percentOfCash / 100);
  }
  if (!(amountUsd > 0)) throw new ValidationError('amountUsd must be > 0');
  if (amountUsd > state.portfolio.cash) throw new ValidationError(`insufficient cash: have $${state.portfolio.cash.toFixed(2)}, need $${amountUsd.toFixed(2)}`);
  // percent-based buys are capped at maxTradeUsd; explicit amounts over the cap are refused
  let capped = false;
  if (percentOfCash != null) {
    if (amountUsd > P.maxTradeUsd) {
      amountUsd = P.maxTradeUsd;
      capped = true;
    }
  } else if (amountUsd > P.maxTradeUsd) {
    throw new ValidationError(`amountUsd $${amountUsd.toFixed(2)} exceeds maxTradeUsd $${P.maxTradeUsd}`);
  }

  const execPrice = q.price * (1 + P.slippageBps / 10000); // market buy crosses the spread
  const fee = amountUsd * (P.feeBps / 10000);
  const qty = round8((amountUsd - fee) / execPrice);
  if (qty <= 0) throw new ValidationError('amount too small to produce a positive quantity after fees');

  const pos = posOf(symbol);
  if (pos) {
    pos.avgEntry = (pos.qty * pos.avgEntry + qty * execPrice) / (pos.qty + qty);
    pos.qty = round8(pos.qty + qty);
  } else {
    state.portfolio.positions[symbol] = { qty, avgEntry: execPrice };
  }
  state.portfolio.cash -= amountUsd;
  state.portfolio.feesPaidUsd = round8((state.portfolio.feesPaidUsd || 0) + fee);

  const trade = {
    t: now(),
    side: 'buy',
    symbol,
    qty,
    price: Math.round(execPrice * 100) / 100,
    feeUsd: Math.round(fee * 100) / 100,
    notionalUsd: Math.round(amountUsd * 100) / 100,
    cashAfter: Math.round(state.portfolio.cash * 100) / 100,
  };
  recordTrade(trade);
  savePortfolio();
  return {
    ok: true,
    ...trade,
    cappedAtMaxTrade: capped || undefined,
    position: state.portfolio.positions[symbol],
  };
}

function sell({ symbol, qty, amountUsd, percentOfPosition }) {
  requireLiveMarket();
  if (!SYMBOLS.includes(symbol)) throw new ValidationError(`unknown symbol ${symbol}; allowed: ${SYMBOLS.join(', ')}`);
  const q = getPrice(symbol);
  const pos = posOf(symbol);
  if (!pos) throw new ValidationError(`no open position in ${symbol}`);

  if (percentOfPosition != null) {
    if (!(percentOfPosition > 0 && percentOfPosition <= 100)) throw new ValidationError('percentOfPosition must be in (0, 100]');
    qty = pos.qty * (percentOfPosition / 100);
  } else if (amountUsd != null) {
    if (!(amountUsd > 0)) throw new ValidationError('amountUsd must be > 0');
    qty = amountUsd / q.price;
  }
  if (!(qty > 0)) throw new ValidationError('qty must be > 0');
  qty = Math.min(round8(qty), pos.qty);
  if (qty <= 0) throw new ValidationError('resolved quantity is 0');

  const execPrice = q.price * (1 - P.slippageBps / 10000);
  const gross = qty * execPrice;
  const fee = gross * (P.feeBps / 10000);
  const net = gross - fee;
  const costBasis = qty * pos.avgEntry;
  const realizedPnl = net - costBasis;

  state.portfolio.realizedPnl = round8(state.portfolio.realizedPnl + realizedPnl);
  state.portfolio.feesPaidUsd = round8((state.portfolio.feesPaidUsd || 0) + fee);
  pos.qty = round8(pos.qty - qty);
  if (pos.qty < 1e-8) delete state.portfolio.positions[symbol];
  state.portfolio.cash += net;

  const trade = {
    t: now(),
    side: 'sell',
    symbol,
    qty,
    price: Math.round(execPrice * 100) / 100,
    feeUsd: Math.round(fee * 100) / 100,
    notionalUsd: Math.round(gross * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    cashAfter: Math.round(state.portfolio.cash * 100) / 100,
  };
  recordTrade(trade);
  savePortfolio();
  return { ok: true, ...trade, position: posOf(symbol) || null };
}

function resetPortfolio(startingCash) {
  if (startingCash != null && !(startingCash > 0)) throw new ValidationError('startingCash must be > 0');
  if (fs.existsSync(TRADES_FILE)) {
    fs.renameSync(TRADES_FILE, path.join(DATA_DIR, `trades-${now()}.jsonl`));
  }
  state.portfolio = initPortfolio(startingCash);
  state.equityHistory = [];
  state.trades = [];
  savePortfolio();
  console.log(`[state] portfolio reset to $${state.portfolio.cash.toFixed(2)}`);
  return { ok: true, portfolio: portfolioSnapshot() };
}

// ---------------------------------------------------------------- snapshots
function portfolioSnapshot() {
  const p = state.portfolio;
  const positions = {};
  let positionsValue = 0;
  for (const [sym, pos] of Object.entries(p.positions)) {
    const q = state.prices[sym];
    const price = q ? q.price : null;
    const value = price != null ? pos.qty * price : null;
    if (value != null) positionsValue += value;
    positions[sym] = {
      qty: pos.qty,
      avgEntry: pos.avgEntry,
      price,
      value: value != null ? Math.round(value * 100) / 100 : null,
      pnlUnrealized: value != null ? Math.round((value - pos.qty * pos.avgEntry) * 100) / 100 : null,
      pnlPct: value != null && pos.avgEntry > 0 ? Math.round(((price / pos.avgEntry - 1) * 100) * 100) / 100 : null,
    };
  }
  const equity = p.cash + positionsValue;
  return {
    cash: Math.round(p.cash * 100) / 100,
    positionsValue: Math.round(positionsValue * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    startingCash: p.startingCash,
    realizedPnl: Math.round(p.realizedPnl * 100) / 100,
    feesPaidUsd: Math.round((p.feesPaidUsd || 0) * 100) / 100,
    pnlTotal: Math.round((equity - p.startingCash) * 100) / 100,
    pnlPct: p.startingCash > 0 ? Math.round(((equity / p.startingCash - 1) * 100) * 100) / 100 : null,
    positions,
  };
}

function fullState() {
  return {
    t: now(),
    bootedAt: state.bootedAt,
    dataSource: state.dataSource,
    dataAgeMs: state.lastMarketFetchOk ? now() - state.lastMarketFetchOk : null,
    lastMarketError: state.lastMarketError || null,
    candlesSource: state.candlesSource,
    candlesInterval: CFG.candles.binanceInterval,
    candlesAgeMs: state.lastCandlesFetchOk ? now() - state.lastCandlesFetchOk : null,
    config: {
      feeBps: P.feeBps,
      slippageBps: P.slippageBps,
      maxTradeUsd: P.maxTradeUsd,
      coins: COINS.map((c) => ({ symbol: c.symbol, name: c.name })),
    },
    portfolio: portfolioSnapshot(),
    prices: state.prices,
    equityHistory: state.equityHistory.slice(-720),
    trades: state.trades.slice(-30).reverse(),
    agentLog: state.agentLog.slice(-20).reverse(),
    news: state.news.slice(0, 25),
  };
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new ValidationError('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, u) {
  const route = `${req.method} ${u.pathname}`;
  switch (route) {
    case 'GET /api/health':
      return sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round((now() - state.bootedAt) / 1000),
        dataSource: state.dataSource,
        lastMarketFetchOk: state.lastMarketFetchOk,
      });
    case 'GET /api/state':
      return sendJson(res, 200, fullState());
    case 'GET /api/prices':
      return sendJson(res, 200, { dataSource: state.dataSource, prices: state.prices });
    case 'GET /api/news': {
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '30', 10) || 30, 80);
      return sendJson(res, 200, { news: state.news.slice(0, limit) });
    }
    case 'GET /api/trades': {
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10) || 50, 200);
      return sendJson(res, 200, { trades: state.trades.slice(-limit).reverse() });
    }
    case 'GET /api/history': {
      const sym = u.searchParams.get('symbol');
      if (!sym || !SYMBOLS.includes(sym)) return sendJson(res, 400, { error: `symbol required, one of: ${SYMBOLS.join(', ')}` });
      const points = Math.min(parseInt(u.searchParams.get('points') || '288', 10) || 288, HISTORY_CAP);
      const h = state.priceHistory[sym] || [];
      return sendJson(res, 200, { symbol: sym, points: h.slice(-points) });
    }
    case 'GET /api/candles': {
      const sym = u.searchParams.get('symbol');
      const limit = Math.min(
        parseInt(u.searchParams.get('limit') || String(CFG.candles.limit), 10) || CFG.candles.limit,
        CFG.candles.limit
      );
      const meta = { source: state.candlesSource, interval: CFG.candles.binanceInterval };
      if (sym) {
        if (!SYMBOLS.includes(sym)) return sendJson(res, 400, { error: `symbol required, one of: ${SYMBOLS.join(', ')}` });
        return sendJson(res, 200, { ...meta, symbol: sym, candles: (state.candles[sym] || []).slice(-limit) });
      }
      const out = {};
      for (const s of SYMBOLS) out[s] = (state.candles[s] || []).slice(-limit);
      return sendJson(res, 200, { ...meta, candles: out });
    }
    case 'GET /api/agent-log': {
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10) || 50, 100);
      return sendJson(res, 200, { decisions: state.agentLog.slice(-limit).reverse() });
    }
    case 'POST /api/buy': {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, buy(b));
      } catch (e) {
        if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }
    case 'POST /api/sell': {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, sell(b));
      } catch (e) {
        if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }
    case 'POST /api/reset': {
      const b = await readBody(req);
      try {
        return sendJson(res, 200, resetPortfolio(b.startingCash));
      } catch (e) {
        if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }
    case 'POST /api/agent-log': {
      const b = await readBody(req);
      const entry = {
        t: now(),
        model: String(b.model || 'unknown').slice(0, 120),
        action: String(b.action || 'unknown').slice(0, 10),
        symbol: b.symbol ? String(b.symbol).slice(0, 12) : null,
        confidence: typeof b.confidence === 'number' ? b.confidence : null,
        reason: String(b.reason || '').slice(0, 300),
        result: String(b.result || '').slice(0, 300),
      };
      state.agentLog.push(entry);
      if (state.agentLog.length > 100) state.agentLog.shift();
      appendJsonl(AGENT_LOG_FILE, entry);
      return sendJson(res, 200, { ok: true });
    }
    default:
      return sendJson(res, 404, { error: `no route ${route}` });
  }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return serveStatic(u.pathname, res);
  } catch (e) {
    console.error(`[http] ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- boot
loadPersisted();
await pollMarket();
await pollNews();
await pollCandles();
setInterval(pollMarket, CFG.market.intervalMs);
setInterval(pollNews, CFG.news.intervalMs);
setInterval(pollCandles, CFG.candles.intervalMs);
setInterval(savePortfolio, 60000);

server.listen(CFG.port, () => {
  console.log('==============================================');
  console.log('  CyptoSim — simulatore crypto paper-trading');
  console.log('  Dashboard:  http://localhost:' + CFG.port);
  console.log('  API docs:   API.md  (per l\'AI)');
  console.log(`  Feed: ${state.dataSource}, ${SYMBOLS.length} coppie, fee ${P.feeBps / 100}%, slippage ${P.slippageBps / 100}%`);
  console.log('  Portafoglio FINTO. Nessun soldi vero.');
  console.log('==============================================');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${sig}] saving and shutting down...`);
    try {
      savePortfolio();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
