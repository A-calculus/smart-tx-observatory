import { Connection } from '@solana/web3.js';
import { StateManager } from '../state/stateManager.js';
import { bus } from '../server/eventBus.js';

const GRPC_CONNECT_TIMEOUT_MS = 10000;
const MAX_GRPC_FAILURES_BEFORE_WSS = 3;
const LEADER_LOOKAHEAD_SLOTS = 32;

export class SlotWatcher {
  private rpcUrl: string;
  private wsUrl: string;
  private grpcUrl: string;
  private grpcToken: string;
  private stateManager: StateManager;
  private isRunning: boolean = false;
  private connection: Connection;

  // Keep track of active subscriptions/connections to clean up
  private wsSubscriptionId: number | null = null;
  private grpcClient: any = null;
  private grpcStream: any = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay: number = 1000;
  private grpcFailureCount: number = 0;
  private grpcFallbackStarted: boolean = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private grpcPermanentlyDisabled: boolean = false;
  private wssPermanentlyFailed: boolean = false;
  private pollingIntervalId: NodeJS.Timeout | null = null;

  // Deduplication: only forward monotonically increasing slots
  private lastProcessedSlot: number = 0;
  private leaderCache = new Map<number, string>();
  private leaderFetchPromise: Promise<void> | null = null;

  constructor(
    rpcUrl: string,
    wsUrl: string,
    grpcUrl: string,
    grpcToken: string,
    stateManager: StateManager
  ) {
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.grpcUrl = grpcUrl;
    this.grpcToken = grpcToken;
    this.stateManager = stateManager;

    // Set up standard Solana Connection
    this.connection = new Connection(this.rpcUrl, {
      wsEndpoint: this.wsUrl,
      commitment: 'confirmed'
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    bus.log('SlotWatcher', 'Starting slot monitoring with priority: gRPC -> WebSocket -> HTTP RPC polling.');

    if (!this.grpcPermanentlyDisabled && this.grpcUrl && this.grpcUrl !== 'YOUR_KEY' && this.grpcToken && this.grpcToken !== 'YOUR_KEY') {
      try {
        bus.log('SlotWatcher', 'Trying gRPC first because it is the fastest slot source.');
        await this.withTimeout(this.connectGrpc(), GRPC_CONNECT_TIMEOUT_MS, 'gRPC initial connection timed out');
        return;
      } catch (e: any) {
        this.cleanupGrpc();
        bus.log('SlotWatcher', `gRPC connection failed: ${e.message}. Falling back to WebSockets...`, 'warn');
      }
    } else {
      bus.log('SlotWatcher', 'gRPC credentials not provided. Falling back to WebSocket subscription.');
    }

    await this.connectWebSocket();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async connectGrpc(): Promise<void> {
    if (this.grpcPermanentlyDisabled) return;
    const ClientModule = await import('@triton-one/yellowstone-grpc');
    const ClientClass: any = ClientModule.default || ClientModule;

    bus.log('SlotWatcher', `Connecting to Yellowstone gRPC at: ${this.grpcUrl}`);

    // Use the official Yellowstone client
    this.grpcClient = new ClientClass(this.grpcUrl, this.grpcToken, {
      'grpc.max_receive_message_length': -1,
    });

    this.grpcStream = await this.grpcClient.subscribe();

    this.grpcStream.on('data', (data: any) => {
      this.grpcFailureCount = 0;
      if (data.slot) {
        const slot = Number(data.slot.slot);

        // Deduplicate: only process strictly increasing slots
        if (slot <= this.lastProcessedSlot) return;
        this.lastProcessedSlot = slot;
        const skipped = data.slot.skipped === true;

        this.processSlot('gRPC', slot, skipped).catch((e: any) => {
          bus.log('SlotWatcher', `[gRPC] Failed to process slot ${slot}: ${e.message}`, 'warn');
          this.stateManager.updateSlot(slot, 'unknown', skipped);
        });
      }
    });

    this.grpcStream.on('error', (err: any) => {
      this.grpcFailureCount++;
      bus.log('SlotWatcher', `[gRPC] Stream error (${this.grpcFailureCount}/${MAX_GRPC_FAILURES_BEFORE_WSS}): ${err.message}`, 'error');
      if (err.message && err.message.toLowerCase().includes('requires a pro')) {
        bus.log('SlotWatcher', '[gRPC] Chainstack tier does not support gRPC. Falling back to WebSocket permanently.', 'warn');
        this.fallbackToWebSocketPermanently();
      } else if (this.grpcFailureCount >= MAX_GRPC_FAILURES_BEFORE_WSS) {
        bus.log('SlotWatcher', `[gRPC] Failed ${this.grpcFailureCount} times. Falling back to WebSocket for this run.`, 'warn');
        this.fallbackToWebSocketPermanently();
      } else {
        this.handleGrpcReconnect();
      }
    });

    this.grpcStream.on('end', () => {
      if (this.grpcPermanentlyDisabled) return;
      this.grpcFailureCount++;
      bus.log('SlotWatcher', `[gRPC] Stream ended (${this.grpcFailureCount}/${MAX_GRPC_FAILURES_BEFORE_WSS})`, 'warn');
      if (this.grpcFailureCount >= MAX_GRPC_FAILURES_BEFORE_WSS) {
        bus.log('SlotWatcher', `[gRPC] Ended ${this.grpcFailureCount} times. Falling back to WebSocket for this run.`, 'warn');
        this.fallbackToWebSocketPermanently();
        return;
      }
      this.handleGrpcReconnect();
    });

    // Send slot subscription request
    const request = {
      slots: {
        incoming_slots: {} // labelled as per jito.md examples
      },
      accounts: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: undefined
    };

    await new Promise<void>((resolve, reject) => {
      this.grpcStream.write(request, (err: any) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    });
    bus.log('SlotWatcher', '[gRPC] Slot subscription active.');
    this.grpcFailureCount = 0;

    // 30-second ping keepalive to prevent Cloudflare idle stream closure (per jito.md)
    const pingRequest = {
      ping: { id: 1 },
      slots: {},
      accounts: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: undefined
    };

    this.pingInterval = setInterval(() => {
      if (this.grpcStream) {
        this.grpcStream.write(pingRequest, (err: any) => {
          if (err) bus.log('SlotWatcher', `[gRPC] Ping failed: ${err.message}`, 'warn');
        });
      }
    }, 30000);
  }

  private handleGrpcReconnect(): void {
    if (!this.isRunning || this.grpcPermanentlyDisabled) return;
    if (this.reconnectTimeout) return;
    this.cleanupGrpc();

    bus.log('SlotWatcher', `[gRPC] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        await this.connectGrpc();
        this.reconnectDelay = 1000;
      } catch (e: any) {
        bus.log('SlotWatcher', `[gRPC] Reconnection failed: ${e.message}. Retrying...`, 'warn');
        this.handleGrpcReconnect();
      }
    }, this.reconnectDelay);
  }

  private fallbackToWebSocketPermanently(): void {
    if (this.grpcFallbackStarted) return;
    this.grpcFallbackStarted = true;
    this.grpcPermanentlyDisabled = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupGrpc();
    this.connectWebSocket().catch((e: any) => {
      bus.log('SlotWatcher', `[WSS] Fallback failed: ${e.message}. Falling back to HTTP polling.`, 'warn');
      this.connectPolling();
    });
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.wsUrl) {
      bus.log('SlotWatcher', '[WSS] No WebSocket URL provided. Skipping WSS fallback.', 'warn');
      return;
    }

    const maskedWsUrl = this.wsUrl.replace(/api_key=([^&]+)/, (match, key) => `api_key=${key.substring(0, 4)}...`);
    bus.log('SlotWatcher', `Connecting to Solana WebSocket at: ${maskedWsUrl}`);

    const interceptWs405 = (originalFn: Function) => (...args: any[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('Unexpected server response: 405')) {
        if (!this.wssPermanentlyFailed) {
          this.wssPermanentlyFailed = true;
          bus.log('SlotWatcher', '[WSS] Server returned 405. WebSockets disabled on this endpoint. Falling back to HTTP Polling.', 'warn');
          if (this.wsSubscriptionId !== null) {
            this.connection.removeSlotChangeListener(this.wsSubscriptionId).catch(() => { });
            this.wsSubscriptionId = null;
          }
          this.connectPolling();
        }
        return;
      }
      originalFn(...args);
    };

    const origLog = console.log;
    const origError = console.error;
    console.log = interceptWs405(origLog);
    console.error = interceptWs405(origError);

    try {
      this.wsSubscriptionId = this.connection.onSlotChange((slotInfo) => {
        const slot = slotInfo.slot;

        if (slot <= this.lastProcessedSlot) return;
        this.lastProcessedSlot = slot;

        const skipped = false;
        this.processSlot('WSS', slot, skipped).catch((e: any) => {
          bus.log('SlotWatcher', `[WSS] Failed to process slot ${slot}: ${e.message}`, 'warn');
          this.stateManager.updateSlot(slot, 'unknown', skipped);
        });
      });
      bus.log('SlotWatcher', '[WSS] WebSocket subscription active.');
    } catch (e: any) {
      bus.log('SlotWatcher', `[WSS] Subscription failed: ${e.message}. Falling back to HTTP Polling.`, 'warn');
      this.connectPolling();
    }
  }

  private connectPolling(): void {
    if (this.pollingIntervalId !== null) return;
    bus.log('SlotWatcher', '[HTTP] Starting HTTP polling for slots (every 400ms)...');

    this.pollingIntervalId = setInterval(async () => {
      try {
        const slot = await this.connection.getSlot();
        if (slot > this.lastProcessedSlot) {
          this.lastProcessedSlot = slot;
          const skipped = false;
          await this.processSlot('HTTP', slot, skipped);
        }
      } catch (e: any) {
        // Silent catch for polling to avoid log spam on transient HTTP errors
      }
    }, 400);
  }

  private async processSlot(source: 'gRPC' | 'WSS' | 'HTTP', slot: number, skipped: boolean): Promise<void> {
    const leader = await this.resolveLeader(slot);
    bus.log('SlotWatcher', `[${source}] Slot received: ${slot} | Leader: ${leader} | Skipped: ${skipped}`);
    this.stateManager.updateSlot(slot, leader, skipped);
  }

  private async resolveLeader(slot: number): Promise<string> {
    const upcoming = this.stateManager.getSnapshot().network.upcomingLeaders;
    const leaderInfo = upcoming.find(l => l.slot === slot);
    if (leaderInfo) return leaderInfo.leader;

    const cached = this.leaderCache.get(slot);
    if (cached) return cached;

    await this.ensureLeaderCache(slot);
    const fetched = this.leaderCache.get(slot);
    if (fetched) return fetched;

    await this.ensureLeaderCache(slot, true);
    return this.leaderCache.get(slot) || 'unknown';
  }

  private async ensureLeaderCache(slot: number, force = false): Promise<void> {
    if (this.leaderFetchPromise && !force) {
      await this.leaderFetchPromise;
      return;
    }

    this.leaderFetchPromise = (async () => {
      const leaders = await this.connection.getSlotLeaders(slot, LEADER_LOOKAHEAD_SLOTS);
      const schedule = leaders.map((leader, index) => {
        const leaderKey = leader.toBase58();
        const leaderSlot = slot + index;
        this.leaderCache.set(leaderSlot, leaderKey);
        return { slot: leaderSlot, leader: leaderKey, isJito: true };
      });

      if (schedule.length > 0) {
        this.stateManager.updateUpcomingLeaders(schedule);
      }

      const minSlotToKeep = slot - LEADER_LOOKAHEAD_SLOTS;
      for (const cachedSlot of this.leaderCache.keys()) {
        if (cachedSlot < minSlotToKeep) this.leaderCache.delete(cachedSlot);
      }
    })();

    try {
      await this.leaderFetchPromise;
    } finally {
      this.leaderFetchPromise = null;
    }
  }

  private cleanupGrpc(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.grpcStream) {
      try { this.grpcStream.end(); } catch { }
      this.grpcStream = null;
    }
    this.grpcClient = null;
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupGrpc();

    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }

    if (this.wsSubscriptionId !== null) {
      try {
        await this.connection.removeSlotChangeListener(this.wsSubscriptionId);
        console.log('[SlotWatcher] WebSocket slot subscription removed.');
      } catch { }
      this.wsSubscriptionId = null;
    }
    console.log('[SlotWatcher] Slot monitoring stopped.');
  }
}
