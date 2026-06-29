import * as fs from 'fs/promises';
import * as path from 'path';

export interface LedgerDecision {
  slot: number;
  pulseScore: number;
  action: 'SUBMIT' | 'HOLD' | 'RETRY' | 'SKIP';
  tip: number;
  reasoning: string;
}

export interface LedgerSubmission {
  bundleIdOrSignature: string;
  slot: number;
  tip: number;
  blockhash: string;
  agentReasoning?: string;
}

export interface LedgerStageTransition {
  bundleIdOrSignature: string;
  fromStage: string;
  toStage: string;
  slot: number;
  deltaMs: number;
}

export interface LedgerFailure {
  bundleIdOrSignature: string;
  failureType: string;
  message: string;
  agentDiagnosis?: string;
}

export interface LedgerHold {
  slot: number;
  pulseScore: number;
  reason: string;
  resumeSlot: number;
}

export interface LedgerSummary {
  totalSubmissions: number;
  successful: number;
  failed: number;
  totalTipsPaidLamports: number;
}

export class LifecycleLedger {
  private ledgerPath: string;

  constructor(ledgerDir: string = './data') {
    this.ledgerPath = path.join(ledgerDir, 'ledger.jsonl');
  }

  public async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.ledgerPath);
      await fs.mkdir(dir, { recursive: true });
      
      // Print initialization message to file
      await this.writeLine({
        type: 'SYSTEM_START',
        timestamp: new Date().toISOString(),
        message: 'Chronos Observatory Ledger initialized.'
      });
    } catch (e: any) {
      console.error(`[LifecycleLedger] Failed to initialize ledger directory: ${e.message}`);
    }
  }

  private async writeLine(obj: any): Promise<void> {
    try {
      const line = JSON.stringify(obj) + '\n';
      await fs.appendFile(this.ledgerPath, line, 'utf-8');
    } catch (e: any) {
      console.error(`[LifecycleLedger] Error appending to JSONL file: ${e.message}`);
    }
  }

  public async logDecision(decision: LedgerDecision): Promise<void> {
    await this.writeLine({
      type: 'DECISION',
      timestamp: new Date().toISOString(),
      ...decision
    });
  }

  public async logSubmission(submission: LedgerSubmission): Promise<void> {
    await this.writeLine({
      type: 'SUBMISSION',
      timestamp: new Date().toISOString(),
      ...submission
    });
  }

  public async logStageTransition(
    bundleIdOrSignature: string, 
    fromStage: string, 
    toStage: string, 
    slot: number, 
    deltaMs: number
  ): Promise<void> {
    await this.writeLine({
      type: 'STAGE_TRANSITION',
      timestamp: new Date().toISOString(),
      bundleIdOrSignature,
      fromStage,
      toStage,
      slot,
      deltaMs
    });
  }

  public async logFailure(
    bundleIdOrSignature: string, 
    failureType: string, 
    message: string, 
    agentDiagnosis?: string
  ): Promise<void> {
    await this.writeLine({
      type: 'FAILURE',
      timestamp: new Date().toISOString(),
      bundleIdOrSignature,
      failureType,
      message,
      agentDiagnosis: agentDiagnosis || 'No diagnosis provided.'
    });
  }

  public async logHold(hold: LedgerHold): Promise<void> {
    await this.writeLine({
      type: 'HOLD',
      timestamp: new Date().toISOString(),
      ...hold
    });
  }

  public async logSummary(summary: LedgerSummary): Promise<void> {
    await this.writeLine({
      type: 'RUN_SUMMARY',
      timestamp: new Date().toISOString(),
      ...summary
    });
  }

  public async backupLedger(): Promise<void> {
    try {
      const backupPath = this.ledgerPath.replace('.jsonl', `.backup.${Date.now()}.jsonl`);
      await fs.copyFile(this.ledgerPath, backupPath);
      console.log(`[LifecycleLedger] Ledger backed up to ${backupPath}`);
    } catch (e: any) {
      console.error(`[LifecycleLedger] Backup failed: ${e.message}`);
    }
  }
}
