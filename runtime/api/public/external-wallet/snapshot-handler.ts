import { ethers } from 'ethers';
import type { ExternalWalletApiContext } from './context';
import {
  assertSnapshotArrayLength,
  createJsonResponse,
  externalWalletLog,
  readExternalWalletSnapshotSource,
  readWalletSnapshotBody,
  requireSnapshotBigInt,
} from './http';

const buildTokenBalances = (
  tokenAddresses: string[],
  tokenCatalog: Awaited<ReturnType<ExternalWalletApiContext['getTokenCatalog']>>,
  balances: bigint[],
  errors: Array<{ tokenAddress: string; error: string }>,
) => {
  const tokenIdByAddress = new Map(
    tokenCatalog
      .filter(token => ethers.isAddress(token.address))
      .map(token => [token.address.toLowerCase(), token.tokenId]),
  );
  const errorByAddress = new Map(errors.map(entry => [entry.tokenAddress.trim().toLowerCase(), entry.error]));
  return tokenAddresses.map((address, index) => {
    const tokenAddress = ethers.getAddress(address).toLowerCase();
    const tokenId = tokenIdByAddress.get(tokenAddress);
    const error = errorByAddress.get(tokenAddress);
    return {
      tokenAddress,
      ...(typeof tokenId === 'number' ? { tokenId } : {}),
      balance: requireSnapshotBigInt(balances[index], `tokenBalance:${tokenAddress}`).toString(),
      ...(error ? { error } : {}),
    };
  });
};

const buildAllowances = (
  requests: Array<{ tokenAddress: string; spender: string }>,
  allowances: bigint[],
  errors: Array<{ tokenAddress: string; spender: string; error: string }>,
) => {
  const errorByKey = new Map(
    errors.map(entry => [
      `${entry.tokenAddress.trim().toLowerCase()}:${entry.spender.trim().toLowerCase()}`,
      entry.error,
    ]),
  );
  return requests.map((request, index) => {
    const tokenAddress = ethers.getAddress(request.tokenAddress).toLowerCase();
    const spender = ethers.getAddress(request.spender).toLowerCase();
    const error = errorByKey.get(`${tokenAddress}:${spender}`);
    return {
      tokenAddress,
      spender,
      allowance: requireSnapshotBigInt(
        allowances[index],
        `allowance:${request.tokenAddress}:${request.spender}`,
      ).toString(),
      ...(error ? { error } : {}),
    };
  });
};

export const handleWalletSnapshot = async (context: ExternalWalletApiContext, request: Request): Promise<Response> => {
  try {
    const adapter = context.getJAdapter();
    if (!adapter) {
      return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
    }
    const body = await readWalletSnapshotBody(request);
    if (!body.entityId.startsWith('0x') || body.entityId.length !== 66) {
      return createJsonResponse(context.jsonHeaders, { error: 'Invalid entityId' }, 400);
    }
    if (!ethers.isAddress(body.owner)) {
      return createJsonResponse(context.jsonHeaders, { error: 'Invalid owner' }, 400);
    }
    const tokenCatalog = await context.getTokenCatalog();
    const tokenAddresses = (
      body.tokenAddresses?.length ? body.tokenAddresses : tokenCatalog.map(token => token.address)
    ).filter(ethers.isAddress);
    const allowanceRequests = body.allowances ?? [];
    const owner = ethers.getAddress(body.owner).toLowerCase();
    const source = await readExternalWalletSnapshotSource(adapter);
    const snapshot = await adapter.readWalletSnapshot({
      owner,
      tokenAddresses,
      allowances: allowanceRequests,
      includeNativeBalance: true,
      blockTag: source.sourceHeight,
    });
    assertSnapshotArrayLength(snapshot.tokenBalances, tokenAddresses.length, 'tokenBalances');
    assertSnapshotArrayLength(snapshot.allowances, allowanceRequests.length, 'allowances');
    const nativeBalance = requireSnapshotBigInt(snapshot.nativeBalance, 'nativeBalance');
    return createJsonResponse(context.jsonHeaders, {
      success: true,
      entityId: body.entityId,
      owner,
      blockNumber: source.sourceHeight,
      blockHash: source.sourceHash,
      ...source,
      transactionHash: ['external-wallet-snapshot', source.sourceHeight, body.entityId, owner].join(':'),
      nativeBalance: nativeBalance.toString(),
      tokenBalances: buildTokenBalances(
        tokenAddresses,
        tokenCatalog,
        snapshot.tokenBalances,
        snapshot.tokenErrors ?? [],
      ),
      allowances: buildAllowances(allowanceRequests, snapshot.allowances, snapshot.allowanceErrors ?? []),
      ...(snapshot.tokenErrors?.length ? { tokenErrors: snapshot.tokenErrors } : {}),
      ...(snapshot.allowanceErrors?.length ? { allowanceErrors: snapshot.allowanceErrors } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    externalWalletLog.error('snapshot.failed', { error: message });
    return createJsonResponse(context.jsonHeaders, { error: message }, 500);
  }
};
