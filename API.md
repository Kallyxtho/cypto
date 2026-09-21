# CyptoSim API — reference for AI agents

Base URL: `http://localhost:3131`
All responses are JSON. Trades execute at LIVE market prices with a fee (10 bps) and
slippage (5 bps) applied. The portfolio is simulated; money is fake. If market data is
stale (>60s without a successful feed poll), every trade is refused with HTTP 400
`market data is stale`.

## Read endpoints

### `GET /api/state`
Full snapshot for dashboards and agents:
- `portfolio`: `cash`, `equity`, `startingCash`, `realizedPnl`, `feesPaidUsd`, `pnlTotal`, `pnlPct`, `positions{SYMBOL:{qty,avgEntry,price,value,pnlUnrealized,pnlPct}}`
- `prices`: `SYMBOL -> {price, change24hPct, high24h, low24h, volume24hUsd, ts}`
- `equityHistory`: `[{t, equity}]` (last 720 samples, one per feed poll)
- `trades`: recent executed orders (newest first)
- `agentLog`: recent AI decisions (newest first)
- `news`: recent headlines `{t, source, title, link, coins[SYMBOL]}`
- `dataSource`: `binance | coingecko | stale`, `dataAgeMs`

### `GET /api/prices` — prices only.
### `GET /api/news?limit=30` — headlines only.
### `GET /api/trades?limit=50` — trade history (newest first).
### `GET /api/history?symbol=BTCUSDT&points=288` — per-symbol price samples for momentum/indicators.
### `GET /api/candles?symbol=BTCUSDT&limit=100` — REAL Binance OHLC klines (15m interval, 100 candles ≈ 25h):
`[{t, o, h, l, c, v}]`, oldest → newest. Without `symbol` returns every symbol:
`{source, interval, candles: {SYMBOL: [...]}}`. This is the trend/chart data — read it before deciding.
### `GET /api/agent-log?limit=50` — past AI decisions.
### `GET /api/health` — `{ok, uptimeSec, dataSource, lastMarketFetchOk}`.

## Trade endpoints

### `POST /api/buy`
Body (choose ONE sizing mode):
- `{"symbol":"BTCUSDT","amountUsd":500}` — spend exactly this many USD (max `maxTradeUsd` 5000, else 400)
- `{"symbol":"BTCUSDT","percentOfCash":10}` — spend 10% of current cash (auto-capped at `maxTradeUsd`)

Response: `{ok, side, symbol, qty, price, feeUsd, notionalUsd, cashAfter, position}`.
Errors (HTTP 400): unknown symbol, insufficient cash, no live price, stale market.

### `POST /api/sell`
Body (choose ONE sizing mode):
- `{"symbol":"BTCUSDT","qty":0.05}` — sell a crypto quantity
- `{"symbol":"BTCUSDT","amountUsd":300}` — sell roughly this USD value
- `{"symbol":"BTCUSDT","percentOfPosition":50}` — sell 50% of the held position

Response includes `realizedPnl` for this sale. Errors: no open position, invalid sizing.

### `POST /api/reset` — body `{"startingCash":100}` optional (default from `config.json`). Archives `trades.jsonl`, resets the paper portfolio.

### `POST /api/agent-log` — internal: the `agent.mjs` loop logs decisions here
(`{model, action, symbol, confidence, reason, result}`), visible on the dashboard.

## Example (curl)

```bash
curl -s http://localhost:3131/api/state | head -c 400
curl -s -X POST http://localhost:3131/api/buy -H "Content-Type: application/json" -d '{"symbol":"ETHUSDT","percentOfCash":5}'
curl -s -X POST http://localhost:3131/api/sell -H "Content-Type: application/json" -d '{"symbol":"ETHUSDT","percentOfPosition":100}'
```

## Notes for agents
- Symbols are Binance-style: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT`, `ADAUSDT`, `DOGEUSDT`, `AVAXUSDT`, `LINKUSDT`, `DOTUSDT`.
- `news.coins` is a heuristic keyword tag of the headline, not ground truth.
- `GET /api/candles` is the chart: judge the trend (SMA20/RSI14 are computed by the agent script) before trading.
- Config (coins, fees, limits, agent settings) lives in `config.json`.
