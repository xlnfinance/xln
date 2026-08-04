import { ZeroAddress } from 'ethers';

import { createExternalStore } from '../../../../../packages/client-core/external-store';
import { formatTokenAmount } from '$lib/components/Entity/entity-asset-values';
import {
  buildExternalTokenCatalogFromRegistry,
  requestExternalWalletSnapshot,
} from '$lib/components/Entity/external-wallet-reader';
import { resolveConfiguredApiBase } from '$lib/stores/xlnStore';
import { runtimeAdapterHeightExternalStore } from '$lib/stores/runtimeControllerStore';
import type { WalletEntityAccountsView } from './account-view-model';
import { readWalletExternalActionContext } from './wallet-external-actions';

export type WalletExternalTokenView = Readonly<{
  symbol: string;
  address: string;
  decimals: number;
  tokenId: number | null;
  balanceRaw: string;
  balance: string;
  allowanceRaw: string | null;
}>;

export type WalletExternalSnapshot = Readonly<{
  loading: boolean;
  error: string | null;
  entityId: string | null;
  owner: string | null;
  spender: string | null;
  sourceHeight: number | null;
  tokens: readonly WalletExternalTokenView[];
}>;

const initialSnapshot: WalletExternalSnapshot = Object.freeze({
  loading: false,
  error: null,
  entityId: null,
  owner: null,
  spender: null,
  sourceHeight: null,
  tokens: Object.freeze([]),
});

const binding = createExternalStore(initialSnapshot);
export const walletExternalStore = binding.store;

let selectedEntity: WalletEntityAccountsView | null = null;
let refreshVersion = 0;

const refresh = async (): Promise<void> => {
  const version = ++refreshVersion;
  const entity = selectedEntity;
  if (!entity) {
    binding.controller.set(initialSnapshot);
    return;
  }
  binding.controller.update(state => Object.freeze({ ...state, loading: true, error: null, entityId: entity.entityId }));
  try {
    const context = await readWalletExternalActionContext(entity);
    const registry = await context.jadapter.getTokenRegistry();
    const tokens = buildExternalTokenCatalogFromRegistry(registry);
    if (tokens.length === 0) throw new Error('WALLET_EXTERNAL_TOKEN_CATALOG_EMPTY');
    const allowanceTokens = tokens.filter(token => token.address !== ZeroAddress);
    const snapshot = await requestExternalWalletSnapshot(
      resolveConfiguredApiBase(window.location.origin),
      entity.entityId,
      context.owner,
      tokens,
      allowanceTokens.map(token => ({ tokenAddress: token.address, spender: context.spender })),
      context.jadapter,
    );
    if (!snapshot) throw new Error('WALLET_EXTERNAL_SNAPSHOT_UNAVAILABLE');
    if (snapshot.tokenErrors?.length) {
      throw new Error(`WALLET_EXTERNAL_TOKEN_READ_FAILED:${snapshot.tokenErrors.map(item => `${item.tokenAddress}:${item.error}`).join('|')}`);
    }
    if (snapshot.allowanceErrors?.length) {
      throw new Error(`WALLET_EXTERNAL_ALLOWANCE_READ_FAILED:${snapshot.allowanceErrors.map(item => `${item.tokenAddress}:${item.spender}:${item.error}`).join('|')}`);
    }
    if (version !== refreshVersion) return;
    let allowanceIndex = 0;
    const projected = tokens.map((token, index) => {
      const allowance = token.address === ZeroAddress ? null : snapshot.allowanceValues[allowanceIndex++] ?? null;
      const balance = snapshot.balances[index];
      if (typeof balance !== 'bigint') throw new Error(`WALLET_EXTERNAL_BALANCE_MISSING:${token.address}`);
      return Object.freeze({
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        tokenId: typeof token.tokenId === 'number' && token.tokenId > 0 ? token.tokenId : null,
        balanceRaw: balance.toString(),
        balance: formatTokenAmount(balance, token.decimals, 4),
        allowanceRaw: allowance?.toString() ?? null,
      });
    });
    binding.controller.set(Object.freeze({
      loading: false,
      error: null,
      entityId: entity.entityId,
      owner: context.owner,
      spender: context.spender,
      sourceHeight: snapshot.sourceHeight ?? null,
      tokens: Object.freeze(projected),
    }));
  } catch (error) {
    if (version !== refreshVersion) return;
    binding.controller.update(state => Object.freeze({
      ...state,
      loading: false,
      error: error instanceof Error ? error.message : String(error || 'External wallet projection failed'),
      tokens: Object.freeze([]),
    }));
  }
};

const selectEntity = async (entity: WalletEntityAccountsView): Promise<void> => {
  selectedEntity = entity;
  await refresh();
};

export const walletExternalStoreController = Object.freeze({ refresh, selectEntity });

runtimeAdapterHeightExternalStore.subscribe(() => {
  if (selectedEntity) void refresh();
});
