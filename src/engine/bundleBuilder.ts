import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { Bundle } from '@drift-labs/jito-ts/dist/sdk/block-engine/types.js';
import bs58 from 'bs58';

export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];

export function parseKeypair(keyStr: string): Keypair {
  try {
    const trimmed = keyStr.trim();
    if (trimmed.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (e: any) {
    throw new Error(`Failed to parse private key: ${e.message}`);
  }
}

export class BundleBuilder {
  private connection: Connection;
  private signer: Keypair;

  constructor(connection: Connection, signer: Keypair) {
    this.connection = connection;
    this.signer = signer;
  }

  // ── Existing: memo + tip bundle (observatory heartbeat) ───────────────────
  public async buildBundle(
    tipAmountLamports: number,
    activeTipAccounts?: string[],
    customBlockhash?: string,
    intentionalDelayMs?: number
  ): Promise<{ bundle: Bundle; txSignature: string; blockhash: string }> {
    let blockhash = customBlockhash;
    if (!blockhash) {
      const latest = await this.connection.getLatestBlockhash('confirmed');
      blockhash = latest.blockhash;
    }

    const tipPool = (activeTipAccounts && activeTipAccounts.length > 0) ? activeTipAccounts : JITO_TIP_ACCOUNTS;
    const randomTipAccount = tipPool[Math.floor(Math.random() * tipPool.length)];
    const tipPubkey = new PublicKey(randomTipAccount);

    const memoProgramId = new PublicKey('MemoSq4gqABAXKb96q683w7Qbxg1Spi1yfSjW84z7pP');
    const memoInstruction = new TransactionInstruction({
      keys: [],
      programId: memoProgramId,
      data: Buffer.from(`CHRONOS Observatory | ${new Date().toISOString()}`)
    });

    const tipInstruction = SystemProgram.transfer({
      fromPubkey: this.signer.publicKey,
      toPubkey: tipPubkey,
      lamports: tipAmountLamports
    });

    const userMessage = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [memoInstruction, tipInstruction]
    }).compileToV0Message();

    const userTx = new VersionedTransaction(userMessage);

    if (intentionalDelayMs && intentionalDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intentionalDelayMs));
    }

    userTx.sign([this.signer]);
    const bundle = new Bundle([userTx as any], 5);
    const txSignature = bs58.encode(userTx.signatures[0]);

    console.log(`[BundleBuilder] Bundle built | Sig: ${txSignature.slice(0, 16)}... | Tip: ${tipAmountLamports} lam`);
    return { bundle, txSignature, blockhash };
  }

  // ── NEW: SOL transfer bundle ──────────────────────────────────────────────
  public async buildSOLTransferBundle(
    recipientAddress: string,
    amountLamports: number,
    tipAmountLamports: number,
    activeTipAccounts?: string[]
  ): Promise<{ bundle: Bundle; txSignature: string; blockhash: string }> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const tipPool = (activeTipAccounts && activeTipAccounts.length > 0) ? activeTipAccounts : JITO_TIP_ACCOUNTS;
    const tipPubkey = new PublicKey(tipPool[Math.floor(Math.random() * tipPool.length)]);
    const recipient = new PublicKey(recipientAddress);

    const instructions = [
      SystemProgram.transfer({ fromPubkey: this.signer.publicKey, toPubkey: recipient, lamports: amountLamports }),
      SystemProgram.transfer({ fromPubkey: this.signer.publicKey, toPubkey: tipPubkey, lamports: tipAmountLamports })
    ];

    const msg = new TransactionMessage({ payerKey: this.signer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.signer]);

    const bundle = new Bundle([tx as any], 5);
    const txSignature = bs58.encode(tx.signatures[0]);
    console.log(`[BundleBuilder] SOL transfer bundle | ${(amountLamports / 1e9).toFixed(6)} SOL -> ${recipientAddress.slice(0, 12)}... | Tip: ${tipAmountLamports}`);
    return { bundle, txSignature, blockhash };
  }

  // ── NEW: SPL token transfer bundle ────────────────────────────────────────
  public async buildSPLTransferBundle(
    recipientAddress: string,
    mintAddress: string,
    amount: bigint,
    decimals: number,
    tipAmountLamports: number,
    activeTipAccounts?: string[]
  ): Promise<{ bundle: Bundle; txSignature: string; blockhash: string }> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const mint = new PublicKey(mintAddress);
    const recipient = new PublicKey(recipientAddress);
    const tipPool = (activeTipAccounts && activeTipAccounts.length > 0) ? activeTipAccounts : JITO_TIP_ACCOUNTS;
    const tipPubkey = new PublicKey(tipPool[Math.floor(Math.random() * tipPool.length)]);

    const senderATA = await getAssociatedTokenAddress(mint, this.signer.publicKey);
    const recipientATA = await getAssociatedTokenAddress(mint, recipient);

    const instructions = [
      createTransferCheckedInstruction(senderATA, mint, recipientATA, this.signer.publicKey, amount, decimals),
      SystemProgram.transfer({ fromPubkey: this.signer.publicKey, toPubkey: tipPubkey, lamports: tipAmountLamports })
    ];

    const msg = new TransactionMessage({ payerKey: this.signer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.signer]);

    const bundle = new Bundle([tx as any], 5);
    const txSignature = bs58.encode(tx.signatures[0]);
    console.log(`[BundleBuilder] SPL transfer bundle | mint: ${mintAddress.slice(0, 12)}... -> ${recipientAddress.slice(0, 12)}... | Tip: ${tipAmountLamports}`);
    return { bundle, txSignature, blockhash };
  }
}
