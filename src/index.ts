import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import axios from 'axios';
import { Connection, Keypair } from '@solana/web3.js';

import { StateManager } from './state/stateManager.js';
import type { TxPayload } from './state/stateManager.js';
import { calculatePulseScore } from './state/pulseScore.js';
import { SlotWatcher } from './observability/slotWatcher.js';
import { TipMonitor } from './observability/tipMonitor.js';
import { AILayer } from './ai/aiLayer.js';
import { BundleBuilder, parseKeypair } from './engine/bundleBuilder.js';
import { JitoSubmitter } from './engine/jitoSubmitter.js';
import { FailureClassifier } from './engine/failureClassifier.js';
import { LifecycleLedger } from './ledger/lifecycleLedger.js';
import { WalletInspector } from './engine/walletInspector.js';
import { ContractDeployer } from './engine/contractDeployer.js';
import { WsServer } from './server/wsServer.js';
import { bus } from './server/eventBus.js';

dotenv.config();

// ── Intercept console → EventBus (so all module logs appear in UI) ──────────
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log = (...args: any[]) => { const m = args.join(' '); _origLog(m); bus.log('sys', m, 'info'); };
console.warn = (...args: any[]) => { const m = args.join(' '); _origWarn(m); bus.log('sys', m, 'warn'); };
console.error = (...args: any[]) => { const m = args.join(' '); _origError(m); bus.log('sys', m, 'error'); };

interface AppConfig {
  pulseScoreWeights: { slotHealth: number; tipPressure: number; leaderReliability: number };
  timing: { slotCadenceTargetMs: number; stateBackupIntervalSec: number; decisionCycleIntervalSlots: number; statusPollingIntervalMs: number };
  execution: { dryRun: boolean; maxRetries: number; minTipLamports: number; maxTipLamports: number; defaultTipLamports: number };
}

type SolanaCluster = 'mainnet' | 'testnet' | 'devnet' | 'unknown';

const GENESIS_TO_CLUSTER: Record<string, SolanaCluster> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcV6TuURoqaaBRuMM8gST6tFC7984G8ZrUkS489R1Y': 'testnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet'
};

function inferJitoCluster(blockEngineUrl: string): SolanaCluster {
  const url = blockEngineUrl.toLowerCase();
  if (url.includes('testnet')) return 'testnet';
  if (url.includes('mainnet')) return 'mainnet';
  if (url.includes('devnet')) return 'devnet';
  return 'unknown';
}

function appendApiKey(url: string, apiKey?: string): string {
  if (!url || !apiKey) return url;
  if (url.includes('YOUR_KEY')) return url.replace(/YOUR_KEY/g, encodeURIComponent(apiKey));
  if (/[?&]api_key=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
}

function providerApiKeyForUrl(url: string, explicitKey?: string): string | undefined {
  if (explicitKey) return explicitKey;
  const normalized = url.toLowerCase();
  if (normalized.includes('solinfra.dev')) return process.env.SOLINFRA_API_KEY;
  if (normalized.includes('chainstack.com')) return process.env.CHAINSTACK_API_KEY;
  return undefined;
}

function normalizeGrpcEndpoint(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://${url}`;
}

function maskUrl(url: string): string {
  return url
    .replace(/api_key=([^&]+)/, 'api_key=****')
    .replace(/token=([^&]+)/, 'token=****');
}

async function assertClusterCompatibility(connection: Connection, jitoUrl: string): Promise<SolanaCluster> {
  const genesisHash = await connection.getGenesisHash();
  const rpcCluster = GENESIS_TO_CLUSTER[genesisHash] || 'unknown';
  const jitoCluster = inferJitoCluster(jitoUrl);

  console.log(`[Index] RPC cluster: ${rpcCluster} (genesis ${genesisHash})`);
  console.log(`[Index] Jito cluster: ${jitoCluster}`);

  if (jitoCluster === 'devnet') {
    throw new Error('Jito Block Engine is not available on Solana Devnet. Use Testnet or Mainnet.');
  }

  if (rpcCluster !== 'unknown' && jitoCluster !== 'unknown' && rpcCluster !== jitoCluster) {
    throw new Error(
      `Cluster mismatch: RPC is ${rpcCluster}, but Jito Block Engine is ${jitoCluster}. ` +
      'Bundles must be built and submitted on the same Solana cluster.'
    );
  }

  if (rpcCluster === 'devnet') {
    throw new Error('Current RPC is Devnet, but Jito bundles are only supported on Testnet/Mainnet. Configure a Testnet RPC for this app.');
  }

  if (rpcCluster === 'unknown' || jitoCluster === 'unknown') {
    console.warn('[Index] Could not fully infer RPC/Jito cluster compatibility. Continuing with caution.');
  }

  return rpcCluster;
}

function shouldDisableGrpc(rpcCluster: SolanaCluster, jitoUrl: string, grpcCluster: SolanaCluster | ''): boolean {
  if (!grpcCluster || grpcCluster === 'unknown') return false;
  if (rpcCluster !== 'unknown') return grpcCluster !== rpcCluster;

  const jitoCluster = inferJitoCluster(jitoUrl);
  if (jitoCluster !== 'unknown') return grpcCluster !== jitoCluster;

  return false;
}

function resolveEndpointConfig() {
  const rpcBaseUrl = process.env.RPC_BASE_URL || '';
  const wsBaseUrl = process.env.WS_BASE_URL || '';
  const grpcBaseUrl = process.env.GRPC_BASE_URL || '';

  const rpcUrl = rpcBaseUrl
    ? appendApiKey(rpcBaseUrl, providerApiKeyForUrl(rpcBaseUrl, process.env.RPC_BASE_API_KEY))
    : appendApiKey(process.env.RPC_URL || '', providerApiKeyForUrl(process.env.RPC_URL || '', process.env.RPC_API_KEY));

  const wsUrl = wsBaseUrl
    ? appendApiKey(wsBaseUrl, providerApiKeyForUrl(wsBaseUrl, process.env.WS_BASE_API_KEY))
    : appendApiKey(process.env.WS_URL || '', providerApiKeyForUrl(process.env.WS_URL || '', process.env.WS_API_KEY));

  const grpcUrl = normalizeGrpcEndpoint(grpcBaseUrl || process.env.GRPC_URL || '');

  const grpcToken = grpcBaseUrl
    ? process.env.GRPC_BASE_TOKEN || process.env.SOLINFRA_GRPC_TOKEN || ''
    : process.env.GRPC_TOKEN || '';

  return { rpcUrl, wsUrl, grpcUrl, grpcToken };
}

async function loadConfig(): Promise<AppConfig> {
  try {
    const fileContent = await fs.readFile('./config.yaml', 'utf-8');
    return YAML.parse(fileContent) as AppConfig;
  } catch {
    return {
      pulseScoreWeights: { slotHealth: 40, tipPressure: 30, leaderReliability: 30 },
      timing: { slotCadenceTargetMs: 400, stateBackupIntervalSec: 30, decisionCycleIntervalSlots: 10, statusPollingIntervalMs: 2000 },
      execution: { dryRun: false, maxRetries: 3, minTipLamports: 1000, maxTipLamports: 5000000, defaultTipLamports: 50000 }
    };
  }
}

async function main() {
  console.log('====================================================');
  console.log('   CHRONOS - Solana Smart Transaction Observatory   ');
  console.log('====================================================');

  const config = await loadConfig();

  // ── Wallet ────────────────────────────────────────────────────────────────
  let wallet: Keypair;
  let isMockWallet = false;
  const privateKeyStr = process.env.SENDER_PRIVATE_KEY;

  if (!privateKeyStr || privateKeyStr.trim() === '' || privateKeyStr === 'your_private_key_here') {
    console.warn('[Warning] SENDER_PRIVATE_KEY not set. Using temporary mock wallet for dry-run.');
    wallet = Keypair.generate();
    isMockWallet = true;
  } else {
    try {
      wallet = parseKeypair(privateKeyStr);
      console.log(`[Index] Wallet: ${wallet.publicKey.toBase58().slice(0, 20)}**********`);
    } catch (e: any) {
      console.error(`[Error] Failed to parse keypair: ${e.message}`);
      process.exit(1);
    }
  }

  // ── RPC ───────────────────────────────────────────────────────────────────
  const endpoints = resolveEndpointConfig();
  const { rpcUrl, wsUrl } = endpoints;
  let { grpcUrl, grpcToken } = endpoints;
  const grpcCluster = (process.env.GRPC_CLUSTER || '').toLowerCase() as SolanaCluster | '';
  const jitoUrl = process.env.JITO_BLOCK_ENGINE_URL || 'https://testnet.block-engine.jito.wtf';
  const uiPort = parseInt(process.env.UI_PORT || '3000', 10);

  console.log(`[Index] Slot transport priority: gRPC (${grpcUrl ? 'configured' : 'not configured'}) -> WS (${wsUrl ? 'configured' : 'not configured'}) -> HTTP RPC`);
  console.log(`[Index] RPC: ${maskUrl(rpcUrl)}`);
  console.log(`[Index] WS: ${maskUrl(wsUrl) || 'not configured'}`);
  console.log(`[Index] Jito: ${jitoUrl}`);

  const connection = new Connection(rpcUrl, 'confirmed');
  const rpcCluster = await assertClusterCompatibility(connection, jitoUrl);
  if (rpcCluster === 'testnet') {
    console.log('[Index] Testnet mode confirmed. Ensure this wallet is funded with testnet SOL.');
  }
  if (grpcUrl && shouldDisableGrpc(rpcCluster, jitoUrl, grpcCluster)) {
    console.warn(`[Index] Disabling gRPC: GRPC_CLUSTER=${grpcCluster}, RPC cluster is ${rpcCluster}, Jito cluster is ${inferJitoCluster(jitoUrl)}.`);
    grpcUrl = '';
    grpcToken = '';
  } else if (grpcUrl && rpcCluster === 'unknown' && grpcCluster) {
    console.warn(`[Index] RPC cluster is unknown, but gRPC remains enabled because GRPC_CLUSTER=${grpcCluster} matches the Jito endpoint.`);
  } else if (grpcUrl && !grpcCluster) {
    console.warn('[Index] GRPC_CLUSTER is not set. Only enable gRPC if that endpoint is on the same cluster as RPC/Jito.');
  }

  // ── Core modules ──────────────────────────────────────────────────────────
  const stateManager = new StateManager();
  const ledger = new LifecycleLedger();
  const failureClassifier = new FailureClassifier();

  await stateManager.initialize();
  await ledger.initialize();

  // ── AI Layer (single + consensus) ─────────────────────────────────────────
  const aiProviders = [
    { name: 'OpenRouter', url: process.env.OPENROUTER_URL || '', apiKey: process.env.OPENROUTER_API_KEY || '', model: process.env.OPENROUTER_MODEL || '' },
    { name: 'Gemini', url: process.env.GEMINI_URL || '', apiKey: process.env.GEMINI_API_KEY || '', model: process.env.GEMINI_MODEL || '' },
    { name: 'Groq', url: process.env.GROQ_URL || '', apiKey: process.env.GROQ_API_KEY || '', model: process.env.GROQ_MODEL || '' },
    { name: 'Mistral', url: process.env.MISTRAL_URL || '', apiKey: process.env.MISTRAL_API_KEY || '', model: process.env.MISTRAL_MODEL || '' }
  ];
  const aiLayer = new AILayer(aiProviders);

  const jitoSubmitter = new JitoSubmitter(connection, stateManager, failureClassifier, ledger, jitoUrl);
  let jitoTipAccounts: string[] = [];
  const bundleBuilder = new BundleBuilder(connection, wallet);
  const walletInspector = new WalletInspector(connection);

  // ── Contract Deployer ─────────────────────────────────────────────────────
  const contractDeployer = new ContractDeployer(
    connection, wallet, aiLayer, stateManager, bundleBuilder, jitoSubmitter, ledger, failureClassifier
  );

  // ── Send TX queue handler ─────────────────────────────────────────────────
  const pendingSendTxQueue: TxPayload[] = [];

  const handleSendTx = (params: typeof pendingSendTxQueue[0]) => {
    const queuedTx = { ...params, txId: params.txId || `send-${Date.now()}` };
    pendingSendTxQueue.push(queuedTx);
    bus.log('Index', `Send TX queued: ${queuedTx.amountLamports} lam → ${queuedTx.recipient.slice(0, 16)}...`);
  };

  // ── WebSocket server ──────────────────────────────────────────────────────
  const wsServer = new WsServer(uiPort);
  wsServer.setContext({
    stateManager,
    aiLayer,
    walletInspector,
    wallet,
    jitoTipAccounts,
    onSendTx: handleSendTx,
    onContractDeploy: (bytes, label) => contractDeployer.queueDeploy(bytes, label)
  });

  // ── Slot monitoring ───────────────────────────────────────────────────────
  // App startup priority is UI -> slots -> Jito -> tips. Inside SlotWatcher,
  // transport priority remains gRPC -> WebSocket -> HTTP RPC polling.
  const slotWatcher = new SlotWatcher(rpcUrl, wsUrl, grpcUrl, grpcToken, stateManager);
  slotWatcher.start().catch((e: any) => {
    bus.log('SlotWatcher', `Startup failed: ${e.message}`, 'error');
  });

  // ── Jito setup ────────────────────────────────────────────────────────────
  try {
    jitoTipAccounts = await jitoSubmitter.initialize();
    wsServer.setContext({
      stateManager,
      aiLayer,
      walletInspector,
      wallet,
      jitoTipAccounts,
      onSendTx: handleSendTx,
      onContractDeploy: (bytes, label) => contractDeployer.queueDeploy(bytes, label)
    });
  } catch (e: any) {
    bus.log('JitoSubmitter', `Initialization failed: ${e.message}`, 'error');
  }

  // ── Observability ─────────────────────────────────────────────────────────
  const tipMonitor = new TipMonitor(stateManager, config.timing.statusPollingIntervalMs);
  await tipMonitor.start();

  // ── Fetch Global Jito Validators ──────────────────────────────────────────
  let jitoValidators: string[] = [];
  try {
    const res = await axios.get('https://api.jito.wtf/v1/validators');
    if (res.data && res.data.validators) {
      jitoValidators = res.data.validators.map((v: any) => v.node_pubkey);
      console.log(`[Index] Loaded ${jitoValidators.length} Jito-enabled validators.`);
    }
  } catch (e) {
    console.warn('[Index] Failed to fetch Jito validators, assuming all upcoming are enabled.');
  }

  // ── Main decision loop ────────────────────────────────────────────────────
  let lastCheckedSlot = 0;
  let nextDecisionSlot = 0;
  let holdRemainingSlots = 0;
  let activeFailure: { bundleId: string; type: string; message: string } | undefined;
  let isAiBusy = false;

  console.log('[Index] Services active. Awaiting slot updates...');

  const loopInterval = setInterval(async () => {
    const stateSnapshot = stateManager.getSnapshot();
    const currentSlot = stateSnapshot.network.latestSlot;

    if (currentSlot === 0 || currentSlot === lastCheckedSlot) return;
    lastCheckedSlot = currentSlot;

    // Emit state snapshot periodically (every 5 slots)
    if (currentSlot % 5 === 0) {
      bus.emit('chronos', { type: 'STATE_SNAPSHOT', state: stateSnapshot, timestamp: new Date().toISOString() });
    }

    // Update leader schedule — refresh every 4 slots, fetch 40 ahead so the schedule
    // is always populated before slots arrive in the SlotWatcher
    try {
      if (currentSlot % 4 === 0) {
        const leaders = await connection.getSlotLeaders(currentSlot, 40);
        stateManager.updateUpcomingLeaders(leaders.map((l, i) => {
          const pubkey = l.toBase58();
          const isJito = jitoValidators.length > 0 ? jitoValidators.includes(pubkey) : true;
          return { slot: currentSlot + i, leader: pubkey, isJito };
        }));
      }
    } catch { /* silent */ }

    const pulseResult = calculatePulseScore(stateSnapshot);
    stateManager.updatePulseScore(pulseResult.score, pulseResult.components);

    if (holdRemainingSlots > 0) { holdRemainingSlots--; return; }

    // Pick up async failures
    if (!activeFailure) {
      const asyncFailure = stateManager.popUnprocessedFailure();
      if (asyncFailure) {
        if (asyncFailure.type === 'LEADER_SKIP') {
          console.log(`[Index] Ignoring leader-skip observation for retry flow: ${asyncFailure.message}`);
        } else {
          activeFailure = { bundleId: asyncFailure.bundleId, type: asyncFailure.type, message: asyncFailure.message };
          console.log(`[Index] Async failure queued: ${asyncFailure.type}`);
        }
      }
    }

    // Decision cycle
    const hasPendingTx = pendingSendTxQueue.length > 0;
    const shouldRunCycle = hasPendingTx || (stateSnapshot.isSimulationActive && currentSlot >= nextDecisionSlot) || activeFailure;

    if (shouldRunCycle && !isAiBusy) {
      isAiBusy = true;
      (async () => {
        try {
          if (hasPendingTx) {
            const pendingTx = pendingSendTxQueue.shift()!;
            await handleSendTxDispatch(pendingTx, stateSnapshot, pulseResult.score, config, isMockWallet);
          } else if (activeFailure) {
            console.log(`[Index] Diagnosing failure: ${activeFailure.type}`);
            const failure = activeFailure;
            activeFailure = undefined;
            const decision = await aiLayer.getDiagnosticDecision(stateSnapshot, failure);
            await ledger.logDecision({ slot: currentSlot, pulseScore: pulseResult.score, action: decision.action, tip: decision.tip, reasoning: decision.reasoning });

            if (decision.action === 'RETRY') {
              console.log(`[Index] AI decided to RETRY based on failure diagnosis: ${decision.reasoning}`);
              const payload = stateManager.getPayload(failure.bundleId);
              if (payload) {
                bus.log('Index', `Executing Diagnostic RETRY for bundle ${failure.bundleId.slice(0, 8)} with tip ${decision.tip} lamports`, 'info');
                // Run retry asynchronously
                handleSendTxDispatch(payload, stateSnapshot, pulseResult.score, config, isMockWallet, decision.tip)
                  .catch(e => bus.log('Index', `Retry dispatch failed: ${e.message}`, 'error'));
              } else {
                bus.log('Index', `Skipping Diagnostic RETRY for ${failure.bundleId.slice(0, 8)}: no original transaction payload exists.`, 'warn');
              }
            } else if (decision.action === 'SKIP') {
              console.log(`[Index] AI decided to SKIP failure: ${decision.reasoning}`);
            }
          } else if (stateSnapshot.isSimulationActive) {
            console.log(`[Index] Simulation cycle at slot ${currentSlot}`);
            const decision = await aiLayer.getExecutionDecision(stateSnapshot, "Simulation Dummy TX");
            await ledger.logDecision({ slot: currentSlot, pulseScore: pulseResult.score, action: decision.action, tip: decision.tip, reasoning: decision.reasoning });

            if (decision.action === 'HOLD') {
              holdRemainingSlots = decision.waitDuration;
              nextDecisionSlot = currentSlot + holdRemainingSlots;
              await ledger.logHold({ slot: currentSlot, pulseScore: pulseResult.score, reason: decision.reasoning, resumeSlot: nextDecisionSlot });
            } else {
              nextDecisionSlot = currentSlot + config.timing.decisionCycleIntervalSlots;
            }
          }
        } catch (e: any) {
          console.error(`[Index] Cycle error: ${e.message}`);
        } finally {
          isAiBusy = false;
        }
      })();
    }
  }, 400);

  // ── Send TX dispatch (AI-timed) ───────────────────────────────────────────
  async function handleSendTxDispatch(
    tx: TxPayload,
    stateSnapshot: any,
    pulseScore: number,
    cfg: AppConfig,
    dryRun: boolean,
    customTip?: number
  ) {
    const txId = tx.txId || `send-${Date.now()}`;
    tx.txId = txId;
    bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'RUNNING', `${tx.amountLamports} lam`);
    try {
      let tipVal: number;
      let reasoning: string;

      if (customTip !== undefined) {
        tipVal = Math.min(Math.max(customTip, cfg.execution.minTipLamports), cfg.execution.maxTipLamports);
        reasoning = `AI Diagnostic Retry with tip ${tipVal} lamports`;
      } else {
        const decision = await aiLayer.getExecutionDecision(stateSnapshot, `Send ${tx.amountLamports} lamports to ${tx.recipient}`);
        tipVal = Math.min(Math.max(decision.tip, cfg.execution.minTipLamports), cfg.execution.maxTipLamports);
        reasoning = decision.reasoning;

        if (decision.action === 'HOLD') {
          const currentSlot = stateSnapshot.network.latestSlot;
          const resumeSlot = currentSlot + decision.waitDuration;
          bus.log('Index', `AI timing decision: HOLD transaction (reason: ${decision.reasoning}). Waiting ${decision.waitDuration} slots.`, 'warn');
          holdRemainingSlots = decision.waitDuration;
          pendingSendTxQueue.unshift(tx); // put back at front of queue
          bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'RETRYING', `HOLD: Waiting ${decision.waitDuration} slots`);
          await ledger.logHold({ slot: currentSlot, pulseScore, reason: decision.reasoning, resumeSlot });
          return;
        }
      }

      if (dryRun) {
        console.log(`[SendTX][DryRun] Would send ${tx.amountLamports} lam to ${tx.recipient} with tip ${tipVal}`);
        bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'VERIFIED', 'DryRun');
        return;
      }

      let bundle, txSignature, blockhash;
      if (tx.tokenMint) {
        const tokenInfo = { mint: tx.tokenMint, symbol: tx.tokenMint.slice(0, 6), uiAmount: 0, decimals: 9, ataAddress: '' };
        ({ bundle, txSignature, blockhash } = await bundleBuilder.buildSPLTransferBundle(
          tx.recipient, tx.tokenMint, BigInt(tx.amountLamports), 9, tipVal, jitoTipAccounts
        ));
      } else {
        ({ bundle, txSignature, blockhash } = await bundleBuilder.buildSOLTransferBundle(
          tx.recipient, tx.amountLamports, tipVal, jitoTipAccounts
        ));
      }

      bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'WATCHING', 'Bundle submitted');

      // Fire and forget bundle tracking
      jitoSubmitter.submitAndTrack(bundle, txSignature, tipVal, blockhash, pulseScore, reasoning, tx)
        .then(ok => {
          if (ok) bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'VERIFIED', txSignature.slice(0, 16));
          else bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'FAILED', 'Bundle rejected');
        })
        .catch(e => {
          bus.log('Index', `SendTX tracking failed: ${e.message}`, 'error');
          bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'FAILED', e.message.slice(0, 60));
        });

    } catch (e: any) {
      bus.log('Index', `SendTX dispatch failed: ${e.message}`, 'error');
      bus.txStatus(txId, `→ ${tx.recipient.slice(0, 8)}...`, 'FAILED', e.message.slice(0, 60));
      // Queue pre-execution failure for Diagnostic AI debugging
      stateManager.pushFailure(`pre-exec-${txId}`, 'PRE_EXECUTION_FAILURE', e.message);
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n[Index] Shutting down...');
    clearInterval(loopInterval);
    tipMonitor.stop();
    await slotWatcher.stop();
    stateManager.stop();
    await stateManager.persistState();
    const snapshot = stateManager.getSnapshot();
    await ledger.logSummary({
      totalSubmissions: snapshot.bundles.completed.length + snapshot.bundles.failed.length,
      successful: snapshot.bundles.completed.length,
      failed: snapshot.bundles.failed.length,
      totalTipsPaidLamports: snapshot.bundles.totalTipsPaidLamports || 0
    });
    await ledger.backupLedger();
    console.log('[Index] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal] Application crashed:', err);
  process.exit(1);
});
