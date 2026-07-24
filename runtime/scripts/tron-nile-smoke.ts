import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import { createJAdapter } from '../jadapter';
import { prepareSignedBatch } from '../hanko/batch';
import { createEmptyBatch } from '../jurisdiction/batch';
import { readAuthenticatedReceiptRange } from '../jadapter/receipt-reader';

const depositArgument = process.argv.slice(2).find((arg) => arg.startsWith('--deposit-usdt='));
const withdrawArgument = process.argv.slice(2).find((arg) => arg.startsWith('--withdraw-usdt='));
const depositAmount = depositArgument ? BigInt(depositArgument.slice('--deposit-usdt='.length)) : 0n;
const withdrawAmount = withdrawArgument ? BigInt(withdrawArgument.slice('--withdraw-usdt='.length)) : 0n;
const privateKey = process.env['TRON_NILE_PRIVATE_KEY'] || '';
if (depositAmount < 0n) throw new Error('TRON_NILE_DEPOSIT_AMOUNT_NEGATIVE');
if (withdrawAmount < 0n) throw new Error('TRON_NILE_WITHDRAW_AMOUNT_NEGATIVE');
if (depositAmount > 0n && withdrawAmount > 0n) {
  throw new Error('TRON_NILE_SINGLE_WRITE_MODE_REQUIRED');
}
if ((depositAmount > 0n || withdrawAmount > 0n) && !privateKey) {
  throw new Error('TRON_NILE_PRIVATE_KEY_REQUIRED_FOR_WRITE');
}

const configPath = resolve(process.cwd(), 'jurisdictions/jurisdictions.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  jurisdictions?: Record<string, {
    chainId?: number;
    rpc?: string;
    defaultDisputeDelayBlocks?: number;
    entityProviderDeploymentBlock?: number;
    contracts?: Record<string, string>;
    tokens?: Record<string, { address?: string; tokenId?: number }>;
  }>;
};
const nile = config.jurisdictions?.['tron-nile'];
if (!nile) throw new Error('TRON_NILE_JURISDICTION_MISSING');
const contracts = nile.contracts;
if (
  !contracts?.['account'] ||
  !contracts['depository'] ||
  !contracts['entityProvider'] ||
  !contracts['deltaTransformer']
) throw new Error('TRON_NILE_CONTRACTS_INCOMPLETE');
const usdt = nile.tokens?.['USDT'];
if (!usdt?.address || usdt.tokenId !== 1) throw new Error('TRON_NILE_USDT_TOKEN_1_REQUIRED');
const deploymentBlock = Number(nile.entityProviderDeploymentBlock);
if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) {
  throw new Error('TRON_NILE_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID');
}
const rpcUrl = String(nile.rpc || '');
const fullHost = rpcUrl.replace(/\/jsonrpc\/?$/i, '');
const adapter = await createJAdapter({
  mode: 'tron',
  chainId: Number(nile.chainId),
  rpcUrl,
  tronFullHost: fullHost,
  ...(privateKey ? { privateKey } : {}),
  ...(!privateKey ? { watchOnly: true } : {}),
  fromReplica: {
    contracts,
    depositoryAddress: contracts['depository'],
    entityProviderAddress: contracts['entityProvider'],
    entityProviderDeploymentBlock: deploymentBlock,
  },
});
const getSolidifiedBlockNumber = adapter.getCurrentBlockNumber;
if (!getSolidifiedBlockNumber) throw new Error('TRON_NILE_SOLIDIFIED_READER_MISSING');
const rpcProvider = adapter.provider as typeof adapter.provider & {
  send(method: string, params: unknown[]): Promise<unknown>;
};

try {
  const registry = await adapter.getTokenRegistry();
  const configuredDelay = Number(nile.defaultDisputeDelayBlocks);
  const onchainDelay = Number(await adapter.depository.defaultDisputeDelay());
  if (!Number.isSafeInteger(configuredDelay) || configuredDelay !== onchainDelay) {
    throw new Error(`TRON_NILE_DISPUTE_DELAY_MISMATCH:configured=${configuredDelay}:onchain=${onchainDelay}`);
  }
  const registeredUsdt = registry.find((token) => token.tokenId === 1);
  if (!registeredUsdt || registeredUsdt.address.toLowerCase() !== usdt.address.toLowerCase()) {
    throw new Error('TRON_NILE_USDT_REGISTRY_MISMATCH');
  }
  if (depositAmount === 0n && withdrawAmount === 0n) {
    console.log(JSON.stringify({
      kind: 'TRON_NILE_READ_SMOKE',
      chainId: adapter.chainId,
      mode: adapter.mode,
      solidifiedBlock: await getSolidifiedBlockNumber(),
      defaultDisputeDelayBlocks: onchainDelay,
      usdt: registeredUsdt,
    }));
    await adapter.provider.destroy();
    process.exit(0);
  }

  const foundationEntityId = `0x${'00'.repeat(31)}01`;
  const keyBytes = Uint8Array.from(Buffer.from(privateKey.replace(/^0x/, ''), 'hex'));
  const before = await adapter.getReserves(foundationEntityId, 1);
  let transactionHash: string;
  let blockNumber: number;
  let authenticatedAddresses: string[];
  let after: bigint;
  if (depositAmount > 0n) {
    const events = await adapter.externalTokenToReserve(
      keyBytes,
      foundationEntityId,
      usdt.address,
      depositAmount,
      { internalTokenId: 1 },
    );
    const reserveEvent = events.find((event) => event.name === 'ReserveUpdated');
    if (!reserveEvent) throw new Error('TRON_NILE_RESERVE_UPDATED_MISSING');
    after = await adapter.getReserves(foundationEntityId, 1);
    if (after !== before + depositAmount) {
      throw new Error(`TRON_NILE_RESERVE_DELTA_MISMATCH:before=${before}:after=${after}:amount=${depositAmount}`);
    }
    transactionHash = reserveEvent.transactionHash;
    blockNumber = reserveEvent.blockNumber;
    authenticatedAddresses = [contracts['depository'], usdt.address];
  } else {
    const recipient = new ethers.Wallet(privateKey).address;
    const recipientEntityId = ethers.zeroPadValue(recipient, 32);
    const tokenBefore = await adapter.getErc20Balance(usdt.address, recipient);
    const currentNonce = await adapter.getEntityNonce(foundationEntityId);
    const batch = createEmptyBatch();
    batch.reserveToExternalToken.push({
      receivingEntity: recipientEntityId,
      tokenId: 1,
      amount: withdrawAmount,
    });
    const signed = prepareSignedBatch(
      batch,
      foundationEntityId,
      keyBytes,
      BigInt(adapter.chainId),
      contracts['depository'],
      currentNonce,
    );
    const receipt = await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
    after = await adapter.getReserves(foundationEntityId, 1);
    const tokenAfter = await adapter.getErc20Balance(usdt.address, recipient);
    if (after !== before - withdrawAmount) {
      throw new Error(`TRON_NILE_WITHDRAW_RESERVE_DELTA_MISMATCH:before=${before}:after=${after}:amount=${withdrawAmount}`);
    }
    if (tokenAfter !== tokenBefore + withdrawAmount) {
      throw new Error(
        `TRON_NILE_WITHDRAW_TOKEN_DELTA_MISMATCH:before=${tokenBefore}:after=${tokenAfter}:amount=${withdrawAmount}`,
      );
    }
    transactionHash = receipt.txHash;
    blockNumber = receipt.blockNumber;
    authenticatedAddresses = [contracts['depository'], contracts['entityProvider'], usdt.address];
  }

  const deadline = Date.now() + 180_000;
  while (await getSolidifiedBlockNumber() < blockNumber) {
    if (Date.now() >= deadline) throw new Error(`TRON_NILE_SOLIDIFICATION_TIMEOUT:${blockNumber}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const authenticated = await readAuthenticatedReceiptRange(
    (method, params) => rpcProvider.send(method, [...params]),
    blockNumber,
    blockNumber,
    authenticatedAddresses,
    { commitment: 'tron-complete-receipts' },
  );
  if (!authenticated.logs.some((log) => log.transactionHash === transactionHash.toLowerCase())) {
    throw new Error(`TRON_NILE_AUTHENTICATED_RECEIPT_MISSING:${transactionHash}`);
  }
  console.log(JSON.stringify({
    kind: depositAmount > 0n ? 'TRON_NILE_DEPOSIT_SMOKE' : 'TRON_NILE_WITHDRAW_SMOKE',
    amount: (depositAmount || withdrawAmount).toString(),
    before: before.toString(),
    after: after.toString(),
    blockNumber,
    transactionHash,
    authenticatedLogs: authenticated.logs.length,
    defaultDisputeDelayBlocks: onchainDelay,
  }));
} finally {
  await adapter.provider.destroy();
}
