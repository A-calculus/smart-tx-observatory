import axios from 'axios';
import https from 'https';
import fs from 'fs';
import YAML from 'yaml';
import { bus } from '../server/eventBus.js';
import { SystemState } from '../state/stateManager.js';

const config = YAML.parse(fs.readFileSync('./config.yaml', 'utf-8'));
const defaultTip = config.execution.defaultTipLamports || 50000;
const minTip = config.execution.minTipLamports || 1000;
const maxTip = config.execution.maxTipLamports || 5000000;
const defaultWaitDuration = config.timing.decisionCycleIntervalSlots || 10;
const slotCadenceTarget = config.timing.slotCadenceTargetMs || 400;
const tipTolerance = config.consensus.tipTolerancePct || 0.20;
const majorityThresholdPct = config.consensus.majorityThresholdPct || 0.67;

export interface AIProvider {
  name: string;
  url: string;
  apiKey: string;
  model: string;
}

export interface AIDecision {
  action: 'SUBMIT' | 'HOLD' | 'RETRY' | 'SKIP';
  tip: number;
  waitDuration: number;
  reasoning: string;
}

const lenientAgent = new https.Agent({ rejectUnauthorized: false });

// ── Test prompt used for self-test ─────────────────────────────────────────
const SELF_TEST_PROMPT = `You are a Solana tx oracle. Respond ONLY with this exact JSON (no changes):
{"action":"SUBMIT","tip":10000,"waitDuration":1,"reasoning":"self-test-ok"}`;

export class ConsensusOrchestrator {
  private providers: AIProvider[];
  private testedOk = false;

  constructor(providers: AIProvider[]) {
    if (providers.length < 3) throw new Error('[Consensus] Need at least 3 providers enabled to activate Consensus Mode');
    this.providers = providers.slice(0, 3); // cap at 3
    bus.log('ConsensusOrchestrator', `Initialized with ${this.providers.length} providers: ${this.providers.map(p => p.name).join(', ')}`);
  }

  public isReady(): boolean { return this.testedOk; }

  // ── Self-test: all providers must respond successfully ──────────────────
  public async selfTest(): Promise<{ allPassed: boolean; results: { provider: string; passed: boolean; latencyMs: number; error?: string }[] }> {
    bus.log('ConsensusOrchestrator', 'Running self-test on all consensus providers...');
    this.testedOk = false;

    const tasks = this.providers.map(async (provider) => {
      const start = Date.now();
      try {
        await this.callProvider(provider, SELF_TEST_PROMPT, false);
        const latencyMs = Date.now() - start;
        bus.emit('chronos', { type: 'CONSENSUS_TEST_RESULT', provider: provider.name, passed: true, latencyMs, timestamp: new Date().toISOString() });
        return { provider: provider.name, passed: true, latencyMs };
      } catch (e: any) {
        const latencyMs = Date.now() - start;
        bus.emit('chronos', { type: 'CONSENSUS_TEST_RESULT', provider: provider.name, passed: false, latencyMs, error: e.message, timestamp: new Date().toISOString() });
        return { provider: provider.name, passed: false, latencyMs, error: e.message };
      }
    });

    const results = await Promise.all(tasks);
    const allPassed = results.every(r => r.passed);
    this.testedOk = allPassed;

    if (allPassed) {
      bus.log('ConsensusOrchestrator', '✅ All consensus providers passed self-test. Consensus mode ready.');
    } else {
      const failed = results.filter(r => !r.passed).map(r => r.provider).join(', ');
      bus.log('ConsensusOrchestrator', `❌ Self-test failed for: ${failed}. Consensus mode NOT activated.`, 'error');
    }

    return { allPassed, results };
  }

  // ── Main consensus decision ──────────────────────────────────────────────
  public async getExecutionDecision(state: SystemState, actionTarget: string): Promise<AIDecision> {
    if (!this.testedOk) {
      bus.log('ConsensusOrchestrator', 'Consensus not tested — falling back to HOLD', 'warn');
      const tip = state.network.tips.percentiles.p50 || defaultTip;
      return { action: 'HOLD', tip, waitDuration: defaultWaitDuration, reasoning: 'Consensus mode not tested. Run self-test first.' };
    }
    const briefing = this.formatExecutionBriefing(state, actionTarget);
    return this.runParallelConsensus(state, briefing, false);
  }

  public async getDiagnosticDecision(state: SystemState, failure: { type: string; message: string }): Promise<AIDecision> {
    if (!this.testedOk) {
      bus.log('ConsensusOrchestrator', 'Consensus not tested — falling back to SKIP', 'warn');
      const tip = state.network.tips.percentiles.p50 || defaultTip;
      return { action: 'SKIP', tip, waitDuration: defaultWaitDuration, reasoning: 'Consensus mode not tested. Run self-test first.' };
    }
    const briefing = this.formatDiagnosticBriefing(state, failure);
    return this.runParallelConsensus(state, briefing, true);
  }

  private async runParallelConsensus(state: SystemState, briefing: string, isDiagnostic: boolean): Promise<AIDecision> {
    // Run all providers in parallel
    const tasks = this.providers.map(async (provider) => {
      try {
        const decision = await this.callProvider(provider, briefing, isDiagnostic, state);
        bus.emit('chronos', {
          type: 'CONSENSUS_VOTE',
          provider: provider.name,
          action: decision.action,
          tip: decision.tip,
          reasoning: decision.reasoning,
          agreed: false, // updated below after vote
          timestamp: new Date().toISOString()
        });
        return { provider: provider.name, decision, error: null };
      } catch (e: any) {
        bus.log('ConsensusOrchestrator', `Provider ${provider.name} failed during consensus: ${e.message}`, 'warn');
        bus.emit('chronos', {
          type: 'CONSENSUS_VOTE',
          provider: provider.name,
          action: 'ABSTAIN',
          tip: 0,
          reasoning: `Provider error: ${e.message}`,
          agreed: false,
          timestamp: new Date().toISOString()
        });
        return { provider: provider.name, decision: null, error: e.message };
      }
    });

    const results = await Promise.all(tasks);
    return this.resolveConsensus(results, state, isDiagnostic);
  }

  // ── Majority vote + tip tolerance ─────────────────────────────────────────
  private resolveConsensus(
    results: { provider: string; decision: AIDecision | null; error: string | null }[],
    state: SystemState,
    isDiagnostic: boolean
  ): AIDecision {
    const valid = results.filter(r => r.decision !== null);

    // Tally action votes
    const tally: Record<string, { tips: number[]; providers: string[] }> = {};
    for (const { provider, decision } of valid) {
      if (!decision) continue;
      if (!tally[decision.action]) tally[decision.action] = { tips: [], providers: [] };
      tally[decision.action].tips.push(decision.tip);
      tally[decision.action].providers.push(provider);
    }

    // Find majority: configured threshold (default 2-of-3 = 67%)
    const threshold = Math.round(this.providers.length * majorityThresholdPct);
    const majorityEntry = Object.entries(tally).find(([_, v]) => v.providers.length >= threshold);

    if (!majorityEntry) {
      const tip = state.network.tips.percentiles.p50 || defaultTip;
      bus.log('ConsensusOrchestrator', `No majority action reached — returning ${isDiagnostic ? 'SKIP' : 'HOLD'}`, 'warn');
      bus.emit('chronos', {
        type: 'CONSENSUS_RESULT',
        finalAction: isDiagnostic ? 'SKIP' : 'HOLD',
        finalTip: tip,
        majorityCount: 0,
        tipWithinThreshold: false,
        timestamp: new Date().toISOString()
      });
      return { action: isDiagnostic ? 'SKIP' : 'HOLD', tip, waitDuration: defaultWaitDuration, reasoning: 'No consensus reached among AI providers.' };
    }

    const [action, { tips, providers: agreeing }] = majorityEntry;

    // Tip consensus check against the configured tolerance
    const sortedTips = [...tips].sort((a, b) => a - b);
    const median = sortedTips[Math.floor(sortedTips.length / 2)];
    const TOLERANCE = tipTolerance;
    const allWithin = sortedTips.every(t => Math.abs(t - median) / median <= TOLERANCE);

    // If tips are too far apart, block submission — providers don't agree on market conditions
    if (!allWithin && (action === 'SUBMIT' || action === 'RETRY')) {
      const p50 = state.network.tips.percentiles.p50 || defaultTip;
      const waitDur = defaultWaitDuration;
      bus.log('ConsensusOrchestrator',
        `⚠️ Tip spread too wide (median ${median}, tolerance ±${Math.round(TOLERANCE * 100)}%). Blocking ${action} → forcing HOLD to re-evaluate.`,
        'warn'
      );
      bus.emit('chronos', {
        type: 'CONSENSUS_RESULT',
        finalAction: isDiagnostic ? 'SKIP' : 'HOLD',
        finalTip: p50,
        majorityCount: agreeing.length,
        tipWithinThreshold: false,
        timestamp: new Date().toISOString()
      });
      return {
        action: isDiagnostic ? 'SKIP' : 'HOLD',
        tip: p50,
        waitDuration: waitDur,
        reasoning: `Tip spread too wide among providers (median ${median} lam, spread exceeds ±${Math.round(TOLERANCE * 100)}%). Holding to re-evaluate.`
      };
    }

    const finalTip = allWithin ? median : median; // always use median if we got here

    bus.log('ConsensusOrchestrator',
      `✅ Consensus: ${action} | Majority: ${agreeing.join('+')} | Tip: ${finalTip} lam (median ${median}, within ±${Math.round(TOLERANCE * 100)}%: ${allWithin})`
    );

    bus.emit('chronos', {
      type: 'CONSENSUS_RESULT',
      finalAction: action,
      finalTip,
      majorityCount: agreeing.length,
      tipWithinThreshold: allWithin,
      timestamp: new Date().toISOString()
    });

    // Update CONSENSUS_VOTE events with agreed flag (emit updated versions)
    for (const { provider, decision } of valid) {
      if (!decision) continue;
      bus.emit('chronos', {
        type: 'CONSENSUS_VOTE',
        provider,
        action: decision.action,
        tip: decision.tip,
        reasoning: decision.reasoning,
        agreed: decision.action === action,
        timestamp: new Date().toISOString()
      });
    }

    const reasoning = valid
      .filter(r => r.decision?.action === action)
      .map(r => `[${r.provider}] ${r.decision!.reasoning}`)
      .join(' | ');

    return {
      action: action as AIDecision['action'],
      tip: finalTip,
      waitDuration: valid.find(r => r.decision?.action === action)?.decision?.waitDuration || 1,
      reasoning: `[CONSENSUS ${agreeing.length}/${this.providers.length}] ${reasoning}`
    };
  }

  private async callProvider(provider: AIProvider, prompt: string, isDiagnostic: boolean, state?: SystemState): Promise<AIDecision> {
    const res = await axios.post(
      provider.url,
      { model: provider.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 500, response_format: { type: 'json_object' } },
      {
        headers: { 'Authorization': `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/chronos-observatory', 'X-Title': 'Chronos Observatory' },
        timeout: 15000,
        httpsAgent: lenientAgent
      }
    );
    const content = res.data.choices[0].message.content;
    const parsed = this.parseCleanJson(content);
    return this.validate(parsed, isDiagnostic, state);
  }

  private parseCleanJson(str: string): any {
    let cleaned = str.trim();
    // Strip code block markers if present
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      cleaned = match[1].trim();
    }
    // Try direct parse first
    try {
      return JSON.parse(cleaned);
    } catch (e: any) {
      // Extract the first JSON object block { ... }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = cleaned.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch (innerErr) {
          // Clean common LLM formatting issues (inline/block comments, control chars)
          const lineCleaned = candidate
            .replace(/\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/[\u0000-\u001F]+/g, ' ');
          try {
            return JSON.parse(lineCleaned);
          } catch (deepErr: any) {
            throw new Error(`JSON parsing failed: ${e.message} (attempted recovery failed: ${deepErr.message})`);
          }
        }
      }
      throw e;
    }
  }

  private validate(parsed: any, isDiagnostic: boolean, state?: SystemState): AIDecision {
    const action = parsed.action;
    if (isDiagnostic && !['RETRY', 'SKIP'].includes(action)) throw new Error(`Invalid Diagnostic action: ${action}`);
    if (!isDiagnostic && !['SUBMIT', 'HOLD'].includes(action)) throw new Error(`Invalid Execution action: ${action}`);

    const fallbackTip = state?.network?.tips?.percentiles?.p50 || defaultTip;
    return {
      action,
      tip: Math.min(Math.max(Number(parsed.tip || fallbackTip), minTip), maxTip),
      waitDuration: Math.min(Math.max(Number(parsed.waitDuration || defaultWaitDuration), 1), 100),
      reasoning: parsed.reasoning || 'No reasoning.'
    };
  }

  private formatExecutionBriefing(state: SystemState, actionTarget: string): string {
    const latestSlot = state.network.latestSlot;
    const score = state.pulseScore.current;
    const { slotHealth, tipPressure, leaderReliability } = state.pulseScore.components;

    const history = state.network.slotHistory;
    const avgDuration = history.length > 0
      ? Math.round(history.reduce((sum, s) => sum + s.durationMs, 0) / history.length)
      : slotCadenceTarget;

    const { p25, p50, p75, p90 } = state.network.tips.percentiles;
    const nextLeader = state.network.upcomingLeaders[0]?.leader || 'unknown';
    const nextLeaderIsJito = state.network.upcomingLeaders[0]?.isJito ?? false;
    const nextLeaderHistory = state.network.unreliableLeaders[nextLeader];
    const leaderInfo = nextLeaderHistory
      ? `UNRELIABLE: has skipped ${nextLeaderHistory.skipCount} times recently`
      : `Good standing${nextLeaderIsJito ? ' (Jito-enabled)' : ' (not Jito)'}`;
    const recentLeaderSkips = this.formatLeaderReliabilitySummary(state);

    // Derive clear tip recommendation from live market data
    const tipGuidance = p50 > 0
      ? `The LIVE MARKET median tip is ${p50} lamports. The state of the network and priority to be given to the target transaction should determine your tip.`
      : 'No tip data yet';

    return `SYSTEM ROLE:
You are the Execution Timing AI for a Solana smart transaction orchestrator. Your decision controls whether to submit a real transaction to the Jito bundle relay right now, or wait for better network conditions.

TARGET TRANSACTION: "${actionTarget}"

NETWORK STATE (Slot ${latestSlot}):
- Avg slot cadence: ${avgDuration}ms (ideal: ${slotCadenceTarget}ms)
- Next block leader: ${nextLeader} | ${leaderInfo}
- Recent skipped leader observations: ${recentLeaderSkips}
- Active in-flight bundles: ${Object.keys(state.bundles.inFlight).length}
- Session results: ${state.bundles.completed.length} success / ${state.bundles.failed.length} failed

LIVE JITO TIP MARKET (lamports):
  p25=${p25}  p50=${p50}  p75=${p75}  p90=${p90}
${tipGuidance}

PULSE SCORE: ${score}/100 — this is a composite health index:
  slotHealth=${slotHealth}/40  (slot cadence and skip rate — lower = network is slower/unstable)
  tipPressure=${tipPressure}/30  (market tip cost — lower = expensive to get included right now)
  leaderReliability=${leaderReliability}/30  (next leader's track record).

YOUR DECISION:
Respond ONLY with a valid JSON block:
{
  "action": "SUBMIT" | "HOLD",
  "tip": <tip in lamports>,
  "waitDuration": <slots to wait if HOLD, 1-50>,
  "reasoning": "<short reasoning of why you chose this action>"
}`;
  }

  private formatDiagnosticBriefing(state: SystemState, failure: { type: string; message: string }): string {
    const latestSlot = state.network.latestSlot;
    const score = state.pulseScore.current;
    const { slotHealth, tipPressure, leaderReliability } = state.pulseScore.components;

    const history = state.network.slotHistory;
    const avgDuration = history.length > 0
      ? Math.round(history.reduce((sum, s) => sum + s.durationMs, 0) / history.length)
      : slotCadenceTarget;

    const { p25, p50, p75, p90 } = state.network.tips.percentiles;
    const nextLeader = state.network.upcomingLeaders[0]?.leader || 'unknown';
    const nextLeaderIsJito = state.network.upcomingLeaders[0]?.isJito ?? false;
    const nextLeaderHistory = state.network.unreliableLeaders[nextLeader];
    const leaderInfo = nextLeaderHistory
      ? `UNRELIABLE: has skipped ${nextLeaderHistory.skipCount} times recently`
      : `Good standing${nextLeaderIsJito ? ' (Jito-enabled)' : ' (not Jito)'}`;
    const recentLeaderSkips = this.formatLeaderReliabilitySummary(state);

    return `SYSTEM ROLE:
You are the Diagnostic AI for a Solana smart transaction orchestrator. A transaction or bundle has failed and you must diagnose it and decide whether to RETRY or SKIP entirely.

NETWORK STATE (Slot ${latestSlot}):
- Avg slot cadence: ${avgDuration}ms (ideal: ${slotCadenceTarget}ms)
- Next block leader: ${nextLeader} | ${leaderInfo}
- Recent skipped leader observations: ${recentLeaderSkips}
- Active in-flight bundles: ${Object.keys(state.bundles.inFlight).length}
- Session results: ${state.bundles.completed.length} success / ${state.bundles.failed.length} failed

LIVE JITO TIP MARKET (lamports):
  p25=${p25}  p50=${p50}  p75=${p75}  p90=${p90}

PULSE SCORE: ${score}/100 — this is a composite health index:
  slotHealth=${slotHealth}/40  (slot cadence and skip rate — lower = network is slower/unstable)
  tipPressure=${tipPressure}/30  (market tip cost — lower = expensive to get included right now)
  leaderReliability=${leaderReliability}/30  (next leader's track record).

FAILURE TO DIAGNOSE:
  Type: ${failure.type}
  Message: ${failure.message}

YOUR DECISION:
Respond ONLY with a valid JSON block:
{
  "action": "RETRY" | "SKIP",
  "tip": <tip in lamports>,
  "waitDuration": 0,
  "reasoning": "<short reasoning on why it failed and why you chose this action>"
}
`;
  }

  private formatLeaderReliabilitySummary(state: SystemState): string {
    const entries = Object.entries(state.network.unreliableLeaders)
      .filter(([, value]) => value.skipCount > 0 || value.failCount > 0)
      .sort(([, a], [, b]) => (b.skipCount + b.failCount) - (a.skipCount + a.failCount))
      .slice(0, 5);

    if (entries.length === 0) return 'none recorded';

    return entries
      .map(([leader, value]) => `${leader.slice(0, 8)}... skips=${value.skipCount}, txFails=${value.failCount}`)
      .join('; ');
  }
}
