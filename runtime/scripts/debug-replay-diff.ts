import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  readPersistedFrameJournal,
  closeRuntimeDb,
  closeInfraDb,
  readPersistedCheckpointSnapshot,
} from '../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';
import { serializeTaggedJson } from '../serialization-utils';
import type { BrowserVMState, EntityReplica, JReplica } from '../types';

type RuntimeCheckpointSnapshot = {
  height?: number;
  timestamp?: number;
  activeJurisdiction?: string;
  eReplicas: Array<[string, EntityReplica]>;
  jReplicas: Array<[string, JReplica]>;
  browserVMState?: BrowserVMState;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const render = (value: unknown): string => serializeTaggedJson(value);

const drainBackgroundPersistence = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 50));

const readReplicaEntries = <T>(value: unknown): Array<[string, T]> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Array<[string, T]> => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return [];
    return [[entry[0], entry[1] as T]];
  });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const readBigInt = (value: unknown): bigint | undefined =>
  typeof value === 'bigint' ? value : undefined;

const readPosition = (value: unknown): JReplica['position'] => {
  const record = asRecord(value);
  return {
    x: readNumber(record['x']) ?? 0,
    y: readNumber(record['y']) ?? 0,
    z: readNumber(record['z']) ?? 0,
  };
};

const readJReplicaEntries = (value: unknown): Array<[string, JReplica]> =>
  readReplicaEntries<Partial<JReplica>>(value).map(([key, replica]) => {
    const contracts = asRecord(replica.contracts);
    const blockTimeMs = readNumber(replica.blockTimeMs);
    const defaultDisputeDelayBlocks = readNumber(replica.defaultDisputeDelayBlocks);
    const chainId = readNumber(replica.chainId);
    const depositoryAddress = readString(replica.depositoryAddress);
    const entityProviderAddress = readString(replica.entityProviderAddress);
    const depositoryContract = readString(contracts['depository']);
    const entityProviderContract = readString(contracts['entityProvider']);
    return [
      key,
      {
        name: replica.name ?? key,
        blockNumber: readBigInt(replica.blockNumber) ?? 0n,
        stateRoot: replica.stateRoot instanceof Uint8Array && replica.stateRoot.length === 32
          ? replica.stateRoot
          : null,
        mempool: Array.isArray(replica.mempool) ? replica.mempool : [],
        blockDelayMs: readNumber(replica.blockDelayMs) ?? 0,
        lastBlockTimestamp: readNumber(replica.lastBlockTimestamp) ?? 0,
        ...(blockTimeMs !== undefined ? { blockTimeMs } : {}),
        ...(defaultDisputeDelayBlocks !== undefined ? { defaultDisputeDelayBlocks } : {}),
        ...(typeof replica.blockReady === 'boolean' ? { blockReady: replica.blockReady } : {}),
        ...(Array.isArray(replica.rpcs) ? { rpcs: replica.rpcs.filter((rpc): rpc is string => typeof rpc === 'string') } : {}),
        ...(chainId !== undefined ? { chainId } : {}),
        position: readPosition(replica.position),
        ...(depositoryAddress ? { depositoryAddress } : {}),
        ...(entityProviderAddress ? { entityProviderAddress } : {}),
        ...(Object.keys(contracts).length > 0
          ? {
              contracts: {
                ...(depositoryContract ? { depository: depositoryContract } : {}),
                ...(entityProviderContract ? { entityProvider: entityProviderContract } : {}),
              },
            }
          : {}),
      },
    ];
  });

const readCheckpointSnapshot = (value: Record<string, unknown>): RuntimeCheckpointSnapshot => {
  const height = value['height'];
  const timestamp = value['timestamp'];
  const activeJurisdiction = value['activeJurisdiction'];
  const browserVMState = value['browserVMState'];
  return {
    ...(typeof height === 'number' ? { height } : {}),
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
    ...(typeof activeJurisdiction === 'string' ? { activeJurisdiction } : {}),
    eReplicas: readReplicaEntries<EntityReplica>(value['eReplicas']),
    jReplicas: readJReplicaEntries(value['jReplicas']),
    ...(browserVMState && typeof browserVMState === 'object'
      ? { browserVMState: browserVMState as BrowserVMState }
      : {}),
  };
};

const collectDiffs = (
  left: unknown,
  right: unknown,
  path = '$',
  out: string[] = [],
  limit = 200,
): string[] => {
  if (out.length >= limit) return out;
  if (render(left) === render(right)) return out;

  if (left instanceof Map && right instanceof Map) {
    const leftKeys = Array.from(left.keys()).map((key) => render(key)).sort();
    const rightKeys = Array.from(right.keys()).map((key) => render(key)).sort();
    const allKeys = Array.from(new Set([...leftKeys, ...rightKeys])).sort();
    for (const key of allKeys) {
      if (out.length >= limit) break;
      const leftEntry = Array.from(left.entries()).find(([entryKey]) => render(entryKey) === key);
      const rightEntry = Array.from(right.entries()).find(([entryKey]) => render(entryKey) === key);
      if (!leftEntry) {
        out.push(`${path}{${key}}: missing on left`);
        continue;
      }
      if (!rightEntry) {
        out.push(`${path}{${key}}: missing on right`);
        continue;
      }
      collectDiffs(leftEntry[1], rightEntry[1], `${path}{${key}}`, out, limit);
    }
    return out;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      out.push(`${path}: array length ${left.length} != ${right.length}`);
      if (out.length >= limit) return out;
    }
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max && out.length < limit; i++) {
      collectDiffs(left[i], right[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }

  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    for (const key of keys) {
      if (out.length >= limit) break;
      if (!(key in left)) {
        out.push(`${path}.${key}: missing on left`);
        continue;
      }
      if (!(key in right)) {
        out.push(`${path}.${key}: missing on right`);
        continue;
      }
      collectDiffs(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
        limit,
      );
    }
    return out;
  }

  out.push(`${path}: ${render(left)} != ${render(right)}`);
  return out;
};

async function main() {
  const seed = 'persist-cli-seed alpha beta gamma delta epsilon zeta';
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1000 };
  env.quietRuntimeLogs = true;

  const signer1 = deriveSignerAddressSync(seed, '1');
  registerSignerKey(signer1, deriveSignerKeySync(seed, '1'));
  registerSignerKey(signer1.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
  const signer2 = deriveSignerAddressSync(seed, '2');
  registerSignerKey(signer2, deriveSignerKeySync(seed, '2'));

  const entityA = generateLazyEntityId([signer1], 1n).toLowerCase();
  const entityB = generateLazyEntityId([signer2], 1n).toLowerCase();
  const jurisdiction = {
    address: '0x000000000000000000000000000000000000dEaD',
    name: 'persistence-smoke',
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
    chainId: 31337,
  };
  env.activeJurisdiction = jurisdiction.name;
  const jReplica: JReplica = {
    name: jurisdiction.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: env.timestamp,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    chainId: jurisdiction.chainId,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  };
  env.jReplicas.set(jurisdiction.name, jReplica);

  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importReplica',
        entityId: entityA,
        signerId: signer1,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signer1],
            shares: { [signer1]: 1n },
            jurisdiction,
          },
        },
      },
      {
        type: 'importReplica',
        entityId: entityB,
        signerId: signer2,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signer2],
            shares: { [signer2]: 1n },
            jurisdiction,
          },
        },
      },
    ],
    entityInputs: [],
  });
  await processRuntime(env, []);
  assert(env.height === 1, `expected genesis frame 1, got ${env.height}`);

  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: entityA,
        signerId: signer1,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: entityB,
              creditAmount: 1000n,
              tokenId: 1,
            },
          },
        ],
      },
    ],
  });
  await processRuntime(env, []);
  assert(Number(env.height) === 2, `expected live frame 2, got ${env.height}`);

  const liveSnapshot = buildRuntimeCheckpointSnapshot(env);
  await drainBackgroundPersistence();
  await closeInfraDb(env);
  await closeRuntimeDb(env);

  const checkpointSnapshot = await readPersistedCheckpointSnapshot(env, 1);
  assert(checkpointSnapshot, 'checkpoint snapshot 1 exists');
  const frame2 = await readPersistedFrameJournal(env, 2);
  assert(frame2, 'frame journal 2 exists');
  await closeInfraDb(env);
  await closeRuntimeDb(env);

  const replayEnv = createEmptyEnv(seed);
  replayEnv.runtimeId = runtimeId;
  replayEnv.dbNamespace = runtimeId;
  const checkpoint = readCheckpointSnapshot(checkpointSnapshot);
  replayEnv.height = checkpoint.height ?? 0;
  replayEnv.timestamp = checkpoint.timestamp ?? 0;
  replayEnv.activeJurisdiction = checkpoint.activeJurisdiction;
  replayEnv.eReplicas = new Map(checkpoint.eReplicas);
  replayEnv.jReplicas = new Map(checkpoint.jReplicas);
  if (checkpoint.browserVMState) {
    replayEnv.browserVMState = checkpoint.browserVMState;
  }

  const applyAllowedKey = Symbol.for('xln.runtime.env.apply.allowed');
  const replayModeKey = Symbol.for('xln.runtime.env.replay.mode');
  (replayEnv as unknown as Record<PropertyKey, unknown>)[replayModeKey] = true;
  (replayEnv as unknown as Record<PropertyKey, unknown>)[applyAllowedKey] = true;
  replayEnv.height = 1;
  replayEnv.timestamp = Number(frame2.timestamp ?? replayEnv.timestamp);
  await (await import('../runtime.ts')).applyRuntimeInput(replayEnv, frame2.runtimeInput);
  (replayEnv as unknown as Record<PropertyKey, unknown>)[applyAllowedKey] = false;

  const replaySnapshot = buildRuntimeCheckpointSnapshot(replayEnv);
  const diffs = collectDiffs(liveSnapshot, replaySnapshot);
  const liveSerialized = serializeTaggedJson(liveSnapshot);
  const replaySerialized = serializeTaggedJson(replaySnapshot);
  let firstDiffAt = -1;
  const minLen = Math.min(liveSerialized.length, replaySerialized.length);
  for (let i = 0; i < minLen; i++) {
    if (liveSerialized[i] !== replaySerialized[i]) {
      firstDiffAt = i;
      break;
    }
  }
  if (firstDiffAt === -1 && liveSerialized.length !== replaySerialized.length) {
    firstDiffAt = minLen;
  }
  const diffContext =
    firstDiffAt >= 0
      ? {
          index: firstDiffAt,
          live: liveSerialized.slice(Math.max(0, firstDiffAt - 160), firstDiffAt + 160),
          replay: replaySerialized.slice(Math.max(0, firstDiffAt - 160), firstDiffAt + 160),
        }
      : null;
  const liveReplica = Array.from(env.eReplicas.values()).find((replica) => replica.entityId === entityA);
  const replayReplica = Array.from(replayEnv.eReplicas.values()).find((replica) => replica.entityId === entityA);
  const liveAccounts = liveReplica
    ? Array.from(liveReplica.state.accounts.entries()).map(([key, account]) => ({
        key,
        hasPendingAccountInput: Boolean(account.pendingAccountInput),
        pendingAccountInputType: account.pendingAccountInput ? typeof account.pendingAccountInput : 'none',
        pendingNewAccountFrameType: account.pendingAccountInput?.newAccountFrame
          ? Array.isArray(account.pendingAccountInput.newAccountFrame)
            ? 'array'
            : typeof account.pendingAccountInput.newAccountFrame
          : 'none',
        pendingNewAccountFrameSerialized: account.pendingAccountInput?.newAccountFrame
          ? render(account.pendingAccountInput.newAccountFrame)
          : null,
      }))
    : [];
  const replayAccounts = replayReplica
    ? Array.from(replayReplica.state.accounts.entries()).map(([key, account]) => ({
        key,
        hasPendingAccountInput: Boolean(account.pendingAccountInput),
        pendingAccountInputType: account.pendingAccountInput ? typeof account.pendingAccountInput : 'none',
        pendingNewAccountFrameType: account.pendingAccountInput?.newAccountFrame
          ? Array.isArray(account.pendingAccountInput.newAccountFrame)
            ? 'array'
            : typeof account.pendingAccountInput.newAccountFrame
          : 'none',
        pendingNewAccountFrameSerialized: account.pendingAccountInput?.newAccountFrame
          ? render(account.pendingAccountInput.newAccountFrame)
          : null,
      }))
    : [];

  console.log(JSON.stringify({
    runtimeId,
    liveHeight: liveSnapshot['height'],
    replayHeight: replaySnapshot['height'],
    liveHash: (await import('../wal/hash')).computePersistedEnvStateHash(liveSnapshot),
    replayHash: (await import('../wal/hash')).computePersistedEnvStateHash(replaySnapshot),
    diffCount: diffs.length,
    diffs,
    firstSerializedDiff: diffContext,
    liveAccounts,
    replayAccounts,
  }, null, 2));

  await drainBackgroundPersistence();
  await closeInfraDb(replayEnv);
  await closeRuntimeDb(replayEnv);
}

main().catch((error) => {
  console.error('debug-replay-diff failed:', error);
  process.exit(1);
});
