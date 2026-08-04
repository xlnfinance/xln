import type {
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/runtime/api/public/runtime-module';

import { createExternalStore } from '../../../../../packages/client-core/external-store';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import {
  runtimeAdapterExternalStore,
  runtimeAdapterHeightExternalStore,
  runtimeControllerHandleExternalStore,
} from '$lib/stores/runtimeControllerStore';
import { xlnInstanceExternalStore } from '$lib/stores/xlnRuntimeLoader';
import {
  projectWalletAccountFrame,
  type WalletEntityAccountsView,
} from './account-view-model';

export type WalletDirectoryEntity = Readonly<{
  entityId: string;
  runtimeId: string;
  signerId: string | null;
  label: string;
  height: number;
  isHub: boolean;
  jurisdiction: string | null;
  jurisdictionRef: string | null;
}>;

export type WalletAccountStoreSnapshot = Readonly<{
  loading: boolean;
  error: string | null;
  requestedEntityId: string | null;
  frameHeight: number;
  directory: readonly WalletDirectoryEntity[];
  entity: WalletEntityAccountsView | null;
}>;

const initialSnapshot: WalletAccountStoreSnapshot = Object.freeze({
  loading: true,
  error: null,
  requestedEntityId: null,
  frameHeight: 0,
  directory: Object.freeze([]),
  entity: null,
});

const binding = createExternalStore(initialSnapshot);
export const walletAccountExternalStore = binding.store;

let requestedEntityId: string | null = null;
let refreshVersion = 0;

const normalizeEntityId = (value: unknown): string | null => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const directoryEntity = (summary: RuntimeAdapterEntitySummary): WalletDirectoryEntity => Object.freeze({
  entityId: String(summary.entityId || '').trim().toLowerCase(),
  runtimeId: String(summary.runtimeId || '').trim().toLowerCase(),
  signerId: String(summary.signerId || '').trim().toLowerCase() || null,
  label: String(summary.label || summary.entityId || 'Unknown entity').trim(),
  height: Math.max(0, Math.floor(Number(summary.height || 0))),
  isHub: summary.isHub === true,
  jurisdiction: summary.jurisdiction?.name ? String(summary.jurisdiction.name) : null,
  jurisdictionRef: getJurisdictionStackId(summary.jurisdiction) || null,
});

const sortDirectory = (summaries: RuntimeAdapterEntitySummary[]): readonly WalletDirectoryEntity[] =>
  Object.freeze(summaries
    .map(directoryEntity)
    .filter(entity => entity.entityId)
    .toSorted((left, right) => {
      if (left.isHub !== right.isHub) return left.isHub ? -1 : 1;
      if (left.height !== right.height) return right.height - left.height;
      return left.entityId.localeCompare(right.entityId);
    }));

const projectionDeps = () => {
  const runtime = xlnInstanceExternalStore.getSnapshot();
  if (!runtime) throw new Error('WALLET_ACCOUNT_RUNTIME_API_NOT_READY');
  return {
    deriveDelta: runtime.deriveDelta,
    getTokenMeta: (tokenId: number) => {
      const info = runtime.getTokenInfo(tokenId);
      const decimals = Number(info.decimals);
      if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new Error(`WALLET_ACCOUNT_TOKEN_DECIMALS_INVALID:${tokenId}`);
      }
      return { symbol: String(info.symbol || `token:${tokenId}`), decimals };
    },
    getKnownTokenIds: runtime.getKnownTokenIds,
    crossJRiskEvidenceComplete: runtimeControllerHandleExternalStore.getSnapshot().mode === 'embedded',
  };
};

const readFrame = (entityId: string | null): Promise<RuntimeAdapterViewFrame> =>
  runtimeQueryClient.readViewFrame({
    ...(entityId ? { entityId } : {}),
    accountsLimit: 100,
    booksLimit: 1,
  });

const refresh = async (): Promise<void> => {
  const version = ++refreshVersion;
  const handle = runtimeControllerHandleExternalStore.getSnapshot();
  if (handle.status !== 'connected') {
    binding.controller.update(snapshot => Object.freeze({
      ...snapshot,
      loading: true,
      error: null,
      requestedEntityId,
      frameHeight: handle.height,
    }));
    return;
  }
  binding.controller.update(snapshot => Object.freeze({
    ...snapshot,
    loading: true,
    error: null,
    requestedEntityId,
  }));
  try {
    const [summaries, frame] = await Promise.all([
      runtimeQueryClient.readEntities({ limit: 5000 }),
      readFrame(requestedEntityId),
    ]);
    if (version !== refreshVersion) return;
    binding.controller.set(Object.freeze({
      loading: false,
      error: null,
      requestedEntityId,
      frameHeight: Math.max(0, Math.floor(Number(frame.height || handle.height || 0))),
      directory: sortDirectory(summaries),
      entity: projectWalletAccountFrame(frame, projectionDeps()),
    }));
  } catch (error) {
    if (version !== refreshVersion) return;
    binding.controller.update(snapshot => Object.freeze({
      ...snapshot,
      loading: false,
      error: error instanceof Error ? error.message : String(error || 'Wallet account projection failed'),
      requestedEntityId,
      frameHeight: handle.height,
      entity: null,
    }));
  }
};

const selectEntity = async (entityId: string | null): Promise<void> => {
  requestedEntityId = normalizeEntityId(entityId);
  await refresh();
};

export const walletAccountStoreController = Object.freeze({
  refresh,
  selectEntity,
  showActiveEntity: (): Promise<void> => selectEntity(null),
});

runtimeAdapterExternalStore.subscribe(() => void refresh());
runtimeAdapterHeightExternalStore.subscribe(() => void refresh());
xlnInstanceExternalStore.subscribe(() => void refresh());
