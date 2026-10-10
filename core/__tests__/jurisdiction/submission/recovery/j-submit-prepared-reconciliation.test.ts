import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyRuntimeTx } from '../../../../runtime/tx/tx-handlers';
import { submitRuntimeJOutbox } from '../../../../runtime/j-submit/j-submit';
import { ensureRuntimeInfrastructure } from '../../../../runtime/envelope/replica-envelope';
import type { RuntimeReplica, RuntimeTx } from '../../../../runtime/types';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import {
  commitJSubmitAttempt,
  jurisdictionName,
} from '../../../fixtures/jurisdiction/j-submit-durability-fixture';

const payer = new ethers.Wallet(`0x${'21'.repeat(32)}`);

const signedWire = async (): Promise<{ raw: string; txHash: string }> => {
  const raw = await payer.signTransaction({
    type: 2,
    chainId: 31_337,
    nonce: 7,
    to: `0x${'22'.repeat(20)}`,
    data: '0x',
    value: 0n,
    gasLimit: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  return { raw, txHash: ethers.keccak256(raw) };
};

type PreparedProvider = Partial<Record<
  'getTransactionReceipt' | 'getTransaction' | 'waitForTransaction' | 'getBlock',
  (...args: unknown[]) => Promise<unknown>
>>;

const preparedAttempt = async (provider: PreparedProvider, adapterExtra: Record<string, unknown> = {}) => {
  const fixture = await commitJSubmitAttempt();
  const batch = fixture.jOutbox[0]?.jTxs[0];
  if (batch?.type !== 'batch' || !batch.data.runtimeSubmitAttempt) throw new Error('prepared fixture missing');
  const wire = await signedWire();
  batch.data.runtimeSubmitAttempt.rawTransaction = wire.raw;
  installAdapter(fixture.env, {
    mode: 'rpc',
    pollNow: async () => {},
    provider,
    broadcastPreparedTransaction: async () => wire.txHash,
    ...adapterExtra,
  } as unknown as JAdapter);
  return { ...fixture, ...wire };
};

const installAdapter = (env: RuntimeReplica, adapter: JAdapter): void => {
  env.state.jReplicas = new Map([[jurisdictionName, {
    name: jurisdictionName,
    chainId: 31337,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  }]]);
  ensureRuntimeInfrastructure(env).liveJAdapters = new Map([[jurisdictionName, adapter]]);
};

const submit = async (env: RuntimeReplica, jOutbox: Awaited<ReturnType<typeof commitJSubmitAttempt>>['jOutbox']) => {
  const queued: RuntimeTx[] = [];
  await submitRuntimeJOutbox(env, jOutbox, {
    enqueueRuntimeInputs: (_target, _inputs, runtimeTxs) => queued.push(...(runtimeTxs ?? [])),
  });
  return queued;
};

describe('prepared J batch wire reconciliation', () => {
  test('an unrecognised JSON-RPC read error is retried, never a terminal quarantine', async () => {
    // ethers maps a node's "header not found" to UNKNOWN_ERROR; the generic
    // classifier defaulted it to terminal and quarantined the signed batch.
    const coalesced = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      info: { error: { code: -32_000, message: 'header not found' } },
    });
    const { env, replica, jOutbox, txHash } = await preparedAttempt({
      getTransactionReceipt: async () => { throw coalesced; },
    });

    const queued = await submit(env, jOutbox);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: {
        outcome: 'transientFailure',
        txHash,
        adapterFailure: { category: 'transient', code: 'J_PREPARED_CHAIN_READ_UNAVAILABLE' },
      },
    });
    await applyRuntimeTx(env, queued[0]!, { isReplay: true });
    expect(replica.jSubmitState?.terminalFailure).toBeUndefined();
    expect(env.infrastructure?.pendingCommittedJOutbox).toHaveLength(1);
  });

  test('a reverted receipt is terminal only once its block is behind the finality depth', async () => {
    // On EVM the adapter's safe head is the latest block, so `head >= receipt`
    // always held and an unfinalized revert quarantined a batch a reorg could include.
    const blockHash = `0x${'a7'.repeat(32)}`;
    const outcomeAtHead = async (head: number) => {
      const { env, jOutbox, txHash } = await preparedAttempt({
        getTransactionReceipt: async () => ({ hash: txHash, status: 0, blockNumber: 100, blockHash }),
        getBlock: async () => ({ hash: blockHash }),
      }, { getCurrentBlockNumber: async () => head, getFinalityDepth: () => 12 });
      const [result] = await submit(env, jOutbox);
      return result?.type === 'recordJSubmitResult' ? result.data : null;
    };

    expect(await outcomeAtHead(105)).toMatchObject({
      outcome: 'transientFailure',
      adapterFailure: { category: 'transient', code: 'J_PREPARED_RECEIPT_REVERTED_AWAITING_FINALITY' },
    });
    expect(await outcomeAtHead(112)).toMatchObject({
      outcome: 'terminalFailure',
      message: 'transaction reverted',
    });
  });
});
