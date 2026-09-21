# Project playbook

> Auto-generated and auto-maintained by NYX. Injected into every session of
> this project. Edit freely — deleting this file opts out of the playbook.

## Verified commands

- `node server.mjs` — avvia simulatore + dashboard su http://localhost:3131
- `node agent.mjs` — trader AI; flag: `--once`, `--dry-run`, `--base-url <url>/v1`, `--model <name>`
- `node test-lifecycle.mjs` — 35 assert integrazione API (server deve girare)
- `node test-agent.mjs` — e2e agente con LLM mock su :5199
- Zero dipendenze npm; richiede Node >= 18 (global fetch)

## Architecture map

- `server.mjs` — feed Binance (fallback CoinGecko) ogni 5s, klines OHLC reali 15m ogni 60s (mirror data-api.binance.vision come fallback), RSS news ogni 5min, portafoglio finto con fee 10bps + slippage 5bps, API REST su :3131, static da `public/`, persistenza in `data/`
- `agent.mjs` — loop trader: GET /api/state + /api/candles → prompt (candele o/h/l/c + SMA20/RSI14 calcolati nel codice) → LLM OpenAI-compatible → JSON tipato validato nel codice → POST /api/buy|sell → log via /api/agent-log
- `config.json` — monete, capitale, fee, limiti, impostazioni agent
- `PIANO.md` (it), `API.md` (en, per l'AI), `README.md` (it)

## Conventions

- Prosa utente in italiano; codice, API e messaggi di errore del server in inglese
- Dashboard: grafico a candele reale in canvas vanilla (`#candleChart`, drawn da `drawCandles` in app.js) con tab simbolo; il click su tab fa `refresh()` forzando refetch via `candlesCache=null`
- Errori API: HTTP 400 + `{error}` via `ValidationError`; simboli stile Binance (BTCUSDT)
- `/api/candles?symbol=X&limit=N` = klines OHLC reali; senza `symbol` restituisce tutte le coppie
- Il modello decide, il codice esegue: aritmetica e limiti di rischio MAI nell'LLM

## Pitfalls & fixes

- `spawnSync` nell'event loop congela un server mock in-process → deadlock col figlio: usare `spawn` async (fix in test-agent.mjs)
- `nohup ... &` e `powershell Start-Process` funzionano ma fanno andare in timeout il tool ( attende i figli ): verificare dopo con curl, il side-effect sopravvive
- In PowerShell da Git Bash quotare con apici singoli, altrimenti bash espande `$_`
- Redirect `> file` fallisce se la dir non esiste ancora al momento del redirect (mkdir prima)
- `loadPersisted` adotta `startingCash` SOLO come baseline P&L dal config; il cash su disco non cambia da solo: per cambiare capitale → edit config + restart + `POST /api/reset {}`
- Cambiare `maxTradeUsd` invalida i test lifecycle con importi grandi: il test ora usa 40/60 USD su capitale 100
- Le soglie assolute nei test devono seguire il capitale: col cambio 10.000→100 è rimasta `sol.value > 470 && < 510` in test-agent.mjs (ora 4.7/5.1)

## Release / deploy

<!-- how this project ships: commands, order, gotchas -->

## Notes

- Obiettivo progetto: simulatore 100% completo per AI trader locale; NESSUN download di modelli finché l'utente non lo chiede (istruzione esplicita del 2026-09-20)
- Hardware: RTX 4050 6GB + 16GB RAM → modelli 7-8B q4 adatti (qwen2.5:7b di default in config)
- 'Jev AI' (TypeSafe) = decision model hosted/chi so, non eseguibile in locale; pattern replicato in agent.mjs (decisioni tipate validatate in codice)
- Server avviato con PowerShell Start-Process (window hidden, log in data/server.log); porta 3131
- Capitale finto: 100 (richiesta utente 2026-09-20), maxTradeUsd 50; valuta del simulatore = USD/USDT (non euro)
