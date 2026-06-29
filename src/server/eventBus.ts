import { EventEmitter } from 'events';
import { SystemState } from '../state/stateManager.js';

// ── Typed event payloads ──────────────────────────────────────────────────────

export interface LogEvent {
  type: 'LOG';
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  timestamp: string;
}

export interface AIDecisionEvent {
  type: 'AI_DECISION';
  aiType: 'EXECUTION' | 'DIAGNOSTIC';
  action: string;
  tip: number;
  reasoning: string;
  mode: 'single' | 'consensus';
  provider?: string;
  slot: number;
  timestamp: string;
}

export interface ConsensusVoteEvent {
  type: 'CONSENSUS_VOTE';
  provider: string;
  action: string;
  tip: number;
  reasoning: string;
  agreed: boolean;
  timestamp: string;
}

export interface ConsensusResultEvent {
  type: 'CONSENSUS_RESULT';
  finalAction: string;
  finalTip: number;
  majorityCount: number;
  tipWithinThreshold: boolean;
  timestamp: string;
}

export interface BundleStatusEvent {
  type: 'BUNDLE_STATUS';
  bundleId: string;
  status: string;
  slot: number;
  timestamp: string;
}

export interface TxSummaryEvent {
  type: 'TX_SUMMARY';
  id: string;
  label: string;
  status: 'WATCHING' | 'RUNNING' | 'VERIFIED' | 'FAILED' | 'RETRYING';
  detail?: string;
  timestamp: string;
}

export interface StateSnapshotEvent {
  type: 'STATE_SNAPSHOT';
  state: SystemState;
  timestamp: string;
}

export interface WalletTokensEvent {
  type: 'WALLET_TOKENS';
  tokens: TokenInfo[];
  solBalanceLamports: number;
  timestamp: string;
}

export interface ConsensusTestResultEvent {
  type: 'CONSENSUS_TEST_RESULT';
  provider: string;
  passed: boolean;
  latencyMs: number;
  error?: string;
  timestamp: string;
}

export interface ModeChangeEvent {
  type: 'MODE_CHANGE';
  mode: 'single' | 'consensus';
  timestamp: string;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  uiAmount: number;
  decimals: number;
  ataAddress: string;
}

export type ChronosEvent =
  | LogEvent
  | AIDecisionEvent
  | ConsensusVoteEvent
  | ConsensusResultEvent
  | BundleStatusEvent
  | TxSummaryEvent
  | StateSnapshotEvent
  | WalletTokensEvent
  | ConsensusTestResultEvent
  | ModeChangeEvent;

// ── Singleton EventBus ────────────────────────────────────────────────────────

class EventBus extends EventEmitter {
  emit(event: 'chronos', payload: ChronosEvent): boolean {
    return super.emit('chronos', payload);
  }

  on(event: 'chronos', listener: (payload: ChronosEvent) => void): this {
    return super.on('chronos', listener);
  }

  /** Convenience: emit a log line */
  log(source: string, message: string, level: LogEvent['level'] = 'info'): void {
    this.emit('chronos', {
      type: 'LOG',
      level,
      source,
      message,
      timestamp: new Date().toISOString()
    });
  }

  /** Convenience: emit a TX summary update */
  txStatus(id: string, label: string, status: TxSummaryEvent['status'], detail?: string): void {
    this.emit('chronos', {
      type: 'TX_SUMMARY',
      id,
      label,
      status,
      detail,
      timestamp: new Date().toISOString()
    });
  }
}

export const bus = new EventBus();
bus.setMaxListeners(50);
