#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { ethers } from 'ethers';

import { DEFAULT_PRIVATE_KEY, createJAdapter } from '../jadapter';
import { createEmptyBatch } from '../j-batch';
import { prepareSignedBatch } from '../hanko/batch';
import { generateLazyEntityId } from '../entity-factory';
import { canonicalJurisdictionEventsHash } from '../j-event-observation';
import { parseReceiptLogsToJEvents, rawEventToJEvents, type RawJEventArgs } from '../jadapter/helpers';

type Args = {
  rpcUrl: string;
  chainId: number;
  spawnAnvil: boolean;
  anvilPort: number;
  keepAnvil: boolean;
};

const parseArgs = (): Args => {
  const flags = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current) continue;
    if (!current.startsWith('--')) continue;
    const [inlineKeyRaw, inlineValue] = current.split('=', 2);
    const inlineKey = inlineKeyRaw || current;
    if (inlineValue !== undefined) {
      flags.set(inlineKey, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }
  const chainId = Number(flags.get('--chain-id') || 31337);
  const anvilPort = Number(flags.get('--anvil-port') || 18545);
  const spawnAnvil = !flags.has('--no-spawn-anvil');
  const rpcUrl = String(flags.get('--rpc-url') || process.env['ANVIL_RPC'] || `http://127.0.0.1:${anvilPort}`);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`Invalid --chain-id=${chainId}`);
  if (!Number.isFinite(anvilPort) || anvilPort <= 0) throw new Error(`Invalid --anvil-port=${anvilPort}`);
  return {
    rpcUrl,
    chainId: Math.floor(chainId),
    spawnAnvil,
    anvilPort: Math.floor(anvilPort),
    keepAnvil: flags.has('--keep-anvil'),
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForRpcReady = async (rpcUrl: string, timeoutMs = 20_000): Promise<void> => {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber();
      await provider.destroy();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  await provider.destroy();
  throw new Error(`RPC not ready at ${rpcUrl}: ${lastError}`);
};

const startAnvil = (args: Args): ChildProcess | null => {
  if (!args.spawnAnvil) return null;
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(args.anvilPort),
    '--chain-id', String(args.chainId),
    '--mixed-mining',
    '--block-time', '1',
    '--block-gas-limit', '60000000',
    '--code-size-limit', '65536',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', chunk => process.stderr.write(`[anvil] ${chunk.toString()}`));
  return child;
};

const toJurisdictionHash = (
  events: Array<{ name: string; args?: Record<string, unknown>; blockNumber?: number; blockHash?: string; transactionHash?: string }>,
  entityId: string,
): string => canonicalJurisdictionEventsHash(
  events.flatMap((event) => {
    const rawEvent: {
      name: string;
      args: RawJEventArgs;
      blockNumber?: number;
      blockHash?: string;
      transactionHash?: string;
    } = {
      name: event.name,
      args: (event.args ?? {}) as RawJEventArgs,
    };
    if (event.blockNumber !== undefined) rawEvent.blockNumber = event.blockNumber;
    if (event.blockHash !== undefined) rawEvent.blockHash = event.blockHash;
    if (event.transactionHash !== undefined) rawEvent.transactionHash = event.transactionHash;
    return rawEventToJEvents(rawEvent, entityId);
  }),
);

const main = async (): Promise<void> => {
  const args = parseArgs();
  const anvil = startAnvil(args);
  const cleanup = (): void => {
    if (!anvil || args.keepAnvil || anvil.exitCode !== null) return;
    try {
      anvil.kill('SIGTERM');
    } catch {
      // best-effort cleanup
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  await waitForRpcReady(args.rpcUrl);
  const provider = new ethers.JsonRpcProvider(args.rpcUrl);
  const adapter = await createJAdapter({
    mode: 'rpc',
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
  });
  await adapter.deployStack();

  const signerAddress = new ethers.Wallet(DEFAULT_PRIVATE_KEY).address;
  const sourceEntity = generateLazyEntityId([signerAddress], 1n).toLowerCase();
  const targetEntity = generateLazyEntityId(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'], 1n).toLowerCase();
  const tokenId = 1;
  const startingAmount = 1_000n;
  const transferAmount = 123n;

  await adapter.debugFundReserves(sourceEntity, tokenId, startingAmount);
  const beforeSource = await adapter.getReserves(sourceEntity, tokenId);
  const beforeTarget = await adapter.getReserves(targetEntity, tokenId);

  const batch = createEmptyBatch();
  batch.reserveToReserve.push({
    receivingEntity: targetEntity,
    tokenId,
    amount: transferAmount,
  });

  const nonce = await adapter.getEntityNonce(sourceEntity);
  const { encodedBatch, hankoData, nextNonce } = prepareSignedBatch(
    batch,
    sourceEntity,
    DEFAULT_PRIVATE_KEY,
    BigInt(args.chainId),
    adapter.addresses.depository,
    nonce,
  );
  const receipt = await adapter.processBatch(encodedBatch, hankoData, nextNonce);
  const minedReceipt = await provider.getTransactionReceipt(receipt.txHash);
  if (!minedReceipt) throw new Error(`Missing transaction receipt for ${receipt.txHash}`);

  const fetchedLogs = await provider.getLogs({
    blockHash: minedReceipt.blockHash,
  });
  const fetchedEvents = parseReceiptLogsToJEvents({
    logs: fetchedLogs.map(log => ({ topics: log.topics, data: log.data })),
    blockNumber: minedReceipt.blockNumber,
    blockHash: minedReceipt.blockHash,
    hash: receipt.txHash,
  }, [
    { interface: adapter.depository.interface },
    { interface: adapter.entityProvider.interface },
  ]);

  const receiptHash = toJurisdictionHash(receipt.events, sourceEntity);
  const fetchedHash = toJurisdictionHash(fetchedEvents, sourceEntity);
  if (receiptHash !== fetchedHash) {
    throw new Error(`RPC event parity mismatch: receipt=${receiptHash} fetched=${fetchedHash}`);
  }

  const afterSource = await adapter.getReserves(sourceEntity, tokenId);
  const afterTarget = await adapter.getReserves(targetEntity, tokenId);
  if (beforeSource - transferAmount !== afterSource) {
    throw new Error(`Source reserve mismatch: before=${beforeSource} after=${afterSource}`);
  }
  if (beforeTarget + transferAmount !== afterTarget) {
    throw new Error(`Target reserve mismatch: before=${beforeTarget} after=${afterTarget}`);
  }

  await adapter.close();
  await provider.destroy();
  cleanup();

  console.log('✅ rpc-settlement-parity passed');
  console.log(JSON.stringify({
    rpcUrl: args.rpcUrl,
    chainId: args.chainId,
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

main().catch((error) => {
  console.error('❌ rpc-settlement-parity failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
