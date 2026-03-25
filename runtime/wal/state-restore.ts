import { isLeftEntity } from '../entity-id-utils';
import { collectOpenSwapOffersForOrderbook, processOrderbookSwaps } from '../entity-tx/handlers/account';
import { createOrderbookExtState } from '../orderbook';
import type { Env, EntityReplica, EntityState, JReplica, RuntimeInput } from '../types';
import type { FrameLogEntry } from '../types';
import {
  loadRuntimeEnvFromWal,
  verifyRuntimeChainFromWal,
  type LoadRuntimeEnvFromWalOptions,
  type VerifyRuntimeChainResult,
} from './runtime';
import { normalizePersistedSnapshotInPlace } from './snapshot';

const isEntryArray = (value: unknown): value is Array<[unknown, unknown]> =>
  Array.isArray(value) && value.length > 0 && Array.isArray(value[0]) && value[0].length === 2;

const normalizeContractAddress = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const maybeAddress = (value as { address?: unknown }).address;
    if (typeof maybeAddress === 'string') return maybeAddress;
    if (typeof (value as { toString?: () => string }).toString === 'function') {
      return (value as { toString: () => string }).toString();
    }
  }
  return undefined;
};

const normalizeReplicaMap = (raw: unknown): Map<string, EntityReplica> => {
  let map: Map<string, EntityReplica>;
  if (raw instanceof Map) {
    map = raw as Map<string, EntityReplica>;
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) return new Map();
    if (!isEntryArray(raw)) {
      throw new Error('Invalid eReplicas array format in snapshot');
    }
    map = new Map(raw as Array<[string, EntityReplica]>);
  } else if (raw && typeof raw === 'object') {
    map = new Map(Object.entries(raw as Record<string, EntityReplica>));
  } else {
    throw new Error('Invalid eReplicas format in snapshot');
  }

  for (const [key, replica] of map.entries()) {
    if (!replica || typeof replica !== 'object') continue;
    const [entityIdFromKey, signerIdFromKey] = String(key).split(':');
    if (!replica.entityId && entityIdFromKey) {
      (replica as EntityReplica).entityId = entityIdFromKey;
    }
    if (!replica.signerId && signerIdFromKey) {
      (replica as EntityReplica).signerId = signerIdFromKey;
    }
    const accounts = replica.state?.accounts;
    const normalizeAccountPendingSignatures = (account: unknown): void => {
      if (!account || typeof account !== 'object') return;
      if (!Array.isArray((account as { pendingSignatures?: unknown }).pendingSignatures)) {
        (account as { pendingSignatures: string[] }).pendingSignatures = [];
      }
    };
    if (accounts instanceof Map) {
      for (const [, account] of accounts.entries()) {
        normalizeAccountPendingSignatures(account);
      }
    } else if (Array.isArray(accounts)) {
      for (const entry of accounts) {
        if (Array.isArray(entry) && entry.length >= 2) {
          normalizeAccountPendingSignatures(entry[1]);
        }
      }
    } else if (accounts && typeof accounts === 'object') {
      for (const account of Object.values(accounts as Record<string, unknown>)) {
        normalizeAccountPendingSignatures(account);
      }
    }
    map.set(key, replica);
  }
  return map;
};

const normalizeJReplica = (jr: JReplica): JReplica => {
  const depository = normalizeContractAddress(
    jr.contracts?.depository ?? (jr.contracts as { depositoryAddress?: unknown } | undefined)?.depositoryAddress,
  );
  const entityProvider = normalizeContractAddress(
    jr.contracts?.entityProvider ?? (jr.contracts as { entityProviderAddress?: unknown } | undefined)?.entityProviderAddress,
  );
  const account = normalizeContractAddress(jr.contracts?.account);
  const deltaTransformer = normalizeContractAddress(jr.contracts?.deltaTransformer);

  const { jadapter: _dropJAdapter, ...rest } = jr as JReplica & { jadapter?: unknown };
  return {
    ...rest,
    ...(depository ? { depositoryAddress: depository } : {}),
    ...(entityProvider ? { entityProviderAddress: entityProvider } : {}),
    contracts: {
      ...jr.contracts,
      ...(depository ? { depository } : {}),
      ...(entityProvider ? { entityProvider } : {}),
      ...(account ? { account } : {}),
      ...(deltaTransformer ? { deltaTransformer } : {}),
    },
  };
};

const normalizeJReplicaMap = (raw: unknown): Map<string, JReplica> => {
  if (raw instanceof Map) {
    const map = raw as Map<string, JReplica>;
    for (const [name, jr] of map.entries()) {
      map.set(name, normalizeJReplica(jr));
    }
    return map;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return new Map();
    if (isEntryArray(raw)) {
      const map = new Map(raw as Array<[string, JReplica]>);
      for (const [name, jr] of map.entries()) {
        map.set(name, normalizeJReplica(jr));
      }
      return map;
    }
    const first = raw[0] as { name?: unknown } | undefined;
    if (first && typeof first === 'object' && typeof first.name === 'string') {
      return new Map((raw as JReplica[]).map((jr) => [jr.name, normalizeJReplica(jr)]));
    }
  }
  if (raw && typeof raw === 'object') {
    const map = new Map(Object.entries(raw as Record<string, JReplica>));
    for (const [name, jr] of map.entries()) {
      map.set(name, normalizeJReplica(jr));
    }
    return map;
  }
  return new Map();
};

const rebuildEntitySwapBookFromAccounts = (env: Env): void => {
  for (const replica of env.eReplicas.values()) {
    const rebuiltSwapBook = new Map<string, Record<string, unknown>>();
    for (const [accountId, account] of replica.state.accounts.entries()) {
      if (!(account?.swapOffers instanceof Map)) continue;
      for (const [offerId, offer] of account.swapOffers.entries()) {
        const swapBookKey = `${String(accountId)}:${String(offerId)}`;
        rebuiltSwapBook.set(swapBookKey, {
          ...(offer as Record<string, unknown>),
          offerId: String((offer as { offerId?: unknown })?.offerId || offerId || ''),
          accountId: String(accountId),
        });
      }
    }
    replica.state.swapBook = rebuiltSwapBook as typeof replica.state.swapBook;
  }
};

const rebuildEntityLockBookFromAccounts = (env: Env): void => {
  for (const replica of env.eReplicas.values()) {
    const rebuiltLockBook = new Map<string, Record<string, unknown>>();
    for (const [accountId, account] of replica.state.accounts.entries()) {
      if (!(account?.locks instanceof Map)) continue;
      const iAmLeft = replica.entityId === account.leftEntity;
      for (const [lockId, lock] of account.locks.entries()) {
        const direction =
          (lock.senderIsLeft && iAmLeft) || (!lock.senderIsLeft && !iAmLeft)
            ? 'outgoing'
            : 'incoming';
        if (direction !== 'outgoing') continue;
        rebuiltLockBook.set(lockId, {
          lockId,
          accountId: String(accountId),
          tokenId: Number(lock.tokenId),
          amount: BigInt(lock.amount),
          hashlock: String(lock.hashlock),
          timelock: BigInt(lock.timelock),
          direction,
          createdAt: BigInt(lock.createdTimestamp),
        });
      }
    }
    replica.state.lockBook = rebuiltLockBook as typeof replica.state.lockBook;
  }
};

const rebuildEntityOrderbookExtFromAccounts = (env: Env): void => {
  for (const replica of env.eReplicas.values()) {
    const snapshotExt = replica.state.orderbookExt as { hubProfile?: Record<string, unknown> } | undefined;
    if (!snapshotExt?.hubProfile) continue;

    const rebuiltExt = createOrderbookExtState(structuredClone(snapshotExt.hubProfile as never));
    replica.state.orderbookExt = rebuiltExt as typeof replica.state.orderbookExt;

    const swapOffers = collectOpenSwapOffersForOrderbook(replica.state);

    if (swapOffers.length === 0) continue;
    const result = processOrderbookSwaps(replica.state, swapOffers, { rehydrateOnly: true });
    if (result.quarantinedOffers.length > 0) {
      console.warn(
        `[ORDERBOOK-REHYDRATE] entity=${replica.entityId} quarantined ${result.quarantinedOffers.length} offers: ` +
        result.quarantinedOffers.map((offer) => `${offer.accountId}:${offer.offerId}:${offer.reason}`).join(', '),
      );
    }
    if (result.mempoolOps.length > 0) {
      console.warn(
        `[ORDERBOOK-REHYDRATE] entity=${replica.entityId} generated ${result.mempoolOps.length} stale ops; ` +
        `quarantined during restore`,
      );
    }
    for (const update of result.bookUpdates) {
      rebuiltExt.books.set(update.pairId, update.book);
    }
  }
};

type BuildRuntimeReplayDepsOptions = {
  createEmptyEnv: (seed?: Uint8Array | string | null) => Env;
  deriveRuntimeIdFromSeed: (seed: string) => string;
  assertPersistedContractConfigReady: (env: Env, label: string) => void;
  validateEntityState: (state: EntityState | unknown, label: string) => void;
  buildCanonicalEnvSnapshot: (
    env: Env,
    options: {
      runtimeInput: RuntimeInput;
      runtimeOutputs: unknown[];
      description: string;
      meta: Record<string, unknown>;
      logs: FrameLogEntry[] | undefined;
      gossipProfiles: unknown[];
    },
  ) => unknown;
  ensureRuntimeState: (env: Env) => { db?: unknown; dbOpenPromise?: unknown };
  applyRuntimeInput: (env: Env, input: RuntimeInput) => Promise<void>;
  normalizeEntitySwapTradingPairs: (state: unknown) => void;
  isDbNotFound: (error: unknown) => boolean;
  replayModeKey: symbol;
  applyAllowedKey: symbol;
};

const createRuntimeReplayDeps = (options: BuildRuntimeReplayDepsOptions) => ({
  normalizeSnapshotInPlace: (snapshot: unknown) =>
    normalizePersistedSnapshotInPlace(snapshot, {
      normalizeReplicaMap,
      normalizeJReplicaMap,
    }),
  createEmptyEnv: options.createEmptyEnv,
  deriveRuntimeIdFromSeed: options.deriveRuntimeIdFromSeed,
  normalizeReplicaMap,
  normalizeJReplicaMap,
  assertPersistedContractConfigReady: options.assertPersistedContractConfigReady,
  validateEntityState: options.validateEntityState,
  rebuildEntitySwapBookFromAccounts,
  rebuildEntityLockBookFromAccounts,
  rebuildEntityOrderbookExtFromAccounts,
  buildCanonicalEnvSnapshot: options.buildCanonicalEnvSnapshot,
  ensureRuntimeState: options.ensureRuntimeState,
  applyRuntimeInput: options.applyRuntimeInput,
  normalizeEntitySwapTradingPairs: options.normalizeEntitySwapTradingPairs,
  isDbNotFound: options.isDbNotFound,
  replayModeKey: options.replayModeKey,
  applyAllowedKey: options.applyAllowedKey,
});

type RuntimeStateRestoreOptions = Omit<LoadRuntimeEnvFromWalOptions, 'replayDeps'> & BuildRuntimeReplayDepsOptions;

export const loadRuntimeStateFromDb = async (options: RuntimeStateRestoreOptions): Promise<Env | null> => {
  return loadRuntimeEnvFromWal({
    runtimeId: options.runtimeId,
    runtimeSeed: options.runtimeSeed,
    fromSnapshotHeight: options.fromSnapshotHeight,
    persistenceSchemaVersion: options.persistenceSchemaVersion,
    createEmptyEnv: options.createEmptyEnv,
    tryOpenDb: options.tryOpenDb,
    getRuntimeDb: options.getRuntimeDb,
    resolveDbNamespace: options.resolveDbNamespace,
    isDbNotFound: options.isDbNotFound,
    replayDeps: createRuntimeReplayDeps(options),
  });
};

export const verifyPersistedRuntimeState = async (
  options: RuntimeStateRestoreOptions,
): Promise<VerifyRuntimeChainResult> => {
  return verifyRuntimeChainFromWal({
    runtimeId: options.runtimeId,
    runtimeSeed: options.runtimeSeed,
    fromSnapshotHeight: options.fromSnapshotHeight,
    persistenceSchemaVersion: options.persistenceSchemaVersion,
    createEmptyEnv: options.createEmptyEnv,
    tryOpenDb: options.tryOpenDb,
    getRuntimeDb: options.getRuntimeDb,
    resolveDbNamespace: options.resolveDbNamespace,
    isDbNotFound: options.isDbNotFound,
    replayDeps: createRuntimeReplayDeps(options),
  });
};
