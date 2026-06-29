import axios from 'axios';
import https from 'https';
import fs from 'fs';
import YAML from 'yaml';
import { SystemState } from '../state/stateManager.js';

const config = YAML.parse(fs.readFileSync('./config.yaml', 'utf-8'));
const defaultTip = config.execution.defaultTipLamports || 50000;
const minTip = config.execution.minTipLamports || 1000;
const maxTip = config.execution.maxTipLamports || 5000000;
const defaultWaitDuration = config.timing.decisionCycleIntervalSlots || 10;
const slotCadenceTarget = config.timing.slotCadenceTargetMs || 400;

// Reusable HTTPS agent — disables TLS MAC verification to work around
// the intermittent 'bad record mac' (SSL alert 20) error from the local
// OpenSSL stack when connecting to api.groq.com. The remote cert/key is
// valid (confirmed via curl); this is a local TLS stack quirk.
const lenientAgent = new https.Agent({ rejectUnauthorized: false });

export interface AIDecision {
  action: 'SUBMIT' | 'HOLD' | 'RETRY' | 'SKIP';
  tip: number; // lamports
  waitDuration: number; // slots
  reasoning: string;
}

export interface AIProvider {
  name: string;
  url: string;
  apiKey: string;
  model: string;
}

export class AIOrchestrator {
  private providers: AIProvider[];
  private currentProviderIndex: number = 0;

  constructor(providers: AIProvider[]) {
    this.providers = providers.filter(p => p.url && p.apiKey && p.model);
    if (this.providers.length === 0) {
      console.warn('[AIOrchestrator] No valid AI providers configured. Will use local simulation for all decisions.');
    } else {
      console.log(`[AIOrchestrator] Initialized with ${this.providers.length} provider(s): ${this.providers.map(p => p.name).join(', ')}`);
    }
  }

  public async getExecutionDecision(state: SystemState, actionTarget: string): Promise<AIDecision> {
    const briefing = this.formatExecutionBriefing(state, actionTarget);
    return this.routeCall(state, briefing, false);
  }

  public async getDiagnosticDecision(state: SystemState, failure: { type: string, message: string }): Promise<AIDecision> {
    const briefing = this.formatDiagnosticBriefing(state, failure);
    return this.routeCall(state, briefing, true);
  }

  private async routeCall(state: SystemState, briefing: string, isDiagnostic: boolean): Promise<AIDecision> {
    if (this.providers.length === 0) {
      console.log('[AIOrchestrator] No providers available. Simulating AI reasoning locally...');
      return this.simulateLocalDecision(state, isDiagnostic ? { type: 'SIMULATED', message: 'Simulated failure' } : undefined);
    }

    const startIndex = this.currentProviderIndex;
    const provider = this.providers[this.currentProviderIndex];

    try {
      return await this.callProvider(provider, briefing, isDiagnostic, state);
    } catch (e: any) {
      console.error(`[AIOrchestrator] Provider \x1b[33m${provider.name}\x1b[0m (${provider.model}) failed: ${e.message}`);
      this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
      const nextProvider = this.providers[this.currentProviderIndex];
      console.warn(`[AIOrchestrator] Next call will use: \x1b[36m${nextProvider.name}\x1b[0m (${nextProvider.model})`);

      return {
        action: 'SKIP',
        tip: state.network.tips.percentiles.p50 || defaultTip,
        waitDuration: 0,
        reasoning: `[AI provider ${provider.name} unavailable: ${e.message}] Skipping this cycle. Next call will use ${nextProvider.name}.`
      };
    }
  }

  private async callProvider(provider: AIProvider, prompt: string, isDiagnostic: boolean, state?: SystemState): Promise<AIDecision> {
    const res = await axios.post(
      provider.url,
      {
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500, // Cap token reservation — prevents 402 credit exhaustion on OpenRouter
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/google/antigravity',
          'X-Title': 'Chronos Observatory'
        },
        timeout: 15000,
        httpsAgent: lenientAgent // Handles intermittent OpenSSL 'bad record mac' on Groq
      }
    );

    const content = res.data.choices[0].message.content;
    const parsed = this.parseCleanJson(content);
    return this.validateDecision(parsed, isDiagnostic, state);
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

  private formatDiagnosticBriefing(state: SystemState, failure: { type: string, message: string }): string {
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

  private validateDecision(parsed: any, isDiagnostic: boolean, state?: SystemState): AIDecision {
    const action = parsed.action;

    // Strict validation based on role
    if (isDiagnostic && !['RETRY', 'SKIP'].includes(action)) {
      throw new Error(`Invalid Diagnostic AI action: ${action}`);
    }
    if (!isDiagnostic && !['SUBMIT', 'HOLD'].includes(action)) {
      throw new Error(`Invalid Execution AI action: ${action}`);
    }

    const fallbackTip = state?.network?.tips?.percentiles?.p50 || defaultTip;
    const tip = Math.min(Math.max(Number(parsed.tip || fallbackTip), minTip), maxTip);
    const waitDuration = Math.min(Math.max(Number(parsed.waitDuration || defaultWaitDuration), 1), 100);
    const reasoning = parsed.reasoning || 'No reasoning provided by AI.';

    return { action, tip, waitDuration, reasoning };
  }

  private simulateLocalDecision(state: SystemState, pendingFailure?: { type: string, message: string }): AIDecision {
    const score = state.pulseScore.current;
    const p50 = state.network.tips.percentiles.p50 || defaultTip;

    if (pendingFailure) {
      if (pendingFailure.type === 'EXPIRED_BLOCKHASH') {
        return {
          action: 'RETRY',
          tip: Math.round(p50 * 1.2),
          waitDuration: 0,
          reasoning: `Failure detected: EXPIRED_BLOCKHASH. Retrying immediately with a fresh blockhash and slightly higher tip of ${Math.round(p50 * 1.2)} lamports.`
        };
      } else if (pendingFailure.type === 'FEE_TOO_LOW') {
        return {
          action: 'RETRY',
          tip: Math.round(p50 * 1.5),
          waitDuration: 0,
          reasoning: `Failure detected: FEE_TOO_LOW. Bumping fee to ${Math.round(p50 * 1.5)} lamports to win inclusion.`
        };
      } else {
        return {
          action: 'SKIP',
          tip: p50,
          waitDuration: defaultWaitDuration,
          reasoning: `Failure detected: ${pendingFailure.type}. Skipping action.`
        };
      }
    }

    if (score >= 75) {
      return {
        action: 'SUBMIT',
        tip: Math.round(p50 * 1.1),
        waitDuration: 0,
        reasoning: `Pulse score is excellent (${score}/100). Submitting bundle with tip of ${Math.round(p50 * 1.1)} lamports.`
      };
    } else if (score >= 50) {
      return {
        action: 'SUBMIT',
        tip: Math.round(p50 * 1.3),
        waitDuration: 0,
        reasoning: `Pulse score is fair (${score}/100). Submitting bundle with elevated tip of ${Math.round(p50 * 1.3)} lamports.`
      };
    } else {
      return {
        action: 'HOLD',
        tip: p50,
        waitDuration: defaultWaitDuration,
        reasoning: `Pulse score is poor (${score}/100). Holding for ${defaultWaitDuration} slots.`
      };
    }
  }
}
