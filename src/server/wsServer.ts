import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from './eventBus.js';
import { StateManager } from '../state/stateManager.js';
import { AILayer } from '../ai/aiLayer.js';
import { WalletInspector } from '../engine/walletInspector.js';
import { Keypair } from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.resolve(__dirname, '../../ui/index.html');

interface RequestContext {
  stateManager: StateManager;
  aiLayer: AILayer;
  walletInspector: WalletInspector;
  wallet: Keypair;
  jitoTipAccounts: string[];
  onSendTx: (params: { recipient: string; tokenMint?: string; amountLamports: number }) => void;
  onContractDeploy: (programBytes: Buffer, label: string) => void;
}

export class WsServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private ctx!: RequestContext;

  constructor(port = 3000) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      bus.log('WsServer', `Client connected (${this.clients.size} total)`);

      // Send current state snapshot immediately
      if (this.ctx) {
        const snap = this.ctx.stateManager.getSnapshot();
        this.send(ws, { type: 'STATE_SNAPSHOT', state: snap, timestamp: new Date().toISOString() });
      }

      ws.on('close', () => {
        this.clients.delete(ws);
        bus.log('WsServer', `Client disconnected (${this.clients.size} remaining)`);
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.cmd === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        } catch { /* ignore */ }
      });
    });

    // Forward all EventBus events to every connected client
    bus.on('chronos', (event) => {
      const payload = JSON.stringify(event);
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    });

    this.server.listen(port, () => {
      bus.log('WsServer', `CHRONOS UI live at http://localhost:${port}`);
    });
  }

  public setContext(ctx: RequestContext): void {
    this.ctx = ctx;
  }

  private send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // ── Static UI ──────────────────────────────────────────────────────────
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      try {
        const html = fs.readFileSync(UI_PATH, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch {
        res.writeHead(404); res.end('UI not found. Build ui/index.html first.');
      }
      return;
    }

    // ── REST API ───────────────────────────────────────────────────────────
    if (url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const body = await this.readBody(req);

      try {
        // GET /api/state
        if (method === 'GET' && url === '/api/state') {
          res.writeHead(200);
          res.end(JSON.stringify(this.ctx.stateManager.getSnapshot()));
          return;
        }

        // GET /api/wallet/tokens
        if (method === 'GET' && url === '/api/wallet/tokens') {
          const balances = await this.ctx.walletInspector.getAllBalances(this.ctx.wallet.publicKey);
          res.writeHead(200);
          res.end(JSON.stringify(balances));
          return;
        }

        // GET /api/mode
        if (method === 'GET' && url === '/api/mode') {
          res.writeHead(200);
          res.end(JSON.stringify({ mode: this.ctx.aiLayer.getMode() }));
          return;
        }

        // POST /api/mode  { mode: 'single' | 'consensus' }
        if (method === 'POST' && url === '/api/mode') {
          const result = await this.ctx.aiLayer.setMode(body.mode);
          res.writeHead(result.ok ? 200 : 400);
          res.end(JSON.stringify(result));
          return;
        }

        // POST /api/consensus/test
        if (method === 'POST' && url === '/api/consensus/test') {
          const result = await this.ctx.aiLayer.runConsensusTest();
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }

        // POST /api/simulate/toggle { active: boolean }
        if (method === 'POST' && url === '/api/simulate/toggle') {
          const { active } = body;
          this.ctx.stateManager.setSimulationActive(!!active);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, isSimulationActive: !!active }));
          // Emitting state snapshot to instantly update the UI
          bus.emit('chronos', { type: 'STATE_SNAPSHOT', state: this.ctx.stateManager.getSnapshot(), timestamp: new Date().toISOString() });
          return;
        }

        // POST /api/tx/send  { recipient, tokenMint?, amountLamports }
        if (method === 'POST' && url === '/api/tx/send') {
          const { recipient, tokenMint, amountLamports } = body;
          if (!recipient || !amountLamports) { res.writeHead(400); res.end(JSON.stringify({ error: 'recipient and amountLamports required' })); return; }
          this.ctx.onSendTx({ recipient, tokenMint, amountLamports: Number(amountLamports) });
          res.writeHead(202);
          res.end(JSON.stringify({ ok: true, message: 'Transaction queued for AI dispatch' }));
          return;
        }

        // POST /api/contract/deploy  { programBytesBase64, label? }
        if (method === 'POST' && url === '/api/contract/deploy') {
          const { programBytesBase64, label } = body;
          if (!programBytesBase64) { res.writeHead(400); res.end(JSON.stringify({ error: 'programBytesBase64 required' })); return; }
          const programBytes = Buffer.from(programBytesBase64, 'base64');
          this.ctx.onContractDeploy(programBytes, label || 'contract-deploy');
          res.writeHead(202);
          res.end(JSON.stringify({ ok: true, message: 'Contract queued for AI-timed deployment', sizeBytes: programBytes.length }));
          return;
        }

        res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
      } catch (e: any) {
        bus.log('WsServer', `REST error: ${e.message}`, 'error');
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      });
    });
  }
}
