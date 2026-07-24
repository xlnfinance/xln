#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';

import { prepareSignedBatch } from '../hanko/batch';
import { createJAdapter } from '../jadapter';
import { readAuthenticatedReceiptRange } from '../jadapter/receipt-reader';
import { createEmptyBatch } from '../jurisdiction/batch';

type JurisdictionConfig = {
  chainId?: number;
  rpc?: string;
  defaultDisputeDelayBlocks?: number;
  entityProviderDeploymentBlock?: number;
  contracts?: Record<string, string>;
  tokens?: Record<string, { address?: string; tokenId?: number }>;
};

const argument = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const jurisdictionId = argument('--jurisdiction') || '';
const depositAmount = BigInt(argument('--deposit') || '0');
const withdrawAmount = BigInt(argument('--withdraw') || '0');
const privateKey = String(process.env['PUBLIC_CHAIN_PRIVATE_KEY'] || '').trim();
if (!jurisdictionId) throw new Error('PUBLIC_SMOKE_JURISDICTION_REQUIRED');
if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('PUBLIC_SMOKE_PRIVATE_KEY_REQUIRED');
if (depositAmount <= 0n || withdrawAmount <= 0n || withdrawAmount > depositAmount) {
  throw new Error(`PUBLIC_SMOKE_AMOUNT_INVALID:${depositAmount}:${withdrawAmount}`);
}

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), 'jurisdictions/jurisdictions.json'), 'utf8'),
) as { jurisdictions?: Record<string, JurisdictionConfig> };
const jurisdiction = config.jurisdictions?.[jurisdictionId];
if (!jurisdiction) throw new Error(`PUBLIC_SMOKE_JURISDICTION_UNKNOWN:${jurisdictionId}`);

const chainId = Number(jurisdiction.chainId);
const rpcUrl = String(jurisdiction.rpc || '');
const deploymentBlock = Number(jurisdiction.entityProviderDeploymentBlock);
const contracts = jurisdiction.contracts;
const token = jurisdiction.tokens?.['USDT'];
if (!Number.isSafeInteger(chainId) || chainId <= 0 || !rpcUrl) {
  throw new Error(`PUBLIC_SMOKE_NETWORK_CONFIG_INVALID:${jurisdictionId}`);
}
if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) {
  throw new Error(`PUBLIC_SMOKE_DEPLOYMENT_BLOCK_INVALID:${jurisdictionId}`);
}
if (
  !contracts?.['account'] ||
  !contracts['depository'] ||
  !contracts['entityProvider'] ||
  !contracts['deltaTransformer']
) {
  throw new Error(`PUBLIC_SMOKE_CONTRACTS_INCOMPLETE:${jurisdictionId}`);
}
if (!token?.address || token.tokenId !== 1) {
  throw new Error(`PUBLIC_SMOKE_USDT_TOKEN_1_REQUIRED:${jurisdictionId}`);
}

const isTron = jurisdictionId.startsWith('tron-');
const keyBytes = ethers.getBytes(privateKey);
const walletAddress = new ethers.Wallet(privateKey).address;
const foundationEntityId = ethers.zeroPadValue('0x01', 32);
const configuredDisputeDelayBlocks = jurisdiction.defaultDisputeDelayBlocks;
if (!Number.isSafeInteger(configuredDisputeDelayBlocks) || configuredDisputeDelayBlocks! <= 0) {
  throw new Error(`PUBLIC_SMOKE_DISPUTE_DELAY_INVALID:${String(configuredDisputeDelayBlocks)}`);
}
const accountAddress = contracts['account'];
const depositoryAddress = contracts['depository'];
const entityProviderAddress = contracts['entityProvider'];
const deltaTransformerAddress = contracts['deltaTransformer'];
const tokenAddress = token.address;
const adapter = await createJAdapter({
  mode: isTron ? 'tron' : 'rpc',
  chainId,
  rpcUrl,
  privateKey,
  defaultDisputeDelayBlocks: configuredDisputeDelayBlocks!,
  txWaitConfirms: 1,
  txWaitTimeoutMs: 180_000,
  ...(isTron ? { tronFullHost: rpcUrl.replace(/\/jsonrpc\/?$/i, '') } : {}),
  fromReplica: {
    contracts: {
      account: accountAddress,
      depository: depositoryAddress,
      entityProvider: entityProviderAddress,
      deltaTransformer: deltaTransformerAddress,
    },
    depositoryAddress,
    entityProviderAddress,
    entityProviderDeploymentBlock: deploymentBlock,
  },
});
const provider = adapter.provider as typeof adapter.provider & {
  send(method: string, params: unknown[]): Promise<unknown>;
};

const authenticate = async (
  blockNumber: number,
  transactionHash: string,
): Promise<number> => {
  const authenticated = await readAuthenticatedReceiptRange(
    (method, params) => provider.send(method, [...params]),
    blockNumber,
    blockNumber,
    [depositoryAddress, entityProviderAddress, tokenAddress],
    isTron ? { commitment: 'tron-complete-receipts' } : { commitment: 'ethereum-trie' },
  );
  if (!authenticated.logs.some((log) => log.transactionHash === transactionHash.toLowerCase())) {
    throw new Error(`PUBLIC_SMOKE_AUTHENTICATED_RECEIPT_MISSING:${transactionHash}`);
  }
  return authenticated.logs.length;
};

try {
  const registry = await adapter.getTokenRegistry();
  const registered = registry.find((entry) => entry.tokenId === 1);
  if (!registered || registered.address.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`PUBLIC_SMOKE_USDT_REGISTRY_MISMATCH:${jurisdictionId}`);
  }
  const configuredDelay = Number(configuredDisputeDelayBlocks);
  const onchainDelay = Number(await adapter.depository.defaultDisputeDelay());
  if (!Number.isSafeInteger(configuredDelay) || configuredDelay !== onchainDelay) {
    throw new Error(`PUBLIC_SMOKE_DISPUTE_DELAY_MISMATCH:${configuredDelay}:${onchainDelay}`);
  }

  const reserveBefore = await adapter.getReserves(foundationEntityId, 1);
  const tokenBefore = await adapter.getErc20Balance(tokenAddress, walletAddress);
  const depositEvents = await adapter.externalTokenToReserve(
    keyBytes,
    foundationEntityId,
    tokenAddress,
    depositAmount,
    { internalTokenId: 1 },
  );
  const depositEvent = depositEvents.find((event) => event.name === 'ReserveUpdated');
  if (!depositEvent) throw new Error('PUBLIC_SMOKE_DEPOSIT_EVENT_MISSING');
  const reserveAfterDeposit = await adapter.getReserves(foundationEntityId, 1);
  const tokenAfterDeposit = await adapter.getErc20Balance(tokenAddress, walletAddress);
  if (reserveAfterDeposit !== reserveBefore + depositAmount) {
    throw new Error(`PUBLIC_SMOKE_DEPOSIT_RESERVE_MISMATCH:${reserveBefore}:${reserveAfterDeposit}`);
  }
  if (tokenAfterDeposit !== tokenBefore - depositAmount) {
    throw new Error(`PUBLIC_SMOKE_DEPOSIT_TOKEN_MISMATCH:${tokenBefore}:${tokenAfterDeposit}`);
  }
  const depositAuthenticatedLogs = await authenticate(
    depositEvent.blockNumber,
    depositEvent.transactionHash,
  );

  const batch = createEmptyBatch();
  batch.reserveToExternalToken.push({
    receivingEntity: ethers.zeroPadValue(walletAddress, 32),
    tokenId: 1,
    amount: withdrawAmount,
  });
  const currentNonce = await adapter.getEntityNonce(foundationEntityId);
  const signed = prepareSignedBatch(
    batch,
    foundationEntityId,
    keyBytes,
    BigInt(chainId),
    depositoryAddress,
    currentNonce,
  );
  const withdrawal = await adapter.processBatch(
    signed.encodedBatch,
    signed.hankoData,
    signed.nextNonce,
  );
  const reserveAfterWithdrawal = await adapter.getReserves(foundationEntityId, 1);
  const tokenAfterWithdrawal = await adapter.getErc20Balance(tokenAddress, walletAddress);
  if (reserveAfterWithdrawal !== reserveAfterDeposit - withdrawAmount) {
    throw new Error(
      `PUBLIC_SMOKE_WITHDRAW_RESERVE_MISMATCH:${reserveAfterDeposit}:${reserveAfterWithdrawal}`,
    );
  }
  if (tokenAfterWithdrawal !== tokenAfterDeposit + withdrawAmount) {
    throw new Error(
      `PUBLIC_SMOKE_WITHDRAW_TOKEN_MISMATCH:${tokenAfterDeposit}:${tokenAfterWithdrawal}`,
    );
  }
  const withdrawalAuthenticatedLogs = await authenticate(
    withdrawal.blockNumber,
    withdrawal.txHash,
  );

  console.log(JSON.stringify({
    kind: 'PUBLIC_JURISDICTION_SMOKE',
    jurisdictionId,
    chainId,
    foundationEntityId,
    tokenId: 1,
    depositAmount: depositAmount.toString(),
    withdrawAmount: withdrawAmount.toString(),
    reserveBefore: reserveBefore.toString(),
    reserveAfterDeposit: reserveAfterDeposit.toString(),
    reserveAfterWithdrawal: reserveAfterWithdrawal.toString(),
    depositTransactionHash: depositEvent.transactionHash,
    withdrawalTransactionHash: withdrawal.txHash,
    depositAuthenticatedLogs,
    withdrawalAuthenticatedLogs,
    defaultDisputeDelayBlocks: onchainDelay,
  }));
} finally {
  await adapter.close();
}
