import type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
} from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import { RuntimeQueryClient } from '../../../packages/runtime-client/src/runtime-query-client';
import type { WalletPortfolioMath } from './wallet-portfolio-model';

export type WalletRuntimeReadDependencies = Readonly<{
  adapter: RuntimeAdapter;
  math: WalletPortfolioMath;
}>;

export const walletRuntimeReadErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Runtime projection read failed');

const remoteRuntimeConfig = (
  snapshot: RuntimeAdapterStorageSnapshot,
): RuntimeAdapterConfig => {
  const wsUrl = String(snapshot.wsUrl || '').trim();
  if (!wsUrl) throw new Error('Remote Runtime endpoint is missing.');
  const authKey = String(snapshot.sessionKey || '').trim();
  return {
    mode: 'remote',
    wsUrl,
    ...(authKey ? { authKey } : {}),
  };
};

export const loadWalletRuntimeReadDependencies = async (
  config: RuntimeAdapterStorageSnapshot,
): Promise<WalletRuntimeReadDependencies> => {
  // Install the canonical browser process surface before loading any protocol
  // module that reads it during module initialization.
  await import('../../../../core/support/process/runtime-process.ts');
  const [remote, account, financial] = await Promise.all([
    import('../../../../core/api/runtime-adapter/remote.ts'),
    import('../../../../core/account/utils.ts'),
    import('../../../../core/account/financial-utils.ts'),
  ]);
  const adapter = new remote.RemoteRuntimeAdapter();
  try {
    await adapter.connect(remoteRuntimeConfig(config));
  } catch (error: unknown) {
    adapter.disconnect();
    throw error;
  }
  return {
    adapter,
    math: {
      deriveDelta: (delta, isLeft) => account.deriveDelta(delta, isLeft),
      formatTokenAmount: financial.formatTokenAmount,
      getTokenInfo: account.getTokenInfo,
      isLeftEntity: account.isLeftEntity,
    },
  };
};

export const createWalletRuntimeQueryClient = (
  adapter: RuntimeAdapter,
): RuntimeQueryClient<RuntimeAdapterReadQuery> => new RuntimeQueryClient({
  resolveAdapter: () => adapter,
  readRuntimeId: () => adapter.runtimeId,
  readCurrentHeight: () => adapter.currentHeight,
  createEmptyQuery: () => ({}),
});
