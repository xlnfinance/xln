import type { FaucetApiResult } from '$lib/components/Entity/account-faucet';
import { readJsonResponse } from '$lib/components/Entity/account-faucet';

export type WalletTestAssetTarget = 'external' | 'reserve' | 'account';

export type WalletTestAssetRequest = Readonly<{
  apiBase: string;
  target: WalletTestAssetTarget;
  entityId: string;
  runtimeId: string;
  owner: string;
  counterpartyId: string | null;
  tokenId: number | null;
  symbol: string;
  amount: string;
}>;

const requestPath = (request: WalletTestAssetRequest): string => {
  if (request.target === 'account') return '/api/faucet/offchain';
  if (request.target === 'reserve') return '/api/faucet/reserve';
  return request.symbol === 'ETH' ? '/api/faucet/gas' : '/api/faucet/erc20';
};

const requestBody = (request: WalletTestAssetRequest): Record<string, unknown> => {
  if (request.target === 'account') return {
    userEntityId: request.entityId,
    userRuntimeId: request.runtimeId,
    hubEntityId: request.counterpartyId,
    tokenId: request.tokenId,
    amount: request.amount,
  };
  if (request.target === 'reserve') return {
    userEntityId: request.entityId,
    tokenId: request.tokenId,
    tokenSymbol: request.symbol,
    amount: request.amount,
  };
  return request.symbol === 'ETH'
    ? { userAddress: request.owner, amount: request.amount }
    : { userAddress: request.owner, tokenSymbol: request.symbol, amount: request.amount };
};

const validateRequest = (request: WalletTestAssetRequest): void => {
  if (!request.entityId || !request.runtimeId || !request.owner) throw new Error('WALLET_FAUCET_OWNER_CONTEXT_MISSING');
  if (!request.symbol || !request.amount) throw new Error('WALLET_FAUCET_ASSET_MISSING');
  if (request.target !== 'external' && (!request.tokenId || request.tokenId <= 0)) {
    throw new Error('WALLET_FAUCET_REGISTERED_TOKEN_REQUIRED');
  }
  if (request.target === 'account' && !request.counterpartyId) {
    throw new Error('WALLET_FAUCET_ACCOUNT_REQUIRED');
  }
};

export const requestWalletTestAsset = async (
  request: WalletTestAssetRequest,
  fetcher: typeof fetch = fetch,
): Promise<FaucetApiResult> => {
  validateRequest(request);
  const response = await fetcher(`${request.apiBase}${requestPath(request)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(request)),
  });
  const result = await readJsonResponse<FaucetApiResult>(response);
  if (!response.ok || !result?.success) {
    throw new Error(result?.error || `WALLET_FAUCET_REJECTED:${response.status}`);
  }
  return Object.freeze(result);
};
