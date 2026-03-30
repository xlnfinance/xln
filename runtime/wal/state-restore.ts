import { isLeftEntity } from '../entity-id-utils';
import { validateEntityOrderbooks } from '../orderbook/validity';
import { rebuildOrderbookPairIndex } from '../orderbook/types';
import type { OrderbookExtState } from '../orderbook/types';
import type { Env, EntityReplica, EntityState, EnvSnapshot, JReplica, RuntimeInput } from '../types';
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
    const rawOrderbookExt = replica.state?.orderbookExt as Record<string, unknown> | undefined;
    if (rawOrderbookExt && typeof rawOrderbookExt === 'object') {
      const normalizeNestedMap = <TValue>(value: unknown): Map<string, TValue> => {
        if (value instanceof Map) return value as Map<string, TValue>;
        if (Array.isArray(value)) {
          if (value.length === 0) return new Map();
          if (!isEntryArray(value)) throw new Error('Invalid orderbookExt map entry format in snapshot');
          return new Map(value as Array<[string, TValue]>);
        }
        if (value && typeof value === 'object') {
          return new Map(Object.entries(value as Record<string, TValue>));
        }
        return new Map();
      };
      const orderbookExt = rawOrderbookExt as OrderbookExtState;
      orderbookExt.books = normalizeNestedMap(orderbookExt.books);
      orderbookExt.referrals = normalizeNestedMap(orderbookExt.referrals);
      orderbookExt.orderPairs = normalizeNestedMap<string[]>(orderbookExt.orderPairs);
      rebuildOrderbookPairIndex(orderbookExt);
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

const shouldVerifyEntityOrderbooksOnRestore = (): boolean =>
  /^(1|true)$/i.test(String(process.env.XLN_ORDERBOOK_VERIFY_ON_RESTORE || '').trim());

const verifyEntityOrderbooksOnRestore = (state: unknown, label: string): void => {
  if (!shouldVerifyEntityOrderbooksOnRestore()) return;
  const report = validateEntityOrderbooks(state as EntityState);
  if (report.ok) return;
  const structureIssues = Object.entries(report.structure)
    .filter(([, value]) => !value.ok)
    .map(([pairId, value]) => `${pairId}:${value.errors.join('|')}`);
  const mediumIssues = [
    ...report.medium.invalidOffers.map((value) => `invalid:${value.swapKey}:${value.reason}`),
    ...report.medium.missingInBook.map((value) => `missing:${value}`),
    ...report.medium.orphanedInBook.map((value) => `orphaned:${value}`),
    ...report.medium.mismatched.map((value) => `mismatch:${value.swapKey}:${value.field}`),
  ];
  const issues = [...structureIssues, ...mediumIssues];
  throw new Error(
    `${label} ORDERBOOK_VERIFY_ON_RESTORE_FAILED: ${issues.slice(0, 20).join(', ') || 'unknown'}`,
  );
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
  ) => EnvSnapshot;
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
  verifyEntityOrderbooksOnRestore,
  rebuildEntityLockBookFromAccounts,
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
