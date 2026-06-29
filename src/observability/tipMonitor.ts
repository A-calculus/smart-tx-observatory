import axios from 'axios';
import { StateManager } from '../state/stateManager.js';

// Jito tip floor REST endpoint (from jito.md)
// Response values are in SOL (float) - must multiply by 1e9 to get lamports
const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

export class TipMonitor {
  private stateManager: StateManager;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private fetchIntervalMs: number;
  private lastPrintedP50: number = 0;

  constructor(stateManager: StateManager, fetchIntervalMs: number = 5000) {
    this.stateManager = stateManager;
    this.fetchIntervalMs = fetchIntervalMs;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[TipMonitor] Starting Jito tip floor monitoring...');

    // Fetch immediately on start
    await this.fetchTipStats();

    // Start periodic polling
    this.intervalId = setInterval(async () => {
      await this.fetchTipStats();
    }, this.fetchIntervalMs);
  }

  private async fetchTipStats(): Promise<void> {
    try {
      const response = await axios.get(JITO_TIP_FLOOR_URL, { timeout: 5000 });

      if (response.data && response.data.length > 0) {
        const stats = response.data[0];

        // Values are in SOL — convert to lamports by multiplying by 1e9
        const p25 = Math.round(Number(stats.landed_tips_25th_percentile || 0) * 1e9);
        const p50 = Math.round(Number(stats.landed_tips_50th_percentile || 0) * 1e9);
        const p75 = Math.round(Number(stats.landed_tips_75th_percentile || 0) * 1e9);
        const p95 = Math.round(Number(stats.landed_tips_95th_percentile || 0) * 1e9);
        const emaP50 = Math.round(Number(stats.ema_landed_tips_50th_percentile || 0) * 1e9);

        if (p50 !== this.lastPrintedP50) {
          console.log(`[TipMonitor] Live Jito tips (lamports) -> p25: ${p25}, p50: ${p50} (ema: ${emaP50}), p75: ${p75}, p95: ${p95}`);
          this.lastPrintedP50 = p50;
        }

        // Feed all samples into state manager
        this.stateManager.updateTips([p25, p50, p75, p95]);
      } else {
        throw new Error('Empty response from Jito tip floor API');
      }
    } catch (e: any) {

      // The AI will continue using whatever was last stored in state.
      console.warn(`[TipMonitor] Failed to fetch Jito tip floor data: ${e.message}. Retaining last known tip values.`);
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[TipMonitor] Tip monitoring stopped.');
  }
}
