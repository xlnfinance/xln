import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types';

import {
  classifyCompetingFinalizationReceipt,
  classifyFinalizationChainTimeGate,
  readFinalizationChainTimeGate,
  reconcileCompetingFinalizationReceipt,
  reconcileProcessedBatchFailure,
  selectCompetingFinalization,
} from '../jurisdiction/adapter/rpc-submission';
import { createRpcReceiptReaders } from '../jurisdiction/adapter/rpc-receipts';
import { parseBlockTimestamp } from '../jurisdiction/adapter/rpc-chain-io';
import type { RpcContractStack } from '../jurisdiction/adapter/rpc-contract-stack';
import type { JSubmitResult } from '../jurisdiction/adapter/types';
import { createEmptyBatch, encodeJBatch } from '../jurisdiction/machine/batch';

const bytes32 = (byte: string): string => `0x${byte.repeat(32)}`;

const failure: JSubmitResult = {
  success: false,
  error: 'staticCall revert: E2()',
  failure: { category: 'terminal', code: 'CALL_EXCEPTION', message: 'staticCall revert: E2()' },
};

const input = (hasProcessedBatch: () => Promise<boolean>) => ({
  receipts: { hasProcessedBatch },
  entityId: `0x${'11'.repeat(32)}`,
  batchHash: `0x${'22'.repeat(32)}`,
  entityNonce: 7n,
  failure,
});

const timedFinalization = () => {
  const batch = createEmptyBatch();
  batch.disputeFinalizations.push({
    counterentity: bytes32('22'),
    initialNonce: 7,
    finalNonce: 7,
    proposerIsLeft: true,
    initialProofbodyHash: bytes32('33'),
    finalProofbody: {
      watchSeed: bytes32('44'),
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [],
      tokenIds: [],
      transformers: [],
    },
    starterArguments: '0x',
    otherArguments: '0x',
    sig: '0x',
    startedByLeft: true,
    cooperative: false,
    submitNotBeforeTimestamp: 100,
  });
  return batch.disputeFinalizations[0]!;
};

const activeChainAccount = () => ({
  nonce: 7n,
  disputeHash: bytes32('55'),
  disputeTimeout: 100n,
  disputeInitialProofbodyHash: bytes32('33'),
  disputeStartedByLeft: true,
});

test('timeout finalization waits on exact L1 time without invoking Solidity early', () => {
  expect(classifyFinalizationChainTimeGate(
    timedFinalization(),
    activeChainAccount(),
    99,
  )).toMatchObject({
    success: false,
    failure: {
      category: 'transient',
      code: 'DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME',
    },
  });
});

test('timeout finalization proceeds exactly at the L1 deadline', () => {
  expect(classifyFinalizationChainTimeGate(
    timedFinalization(),
    activeChainAccount(),
    100,
  )).toBeNull();
});

test('timeout gate fails loud when active on-chain identity contradicts signed proof', () => {
  expect(() => classifyFinalizationChainTimeGate(
    timedFinalization(),
    { ...activeChainAccount(), nonce: 8n },
    99,
  )).toThrow('DISPUTE_FINALIZATION_CHAIN_IDENTITY_MISMATCH');
});

test('timeout gate leaves a consumed dispute to exact E5 receipt reconciliation', () => {
  expect(classifyFinalizationChainTimeGate(
    timedFinalization(),
    { ...activeChainAccount(), disputeHash: ethers.ZeroHash },
    99,
  )).toBeNull();
});

test('runtime-only deadline does not change canonical batch calldata', () => {
  const timed = createEmptyBatch();
  timed.disputeFinalizations.push(timedFinalization());
  const canonical = structuredClone(timed);
  delete canonical.disputeFinalizations[0]!.submitNotBeforeTimestamp;
  expect(encodeJBatch(timed)).toBe(encodeJBatch(canonical));
});

test('timeout gate covers finalization co-batched with registry reveal evidence', async () => {
  const batch = createEmptyBatch();
  batch.disputeFinalizations.push(timedFinalization());
  batch.revealSecrets.push({ transformer: ethers.ZeroAddress, secret: bytes32('66') });
  let accountReads = 0;
  let timestampReads = 0;
  const result = await readFinalizationChainTimeGate({
    batch,
    readAccount: async () => {
      accountReads += 1;
      return activeChainAccount();
    },
    readLatestBlockTimestamp: async () => {
      timestampReads += 1;
      return 99;
    },
  });
  expect(result).toMatchObject({
    success: false,
    failure: { code: 'DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME' },
  });
  expect(accountReads).toBe(1);
  expect(timestampReads).toBe(1);
});

test('latest block timestamp accepts canonical hex quantity and rejects malformed boundaries', () => {
  expect(parseBlockTimestamp('0x64')).toBe(100);
  expect(() => parseBlockTimestamp('not-a-quantity')).toThrow('J_CHAIN_BLOCK_TIMESTAMP_INVALID');
  expect(() => parseBlockTimestamp(BigInt(Number.MAX_SAFE_INTEGER) + 1n))
    .toThrow('J_CHAIN_BLOCK_TIMESTAMP_INVALID');
});

test('exact mined batch receipt reconciles a lost submission result', async () => {
  expect(await reconcileProcessedBatchFailure(input(async () => true))).toEqual({ success: true });
});

test('different consumed batch preserves the original terminal failure', async () => {
  expect(await reconcileProcessedBatchFailure(input(async () => false))).toBe(failure);
});

test('unavailable receipt authority remains unknown instead of terminal', async () => {
  const result = await reconcileProcessedBatchFailure(input(async () => {
    const error = new Error('request timeout');
    Object.assign(error, { code: 'TIMEOUT' });
    throw error;
  }));
  expect(result).toMatchObject({
    success: false,
    failure: { category: 'transient', code: 'TIMEOUT' },
  });
});

test('malformed processed-batch receipt remains a loud integrity failure', async () => {
  const result = await reconcileProcessedBatchFailure(input(async () => {
    throw new Error('HANKO_BATCH_RECEIPT_DUPLICATE:entity:hash:7');
  }));
  expect(result).toMatchObject({
    success: false,
    failure: { category: 'terminal', code: 'J_ADAPTER_TERMINAL' },
  });
  expect(result).not.toBe(failure);
});

test('competing-finalization receipt failures replace E5 instead of being swallowed', async () => {
  const receipts = {
    readDisputeFinalizationReceipt: async () => {
      const error = new Error('request timeout');
      Object.assign(error, { code: 'TIMEOUT' });
      throw error;
    },
  };
  const result = await reconcileCompetingFinalizationReceipt({
    receipts,
    entityId: bytes32('11'),
    counterentity: bytes32('22'),
    initialNonce: 7n,
    initialProofbodyHash: bytes32('33'),
    failure,
  });
  expect(result).toMatchObject({
    success: false,
    error: 'request timeout',
    failure: { category: 'transient', code: 'TIMEOUT' },
  });
  expect(result).not.toBe(failure);
});

test('competing finalization remains transient until its event crosses mainnet finality', () => {
  const result = classifyCompetingFinalizationReceipt(failure, {
    blockNumber: 100,
    transactionHash: `0x${'33'.repeat(32)}`,
  });
  expect(result).toMatchObject({
    success: false,
    failure: { category: 'transient', code: 'STALE_FINALIZATION_AWAITING_FINALITY' },
  });
});

test('co-batched evidence does not change exact competing-finalization classification', () => {
  const batch = createEmptyBatch();
  batch.disputeFinalizations.push(timedFinalization());
  batch.revealSecrets.push({ transformer: ethers.ZeroAddress, secret: bytes32('77') });
  expect(selectCompetingFinalization(batch)).toBe(batch.disputeFinalizations[0]);
  expect(classifyCompetingFinalizationReceipt(failure, {
    blockNumber: 101,
    transactionHash: bytes32('88'),
  })).toMatchObject({
    success: false,
    failure: { category: 'transient', code: 'STALE_FINALIZATION_AWAITING_FINALITY' },
  });
});

test('globally safe receipt remains transient until the local watcher authenticates its event', () => {
  const result = classifyCompetingFinalizationReceipt(failure, {
    blockNumber: 100,
    transactionHash: `0x${'44'.repeat(32)}`,
  });
  expect(result).toMatchObject({
    success: false,
    failure: { category: 'transient', code: 'STALE_FINALIZATION_AWAITING_FINALITY' },
  });
});

test('competing finalization receipt boundaries reject unsafe Number coercion', () => {
  expect(() => classifyCompetingFinalizationReceipt(failure, {
    blockNumber: Number.MAX_SAFE_INTEGER + 1,
    transactionHash: `0x${'55'.repeat(32)}`,
  })).toThrow('STALE_FINALIZATION_RECEIPT_BOUNDARY_INVALID');
});

test('receipt reader canonicalizes DisputeFinalized nonce before binding calldata evidence', async () => {
  const entityId = bytes32('11');
  const counterentity = bytes32('22');
  const initialProofbodyHash = bytes32('33');
  const transactionHash = bytes32('44');
  const finalization = {
    counterentity,
    initialNonce: 7,
    finalNonce: 11,
    proposerIsLeft: false,
    initialProofbodyHash,
    finalProofbody: {
      watchSeed: bytes32('55'),
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [5n, -3n],
      tokenIds: [1n, 2n],
      transformers: [],
    },
    starterArguments: '0x5678',
    otherArguments: '0xabcd',
    sig: '0x0102',
    startedByLeft: true,
    cooperative: false,
  };
  const batch = createEmptyBatch();
  batch.disputeFinalizations.push(finalization);
  const iface = Depository__factory.createInterface();
  const calldata = iface.encodeFunctionData('processBatch', [encodeJBatch(batch), '0x0102', 3n]);
  const finalizationEvidenceHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
    [
      initialProofbodyHash,
      11n,
      false,
      true,
      ethers.keccak256('0x5678'),
      ethers.keccak256('0xabcd'),
      ethers.keccak256('0x0102'),
    ],
  ));
  const encodedLog = iface.encodeEventLog(iface.getEvent('DisputeFinalized'), [
    entityId,
    counterentity,
    7n,
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'uint256', 'int256[]', 'uint256[]'],
      [bytes32('55'), 10, 10, [5n, -3n], [1n, 2n]],
    )),
    finalizationEvidenceHash,
  ]);
  const provider = {
    getLogs: async ({ topics }: { topics: readonly string[] }) => topics[1]?.toLowerCase() === entityId.toLowerCase()
      ? [{
          topics: encodedLog.topics,
          data: encodedLog.data,
          transactionHash,
          blockNumber: 100,
          blockHash: bytes32('66'),
          index: 0,
        }]
      : [],
    getTransaction: async () => ({ data: calldata }),
  } as unknown as ethers.JsonRpcProvider;
  const stack = {
    depository: { interface: iface },
    entityProviderDeploymentBlock: 0,
    getDepositoryAddress: async () => ethers.ZeroAddress,
  } as unknown as RpcContractStack;

  await expect(createRpcReceiptReaders(provider, stack).readDisputeFinalizationReceipt(
    entityId,
    counterentity,
    7n,
    initialProofbodyHash,
  )).resolves.toEqual({ blockNumber: 100, transactionHash });
});
