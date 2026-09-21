// CyptoSim dashboard — polls the simulator API and renders the UI. Vanilla JS.
'use strict';

const PORT = 3131;
// Works both when served by the simulator itself (same origin) and when the
// page is opened from a different local server (e.g. an IDE preview).
const API_BASE = location.port === String(PORT) ? '' : `http://${location.hostname || 'localhost'}:${PORT}`;

const $ = (id) => document.getElementById(id);
const fmtUsd = (n, digits = 2) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPct = (n) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');
const fmtQty = (n) => (n == null ? '—' : Number(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
const relTime = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'g';
};
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let offline = false;
let selectedSym = 'BTCUSDT';
let candlesCache = null; // last /api/candles payload for selectedSym
let lastCandlesFetch = 0;

async function api(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderStats(pf) {
  $('stEquity').textContent = fmtUsd(pf.equity);
  const pnl = $('stPnl');
  pnl.textContent = `${fmtPct(pf.pnlPct)} (${pf.pnlTotal >= 0 ? '+' : '-'}$${Math.abs(pf.pnlTotal).toFixed(2)})`;
  pnl.className = 'delta ' + cls(pf.pnlTotal);
  $('stCash').textContent = fmtUsd(pf.cash);
  $('stStart').textContent = `capitale iniziale ${fmtUsd(pf.startingCash)}`;
  $('stPos').textContent = fmtUsd(pf.positionsValue);
  const open = Object.keys(pf.positions).length;
  $('stPosCount').textContent = open ? `${open} posizione${open > 1 ? 'i' : ''} aperta${open > 1 ? 'e' : ''}` : 'nessuna posizione';
  const real = $('stRealized');
  real.textContent = (pf.realizedPnl >= 0 ? '+' : '-') + '$' + Math.abs(pf.realizedPnl).toFixed(2);
  real.className = 'value ' + cls(pf.realizedPnl);
  $('stFees').textContent = `fee pagate $${pf.feesPaidUsd.toFixed(2)}`;
}

function renderBadge(st) {
  const b = $('dataBadge');
  const age = st.dataAgeMs != null ? Math.round(st.dataAgeMs / 1000) : null;
  $('dataAge').textContent = st.lastMarketError ? 'feed in errore' : age != null ? `dati di ${age}s fa` : '';
  if (st.dataSource === 'binance') { b.textContent = 'LIVE Binance'; b.className = 'badge live'; }
  else if (st.dataSource === 'coingecko') { b.textContent = 'LIVE CoinGecko'; b.className = 'badge fallback'; }
  else if (st.dataSource === 'stale') { b.textContent = 'STALE'; b.className = 'badge stale'; }
  else { b.textContent = st.dataSource; b.className = 'badge'; }
}

function renderPrices(st) {
  const tbody = $('pricesTable').querySelector('tbody');
  const rows = st.config.coins.map(({ symbol, name }) => {
    const q = st.prices[symbol];
    const pos = st.portfolio.positions[symbol];
    if (!q) {
      return `<tr><td class="sym">${symbol}<small>${name}</small></td><td colspan="5" class="flat">in attesa dati…</td></tr>`;
    }
    const chgCls = cls(q.change24hPct);
    return `<tr>
      <td class="sym">${symbol}<small>${name}</small></td>
      <td>${fmtUsd(q.price, q.price >= 100 ? 2 : 4)}</td>
      <td class="${chgCls}">${fmtPct(q.change24hPct)}</td>
      <td>${pos ? fmtQty(pos.qty) : '—'}</td>
      <td>${pos && pos.value != null ? fmtUsd(pos.value) : '—'}</td>
      <td class="${pos && pos.pnlUnrealized != null ? cls(pos.pnlUnrealized) : 'flat'}">${pos && pos.pnlPct != null ? fmtPct(pos.pnlPct) : '—'}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

function renderTrades(trades) {
  const tbody = $('tradesTable').querySelector('tbody');
  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="flat">Nessun ordine — l\'AI o tu non avete ancora operato</td></tr>';
    return;
  }
  tbody.innerHTML = trades
    .map((t) => `<tr>
      <td class="flat">${relTime(t.t)} fa</td>
      <td class="decision ${t.side}">${t.side === 'buy' ? 'BUY' : 'SELL'}</td>
      <td class="sym">${t.symbol}</td>
      <td>${fmtQty(t.qty)}</td>
      <td>${fmtUsd(t.price, t.price >= 100 ? 2 : 4)}</td>
      <td class="${t.realizedPnl != null ? cls(t.realizedPnl) : 'flat'}">${t.realizedPnl != null ? (t.realizedPnl >= 0 ? '+' : '-') + '$' + Math.abs(t.realizedPnl).toFixed(2) : '—'}</td>
    </tr>`)
    .join('');
}

function renderAgent(decisions) {
  const ul = $('agentList');
  if (!decisions.length) return; // keep placeholder if empty
  ul.innerHTML = decisions
    .map((d) => `<li>
      <span class="when">${relTime(d.t)} fa</span>
      <span class="decision ${esc(d.action)}">${esc(d.action)}${d.symbol ? ' ' + esc(d.symbol) : ''}</span>
      <span class="tag">${esc(d.model)}${d.confidence != null ? ' · ' + Math.round(d.confidence * 100) + '%' : ''}</span>
      <span class="reason">${esc(d.reason || d.result || '')}</span>
    </li>`)
    .join('');
}

function renderNews(news) {
  const ul = $('newsList');
  if (!news.length) return;
  ul.innerHTML = news
    .map((n) => `<li>
      <span class="when">${relTime(n.t)}</span>
      ${n.link ? `<a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : `<span>${esc(n.title)}</span>`}
      ${n.coins.map((c) => `<span class="tag">${esc(c.replace('USDT', ''))}</span>`).join('')}
      <span class="tag">${esc(n.source)}</span>
    </li>`)
    .join('');
}

// ---------------- chart ----------------
function drawChart(history) {
  const canvas = $('equityChart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = 180;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!history || history.length < 2) {
    ctx.fillStyle = '#8b93a7';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText('In attesa di dati sufficienti…', 12, h / 2);
    return;
  }
  const pad = { l: 56, r: 8, t: 10, b: 18 };
  const vals = history.map((p) => p.equity);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;
  const x = (i) => pad.l + (i / (history.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  ctx.strokeStyle = '#232a3d';
  ctx.fillStyle = '#8b93a7';
  ctx.font = '11px "Segoe UI", sans-serif';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    ctx.fillText('$' + Math.round(v).toLocaleString('en-US'), 4, y(v) + 4);
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
  }

  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? '#16c784' : '#ea3943';
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, up ? 'rgba(22,199,132,.25)' : 'rgba(234,57,67,.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  history.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.equity)) : ctx.moveTo(x(0), y(p.equity))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(x(history.length - 1), h - pad.b);
  ctx.lineTo(x(0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = '#8b93a7';
  ctx.fillText(relTime(history[0].t) + ' fa', pad.l, h - 4);
  ctx.fillText('adesso', w - pad.r - 40, h - 4);
}

// ---------------- candlestick chart (real Binance klines) ----------------
function buildSymTabs(coins) {
  const tabs = $('symTabs');
  const key = coins.join(',');
  if (tabs.dataset.built === key) return;
  tabs.dataset.built = key;
  tabs.innerHTML = '';
  for (const sym of coins) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = sym.replace('USDT', '');
    b.className = 'tab' + (sym === selectedSym ? ' active' : '');
    b.addEventListener('click', () => {
      if (selectedSym === sym) return;
      selectedSym = sym;
      candlesCache = null; // force refetch for the new symbol
      lastCandlesFetch = 0;
      [...tabs.children].forEach((el) => el.classList.toggle('active', el === b));
      refresh();
    });
    tabs.appendChild(b);
  }
}

function drawCandles(candles, interval, source) {
  const canvas = $('candleChart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = 300;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!candles || candles.length < 2) {
    ctx.fillStyle = '#8b93a7';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText('In attesa di candele reali da Binance…', 12, h / 2);
    return;
  }
  const GREEN = '#16c784';
  const RED = '#ea3943';
  const pad = { l: 64, r: 10, t: 10, b: 22 };
  let min = Math.min(...candles.map((c) => c.l));
  let max = Math.max(...candles.map((c) => c.h));
  const span0 = max - min || 1;
  min -= span0 * 0.05;
  max += span0 * 0.05;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const volH = 26;
  const priceH = plotH - volH - 6;
  const x = (i) => pad.l + ((i + 0.5) / candles.length) * plotW;
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * priceH;
  const vMax = Math.max(...candles.map((c) => c.v)) || 1;

  ctx.strokeStyle = '#232a3d';
  ctx.fillStyle = '#8b93a7';
  ctx.font = '10px "Segoe UI", sans-serif';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    ctx.fillText(fmtUsd(v, v >= 1000 ? 0 : 2), 2, y(v) + 3);
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
  }

  const cw = plotW / candles.length;
  const bodyW = Math.max(1.5, cw * 0.62);
  candles.forEach((c, i) => {
    const color = c.c >= c.o ? GREEN : RED;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x(i), y(c.h));
    ctx.lineTo(x(i), y(c.l));
    ctx.stroke();
    const yO = y(c.o);
    const yC = y(c.c);
    ctx.fillRect(x(i) - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yO - yC)));
    ctx.globalAlpha = 0.35;
    const vh = (c.v / vMax) * volH;
    ctx.fillRect(x(i) - bodyW / 2, pad.t + priceH + 6 + (volH - vh), bodyW, vh);
    ctx.globalAlpha = 1;
  });

  ctx.fillStyle = '#8b93a7';
  const tLabel = (c) => new Date(c.t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  ctx.fillText(tLabel(candles[0]), pad.l, h - 6);
  const mid = Math.floor(candles.length / 2);
  ctx.fillText(tLabel(candles[mid]), x(mid) - 16, h - 6);
  ctx.textAlign = 'right';
  ctx.fillText(`${tLabel(candles[candles.length - 1])}  ·  ${interval || '15m'}  ·  ${source || 'Binance'}`, w - pad.r, h - 6);
  ctx.textAlign = 'left';
}

async function updateCandles(st) {
  const coins = (st.config.coins || []).map((c) => c.symbol);
  if (coins.length && !coins.includes(selectedSym)) selectedSym = coins[0];
  buildSymTabs(coins);
  if (candlesCache && Date.now() - lastCandlesFetch < 30000) {
    drawCandles(candlesCache.candles, candlesCache.interval, candlesCache.source);
    return;
  }
  try {
    const cd = await api(`/api/candles?symbol=${encodeURIComponent(selectedSym)}&limit=100`);
    candlesCache = cd;
    lastCandlesFetch = Date.now();
    drawCandles(cd.candles, cd.interval, cd.source);
    $('candleTitle').textContent = `Candele ${cd.interval} — ${selectedSym} (dati reali ${cd.source})`;
  } catch {
    drawCandles(null);
  }
}

// ---------------- refresh loop ----------------
async function refresh() {
  try {
    const st = await api('/api/state');
    offline = false;
    $('offline').classList.add('hidden');
    renderStats(st.portfolio);
    renderBadge(st);
    renderPrices(st);
    renderTrades(st.trades);
    renderAgent(st.agentLog);
    renderNews(st.news);
    drawChart(st.equityHistory);
    updateCandles(st);
  } catch (e) {
    if (!offline) {
      offline = true;
      $('offline').classList.remove('hidden');
      $('dataBadge').textContent = 'OFFLINE';
      $('dataBadge').className = 'badge stale';
    }
  }
}

$('resetBtn').addEventListener('click', async () => {
  const answer = prompt('Operazione che azzera il portafoglio finto.\nDigita RESET per confermare:');
  if (answer !== 'RESET') return;
  try {
    await api('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    refresh();
  } catch (e) {
    alert('Reset fallito: ' + e.message);
  }
});

refresh();
setInterval(refresh, 5000);
window.addEventListener('resize', () => refresh());
