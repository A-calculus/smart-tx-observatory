# CHRONOS Observatory

AI-guided Solana transaction observability and Jito bundle execution for Testnet.

CHRONOS watches Solana network conditions in real time, scores the current execution environment, asks AI agents whether to submit, hold, retry, or skip, then tracks each Jito bundle from accepted to landed, confirmed, finalized, failed, or invalid. It is built for the messy edge where transaction timing, leader reliability, tip pressure, blockhash freshness, and Jito bundle state all meet.

![Consensus mode with validator context](public/consensus%20mode%20activated%2C%20which%20each%20slot%20leader%20validator.%20Saw%20Jupiter%20hence%20why%20i%20capture%20it.png)

## Why This Exists

Most Solana transaction tools answer one question: "did my transaction confirm?"

CHRONOS asks the questions that matter before and after submission:

- Is the next leader reliable or recently skipped?
- Is the Jito tip market cheap, normal, or spiking?
- Is slot cadence healthy enough to submit now?
- Did the bundle fail atomically, disappear from Jito, expire, or land?
- If Jito returns `Invalid`, what does chain state say about the signature, blockhash, balance, and leader window?
- Should the retry use the same tip, p90 tip, wait for rotation, or skip?

The result is an observatory, not just a sender. Every decision, submission, retry, failure, and stage transition is written to an append-only ledger.

## What Makes It Stand Out

- **AI timing layer**: AI decides whether to `SUBMIT` or `HOLD` before dispatch, using live network state.
- **Diagnostic AI layer**: failed transaction bundles can be diagnosed and retried only when there is a real failed transaction payload.
- **Network observations stay separate**: leader skips inform AI context and pulse score, but do not create fake retries.
- **Jito-native lifecycle tracking**: polls `getInflightBundleStatuses`, then tracks on-chain confirmation after landing.
- **Failure context enrichment**: `Invalid` and atomic bundle failures collect signature status, blockhash validity, sender balance, tip market, in-flight count, and upcoming leader data before AI diagnosis.
- **Consensus mode**: optional multi-provider AI consensus reduces single-model hallucination risk.
- **UI-first observability**: most system events flow through the in-app WebSocket event bus, not only stdout.
- **Testnet/mainnet guardrails**: RPC and Jito clusters are checked so Devnet/Testnet/Mainnet are not silently mixed.

![Failed twice then submitted successfully](public/bundled%20failed%20twice%20and%20the%20ai%20retried%2C%20it%20its%20submited%20succcessfully.png)

## Current Metrics

Metrics are derived from `data/ledger.jsonl` and `state/snapshot.json` in this repository:

| Metric | Current observed value |
|---|---:|
| Ledger decision/submission/failure/transition events matching core patterns | 24 |
| Latest persisted slot | 429646758 |
| Finalized successful bundle count in snapshot | 1 |
| Failed bundle count in snapshot | 3 |
| Total finalized tips paid | 8,684 lamports |
| Snapshot persistence interval | 30 seconds |
| Slot history window | 50 slots |

These files are intentionally local runtime artifacts. They make the project auditable: the UI is live, but the ledger is the record.

## System Architecture

```text
                ┌────────────────────┐
                │ Static HTML UI      │
                │ + WebSocket client  │
                └─────────▲──────────┘
                          │ EventBus
┌──────────────┐   ┌───────┴────────┐
│ Yellowstone  │   │ WsServer        │
│ gRPC / WSS   ├──►│ REST + WS UI    │
│ / HTTP slots │   └───────▲────────┘
└──────▲───────┘           │
       │                   │
┌──────┴───────┐   ┌───────┴────────┐
│ SlotWatcher  ├──►│ StateManager    │◄──────────────┐
└──────────────┘   │ snapshot.json   │               │
                   └───────▲────────┘               │
                           │                        │
┌──────────────┐   ┌───────┴────────┐       ┌───────┴────────┐
│ TipMonitor   ├──►│ PulseScore      ├──────► AI Layer        │
│ Jito tips    │   │ health model    │       │ single/consensus│
└──────────────┘   └────────────────┘       └───────▲────────┘
                                                     │
                                             ┌───────┴────────┐
                                             │ BundleBuilder   │
                                             │ SOL/SPL + tip   │
                                             └───────▲────────┘
                                                     │
                                             ┌───────┴────────┐
                                             │ JitoSubmitter   │
                                             │ submit + track  │
                                             └───────▲────────┘
                                                     │
                                             ┌───────┴────────┐
                                             │ LifecycleLedger │
                                             │ ledger.jsonl    │
                                             └────────────────┘
```

## Execution Flow

1. **UI starts first**
   - The app serves `ui/index.html` and opens a WebSocket server.
   - Logs and status updates use `bus.log()` and `TX_SUMMARY`, so the UI is the primary operator surface.

2. **Slot monitoring starts**
   - Priority is `gRPC -> WebSocket -> HTTP RPC polling`.
   - gRPC gives the fastest slot signal.
   - If gRPC fails repeatedly, CHRONOS falls back to WSS for that run.
   - Missing leaders are resolved through RPC leader lookups and cached by slot.

3. **Jito initializes**
   - Connects to the configured block engine.
   - Fetches live tip accounts where possible.
   - Falls back to known Jito tip accounts when the client is unavailable.

4. **Tip monitoring starts**
   - Polls live Jito tip data and stores p25/p50/p75/p90 style market context.

5. **AI decides timing**
   - For a queued user transaction, AI receives:
     - slot cadence
     - leader reliability
     - recent skipped leader observations
     - tip market
     - in-flight bundle count
     - prior session success/failure state
   - It returns `SUBMIT` or `HOLD`.

6. **Bundle is built**
   - Fetches fresh blockhash.
   - Builds a versioned transaction.
   - Adds the user transfer and a Jito tip transfer atomically.

7. **Jito tracking begins**
   - `sendBundle()` acceptance is not treated as success.
   - CHRONOS tracks:
     - `Pending`
     - `Landed`
     - `Confirmed`
     - `Finalized`
     - `Failed`
     - `Invalid`
     - timeout

8. **Diagnostics run only for real failed transactions**
   - Leader skips are network observations, not retry jobs.
   - If a bundle fails and has a stored payload, Diagnostic AI can decide `RETRY` or `SKIP`.
   - Retries rebuild with a fresh blockhash and updated tip.

![Leader skip informs decisions](public/Leader%20skipp%20and%20it%20decided%20to%20retry%20for%20this%20bundle%20by%20default%2C%20it%20leader%20skiping%20only%20informs%20its%20decision.png)

## Failure Intelligence

Jito can return `Invalid` with little detail. CHRONOS now enriches these failures before the AI diagnoses them.

Collected context includes:

- transaction signature status with `searchTransactionHistory`
- blockhash validity
- sender balance
- submitted amount
- current observed slot
- tip p50/p90
- in-flight bundle count
- upcoming leaders
- recently unreliable leaders

This means the Diagnostic AI can distinguish between:

- stale blockhash
- dropped bundle
- insufficient balance
- low tip pressure mismatch
- leader/timing issue
- on-chain execution error
- transient Jito tracking loss

## Module Map

| Module | Path | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Startup ordering, endpoint resolution, main decision loop |
| State | `src/state/stateManager.ts` | Runtime state, snapshots, failed payload archive |
| Pulse score | `src/state/pulseScore.ts` | Composite network health score |
| Slots | `src/observability/slotWatcher.ts` | gRPC/WSS/HTTP slot feed and leader lookup |
| Tips | `src/observability/tipMonitor.ts` | Live Jito tip floor monitoring |
| AI single mode | `src/ai/aiOrchestrator.ts` | Single-provider execution and diagnostic decisions |
| AI consensus mode | `src/ai/consensusOrchestrator.ts` | Multi-provider voting and self-test |
| AI facade | `src/ai/aiLayer.ts` | Mode switching and UI event emission |
| Bundle builder | `src/engine/bundleBuilder.ts` | SOL/SPL versioned tx bundle construction |
| Jito submitter | `src/engine/jitoSubmitter.ts` | Bundle submission, status polling, failure context |
| Wallet inspector | `src/engine/walletInspector.ts` | SOL/SPL balances for UI |
| Ledger | `src/ledger/lifecycleLedger.ts` | JSONL audit log |
| Server | `src/server/wsServer.ts` | Static UI, REST API, WebSocket fanout |
| UI | `ui/index.html` | Single-file operator dashboard |

## Project Type

This is **not a NestJS app**.

It is a **long-running Node.js + TypeScript backend service** with:

- a custom HTTP server
- a WebSocket server
- a static HTML dashboard
- background slot/tip/Jito polling loops
- filesystem-backed state and ledger persistence

Vercel failed because it tried to infer a NestJS entrypoint:

```text
Error: No entrypoint found which imports nestjs. Found possible entrypoint: src/index.ts
```

That error is expected for this architecture. CHRONOS is not a serverless request/response app. It needs a persistent process.

Recommended deployment targets:

- VPS
- Railway
- Fly.io
- Render background service
- Docker on any always-on host
- systemd process on a Linux server

Vercel can host a separate frontend, but the observatory backend should run somewhere that supports long-lived WebSocket and background workers.

## Environment

Use Testnet consistently when using Jito Testnet:

```env
RPC_BASE_URL=https://api.testnet.solana.com
WS_BASE_URL=wss://api.testnet.solana.com
JITO_BLOCK_ENGINE_URL=https://testnet.block-engine.jito.wtf
GRPC_CLUSTER=testnet
```

Optional provider-specific endpoints:

```env
SOLINFRA_API_KEY=...
GRPC_BASE_URL=https://fra.grpc.solinfra.dev:443
GRPC_BASE_TOKEN=...

CHAINSTACK_API_KEY=...
RPC_URL=...
WS_URL=...
GRPC_URL=...
GRPC_TOKEN=...
```

AI providers:

```env
OPENROUTER_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...

GEMINI_URL=...
GEMINI_API_KEY=...
GEMINI_MODEL=...

GROQ_URL=...
GROQ_API_KEY=...
GROQ_MODEL=...

MISTRAL_URL=...
MISTRAL_API_KEY=...
MISTRAL_MODEL=...
```

Wallet:

```env
SENDER_PRIVATE_KEY=...
```

Never mix Devnet RPC with Jito Testnet. CHRONOS checks cluster compatibility at startup to prevent this class of failure.

## Running Locally

```bash
npm install
npm run build
npm start
```

Open:

```text
http://localhost:3000
```

Simulation:

```bash
npm run simulate
```

## REST API

The UI uses these local endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Current state snapshot |
| `GET` | `/api/wallet/tokens` | Wallet SOL/SPL balances |
| `GET` | `/api/mode` | AI mode |
| `POST` | `/api/mode` | Switch `single` / `consensus` |
| `POST` | `/api/consensus/test` | Run consensus provider self-test |
| `POST` | `/api/simulate/toggle` | Toggle simulation mode |
| `POST` | `/api/tx/send` | Queue AI-timed transfer |
| `POST` | `/api/contract/deploy` | Queue AI-timed program deployment |

## State And Auditability

| File | Role |
|---|---|
| `state/snapshot.json` | Runtime state persisted every 30 seconds |
| `data/ledger.jsonl` | Append-only lifecycle ledger |
| `data/ledger.backup.*.jsonl` | Shutdown backups |

The ledger is intentionally verbose. It captures:

- AI decisions
- holds
- submissions
- failures
- stage transitions
- run summaries

## Notes On Jito Testnet

- `sendBundle()` returning a bundle ID means the block engine accepted the bundle for processing. It does not mean the bundle landed.
- `Invalid` means the bundle is no longer in Jito's inflight tracking window or cannot be found by that status path. CHRONOS now checks chain context before asking AI whether to retry.
- Testnet leader behavior and tip markets can be noisy; this is exactly why leader reliability and tip pressure are part of the prompt.

## Roadmap

- Per-transaction retry budget and backoff.
- Stronger `Invalid` taxonomy using signature status, blockhash age, and leader window.
- Better distinction between Jito tracking disappearance and actual execution failure.
- Dockerfile and production deployment template.
- Historical metrics dashboard from `ledger.jsonl`.
- Optional database sink for long-running deployments.

