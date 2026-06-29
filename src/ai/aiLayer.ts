import { AIOrchestrator } from './aiOrchestrator.js';
import { ConsensusOrchestrator } from './consensusOrchestrator.js';
import { AIProvider, AIDecision } from './consensusOrchestrator.js';
import { SystemState } from '../state/stateManager.js';
import { bus } from '../server/eventBus.js';

export type AIMode = 'single' | 'consensus';

export class AILayer {
  private single: AIOrchestrator;
  private consensus?: ConsensusOrchestrator;
  private mode: AIMode = 'single';

  constructor(allProviders: AIProvider[]) {
    this.single = new AIOrchestrator(allProviders);

    // Consensus Mode requires at least 3 enabled providers (e.g. OpenRouter, Gemini, Groq)
    const consensusProviders = allProviders.filter(p => p.url && p.apiKey && p.model).slice(0, 3);
    if (consensusProviders.length >= 3) {
      this.consensus = new ConsensusOrchestrator(consensusProviders);
    } else {
      bus.log('AILayer', `Consensus Mode disabled: Needs at least 3 active/enabled providers (found ${consensusProviders.length}).`, 'warn');
    }
  }

  public getMode(): AIMode { return this.mode; }

  /** Switch to consensus mode only if self-test has been passed */
  public async setMode(mode: AIMode): Promise<{ ok: boolean; error?: string }> {
    if (mode === 'consensus') {
      if (!this.consensus) {
        return { ok: false, error: 'Consensus Mode requires at least 3 configured/enabled AI providers. Check your environment variables.' };
      }
      if (!this.consensus.isReady()) {
        return { ok: false, error: 'Run consensus self-test first. All providers must pass before activating.' };
      }
    }
    this.mode = mode;
    bus.emit('chronos', { type: 'MODE_CHANGE', mode, timestamp: new Date().toISOString() });
    bus.log('AILayer', `Mode switched to: ${mode.toUpperCase()}`);
    return { ok: true };
  }

  /** Run self-test on consensus providers — must pass before consensus can be activated */
  public async runConsensusTest() {
    if (!this.consensus) {
      return {
        allPassed: false,
        results: [],
        error: 'Consensus Mode is disabled because fewer than 3 AI providers are configured.'
      };
    }
    return this.consensus.selfTest();
  }

  /** Get a timing decision for a specific transaction */
  public async getExecutionDecision(
    state: SystemState,
    actionTarget: string
  ): Promise<AIDecision & { mode: AIMode }> {
    let decision: AIDecision;
    if (this.mode === 'consensus' && this.consensus) {
      decision = await this.consensus.getExecutionDecision(state, actionTarget);
    } else {
      decision = await this.single.getExecutionDecision(state, actionTarget);
    }

    bus.emit('chronos', {
      type: 'AI_DECISION',
      aiType: 'EXECUTION',
      action: decision.action,
      tip: decision.tip,
      reasoning: decision.reasoning,
      mode: this.mode,
      slot: state.network.latestSlot,
      timestamp: new Date().toISOString()
    });

    return { ...decision, mode: this.mode };
  }

  /** Get a diagnostic decision for a failure */
  public async getDiagnosticDecision(
    state: SystemState,
    failure: { type: string; message: string }
  ): Promise<AIDecision & { mode: AIMode }> {
    let decision: AIDecision;
    if (this.mode === 'consensus' && this.consensus) {
      decision = await this.consensus.getDiagnosticDecision(state, failure);
    } else {
      decision = await this.single.getDiagnosticDecision(state, failure);
    }

    bus.emit('chronos', {
      type: 'AI_DECISION',
      aiType: 'DIAGNOSTIC',
      action: decision.action,
      tip: decision.tip,
      reasoning: decision.reasoning,
      mode: this.mode,
      slot: state.network.latestSlot,
      timestamp: new Date().toISOString()
    });

    return { ...decision, mode: this.mode };
  }
}
