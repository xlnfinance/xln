import type { Provider, Signer } from 'ethers';
import { rpcLog } from '../../rpc-public';
import { isNonceSyncError, type FeeOverrides, type RpcReceipt } from '../rpc-boundary';

type TransactionSequencerConfig = {
  provider: Provider;
  primarySigner: Signer;
  usesEvmNonce: boolean;
  buildFeeOverrides(): Promise<FeeOverrides>;
  waitForReceipt(tx: unknown, label: string): Promise<RpcReceipt>;
};

export type RpcTransactionSequencer = {
  runFor<T>(signer: Signer, work: () => Promise<T>): Promise<T>;
  run<T>(work: () => Promise<T>): Promise<T>;
  resetFor(signer: Signer): Promise<void>;
  poisonFor(signer: Signer, cause: unknown): Promise<void>;
  reset(): Promise<void>;
  allocateFor(signer: Signer): Promise<number>;
  allocate(): Promise<number>;
  send(
    signer: Signer,
    label: string,
    submit: (nonce: number, feeOverrides: FeeOverrides) => Promise<unknown>,
  ): Promise<RpcReceipt>;
};

export type SignerNonceSequencer = Pick<
  RpcTransactionSequencer,
  'runFor' | 'resetFor' | 'allocateFor'
> & {
  poisonFor(signer: Signer, cause: unknown): Promise<void>;
};

const resetSignerNonceCache = (signer: Signer): void => {
  if (
    typeof signer !== 'object' ||
    signer === null ||
    !('resetNonce' in signer) ||
    typeof signer.resetNonce !== 'function'
  ) {
    return;
  }
  try {
    signer.resetNonce();
  } catch (error) {
    rpcLog.warn('signer.nonce_reset_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Serializes external RPC transactions per signer EOA. This is transport nonce
 * ownership, not concurrent Runtime ingress: reducers still have one ordered
 * mempool and one writer.
 */
export const createRpcTransactionSequencer = (config: TransactionSequencerConfig): RpcTransactionSequencer => {
  const nonceSequencer = createSignerNonceSequencer(config.provider, config.usesEvmNonce);

  const send = async (
    signer: Signer,
    label: string,
    submit: (nonce: number, feeOverrides: FeeOverrides) => Promise<unknown>,
  ): Promise<RpcReceipt> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (attempt > 1) {
          await nonceSequencer.resetFor(signer);
          console.warn(`⚠️ [JAdapter:rpc] retrying ${label} after nonce sync ` + `(attempt ${attempt}/2)`);
        }
        const nonce = await nonceSequencer.allocateFor(signer);
        const feeOverrides = await config.buildFeeOverrides();
        console.log(`🔐 [JAdapter:rpc] ${label} nonce=${nonce}`);
        return await config.waitForReceipt(await submit(nonce, feeOverrides), label);
      } catch (error) {
        if (attempt < 2 && isNonceSyncError(error)) continue;
        await nonceSequencer.resetFor(signer);
        throw error;
      }
    }
    throw new Error(`${label} failed after nonce retry`);
  };

  return {
    ...nonceSequencer,
    run: work => nonceSequencer.runFor(config.primarySigner, work),
    reset: () => nonceSequencer.resetFor(config.primarySigner),
    allocate: () => nonceSequencer.allocateFor(config.primarySigner),
    send,
  };
};

export const createSignerNonceSequencer = (
  provider: Provider,
  usesEvmNonce: boolean,
): SignerNonceSequencer => {
  const queues = new Map<string, Promise<unknown>>();
  const nextNonces = new Map<string, number>();
  const poisoned = new Map<string, string>();
  const signerKey = async (signer: Signer): Promise<string> => (await signer.getAddress()).toLowerCase();

  const runFor = async <T>(signer: Signer, work: () => Promise<T>): Promise<T> => {
    const key = await signerKey(signer);
    const previous = queues.get(key) ?? Promise.resolve();
    // The previous caller already receives its rejection. The queue must still
    // advance so one failed RPC transaction cannot deadlock this EOA forever.
    const next = previous.catch(() => undefined).then(async () => {
      const poison = poisoned.get(key);
      if (poison) throw new Error(`SIGNER_NONCE_SEQUENCER_POISONED:${key}:${poison}`);
      return work();
    });
    const tail = next.then(() => undefined, () => undefined).finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    queues.set(key, tail);
    return next;
  };

  const resetFor = async (signer: Signer): Promise<void> => {
    nextNonces.delete(await signerKey(signer));
    resetSignerNonceCache(signer);
  };

  const allocateFor = async (signer: Signer): Promise<number> => {
    if (!usesEvmNonce) return 0;
    const key = await signerKey(signer);
    const poison = poisoned.get(key);
    if (poison) throw new Error(`SIGNER_NONCE_SEQUENCER_POISONED:${key}:${poison}`);
    const address = await signer.getAddress();
    const chainNonce = Math.max(
      await provider.getTransactionCount(address, 'latest'),
      await provider.getTransactionCount(address, 'pending'),
    );
    const cachedNonce = nextNonces.get(key);
    const nonce = cachedNonce === undefined || chainNonce > cachedNonce ? chainNonce : cachedNonce;
    nextNonces.set(key, nonce + 1);
    return nonce;
  };

  return {
    runFor,
    resetFor,
    allocateFor,
    async poisonFor(signer, cause) {
      poisoned.set(
        await signerKey(signer),
        cause instanceof Error ? cause.message : String(cause),
      );
    },
  };
};
