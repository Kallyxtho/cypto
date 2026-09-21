#!/usr/bin/env node
// CyptoSim AI trader — connects a LOCAL LLM to the simulator.
// Works with any OpenAI-compatible endpoint, no model is downloaded here:
//   Ollama    -> --base-url http://localhost:11434/v1  (default)
//   Jan       -> --base-url http://localhost:1337/v1
//   LM Studio -> --base-url http://localhost:1234/v1
//
// Design (Jev-style, local): the LLM only emits a TYPED decision
// {action, symbol, percentOfCash|percentOfPosition, confidence, reason}.
// This script validates the schema in code and enforces every risk limit —
// out-of-schema or low-confidence answers are rejected/downgraded by code,
// never executed. Arithmetic and permissions never live in the model.
//
// Usage:
//   node agent.mjs                 # loop forever, one decision every intervalMinutes
//   node agent.mjs --once          # single decision cycle, then exit
//   node agent.mjs --dry-run       # decide but do not execute
//   node agent.mjs --base-url http://localhost:1337/v1 --model <name>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const ONCE = has('once');
const DRY = has('dry-run');
const SIM = flag('sim', 'http://localhost:3131');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const AG = {
  ...CFG.agent,
  ...(flag('base-url', null) ? { baseUrl: flag('base-url', null) } : {}),
  ...(flag('model', null) ? { model: flag('model', null) } : {}),
};
const SYMBOLS = CFG.coins.map((c) => c.symbol);

const STYLES = {
  conservative: 'Trade rarely. Prefer holding. Max 5% of cash per buy. Only act on strong, fresh news or clear oversold conditions. Cut losing positions above -8%.',
  balanced: 'Trade moderately. Size buys between 3% and 15% of cash. React to fresh significant news and 24h momentum. Cut losers above -10%, take profits above +15% if momentum fades.',
  aggressive: 'Trade actively. Size buys between 5% and 20% of cash. Exploit volatility and news momentum. Cut losers above -15%, take profits above +25%.',
};

const SYSTEM_PROMPT = `You are an autonomous crypto spot trader operating a PAPER trading account (fake money, real market prices).

You receive: live prices, recent OHLC candles (15m) with indicators (SMA20, RSI14, 24h range), your portfolio, recent crypto news and your past decisions. You must output EXACTLY ONE decision as a single JSON object and NOTHING else. No prose, no markdown fences.

Decision schema:
{"action":"buy","symbol":"<SYMBOL>","percentOfCash":<1-${AG.maxTradePctOfCash}>,"confidence":<0..1>,"reason":"<max 140 chars, English>"}
{"action":"sell","symbol":"<SYMBOL>","percentOfPosition":<1-100>,"confidence":<0..1>,"reason":"<max 140 chars, English>"}
{"action":"hold","confidence":<0..1>,"reason":"<max 140 chars, English>"}

Hard rules:
- "symbol" must be one of the listed SYMBOLS exactly as written.
- Buy only with money you have; sell only positions you hold.
- Never propose more than ${AG.maxTradePctOfCash}% of cash in one buy.
- If confidence < ${AG.minConfidence}, output "hold".
- Base decisions on: the OHLC candle trend and indicators (SMA20, RSI14, 24h range), news impact (which coin, how big, how fresh), 24h momentum, your open positions and unrealized P&L, and the equity trend.
- Style: ${STYLES[AG.style] || STYLES.balanced}
- You are a small local model: avoid overtrading. When in doubt, hold. Fewer, better trades.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function simFetch(pathname, opts) {
  const res = await fetch(SIM + pathname, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `simulator HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- prompt
function fmtUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const round2 = (n) => Math.round(n * 100) / 100;

function sma(values, n) {
  if (!Array.isArray(values) || values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, n = 14) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function buildContext(st, candlesData) {
  const age = st.dataAgeMs != null ? Math.round(st.dataAgeMs / 1000) + 's ago' : 'unknown';
  const lines = [];
  lines.push(`MARKET (source ${st.dataSource}, ${age}):`);
  for (const { symbol } of st.config.coins) {
    const q = st.prices[symbol];
    if (q) {
      lines.push(
        `  ${symbol} ${fmtUsd(q.price)} 24h ${q.change24hPct >= 0 ? '+' : ''}${q.change24hPct.toFixed(2)}% ` +
          `vol24h ${fmtUsd(q.volume24hUsd, 0)}`
      );
    }
  }

  const pf = st.portfolio;
  lines.push('');
  lines.push(
    `PORTFOLIO: cash ${fmtUsd(pf.cash)} | equity ${fmtUsd(pf.equity)} | total P&L ${pf.pnlTotal >= 0 ? '+' : ''}${fmtUsd(pf.pnlTotal)} (${pf.pnlPct}%) | realized ${pf.realizedPnl >= 0 ? '+' : ''}${fmtUsd(pf.realizedPnl)}`
  );
  const pos = Object.entries(pf.positions);
  if (pos.length) {
    lines.push('POSITIONS:');
    for (const [sym, p] of pos) {
      lines.push(
        `  ${sym}: qty ${p.qty} @ avg ${fmtUsd(p.avgEntry)} now ${fmtUsd(p.price)} ` +
          `unrealized ${p.pnlUnrealized >= 0 ? '+' : ''}${fmtUsd(p.pnlUnrealized)} (${p.pnlPct}%)`
      );
    }
  } else {
    lines.push('POSITIONS: none (all cash)');
  }

  if (st.equityHistory.length >= 2) {
    const first = st.equityHistory[0].equity;
    const last = st.equityHistory[st.equityHistory.length - 1].equity;
    const spanH = ((st.equityHistory[st.equityHistory.length - 1].t - st.equityHistory[0].t) / 3600000).toFixed(1);
    lines.push(`EQUITY TREND (${spanH}h): ${fmtUsd(first)} -> ${fmtUsd(last)} (${(((last / first) - 1) * 100).toFixed(2)}%)`);
  }

  if (candlesData?.source === 'binance' && candlesData.candles) {
    lines.push('');
    lines.push(`CANDLES (real Binance ${candlesData.interval} klines, o/h/l/c, oldest -> newest):`);
    for (const { symbol } of st.config.coins) {
      const arr = candlesData.candles[symbol];
      if (!Array.isArray(arr) || arr.length < 20) continue;
      const closes = arr.map((c) => c.c);
      const price = st.prices[symbol]?.price ?? closes[closes.length - 1];
      const s20 = sma(closes, 20);
      const r14 = rsi(closes, 14);
      const last24 = arr.slice(-96);
      const lo = Math.min(...last24.map((c) => c.l));
      const hi = Math.max(...last24.map((c) => c.h));
      const ref = closes[closes.length - 13] ?? closes[0];
      const mom3h = ref > 0 ? ((closes[closes.length - 1] / ref - 1) * 100).toFixed(2) : '0.00';
      const table = arr
        .slice(-10)
        .map((c) => `${round2(c.o)}/${round2(c.h)}/${round2(c.l)}/${round2(c.c)}`)
        .join(' ');
      lines.push(
        `  ${symbol} now ${fmtUsd(price)} | SMA20 ${s20 ? fmtUsd(s20) : 'n/a'} | RSI14 ${r14 != null ? r14.toFixed(0) : 'n/a'} | 24h range ${fmtUsd(lo)}-${fmtUsd(hi)} | 3h momentum ${mom3h}%`
      );
      lines.push(`    ${table}`);
    }
  }

  const news = (st.news || []).slice(0, 15);
  lines.push('');
  lines.push(news.length ? 'RECENT NEWS (newest first):' : 'RECENT NEWS: none available');
  for (const n of news) {
    const ageM = Math.max(0, Math.round((Date.now() - n.t) / 60000));
    const coins = n.coins.length ? n.coins.map((c) => c.replace('USDT', '')).join(',') : 'general';
    lines.push(`  [${ageM}m ago][${coins}][${n.source}] ${n.title}`);
  }

  const past = (st.agentLog || []).slice(0, 3);
  if (past.length) {
    lines.push('');
    lines.push('YOUR LAST DECISIONS:');
    for (const d of past) {
      lines.push(`  ${d.action}${d.symbol ? ' ' + d.symbol : ''} conf ${d.confidence ?? '?'} -> ${d.result || d.reason}`);
    }
  }

  lines.push('');
  lines.push('Decide now. Reply with ONLY one JSON object following the schema.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- decision handling
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Code-enforced schema + risk gate (the "typed decision" layer).
function validateDecision(d, st) {
  const notes = [];
  if (!d || typeof d !== 'object') return { action: 'hold', notes: ['unparseable answer'] };
  const conf = typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1 ? d.confidence : null;

  let action = d.action;
  if (!['buy', 'sell', 'hold'].includes(action)) {
    notes.push(`invalid action "${action}" -> hold`);
    action = 'hold';
  }
  if (conf != null && conf < AG.minConfidence && action !== 'hold') {
    notes.push(`confidence ${conf} < ${AG.minConfidence} -> hold`);
    action = 'hold';
  }

  if (action === 'buy') {
    if (!SYMBOLS.includes(d.symbol)) {
      notes.push(`unknown symbol "${d.symbol}" -> hold`);
      action = 'hold';
    } else {
      let pct = Number(d.percentOfCash);
      if (!(pct > 0)) {
        notes.push('missing percentOfCash -> hold');
        action = 'hold';
      } else {
        if (pct > AG.maxTradePctOfCash) {
          notes.push(`percentOfCash ${pct} clamped to ${AG.maxTradePctOfCash}`);
          pct = AG.maxTradePctOfCash;
        }
        return { action, symbol: d.symbol, percentOfCash: pct, confidence: conf, notes };
      }
    }
  }

  if (action === 'sell') {
    if (!SYMBOLS.includes(d.symbol) || !st.portfolio.positions[d.symbol]) {
      notes.push(`no position in "${d.symbol}" -> hold`);
      action = 'hold';
    } else {
      let pct = Number(d.percentOfPosition);
      if (!(pct > 0)) {
        notes.push('missing percentOfPosition -> hold');
        action = 'hold';
      } else {
        pct = Math.min(pct, 100);
        return { action, symbol: d.symbol, percentOfPosition: pct, confidence: conf, notes };
      }
    }
  }

  return { action: 'hold', confidence: conf, notes };
}

async function callLlm(st, candlesData) {
  const res = await fetch(AG.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AG.apiKey ? { Authorization: `Bearer ${AG.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: AG.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildContext(st, candlesData) },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `LLM HTTP ${res.status}`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty LLM response');
  return content;
}

async function cycle() {
  const st = await simFetch('/api/state');
  if (st.dataSource === 'stale') {
    log('market data stale, skipping cycle');
    return;
  }

  let candlesData = null;
  try {
    candlesData = await simFetch('/api/candles');
  } catch {}

  let content;
  try {
    content = await callLlm(st, candlesData);
  } catch (e) {
    log(`LLM error: ${e.message}`);
    return;
  }

  const parsed = extractJson(content);
  const decision = validateDecision(parsed, st);
  const reason = String(parsed?.reason || '').slice(0, 140);

  let result;
  if (decision.action === 'hold') {
    result = 'HOLD' + (decision.notes.length ? ` (${decision.notes.join('; ')})` : '');
    log(`HOLD — ${reason || 'no reason given'}`);
  } else if (DRY) {
    result = 'DRY-RUN not executed';
    log(`[dry-run] ${decision.action.toUpperCase()} ${decision.symbol} ${decision.percentOfCash ?? decision.percentOfPosition}% — ${reason}`);
  } else {
    try {
      const path = decision.action === 'buy' ? '/api/buy' : '/api/sell';
      const payload =
        decision.action === 'buy'
          ? { symbol: decision.symbol, percentOfCash: decision.percentOfCash }
          : { symbol: decision.symbol, percentOfPosition: decision.percentOfPosition };
      const receipt = await simFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      result = `EXECUTED ${receipt.side} ${receipt.qty} ${receipt.symbol} @ ${fmtUsd(receipt.price)} fee ${fmtUsd(receipt.feeUsd)}`;
      log(result);
    } catch (e) {
      result = `REJECTED: ${e.message}`;
      log(result);
    }
  }

  await simFetch('/api/agent-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AG.model,
      action: decision.action,
      symbol: decision.symbol || null,
      confidence: decision.confidence,
      reason,
      result,
    }),
  }).catch(() => {});
}

async function main() {
  log(`CyptoSim agent — sim ${SIM} | LLM ${AG.baseUrl} model "${AG.model}"${DRY ? ' | DRY-RUN' : ''}`);
  log(`risk: max ${AG.maxTradePctOfCash}% of cash per buy, min confidence ${AG.minConfidence}, style ${AG.style}`);
  while (true) {
    try {
      await cycle();
    } catch (e) {
      log(`cycle error: ${e.message}`);
      if (e.cause?.code === 'ECONNREFUSED') log(`simulator not reachable at ${SIM} — start it with: node server.mjs`);
    }
    if (ONCE) break;
    await sleep(AG.intervalMinutes * 60000);
  }
}

main();
