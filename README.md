# CyptoSim — simulatore crypto paper-trading con AI locale

Portafoglio **finto**, mercato **vero**: prezzi live da Binance (fallback CoinGecko),
notizie live da feed RSS, ordini con fee e slippage, e un agente AI che collega un
modello locale (Ollama / Jan / LM Studio) al simulatore.

**Nessun denaro vero è coinvolto.** Vedi `PIANO.md` per il piano completo.

## Avvio rapido

```bash
node server.mjs
```

Apri http://localhost:3131 — dashboard con grafico a candele reale (Binance 15m),
prezzi, portafoglio, grafico equity, notizie e decisioni AI.

## Files

| File | Ruolo |
|---|---|
| `server.mjs` | Simulatore: feed prezzi, notizie, portafoglio, API REST, dashboard |
| `agent.mjs` | Agente AI: legge candele+mercato+notizie, decide, esegue ordini (loop automatico) |
| `config.json` | Monete, capitale finto, fee/slippage, impostazioni agente |
| `public/` | Dashboard (HTML/CSS/JS vanilla) |
| `data/` | Stato persistente (portafoglio, trades, decisioni AI, cache notizie) |
| `API.md` | Documentazione API (per te e per l'AI) |
| `PIANO.md` | Il piano completo del progetto |

## Comandi

```bash
node server.mjs                          # avvia il simulatore
node agent.mjs                           # avvia l'AI trader (richiede modello locale)
node agent.mjs --dry-run                 # l'AI decide ma non esegue
node agent.mjs --once                    # una sola decisione e chiude
node agent.mjs --base-url http://localhost:1337/v1 --model nome-modello
```

L'agente non scarica alcun modello: si collega a ciò che è già installato. Quando
installerai il modello (vedi `PIANO.md`, Fase 2), configurerai `config.json → agent`.

## Configurazione rapida (`config.json`)

- `portfolio.startingCashUsd`: capitale finto iniziale (default 100)
- `portfolio.feeBps` / `slippageBps`: realismo degli ordini (10 bps / 5 bps)
- `coins`: coppie tradabili (default 10 majors)
- `candles`: klines Binance per grafico e contesto AI (intervallo 15m, ultime 100)
- `agent`: endpoint del modello, modello, intervallo decisioni, limiti di rischio
