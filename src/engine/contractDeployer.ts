import {
  Connection,
  Keypair,
  PublicKey,
  BpfLoader,
  BPF_LOADER_PROGRAM_ID,
} from '@solana/web3.js';
import { bus } from '../server/eventBus.js';
import { JitoSubmitter } from './jitoSubmitter.js';
import { BundleBuilder } from './bundleBuilder.js';
import { StateManager } from '../state/stateManager.js';
import { AILayer } from '../ai/aiLayer.js';
import { LifecycleLedger } from '../ledger/lifecycleLedger.js';
import { FailureClassifier } from './failureClassifier.js';

export interface DeployResult {
  programId: string;
  success: boolean;
  error?: string;
  tipBundleId?: string;
}

/**
 * ContractDeployer — AI-timed BPF program deployment.
 *
 * Flow:
 *  1. AI monitors network, decides when to start deployment (SUBMIT or HOLD)
 *  2. On SUBMIT: BpfLoader.load() deploys the program via chunked RPC transactions
 *  3. Simultaneously, a Jito tip bundle is submitted to signal MEV-priority intent
 *     and to log the deploy event on-chain (compatible with the observatory's lifecycle)
 *  4. Full lifecycle events emitted at each step
 *
 * Note: BPF program data must be loaded in chunks (~900 bytes each), which requires
 * multiple sequential RPC transactions internally. The Jito bundle covers the final
 * finalization/tip payment. The AI tip amount governs the Jito tip, not the program
 * account rent (which is fixed by program size).
 */
export class ContractDeployer {
  private connection: Connection;
  private signer: Keypair;
  private aiLayer: AILayer;
  private stateManager: StateManager;
  private bundleBuilder: BundleBuilder;
  private jitoSubmitter: JitoSubmitter;
  private ledger: LifecycleLedger;
  private failureClassifier: FailureClassifier;

  constructor(
    connection: Connection,
    signer: Keypair,
    aiLayer: AILayer,
    stateManager: StateManager,
    bundleBuilder: BundleBuilder,
    jitoSubmitter: JitoSubmitter,
    ledger: LifecycleLedger,
    failureClassifier: FailureClassifier
  ) {
    this.connection = connection;
    this.signer = signer;
    this.aiLayer = aiLayer;
    this.stateManager = stateManager;
    this.bundleBuilder = bundleBuilder;
    this.jitoSubmitter = jitoSubmitter;
    this.ledger = ledger;
    this.failureClassifier = failureClassifier;
  }

  /**
   * Queue a program for AI-timed deployment.
   * Resolves immediately (non-blocking). Status emitted via EventBus.
   */
  public async queueDeploy(programBytes: Buffer, label = 'contract-deploy'): Promise<void> {
    const deployId = `deploy-${Date.now()}`;
    bus.txStatus(deployId, label, 'WATCHING', 'Waiting for AI timing decision...');
    bus.log('ContractDeployer', `Program queued (${programBytes.length} bytes). Watching network...`);

    // Non-blocking: run in background
    this.runDeployLoop(deployId, label, programBytes).catch((e) => {
      bus.log('ContractDeployer', `Unhandled error in deploy loop: ${e.message}`, 'error');
      bus.txStatus(deployId, label, 'FAILED', e.message);
    });
  }

  private async runDeployLoop(deployId: string, label: string, programBytes: Buffer): Promise<void> {
    const MAX_WAIT_CYCLES = 30; // Max ~5 min waiting for AI to say SUBMIT
    let cycles = 0;

    while (cycles < MAX_WAIT_CYCLES) {
      const state = this.stateManager.getSnapshot();
      const decision = await this.aiLayer.getExecutionDecision(state, "Contract Deployment");

      if (decision.action === 'HOLD') {
        bus.log('ContractDeployer', `AI says HOLD (${decision.waitDuration} slots). Waiting...`);
        await new Promise(r => setTimeout(r, decision.waitDuration * 400));
        cycles++;
        continue;
      }

      if (decision.action === 'SKIP') {
        bus.log('ContractDeployer', 'AI says SKIP. Retrying next cycle...');
        await new Promise(r => setTimeout(r, 4000));
        cycles++;
        continue;
      }

      if (decision.action === 'SUBMIT' || decision.action === 'RETRY') {
        bus.txStatus(deployId, label, 'RUNNING', `Deploying program... Tip: ${decision.tip} lam`);
        await this.executeDeploy(deployId, label, programBytes, decision.tip);
        return;
      }

      cycles++;
    }

    bus.log('ContractDeployer', 'Max wait cycles exceeded — deploy aborted', 'error');
    bus.txStatus(deployId, label, 'FAILED', 'AI never issued SUBMIT within time limit');
  }

  private async executeDeploy(deployId: string, label: string, programBytes: Buffer, tipLamports: number): Promise<void> {
    try {
      bus.log('ContractDeployer', 'Submitting tip bundle to signal deploy intent...');

      // 1. Submit Jito tip bundle first (signals priority intent to MEV relayers)
      const { bundle, txSignature, blockhash } = await this.bundleBuilder.buildBundle(tipLamports);
      const tipSuccess = await this.jitoSubmitter.submitAndTrack(
        bundle, txSignature, tipLamports, blockhash,
        this.stateManager.getSnapshot().pulseScore.current,
        `[ContractDeployer] Program deploy tip for ${deployId}`
      );

      if (!tipSuccess) {
        bus.log('ContractDeployer', 'Tip bundle failed — deploy aborted', 'warn');
        bus.txStatus(deployId, label, 'FAILED', 'Jito tip bundle rejected');
        return;
      }

      // 2. Load BPF program via standard RPC (chunked internally by BpfLoader)
      bus.log('ContractDeployer', `Loading BPF program (${programBytes.length} bytes) via RPC...`);

      const program = Keypair.generate();
      bus.log('ContractDeployer', `Generated program account: ${program.publicKey.toBase58()}`);

      await BpfLoader.load(
        this.connection,
        this.signer,
        program,
        programBytes,
        BPF_LOADER_PROGRAM_ID
      );

      bus.log('ContractDeployer', `✅ Program deployed! ID: ${program.publicKey.toBase58()}`);
      bus.txStatus(deployId, label, 'VERIFIED', `Program ID: ${program.publicKey.toBase58()}`);

      await this.ledger.logDecision({
        slot: this.stateManager.getSnapshot().network.latestSlot,
        pulseScore: this.stateManager.getSnapshot().pulseScore.current,
        action: 'SUBMIT',
        tip: tipLamports,
        reasoning: `Contract deployed: ${program.publicKey.toBase58()}`
      });

    } catch (e: any) {
      const errorRecord = this.failureClassifier.classifyJitoError(e, deployId);
      bus.log('ContractDeployer', `Deploy failed: ${e.message}`, 'error');
      bus.txStatus(deployId, label, 'FAILED', errorRecord.message);
      await this.ledger.logFailure(deployId, errorRecord.failureType, errorRecord.message, 'ContractDeployer.executeDeploy');
    }
  }
}
