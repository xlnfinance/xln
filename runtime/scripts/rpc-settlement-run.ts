#!/usr/bin/env bun
/**
 * The parity assertions themselves, independent of how the stack was reached.
 *
 * A batch is submitted, its receipt-decoded J-events are compared against the
 * same events refetched from the chain, and reserves must move exactly by the
 * declared amount.
 */

import { ethers } from 'ethers';

import { DEV_CHAIN_IDS, createXlnJsonRpcProvider } from '../jurisdiction/adapter';
import type { JAdapter } from '../jurisdiction/adapter/types';
import { createEmptyBatch } from '../jurisdiction/machine/batch';
import { prepareSignedBatch } from '../hanko/batch';
import { generateLazyEntityId } from '../entity/factory';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/machine/event-observation';
import { rawEventToJEvents } from '../jurisdiction/adapter/j-event-payloads';
import { parseReceiptLogsToJEvents } from '../jurisdiction/adapter/j-event-log-decoder';

export type ParityRunOptions = {
  mode: string;
  rpcUrl: string;
  chainId: number;
  tokenAddress?: string;
};

type SourceEvent = {
  name: string;
  args?: Record<string, unknown>;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
};

const TOKEN_ID = 1;
const TRANSFER_AMOUNT = 123n;
const FUNDING_AMOUNT = 1_000n;

const toJurisdictionHash = (events: SourceEvent[], entityId: string): string =>
  canonicalJurisdictionEventsHash(events.flatMap((event) => {
    const rawEvent: {
      name: string;
      args: Record<string, unknown>;
      blockNumber?: number;
      blockHash?: string;
      transactionHash?: string;
    } = { name: event.name, args: (event.args ?? {}) as Record<string, unknown> };
    if (event.blockNumber !== undefined) rawEvent.blockNumber = event.blockNumber;
    if (event.blockHash !== undefined) rawEvent.blockHash = event.blockHash;
    if (event.transactionHash !== undefined) rawEvent.transactionHash = event.transactionHash;
    return rawEventToJEvents(rawEvent, entityId);
  }));

const approveToken = async (
  adapter: JAdapter,
  options: ParityRunOptions,
  tokenAddress: string,
  privateKey: string,
): Promise<void> => {
  const provider = createXlnJsonRpcProvider(options.rpcUrl, options.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const token = new ethers.Contract(tokenAddress, [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
  ], wallet);
  const allowance = await token.getFunction('allowance')(
    wallet.address,
    adapter.addresses.depository,
  ) as bigint;
  if (allowance < FUNDING_AMOUNT) {
    const approval = await token.getFunction('approve')(adapter.addresses.depository, ethers.MaxUint256);
    const approvalReceipt = await approval.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) {
      throw new Error(`PARITY_TOKEN_APPROVE_FAILED:${approval.hash}`);
    }
  }
  await provider.destroy();
};

/**
 * Dev chains mint straight into reserves. A real chain has no such hook, so
 * reserves are funded through the same external-token deposit a user would run.
 */
const fundReserves = async (
  adapter: JAdapter,
  options: ParityRunOptions,
  entityId: string,
  privateKey: string,
): Promise<void> => {
  if (DEV_CHAIN_IDS.has(options.chainId)) {
    await adapter.debugFundReserves(entityId, TOKEN_ID, FUNDING_AMOUNT);
    return;
  }
  if (!options.tokenAddress) throw new Error('PARITY_TOKEN_ADDRESS_REQUIRED');
  if (await adapter.getReserves(entityId, TOKEN_ID) >= FUNDING_AMOUNT) return;

  await approveToken(adapter, options, options.tokenAddress, privateKey);
  const deposit = createEmptyBatch();
  deposit.externalTokenToReserve.push({
    entity: entityId,
    contractAddress: options.tokenAddress,
    externalTokenId: 0n,
    tokenType: 0,
    internalTokenId: TOKEN_ID,
    amount: FUNDING_AMOUNT,
  });
  const signed = prepareSignedBatch(
    deposit,
    entityId,
    privateKey,
    BigInt(options.chainId),
    adapter.addresses.depository,
    await adapter.getEntityNonce(entityId),
  );
  await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
};

const deriveTargetEntity = (signerAddress: string): string => generateLazyEntityId(
  [new ethers.Wallet(ethers.keccak256(
    ethers.solidityPacked(['string', 'address'], ['xln:rpc-settlement-parity:target', signerAddress]),
  )).address],
  1n,
).toLowerCase();

export const runParity = async (
  adapter: JAdapter,
  options: ParityRunOptions,
  privateKey: string,
): Promise<void> => {
  const provider = createXlnJsonRpcProvider(options.rpcUrl, options.chainId);
  const signerAddress = new ethers.Wallet(privateKey).address;
  const sourceEntity = generateLazyEntityId([signerAddress], 1n).toLowerCase();
  const targetEntity = deriveTargetEntity(signerAddress);

  await fundReserves(adapter, options, sourceEntity, privateKey);
  const beforeSource = await adapter.getReserves(sourceEntity, TOKEN_ID);
  const beforeTarget = await adapter.getReserves(targetEntity, TOKEN_ID);
  if (beforeSource < TRANSFER_AMOUNT) {
    throw new Error(`PARITY_SOURCE_RESERVE_INSUFFICIENT:${beforeSource}:${TRANSFER_AMOUNT}`);
  }

  const batch = createEmptyBatch();
  batch.reserveToReserve.push({ receivingEntity: targetEntity, tokenId: TOKEN_ID, amount: TRANSFER_AMOUNT });
  const { encodedBatch, hankoData, nextNonce } = prepareSignedBatch(
    batch,
    sourceEntity,
    privateKey,
    BigInt(options.chainId),
    adapter.addresses.depository,
    await adapter.getEntityNonce(sourceEntity),
  );
  const receipt = await adapter.processBatch(encodedBatch, hankoData, nextNonce);
  const minedReceipt = await provider.getTransactionReceipt(receipt.txHash);
  if (!minedReceipt) throw new Error(`PARITY_RECEIPT_MISSING:${receipt.txHash}`);

  // A public block carries unrelated transactions. Parity compares this batch's
  // events, so the refetch is narrowed to this transaction rather than trusting
  // the block to hold nothing else touching our contracts.
  const fetchedLogs = (await provider.getLogs({ blockHash: minedReceipt.blockHash }))
    .filter(log => log.transactionHash === receipt.txHash);
  const fetchedEvents = parseReceiptLogsToJEvents({
    logs: fetchedLogs.map(log => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      index: log.index,
    })),
    blockNumber: minedReceipt.blockNumber,
    blockHash: minedReceipt.blockHash,
    hash: receipt.txHash,
  }, [
    { address: adapter.addresses.depository, interface: adapter.depository.interface },
    { address: adapter.addresses.entityProvider, interface: adapter.entityProvider.interface },
  ]);

  const receiptHash = toJurisdictionHash(receipt.events, sourceEntity);
  const fetchedHash = toJurisdictionHash(fetchedEvents, sourceEntity);
  if (receiptHash !== fetchedHash) {
    throw new Error(`PARITY_EVENT_HASH_MISMATCH:receipt=${receiptHash}:fetched=${fetchedHash}`);
  }

  const afterSource = await adapter.getReserves(sourceEntity, TOKEN_ID);
  const afterTarget = await adapter.getReserves(targetEntity, TOKEN_ID);
  if (beforeSource - TRANSFER_AMOUNT !== afterSource) {
    throw new Error(`PARITY_SOURCE_RESERVE_MISMATCH:${beforeSource}:${afterSource}`);
  }
  if (beforeTarget + TRANSFER_AMOUNT !== afterTarget) {
    throw new Error(`PARITY_TARGET_RESERVE_MISMATCH:${beforeTarget}:${afterTarget}`);
  }
  await provider.destroy();

  console.log('✅ rpc-settlement-parity passed');
  console.log(JSON.stringify({
    kind: 'RPC_SETTLEMENT_PARITY',
    mode: options.mode,
    rpcUrl: options.rpcUrl,
    chainId: options.chainId,
    depository: adapter.addresses.depository,
    sourceEntity,
    targetEntity,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    eventCount: receipt.events.length,
    fetchedEventCount: fetchedEvents.length,
    eventsHash: receiptHash,
    reserves: {
      beforeSource: beforeSource.toString(),
      afterSource: afterSource.toString(),
      beforeTarget: beforeTarget.toString(),
      afterTarget: afterTarget.toString(),
    },
  }, null, 2));
};
