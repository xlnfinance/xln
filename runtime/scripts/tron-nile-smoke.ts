import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJAdapter } from '../jadapter';
import { readAuthenticatedReceiptRange } from '../jadapter/receipt-reader';

const depositArgument = process.argv.slice(2).find((arg) => arg.startsWith('--deposit-usdt='));
const depositAmount = depositArgument ? BigInt(depositArgument.slice('--deposit-usdt='.length)) : 0n;
const privateKey = process.env['TRON_NILE_PRIVATE_KEY'] || '';
if (depositAmount < 0n) throw new Error('TRON_NILE_DEPOSIT_AMOUNT_NEGATIVE');
if (depositAmount > 0n && !privateKey) {
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
  if (depositAmount === 0n) {
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
  const before = await adapter.getReserves(foundationEntityId, 1);
  const events = await adapter.externalTokenToReserve(
    Uint8Array.from(Buffer.from(privateKey.replace(/^0x/, ''), 'hex')),
    foundationEntityId,
    usdt.address,
    depositAmount,
    { internalTokenId: 1 },
  );
  const reserveEvent = events.find((event) => event.name === 'ReserveUpdated');
  if (!reserveEvent) throw new Error('TRON_NILE_RESERVE_UPDATED_MISSING');
  const after = await adapter.getReserves(foundationEntityId, 1);
  if (after !== before + depositAmount) {
    throw new Error(`TRON_NILE_RESERVE_DELTA_MISMATCH:before=${before}:after=${after}:amount=${depositAmount}`);
  }

  const deadline = Date.now() + 180_000;
  while (await getSolidifiedBlockNumber() < reserveEvent.blockNumber) {
    if (Date.now() >= deadline) throw new Error(`TRON_NILE_SOLIDIFICATION_TIMEOUT:${reserveEvent.blockNumber}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const authenticated = await readAuthenticatedReceiptRange(
    (method, params) => rpcProvider.send(method, [...params]),
    reserveEvent.blockNumber,
    reserveEvent.blockNumber,
    [contracts['depository'], usdt.address],
    { commitment: 'tron-complete-receipts' },
  );
  if (!authenticated.logs.some((log) => log.transactionHash === reserveEvent.transactionHash.toLowerCase())) {
    throw new Error(`TRON_NILE_AUTHENTICATED_RECEIPT_MISSING:${reserveEvent.transactionHash}`);
  }
  console.log(JSON.stringify({
    kind: 'TRON_NILE_DEPOSIT_SMOKE',
    amount: depositAmount.toString(),
    before: before.toString(),
    after: after.toString(),
    blockNumber: reserveEvent.blockNumber,
    transactionHash: reserveEvent.transactionHash,
    authenticatedLogs: authenticated.logs.length,
    defaultDisputeDelayBlocks: onchainDelay,
  }));
} finally {
  await adapter.provider.destroy();
}
