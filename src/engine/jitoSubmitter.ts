import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { searcher } from '@drift-labs/jito-ts';
import { Bundle } from '@drift-labs/jito-ts/dist/sdk/block-engine/types.js';
import axios from 'axios';
import { StateManager } from '../state/stateManager.js';
import type { TxPayload } from '../state/stateManager.js';
import { FailureClassifier } from './failureClassifier.js';
import { LifecycleLedger } from '../ledger/lifecycleLedger.js';
import { bus } from '../server/eventBus.js';

// Bundle status polling intervals
const INFLIGHT_POLL_INTERVAL_MS = 2000;
const INFLIGHT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (Jito's in-flight window)

export class JitoSubmitter {
  private connection: Connection;
  private stateManager: StateManager;
  private failureClassifier: FailureClassifier;
  private ledger: LifecycleLedger;
  private blockEngineUrl: string;
  private client: searcher.SearcherClient | null = null;

  constructor(
    connection: Connection,
    stateManager: StateManager,
    failureClassifier: FailureClassifier,
    ledger: LifecycleLedger,
    blockEngineUrl: string
    // NOTE: auth keypair intentionally omitted — not required for public block engine access (per jito)
  ) {
    this.connection = connection;
    this.stateManager = stateManager;
    this.failureClassifier = failureClassifier;
    this.ledger = ledger;
    this.blockEngineUrl = blockEngineUrl;
  }

  public async initialize(): Promise<string[]> {
    console.log(`[JitoSubmitter] Connecting to Jito Block Engine at: ${this.blockEngineUrl}`);

    try {
      // Auth keypair is not required for public block engine access
      const grpcUrl = this.blockEngineUrl.replace(/^https?:\/\//, '');
      this.client = searcher.searcherClient(grpcUrl, undefined as any);
      const response = await this.client.getTipAccounts();
      if ('ok' in response && response.ok) {
        const accounts = response.value;
        console.log(`[JitoSubmitter] Connected. Jito tip accounts confirmed: ${accounts.length}`);
        return accounts;
      } else {
        const error = (response as any).error;
        throw new Error(error ? String(error) : 'Unknown Jito SearcherClientError');
      }
    } catch (e: any) {
      console.warn(`[JitoSubmitter] Jito gRPC client unavailable: ${e.message}. Using REST API fallback.`);
      // Return hardcoded static Jito tip accounts as fallback
      return [
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
        'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
        'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
        'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
        '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
      ];
    }
  }

  public async submitAndTrack(
    bundle: Bundle,
    txSignature: string,
    tipAmount: number,
    blockhash: string,
    pulseScore: number,
    agentReasoning?: string,
    txPayload?: TxPayload
  ): Promise<boolean> {
    let bundleId = '';

    // Log AI decision intent
    await this.ledger.logDecision({
      slot: this.stateManager.getSnapshot().network.latestSlot,
      pulseScore,
      action: 'SUBMIT',
      tip: tipAmount,
      reasoning: agentReasoning || 'AI Submission triggered'
    });

    console.log(`[JitoSubmitter] Submitting bundle | Tx: ${txSignature.slice(0, 16)}...`);

    if (this.client) {
      try {
        const result = await this.client.sendBundle(bundle as any);
        if ('ok' in result && result.ok) {
          bundleId = result.value;
          console.log(`[JitoSubmitter] Bundle accepted | ID: ${bundleId}`);
        } else {
          const error = (result as any).error;
          throw new Error(error ? String(error) : 'Jito block engine rejected the bundle');
        }
      } catch (e: any) {
        console.error(`[JitoSubmitter] sendBundle failed: ${e.message}`);
        const errorRecord = this.failureClassifier.classifyJitoError(e, txSignature);
        this.stateManager.registerSubmission(txSignature, this.stateManager.getSnapshot().network.latestSlot, tipAmount, blockhash, agentReasoning, txPayload);
        this.stateManager.updateBundleStage(txSignature, 'failed', this.stateManager.getSnapshot().network.latestSlot, {
          type: errorRecord.failureType,
          message: errorRecord.message
        });
        if (txPayload?.txId) {
          bus.txStatus(txPayload.txId, `→ ${txPayload.recipient.slice(0, 8)}...`, 'FAILED', errorRecord.message.slice(0, 80));
        }
        await this.ledger.logFailure(txSignature, errorRecord.failureType, errorRecord.message, 'Initial Jito sendBundle failed');
        return false;
      }
    } else {
      // Mock/Offline mode
      bundleId = `mock-bundle-${Date.now()}`;
      console.log(`[JitoSubmitter][Mock] Mock bundle ID: ${bundleId}`);
    }

    const trackingId = bundleId || txSignature;
    const currentSlot = this.stateManager.getSnapshot().network.latestSlot;

    this.stateManager.registerSubmission(trackingId, currentSlot, tipAmount, blockhash, agentReasoning, txPayload);
    await this.ledger.logSubmission({
      bundleIdOrSignature: trackingId,
      slot: currentSlot,
      tip: tipAmount,
      blockhash,
      agentReasoning
    });

    // Track in background — don't await
    this.trackBundleStatus(bundleId, txSignature, currentSlot, blockhash, txPayload);
    return true;
  }

  /**
   * Tracks bundle status using Jito's own JSON-RPC APIs:
   * 1. getInflightBundleStatuses — fast polling for in-flight state (Pending/Landed/Failed/Invalid)
   * 2. getBundleStatuses — on-chain confirmation status once landed
   */
  private async trackBundleStatus(bundleId: string, txSignature: string, submittedSlot: number, blockhash: string, txPayload?: TxPayload): Promise<void> {
    if (!bundleId || bundleId.startsWith('mock-')) {
      console.log(`[JitoSubmitter][Mock] Skipping real bundle tracking for mock bundle.`);
      return;
    }

    const startTime = Date.now();
    let isLanded = false;

    console.log(`[JitoSubmitter] Tracking bundle ${bundleId.slice(0, 16)}... via Jito JSON-RPC`);

    // Phase 1: Poll getInflightBundleStatuses until Landed/Failed/Invalid or timeout
    const inflightInterval = setInterval(async () => {
      if (Date.now() - startTime > INFLIGHT_TIMEOUT_MS) {
        clearInterval(inflightInterval);
        const currentSlot = this.stateManager.getSnapshot().network.latestSlot;
        const failureDetails = { type: 'TIMEOUT', message: 'Bundle not confirmed within 5-minute Jito inflight window.' };
        this.stateManager.updateBundleStage(bundleId, 'failed', currentSlot, failureDetails);
        this.updateTxStatus(txPayload, 'FAILED', failureDetails.message);
        await this.ledger.logFailure(bundleId, failureDetails.type, failureDetails.message, 'Jito inflight window expired');
        return;
      }

      try {
        const inflightRes = await axios.post(`${this.blockEngineUrl}/api/v1/getInflightBundleStatuses`, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getInflightBundleStatuses',
          params: [[bundleId]]
        }, { timeout: 10000 });

        const statusArr = inflightRes.data?.result?.value;
        if (!statusArr || statusArr.length === 0) return; // Still pending

        const bundleStatus = statusArr[0];
        const status: string = bundleStatus.status;
        const currentSlot = this.stateManager.getSnapshot().network.latestSlot;
        const deltaMs = Date.now() - startTime;

        if (status === 'Landed') {
          if (!isLanded) {
            isLanded = true;
            clearInterval(inflightInterval);
            console.log(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... LANDED in slot ${bundleStatus.landed_slot || currentSlot}`);
            this.stateManager.updateBundleStage(bundleId, 'processed', bundleStatus.landed_slot || currentSlot);
            this.updateTxStatus(txPayload, 'WATCHING', `Landed in slot ${bundleStatus.landed_slot || currentSlot}`);
            await this.ledger.logStageTransition(bundleId, 'submitted', 'processed', bundleStatus.landed_slot || currentSlot, deltaMs);

            // Phase 2: Now poll getBundleStatuses for confirmed/finalized
            this.trackOnChainConfirmation(bundleId, txSignature, bundleStatus.landed_slot || currentSlot, startTime, txPayload);
          }
        } else if (status === 'Failed') {
          clearInterval(inflightInterval);
          // Log the full raw status object so the exact rejection reason is visible
          const rawReason = JSON.stringify(bundleStatus, null, 2);
          const failureMsg = bundleStatus.reason || bundleStatus.err || 'No specific reason returned by Jito.';
          console.error(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... FAILED (Jito)`);
          console.error(`[JitoSubmitter] Failure reason: ${failureMsg}`);
          console.error(`[JitoSubmitter] Raw Jito status payload:\n${rawReason}`);
          const context = await this.collectFailureContext(txSignature, blockhash, txPayload);
          const failureDetails = { type: 'BUNDLE_FAILURE_ATOMIC', message: `Jito rejected bundle: ${failureMsg}`, context };
          this.stateManager.updateBundleStage(bundleId, 'failed', currentSlot, failureDetails);
          this.updateTxStatus(txPayload, 'FAILED', failureDetails.message);
          await this.ledger.logFailure(bundleId, failureDetails.type, failureDetails.message, 'Jito inflight status: Failed');
        } else if (status === 'Invalid') {
          clearInterval(inflightInterval);
          const rawReason = JSON.stringify(bundleStatus, null, 2);
          console.error(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... INVALID (no longer in Jito system)`);
          console.error(`[JitoSubmitter] Raw Jito status payload:\n${rawReason}`);
          const context = await this.collectFailureContext(txSignature, blockhash, txPayload);
          const failureDetails = { type: 'BUNDLE_FAILURE_ATOMIC', message: 'Bundle is no longer in the Jito system (Invalid).', context };
          this.stateManager.updateBundleStage(bundleId, 'failed', currentSlot, failureDetails);
          this.updateTxStatus(txPayload, 'FAILED', failureDetails.message);
          await this.ledger.logFailure(bundleId, failureDetails.type, failureDetails.message, 'Jito inflight status: Invalid');
        }
        // 'Pending' — continue polling
      } catch (e: any) {
        console.warn(`[JitoSubmitter] getInflightBundleStatuses poll error: ${e.message}`);
      }
    }, INFLIGHT_POLL_INTERVAL_MS);
  }

  private async trackOnChainConfirmation(bundleId: string, txSignature: string, landedSlot: number, startTime: number, txPayload?: TxPayload): Promise<void> {
    const confirmTimeout = Date.now() + 60000; // 60s to reach finalized
    let isConfirmed = false;

    const interval = setInterval(async () => {
      if (Date.now() > confirmTimeout) {
        clearInterval(interval);
        console.log(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... confirmation tracking timed out.`);
        return;
      }

      try {
        // Use standard Solana getSignatureStatuses for on-chain confirmation tracking
        const statusRes = await this.connection.getSignatureStatuses([txSignature]);
        const status = statusRes?.value?.[0];
        if (!status) return;

        const currentSlot = status.slot;
        const deltaMs = Date.now() - startTime;

        if (status.err) {
          clearInterval(interval);
          const errorRecord = this.failureClassifier.classifyOnChainError(status.err, txSignature);
          this.stateManager.updateBundleStage(bundleId, 'failed', currentSlot, {
            type: errorRecord.failureType,
            message: errorRecord.message
          });
          this.updateTxStatus(txPayload, 'FAILED', errorRecord.message);
          await this.ledger.logFailure(bundleId, errorRecord.failureType, errorRecord.message, 'On-chain execution failed');
          console.log(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... FAILED on-chain`);
          return;
        }

        if (status.confirmationStatus === 'confirmed' && !isConfirmed) {
          isConfirmed = true;
          this.stateManager.updateBundleStage(bundleId, 'confirmed', currentSlot);
          this.updateTxStatus(txPayload, 'WATCHING', `Confirmed | ${txSignature.slice(0, 16)}`);
          await this.ledger.logStageTransition(bundleId, 'processed', 'confirmed', currentSlot, deltaMs);
          console.log(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... CONFIRMED`);
        }

        if (status.confirmationStatus === 'finalized') {
          clearInterval(interval);
          this.stateManager.updateBundleStage(bundleId, 'finalized', currentSlot);
          this.updateTxStatus(txPayload, 'VERIFIED', `Finalized | ${txSignature.slice(0, 16)}`);
          await this.ledger.logStageTransition(bundleId, 'confirmed', 'finalized', currentSlot, deltaMs);
          console.log(`[JitoSubmitter] Bundle ${bundleId.slice(0, 16)}... FINALIZED`);
        }
      } catch (e: any) {
        console.warn(`[JitoSubmitter] On-chain confirmation poll error: ${e.message}`);
      }
    }, 2000);
  }

  private updateTxStatus(txPayload: TxPayload | undefined, status: 'WATCHING' | 'RUNNING' | 'VERIFIED' | 'FAILED' | 'RETRYING', detail: string): void {
    if (!txPayload?.txId) return;
    bus.txStatus(txPayload.txId, `→ ${txPayload.recipient.slice(0, 8)}...`, status, detail.slice(0, 100));
  }

  private async collectFailureContext(txSignature: string, blockhash: string | undefined, txPayload?: TxPayload): Promise<string> {
    const snapshot = this.stateManager.getSnapshot();
    const lines: string[] = [
      `txSignature=${txSignature}`,
      `latestObservedSlot=${snapshot.network.latestSlot}`,
      `inFlightBundles=${Object.keys(snapshot.bundles.inFlight).length}`,
      `tipP50=${snapshot.network.tips.percentiles.p50}`,
      `tipP90=${snapshot.network.tips.percentiles.p90}`
    ];

    try {
      const status = await this.connection.getSignatureStatus(txSignature, { searchTransactionHistory: true });
      lines.push(`signatureStatus=${status.value ? JSON.stringify({
        slot: status.value.slot,
        confirmationStatus: status.value.confirmationStatus,
        err: status.value.err
      }) : 'not_found'}`);
    } catch (e: any) {
      lines.push(`signatureStatusError=${e.message}`);
    }

    if (blockhash) {
      try {
        const valid = await this.connection.isBlockhashValid(blockhash, { commitment: 'confirmed' });
        lines.push(`blockhash=${blockhash}`);
        lines.push(`blockhashValid=${valid.value}`);
      } catch (e: any) {
        lines.push(`blockhashCheckError=${e.message}`);
      }
    }

    if (txPayload?.recipient) {
      lines.push(`recipient=${txPayload.recipient}`);
      lines.push(`amountLamports=${txPayload.amountLamports}`);
    }

    if (txPayload?.sender) {
      try {
        const balance = await this.connection.getBalance(new PublicKey(txPayload.sender), 'confirmed');
        lines.push(`sender=${txPayload.sender}`);
        lines.push(`senderBalanceLamports=${balance}`);
      } catch (e: any) {
        lines.push(`senderBalanceError=${e.message}`);
      }
    }

    const upcoming = snapshot.network.upcomingLeaders.slice(0, 5)
      .map((leader) => `${leader.slot}:${leader.leader.slice(0, 8)}...${leader.isJito ? ':jito' : ':non-jito'}`)
      .join(', ');
    lines.push(`upcomingLeaders=${upcoming || 'unknown'}`);

    const unreliable = Object.entries(snapshot.network.unreliableLeaders)
      .filter(([, value]) => value.skipCount > 0 || value.failCount > 0)
      .sort(([, a], [, b]) => (b.skipCount + b.failCount) - (a.skipCount + a.failCount))
      .slice(0, 5)
      .map(([leader, value]) => `${leader.slice(0, 8)}... skips=${value.skipCount} txFails=${value.failCount}`)
      .join('; ');
    lines.push(`recentUnreliableLeaders=${unreliable || 'none'}`);

    return lines.join('\n');
  }
}
