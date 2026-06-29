# CHRONOS — Solana Smart Transaction Observatory

> **Testnet-ready** autonomous Solana transaction intelligence system.  
> Observes real-time network conditions, runs AI-driven bundle decisions, and tracks Jito MEV bundles through their full lifecycle.

---

## Overview

CHRONOS is a Node.js/TypeScript backend observatory for Solana Testnet. It continuously monitors network health, delegates submission decisions to a round-robin AI agent, builds Jito MEV bundles with embedded tip instructions, and tracks each bundle from submission to finalization — all with full ledger auditability.

```
Network  →  SlotWatcher  →  PulseScore  →  AIOrchestrator  →  BundleBuilder  →  JitoSubmitter
                ↓                                                                      ↓
           TipMonitor                                                          LifecycleLedger
```

---

## Architecture

| Module | Path | Role |
|---|---|---|
| **SlotWatcher** | `src/observability/slotWatcher.ts` | Streams slot data via Yellowstone gRPC (or WSS fallback) |
| **TipMonitor** | `src/observability/tipMonitor.ts` | Polls Jito tip floor REST API every ~2s |
| **AIOrchestrator** | `src/ai/aiOrchestrator.ts` | Round-robin AI decision engine (4 providers) |
| **BundleBuilder** | `src/engine/bundleBuilder.ts` | Constructs versioned Solana transactions with atomic tips |
| **JitoSubmitter** | `src/engine/jitoSubmitter.ts` | Submits bundles and polls Jito inflight/confirmed status |
| **StateManager** | `src/state/stateManager.ts` | In-memory network state, snapshotted every 30s |
| **LifecycleLedger** | `src/ledger/lifecycleLedger.ts` | JSONL append-only audit log for all decisions and outcomes |
| **PulseScore** | `src/state/pulseScore.ts` | 0–100 composite score of slot health, tip pressure, leader reliability |

---

## AI Orchestration — Round-Robin Multi-Provider

The AI Orchestrator cycles through up to 4 providers in order:

```
OpenRouter → Gemini → Groq → Mistral → (back to OpenRouter...)
```

- **On success**: uses the current provider, stays on it next cycle.
- **On failure** (timeout, 429, API error): logs the error to console, **advances to the next provider** for the next call, returns **SKIP** for the current cycle (no bundle submitted).
- **Skipped providers**: any provider with an empty `API_KEY` is automatically excluded at startup.

Configure via `.env`:
```env
OPENROUTER_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openrouter/owl-alpha

GEMINI_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-pro

GROQ_URL=https://api.groq.com/openai/v1/chat/completions
GROQ_API_KEY=
GROQ_MODEL=llama3-70b-8192

MISTRAL_URL=https://api.mistral.ai/v1/chat/completions
MISTRAL_API_KEY=
MISTRAL_MODEL=mistral-large-latest
```

---

## Network Connectivity

### Slot Monitoring

CHRONOS attempts to connect via **Yellowstone gRPC** first for sub-block latency, and falls back to **WebSocket** if gRPC fails.

| Endpoint | Value |
|---|---|
| gRPC | `fra.grpc.solinfra.dev:443` |
| WSS | `wss://fra.rpc.solinfra.dev/sol?api_key=<KEY>` |

> **Note**: Solinfra's free/developer plan has gRPC **and** WebSockets disabled. If your plan does not support these, the system will log a clear error and skip streaming. Upgrade to Pro/Ultra for gRPC, or provide an alternative `WS_URL` in `.env` for WebSocket.

### RPC

```env
RPC_BASE_URL=https://api.testnet.solana.com
WS_BASE_URL=wss://api.testnet.solana.com
JITO_BLOCK_ENGINE_URL=https://testnet.block-engine.jito.wtf

# Optional keyed provider URLs
SOLINFRA_API_KEY=your_solinfra_rpc_key
GRPC_BASE_URL=fra.grpc.solinfra.dev:443
GRPC_BASE_TOKEN=your_solinfra_grpc_token
GRPC_CLUSTER=testnet
```

All API keys are **truncated in console output** — e.g. `api_key=rpc_...` — and never logged in full.

---

## Jito Bundle Lifecycle

```
buildBundle()
    │
    ├─ Fetch fresh blockhash
    ├─ Select random tip account from live getTipAccounts() result
    ├─ Build: [MemoInstruction + TipInstruction] in a single VersionedTransaction
    └─ Sign & wrap in Jito Bundle
           │
    submitAndTrack()
           │
           ├─ sendBundle() → gRPC or REST
           ├─ poll getInflightBundleStatuses (every 2s)
           │     ├─ Pending → continue
           │     ├─ Landed  → poll getBundleStatuses for confirmed/finalized
           │     ├─ Failed  → log full raw Jito status payload + reason field
           │     └─ Invalid → log full raw Jito status payload
           └─ Ledger entry at every stage transition
```

> Tip accounts are fetched **live from the Block Engine** at startup (`getTipAccounts()`). This ensures testnet bundles write-lock the correct testnet accounts rather than mainnet static addresses.

---

## Console Output

| Prefix | Color | Meaning |
|---|---|---|
| `[AI Decision] Action: SUBMIT` | 🟢 Green | Bundle submission triggered |
| `[AI Decision] Action: RETRY` | 🔵 Cyan | Retrying with fresh blockhash/higher tip |
| `[AI Decision] Action: HOLD` | 🟡 Yellow | Waiting N slots for conditions to improve |
| `[AI Decision] Action: SKIP` | ⚫ Gray | Cycle skipped (AI provider error or low priority) |

Colors are applied only when stdout is a TTY or `FORCE_COLOR=1` is set.

---

## Ledger & State

| File | Description |
|---|---|
| `data/ledger.jsonl` | JSONL append-only log of all decisions, submissions, failures, transitions |
| `data/ledger.backup.*.jsonl` | Auto-backup created on clean shutdown |
| `state/snapshot.json` | Full system state snapshot, saved every 30 seconds |

---

## Environment Configuration

Copy `.env.example` to `.env` and populate:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `RPC_BASE_URL` | ✅ | Primary HTTPS RPC URL. Use `https://api.testnet.solana.com` for public Testnet |
| `WS_BASE_URL` | — | Primary WSS URL. Use `wss://api.testnet.solana.com` for public Testnet |
| `RPC_BASE_API_KEY` / `WS_BASE_API_KEY` | — | Optional API keys for keyed `*_BASE_URL` providers |
| `SOLINFRA_API_KEY` | — | Optional Solinfra RPC/WSS key. Appends as `?api_key=` only for Solinfra URLs |
| `GRPC_BASE_URL` | — | Yellowstone gRPC endpoint, host:port format preferred |
| `GRPC_BASE_TOKEN` | — | Yellowstone gRPC `x-token` metadata token |
| `GRPC_CLUSTER` | — | Cluster for the gRPC endpoint. Must match RPC/Jito when set |
| `CHAINSTACK_API_KEY` | — | Optional Chainstack key. Used only for Chainstack fallback URLs |
| `RPC_URL` / `WS_URL` | — | Provider-specific fallback RPC/WSS URLs |
| `JITO_BLOCK_ENGINE_URL` | ✅ | Jito block engine (testnet or mainnet) |
| `SENDER_PRIVATE_KEY` | ✅ | Wallet for signing bundles (base58 or JSON array) |
| `OPENROUTER_API_KEY` | ✅ | Primary AI provider key |
| `GEMINI_API_KEY` | — | Secondary AI provider |
| `GROQ_API_KEY` | — | Third AI provider |
| `MISTRAL_API_KEY` | — | Fourth AI provider |

---

## Running

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start live observatory
npm run start

# Run simulation (no real transactions)
npm run simulate
```

---

## Current Status

| Feature | Status |
|---|---|
| gRPC slot streaming | ✅ Implemented (requires Pro plan) |
| WebSocket fallback | ✅ Implemented |
| Jito tip floor monitoring | ✅ Live from `bundles.jito.wtf` |
| AI round-robin orchestration | ✅ 4 providers, cycles on failure |
| Jito bundle submission | ✅ With atomic tip embedding |
| Bundle lifecycle tracking | ✅ Inflight → Landed → Confirmed → Finalized |
| Failure classification | ✅ Detailed Jito raw payload logged on failure |
| Autonomous retry loop | ✅ AI evaluates failures and issues RETRY decisions |
| Ledger persistence | ✅ JSONL + 30s snapshot |
| Credential masking | ✅ API keys truncated in all console output |
| Simulation mode | ✅ `npm run simulate` — no real transactions |

---

## Region

All infrastructure is locked to **Frankfurt (FRA)** throughout. Jito Testnet has no regional block engine variant — `testnet.block-engine.jito.wtf` is used globally.
