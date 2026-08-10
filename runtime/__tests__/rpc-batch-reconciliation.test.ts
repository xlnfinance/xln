import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types';

import {
  classifyCompetingFinalizationReceipt,
  reconcileCompetingFinalizationReceipt,
  reconcileProcessedBatchFailure,
} from '../jurisdiction/adapter/rpc-submission';
import { createRpcReceiptReaders } from '../jurisdiction/adapter/rpc-receipts';
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
