import { describe, expect, test } from 'bun:test';

import { isTransientJAdapterStartupError } from '../../../jurisdiction/adapter/kernel/retry';
import { JBroadcastReceiptError, makeJAdapterFailureResult } from '../../../jurisdiction/adapter/kernel/failure';
import {
  submitBoardActivation,
  type RpcEntityProviderSubmitContext,
} from '../../../jurisdiction/adapter/rpc/write/rpc-submit-entity-provider';
import { createRpcWalletWriteMethods } from '../../../jurisdiction/adapter/rpc/wallet/rpc-wallet-writes';

const ethersError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

describe('structured J-adapter failure taxonomy', () => {
  test.each(['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT'])(
    '%s remains transient even when its message lacks transport keywords',
    (code) => {
      const error = ethersError(code, 'provider operation failed');
      expect(isTransientJAdapterStartupError(error)).toBe(true);
    },
  );

  test('CALL_EXCEPTION and explicit revert stay terminal even with transient-looking text', () => {
    const callException = ethersError('CALL_EXCEPTION', 'execution reverted after ECONNRESET');
    expect(isTransientJAdapterStartupError(callException)).toBe(false);
    expect(isTransientJAdapterStartupError('staticCall revert: server timeout')).toBe(false);
  });

  test('adapter result preserves the original ethers code and chosen category', () => {
    expect(makeJAdapterFailureResult(ethersError('SERVER_ERROR', 'provider operation failed')))
      .toEqual({
        success: false,
        error: 'provider operation failed',
        failure: {
          category: 'transient',
          code: 'SERVER_ERROR',
          message: 'provider operation failed',
        },
      });
    expect(makeJAdapterFailureResult(ethersError('CALL_EXCEPTION', 'execution reverted')))
      .toMatchObject({ failure: { category: 'terminal', code: 'CALL_EXCEPTION' } });
  });

  test.each([
    ['NONCE_EXPIRED', 'nonce has already been used'],
    ['REPLACEMENT_UNDERPRICED', 'replacement fee too low'],
    ['TRANSACTION_REPLACED', 'transaction replaced'],
    ['UNKNOWN_ERROR', 'nonce too low'],
  ])('%s nonce-envelope contention remains transient', (code, message) => {
    const error = ethersError(code, message);
    expect(isTransientJAdapterStartupError(error)).toBe(true);
    expect(makeJAdapterFailureResult(error).failure).toMatchObject({ category: 'transient', code });
  });

  test('revert evidence still outranks nonce-looking text', () => {
    const error = ethersError('UNKNOWN_ERROR', 'execution reverted: nonce too low');
    expect(makeJAdapterFailureResult(error).failure.category).toBe('terminal');
  });

  test('nested ethers JSON-RPC nonce evidence is classified without replacing its root message', () => {
    const error = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      info: { error: { code: -32_000, message: 'nonce too low' } },
    });
    expect(makeJAdapterFailureResult(error).failure).toEqual({
      category: 'transient',
      code: 'UNKNOWN_ERROR',
      message: 'could not coalesce error',
    });
  });
});

test('a broadcast that times out inside the submit lane keeps its typed failure and txHash', async () => {
  // `return context.runSerialized(...)` inside try had no await: the lane's
  // rejection skipped the catch, so the caller got a raw throw and lost the
  // hash of a transaction that was already broadcast.
  const txHash = `0x${'ab'.repeat(32)}`;
  const context = {
    watchOnly: false,
    signer: {},
    entityProvider: { connect: () => ({}) },
    runSerialized: async () => {
      throw new JBroadcastReceiptError(txHash, new Error('receipt wait timed out'));
    },
  } as unknown as RpcEntityProviderSubmitContext;
  const result = await submitBoardActivation(
    context,
    { type: 'entityProviderActivateBoard', data: { targetEntityId: `0x${'11'.repeat(32)}` } } as unknown as Parameters<
      typeof submitBoardActivation
    >[1],
    undefined,
  );
  expect(result).toMatchObject({ success: false, txHash });
});

test('external wallet transfers take the signer lane and its explicit nonce', async () => {
  // transferErc20/transferNative skipped the per-signer sequencer, so the
  // provider could hand them a nonce a prepared batch was about to use.
  const lane: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const signer = {
    getAddress: async () => `0x${'12'.repeat(20)}`,
    sendTransaction: async (tx: Record<string, unknown>) => {
      sent.push(tx);
      return { hash: `0x${'cd'.repeat(32)}` };
    },
  };
  const writes = createRpcWalletWriteMethods({
    provider: {} as never,
    signerForPrivateKey: async () => signer as never,
    runSerializedBatchFor: async (_signer, work) => {
      lane.push('enter');
      try {
        return await work();
      } finally {
        lane.push('exit');
      }
    },
    sendSignerTxWithExplicitNonce: async (_signer, label, send) => {
      lane.push(label);
      await send(41, { maxFeePerGas: 2n });
      return { hash: `0x${'cd'.repeat(32)}`, blockNumber: 7, blockHash: `0x${'ef'.repeat(32)}`, logs: [] };
    },
  });

  expect(await writes.transferNative(new Uint8Array(32).fill(1), `0x${'34'.repeat(20)}`, 5n))
    .toBe(`0x${'cd'.repeat(32)}`);
  expect(lane).toEqual(['enter', 'transferNative', 'exit']);
  expect(sent[0]).toMatchObject({ to: `0x${'34'.repeat(20)}`, value: 5n, nonce: 41, maxFeePerGas: 2n });
});
