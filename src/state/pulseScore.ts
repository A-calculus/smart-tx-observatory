import { SystemState } from './stateManager.js';
import fs from 'fs';
import YAML from 'yaml';

const config = YAML.parse(fs.readFileSync('./config.yaml', 'utf-8'));
const weights = config.pulseScoreWeights || { slotHealth: 40, tipPressure: 30, leaderReliability: 30 };
const slotTarget = config.timing.slotCadenceTargetMs || 400;

export interface PulseScoreResult {
  score: number;
  components: {
    slotHealth: number;
    tipPressure: number;
    leaderReliability: number;
  };
}

export function calculatePulseScore(state: SystemState): PulseScoreResult {
  const history = state.network.slotHistory;
  const maxSlotHealth = weights.slotHealth;
  const maxTipPressure = weights.tipPressure;
  const maxLeaderReliability = weights.leaderReliability;

  // ── 1. Slot Health (sensitive linear scoring) ─────────────────────────────
  // Based on: average slot duration vs target (400ms), skip rate in recent window
  let slotHealth = maxSlotHealth;
  if (history.length > 0) {
    const avgDuration = history.reduce((sum, s) => sum + s.durationMs, 0) / history.length;

    // Linear decay: each ms above target costs proportionally more
    // At 400ms → 100%, at 800ms → 0%, smooth curve in between
    const cadenceRatio = Math.min(avgDuration, slotTarget * 2) / (slotTarget * 2);
    const cadenceScore = 1 - cadenceRatio; // 1.0 at ideal, 0.0 at 2× target

    // Skip rate uses last 20 slots for tighter signal
    const recentWindow = history.slice(-20);
    const skippedCount = recentWindow.filter(s => s.skipped).length;
    const skipRate = skippedCount / recentWindow.length;

    // Skip penalty: >0% starts degrading immediately; >10% = full penalty
    const skipPenalty = Math.min(skipRate / 0.10, 1.0); // 0% = no penalty, 10%+ = max
    const skipMultiplier = 1.0 - (skipPenalty * 0.6); // max 60% deduction from skips

    slotHealth = Math.round(maxSlotHealth * cadenceScore * skipMultiplier);
  }

  // ── 2. Tip Pressure (continuous, inversely scaled to p50 market) ──────────
  // Low tip market = high score (easy to get included at lower cost)
  // High tip market = low score (AI should bid up or hold)
  let tipPressure = maxTipPressure;
  const p50 = state.network.tips.percentiles.p50;
  const p75 = state.network.tips.percentiles.p75;
  const p90 = state.network.tips.percentiles.p90;

  if (p50 > 0) {
    // Classify market pressure using percentile spread:
    // Tight spread (p90/p50 close) = competitive market; wide spread = volatile
    const spread = p90 > 0 ? p90 / p50 : 1;

    let marketPressureScore: number;
    if (p50 <= 5000) {
      marketPressureScore = 1.0;   // Near-free: ideal
    } else if (p50 <= 20000) {
      marketPressureScore = 0.85;  // Low: good
    } else if (p50 <= 50000) {
      marketPressureScore = 0.65;  // Moderate
    } else if (p50 <= 150000) {
      marketPressureScore = 0.40;  // High congestion
    } else if (p50 <= 500000) {
      marketPressureScore = 0.20;  // Very high congestion
    } else {
      marketPressureScore = 0.05;  // Extreme congestion: hold
    }

    // Spread penalty: volatile markets are riskier
    const spreadPenalty = Math.max(0, (spread - 2) / 8); // spread >2× starts penalising
    tipPressure = Math.round(maxTipPressure * Math.max(0, marketPressureScore - spreadPenalty));
  }

  // ── 3. Leader Reliability ─────────────────────────────────────────────────
  // Uses both the in-session skip history AND the persistent unreliableLeaders record
  let leaderReliability = Math.round(maxLeaderReliability * 0.7); // neutral default

  const upcomingLeaders = state.network.upcomingLeaders;
  if (upcomingLeaders.length > 0) {
    const nextLeader = upcomingLeaders[0];

    // Check persistent unreliable leaders record (cross-session memory)
    const knownBad = state.network.unreliableLeaders[nextLeader.leader];
    if (knownBad) {
      const skipCount = knownBad.skipCount;
      // Each skip costs proportionally: 0 = full marks, 5+ skips = 0
      const badMultiplier = Math.max(0, 1 - (skipCount / 5));
      leaderReliability = Math.round(maxLeaderReliability * badMultiplier * 0.5);
    } else {
      // Good standing: check in-session slot history for this leader
      const leaderSlots = history.filter(s => s.leader === nextLeader.leader);
      if (leaderSlots.length >= 2) {
        const successRate = leaderSlots.filter(s => !s.skipped).length / leaderSlots.length;
        leaderReliability = Math.round(maxLeaderReliability * successRate);
      } else {
        // Insufficient data: neutral-good
        leaderReliability = Math.round(maxLeaderReliability * 0.8);
      }
    }

    // Bonus: Jito-enabled leader is more valuable for bundle inclusion
    if (nextLeader.isJito) {
      leaderReliability = Math.min(maxLeaderReliability, leaderReliability + 3);
    }
  }

  const score = Math.min(100, slotHealth + tipPressure + leaderReliability);
  return {
    score,
    components: { slotHealth, tipPressure, leaderReliability }
  };
}
