# PIANO — AI Trader Crypto (simulazione, senza soldi veri)

> **Nota su Jev AI**: Jev (TypeSafe, settembre 2026) è un "System One model" che risponde
> con decisioni tipate + probabilità invece di testo. **Non è scaricabile**: gira solo
> sull'API hosted di TypeSafe (pesi chiusi, early access). Non possiamo farlo girare sul
> tuo PC. Però: lo **stesso schema di lavoro** (stato in ingresso → decisione tipata →
> esecuzione validata nel codice) lo abbiamo replicato in locale con un LLM open
> (llama.cpp/Ollama) che emette JSON vincolato, mentre aritmetica, limiti di rischio e
> validazione restano **nel codice, mai nel modello**. Questo è l'architettura giusta
> anche se un domani volessi passare a Jev o ad altro.

## Obiettivo

Costruire un ambiente in cui un'AI (modello locale sul tuo PC) opera **automaticamente**
su un portafoglio finto seguendo il mercato reale: prezzi live, notizie live, ordini
eseguiti con fee e slippage. L'AI crede di avere soldi veri; il tuo portafoglio vero non
esiste nemmeno. Solo dopo mesi di risultati positivi si può pensare (con estrema
cautela) a soldi veri — e comunque con capitali che puoi permetterti di perdere.

**Avvertenza onesta**: nessun simulatore garantisce profitti. I mercati crypto possono
andare contro chiunque. Il valore di questo progetto è allenare disciplina e misurare
strategie, non promettere ricchezza.

## Architettura

```
┌─────────────────────────────────────────────────────────────┐
│                     IL TUO PC (locale)                       │
│                                                              │
│  ┌────────────┐   prezzi/notizie    ┌────────────────────┐  │
│  │  server.mjs│◄────────────────────┤  Binance/CoinGecko │  │
│  │ (simulatore)│   RSS              │  + feed notizie    │  │
│  └──────┬─────┘                     └────────────────────┘  │
│         │  REST API (/api/state, /api/buy, ...)             │
│         ▼                                                    │
│  ┌────────────┐   decisione JSON tipata   ┌──────────────┐  │
│  │  agent.mjs │──────────────────────────►│ LLM locale    │  │
│  │ (trader AI)│  valida schema + rischi   │ (Ollama/Jan/  │  │
│  └────────────┘  nel codice               │  LM Studio)   │  │
│                                            └──────────────┘  │
│  ┌────────────┐                                              │
│  │ Dashboard  │  http://localhost:3131 — vedi tutto dal vivo │
│  └────────────┘                                              │
└─────────────────────────────────────────────────────────────┘
```

Principi (presa dalle analisi su Jev):
1. **Il modello decide, il codice esegue.** L'AI può solo proporre una mossa tipata
   (buy/sell/hold con percentuali e confidence). Il codice verifica schema, simbolo,
   limiti di rischio, cash disponibile — e rifiuta o limita.
2. **Niente aritmetica nel modello.** Prezzi, P&L, quantità: calcolati dal simulatore.
3. **Ogni decisione è loggata** con confidence e motivo: la dashboard mostra perché.

## Fasi

### Fase 1 — Simulatore (FATTO)
- `server.mjs`: prezzi reali Binance (fallback CoinGecko) ogni 5s, notizie RSS
  (Cointelegraph, CoinDesk, Decrypt) ogni 5 min, portafoglio finto $100 con fee
  0,10% e slippage 0,05%, persistenza su disco, API REST completa, dashboard.
- Verifica: avvia `node server.mjs`, apri http://localhost:3131.

### Fase 2 — Modello locale (DA FARE — su tua decisione, niente scaricato ora)
Hardware rilevato: RTX 4050 (6 GB VRAM) + 16 GB RAM. Opzioni:
- **Ollama** (consigliato, più semplice): installa da ollama.com, poi
  `ollama pull qwen2.5:7b-instruct-q4_K_M` (~4,7 GB, entra nei 6 GB). Alternative:
  `llama3.1:8b-instruct-q4_K_M`, `mistral:7b-instruct-q4_K_M`.
- **Jan** (interfaccia grafica) o **LM Studio**: scarichi il modello da lì, poi
  abiliti il "local server" OpenAI-compatible.
- L'agente è già pronto per tutti: basta `--base-url` e `--model`.

### Fase 3 — Aggiungere il modello all'agente (al momento dell'installazione)
1. Avvia il modello locale (es. `ollama serve`).
2. `node agent.mjs --dry-run` → guardalo decidere senza eseguire nulla.
3. `node agent.mjs` → opera davvero sul portafoglio finto, una decisione ogni 15 min.
4. Osserva per giorni: la dashboard mostra decisioni, ordini e P&L.

### Fase 4 — Migliorare l'AI (dopo qualche settimana di dati)
- [FATTO] Candele storiche reali (klines Binance 15m, ultime 100 ≈ 25h) nel contesto
  dell'AI con indicatori calcolati nel codice (SMA20, RSI14, range 24h, momentum 3h),
  e grafico a candele reale nella dashboard (`/api/candles`, dati 100% Binance).
- Confrontare più stili (`config.json → agent.style`: conservative/balanced/aggressive).
- Modelli più grandi o diversi, prompt più raffinati, memoria delle decisioni.
- Report periodici: P&L per decisione, win rate, drawdown massimo.

### Fase 5 — Solo se tutto regge e tu vuoi davvero
- Studio serio del trading reale (tasse italiane, exchange regolamentati, rischi).
- Eventuale passaggio a soldi veri con capitali minimi e limiti rigidi nel codice.
  Questa fase la decidi tu con calma; nessun componente attuale tocca soldi veri.

## Regole di rischio già in codice
- Massimo 20% della liquidità per singolo acquisto (configurabile).
- Confidence minima 0,6: sotto soglia l'agente esegue HOLD.
- Prezzi "stale" (>60s senza dati): nessun ordine viene eseguito.
- Fee 0,10% + slippage 0,05% per ordine: il costo esiste anche nel simulatore.
- Reset del portafoglio disponibile ma protetto da conferma.

## Cosa NON fa questo sistema
- Non tocca soldi veri, exchange o API con chiavi private.
- Non fa short/leverage: solo spot buy/sell.
- Non garantisce profitti: misura comportamenti.
