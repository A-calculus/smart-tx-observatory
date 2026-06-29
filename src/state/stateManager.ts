import * as fs from 'fs/promises';
import * as path from 'path';

export interface SlotInfo {
  slot: number;
  timestamp: string;
  durationMs: number;
  leader: string;
  skipped: boolean;
}

export interface LeaderScheduleInfo {
  slot: number;
  leader: string;
  isJito: boolean;
}

export interface TipPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface TxPayload {
  recipient: string;
  tokenMint?: string;
  amountLamports: number;
}

export interface BundleState {
  bundleId: string;
  submittedAt: string;
  submittedSlot: number;
  tip: number;
  blockhash: string;
  status: 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed';
  stageTimestamps: {
    submitted: string;
    processed: string | null;
    confirmed: string | null;
    finalized: string | null;
    failed: string | null;
  };
  stageSlots: {
    submitted: number;
    processed: number | null;
    confirmed: number | null;
    finalized: number | null;
    failed: number | null;
  };
  failureType?: string;
  failureMessage?: string;
  agentReasoning?: string;
  txPayload?: TxPayload;
}

export interface PulseScoreState {
  current: number;
  lastUpdated: string;
  components: {
    slotHealth: number;
    tipPressure: number;
    leaderReliability: number;
  };
}

export interface SystemState {
  network: {
    latestSlot: number;
    slotHistory: SlotInfo[];
    upcomingLeaders: LeaderScheduleInfo[];
    unreliableLeaders: Record<string, { skipCount: number, failCount: number }>;
    tips: {
      recent: number[];
      percentiles: TipPercentiles;
    };
  };
  bundles: {
    inFlight: Record<string, BundleState>;
    completed: string[];
    failed: string[];
    failedDetails: Record<string, BundleState>;
    unprocessedFailures: { bundleId: string, type: string, message: string }[];
    totalTipsPaidLamports: number;
  };
  pulseScore: PulseScoreState;
  isSimulationActive: boolean;
}

export class StateManager {
  private state: SystemState;
  private snapshotPath: string;
  private backupTimer: NodeJS.Timeout | null = null;

  constructor(snapshotDir: string = './state') {
    this.snapshotPath = path.join(snapshotDir, 'snapshot.json');
    this.state = {
      network: {
        latestSlot: 0,
        slotHistory: [],
        upcomingLeaders: [],
        unreliableLeaders: {},
        tips: {
          recent: [],
          percentiles: { p25: 0, p50: 0, p75: 0, p90: 0 }
        }
      },
      bundles: {
        inFlight: {},
        completed: [],
        failed: [],
        failedDetails: {},
        unprocessedFailures: [],
        totalTipsPaidLamports: 0
      },
      pulseScore: {
        current: 50,
        lastUpdated: new Date().toISOString(),
        components: { slotHealth: 50, tipPressure: 50, leaderReliability: 50 }
      },
      isSimulationActive: false
    };
  }

  public async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.snapshotPath);
      await fs.mkdir(dir, { recursive: true });

      // Try to load existing snapshot
      const data = await fs.readFile(this.snapshotPath, 'utf-8');
      const parsed = JSON.parse(data);
      // Merge with default state structure
      this.state = { ...this.state, ...parsed };

      // Ensure unprocessedFailures exists 
      if (!this.state.bundles.unprocessedFailures) {
        this.state.bundles.unprocessedFailures = [];
      }
      this.state.bundles.unprocessedFailures = this.state.bundles.unprocessedFailures.filter(
        failure => failure.type !== 'LEADER_SKIP'
      );
      if (!this.state.bundles.failedDetails) {
        this.state.bundles.failedDetails = {};
      }
      if (this.state.bundles.totalTipsPaidLamports === undefined) {
        this.state.bundles.totalTipsPaidLamports = 0;
      }

      console.log(`[StateManager] State loaded from ${this.snapshotPath}. Latest slot: ${this.state.network.latestSlot}`);
    } catch (e: any) {
      console.log('[StateManager] No existing state snapshot found. Initializing fresh state.');
    }

    // Start periodic persistence
    this.startBackupInterval();
  }

  public getSnapshot(): SystemState {
    // Deep clone to ensure immutability outside
    return JSON.parse(JSON.stringify(this.state));
  }

  public updateSlot(slot: number, leader: string, skipped: boolean): void {
    const now = new Date().toISOString();
    const history = this.state.network.slotHistory;

    let durationMs = 400; // default baseline
    if (history.length > 0) {
      const prev = history[history.length - 1];
      durationMs = Date.now() - new Date(prev.timestamp).getTime();
      
      // Gap 5: Detect Leader Skip
      if (this.state.network.latestSlot > 0 && slot - this.state.network.latestSlot > 1) {
        // Try to identify the skipped leader
        const skippedSlot = this.state.network.latestSlot + 1;
        const skippedLeaderInfo = this.state.network.upcomingLeaders.find(l => l.slot === skippedSlot);
        const skippedLeaderId = skippedLeaderInfo ? skippedLeaderInfo.leader : 'unknown';

        console.warn(`[StateManager] LEADER_SKIP detected! Slot jumped from ${this.state.network.latestSlot} to ${slot}. Missed Leader: ${skippedLeaderId}`);
        
        if (skippedLeaderId !== 'unknown') {
          if (!this.state.network.unreliableLeaders[skippedLeaderId]) {
            this.state.network.unreliableLeaders[skippedLeaderId] = { skipCount: 0, failCount: 0 };
          }
          this.state.network.unreliableLeaders[skippedLeaderId].skipCount++;
        }

        console.warn(
          `[StateManager] Network observation only: leader skip affects reliability scoring, not transaction retry.`
        );
      }
    }

    this.state.network.latestSlot = slot;
    this.state.network.slotHistory.push({
      slot,
      timestamp: now,
      durationMs,
      leader,
      skipped
    });

    // Roll historical window (limit to 50 slots)
    if (this.state.network.slotHistory.length > 50) {
      this.state.network.slotHistory.shift();
    }
  }

  public updateTips(recentTips: number[]): void {
    this.state.network.tips.recent = recentTips;
    if (recentTips.length === 0) return;

    const sorted = [...recentTips].sort((a, b) => a - b);

    const getPercentile = (p: number) => {
      const idx = Math.floor((sorted.length - 1) * p);
      return sorted[idx] || 0;
    };

    this.state.network.tips.percentiles = {
      p25: getPercentile(0.25),
      p50: getPercentile(0.50),
      p75: getPercentile(0.75),
      p90: getPercentile(0.90)
    };
  }

  public updateUpcomingLeaders(leaders: LeaderScheduleInfo[]): void {
    this.state.network.upcomingLeaders = leaders;
  }

  public setSimulationActive(active: boolean): void {
    this.state.isSimulationActive = active;
  }

  public updatePulseScore(score: number, components: PulseScoreState['components']): void {
    this.state.pulseScore = {
      current: score,
      lastUpdated: new Date().toISOString(),
      components
    };
  }

  public registerSubmission(
    bundleId: string,
    slot: number,
    tip: number,
    blockhash: string,
    agentReasoning?: string,
    txPayload?: TxPayload
  ): void {
    const now = new Date().toISOString();
    this.state.bundles.inFlight[bundleId] = {
      bundleId,
      submittedAt: now,
      submittedSlot: slot,
      tip,
      blockhash,
      status: 'submitted',
      stageTimestamps: {
        submitted: now,
        processed: null,
        confirmed: null,
        finalized: null,
        failed: null
      },
      stageSlots: {
        submitted: slot,
        processed: null,
        confirmed: null,
        finalized: null,
        failed: null
      },
      agentReasoning,
      txPayload
    };
  }

  public getPayload(bundleId: string): TxPayload | undefined {
    return this.state.bundles.inFlight[bundleId]?.txPayload
      || this.state.bundles.failedDetails[bundleId]?.txPayload;
  }

  public updateBundleStage(bundleId: string, stage: 'processed' | 'confirmed' | 'finalized' | 'failed', slot: number, failureDetails?: { type: string, message: string }): void {
    const bundle = this.state.bundles.inFlight[bundleId];
    if (!bundle) return;

    const now = new Date().toISOString();
    bundle.status = stage;
    bundle.stageTimestamps[stage] = now;
    bundle.stageSlots[stage] = slot;

    if (stage === 'failed' && failureDetails) {
      bundle.failureType = failureDetails.type;
      bundle.failureMessage = failureDetails.message;
      this.state.bundles.failed.push(bundleId);
      this.state.bundles.failedDetails[bundleId] = { ...bundle };
      this.state.bundles.unprocessedFailures.push({
        bundleId,
        type: failureDetails.type,
        message: failureDetails.message
      });
      delete this.state.bundles.inFlight[bundleId];
    } else if (stage === 'finalized') {
      this.state.bundles.completed.push(bundleId);
      this.state.bundles.totalTipsPaidLamports += bundle.tip;
      delete this.state.bundles.inFlight[bundleId];
    }
  }

  public popUnprocessedFailure(): { bundleId: string, type: string, message: string } | undefined {
    return this.state.bundles.unprocessedFailures.shift();
  }

  public pushFailure(bundleId: string, type: string, message: string): void {
    this.state.bundles.unprocessedFailures.push({ bundleId, type, message });
  }

  public async persistState(): Promise<void> {
    try {
      const serialized = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.snapshotPath, serialized, 'utf-8');
    } catch (e: any) {
      console.error(`[StateManager] Failed to persist state snapshot: ${e.message}`);
    }
  }

  private startBackupInterval(): void {
    this.backupTimer = setInterval(() => {
      this.persistState();
    }, 30000); // 30 seconds
  }

  public stop(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }
}
