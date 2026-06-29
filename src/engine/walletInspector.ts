import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { bus, TokenInfo } from '../server/eventBus.js';

export class WalletInspector {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async getSOLBalance(pubkey: PublicKey): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(pubkey, 'confirmed');
      bus.log('WalletInspector', `SOL balance: ${(lamports / 1e9).toFixed(6)} SOL (${lamports} lamports)`);
      return lamports;
    } catch (e: any) {
      bus.log('WalletInspector', `Failed to fetch SOL balance: ${e.message}`, 'error');
      throw e;
    }
  }

  public async getSPLTokens(pubkey: PublicKey): Promise<TokenInfo[]> {
    try {
      const res = await this.connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: TOKEN_PROGRAM_ID },
        'confirmed'
      );

      const tokens: TokenInfo[] = res.value
        .map(({ pubkey: ata, account }) => {
          const info = (account.data as any).parsed?.info;
          if (!info || !info.tokenAmount) return null;
          const amount = info.tokenAmount;
          return {
            mint: info.mint,
            symbol: info.mint.slice(0, 6) + '…', // no on-chain metadata available cheaply
            uiAmount: parseFloat(amount.uiAmountString || '0'),
            decimals: amount.decimals,
            ataAddress: ata.toBase58()
          } as TokenInfo;
        })
        .filter((t): t is TokenInfo => t !== null && t.uiAmount > 0);

      bus.log('WalletInspector', `Found ${tokens.length} SPL token account(s) with balance`);
      bus.emit('chronos', {
        type: 'WALLET_TOKENS',
        tokens,
        solBalanceLamports: 0, // caller fills this in
        timestamp: new Date().toISOString()
      });

      return tokens;
    } catch (e: any) {
      bus.log('WalletInspector', `Failed to fetch SPL tokens: ${e.message}`, 'warn');
      return [];
    }
  }

  /** Returns both SOL and SPL tokens, emits WALLET_TOKENS event */
  public async getAllBalances(pubkey: PublicKey): Promise<{ solLamports: number; tokens: TokenInfo[] }> {
    const [solLamports, tokens] = await Promise.all([
      this.getSOLBalance(pubkey),
      this.getSPLTokens(pubkey)
    ]);

    bus.emit('chronos', {
      type: 'WALLET_TOKENS',
      tokens,
      solBalanceLamports: solLamports,
      timestamp: new Date().toISOString()
    });

    return { solLamports, tokens };
  }

  /** Throws if requestedLamports > availableLamports. Always keeps 0.001 SOL rent reserve. */
  public enforceSOLCap(requestedLamports: number, availableLamports: number): void {
    const RENT_RESERVE = 1_000_000; // 0.001 SOL
    const spendable = availableLamports - RENT_RESERVE;
    if (requestedLamports > spendable) {
      throw new Error(
        `Insufficient SOL: requested ${requestedLamports} lam, spendable ${spendable} lam (keeping ${RENT_RESERVE} lam for rent)`
      );
    }
  }

  /** Throws if requestedUiAmount > token uiAmount */
  public enforceSPLCap(requestedUiAmount: number, token: TokenInfo): void {
    if (requestedUiAmount > token.uiAmount) {
      throw new Error(
        `Insufficient ${token.symbol}: requested ${requestedUiAmount}, available ${token.uiAmount}`
      );
    }
  }
}
