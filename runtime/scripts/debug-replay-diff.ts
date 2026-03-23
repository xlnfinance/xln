import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  getRuntimeDb,
  tryOpenDb,
  closeRuntimeDb,
  readPersistedCheckpointSnapshot,
} from '../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';
import { readPersistedFrameJournalBuffer } from '../wal/store';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

type PlainJson = null | boolean | number | string | PlainJson[] | { [key: string]: PlainJson };

const toPlain = (value: unknown): PlainJson =>
  JSON.parse(serializeTaggedJson(value)) as PlainJson;

const render = (value: unknown): string => serializeTaggedJson(value);

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
      collectDiffs(left[i] as PlainJson, right[i] as PlainJson, `${path}[${i}]`, out, limit);
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
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
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
    name: 'persistence-smoke',
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
    chainId: 31337,
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    chainId: jurisdiction.chainId,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  } as any);

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
  assert(env.height === 2, `expected live frame 2, got ${env.height}`);

  const liveSnapshot = buildRuntimeCheckpointSnapshot(env);

  const opened = await tryOpenDb(env);
  assert(opened, 'db opened');
  const db = getRuntimeDb(env);
  const checkpointSnapshot = await readPersistedCheckpointSnapshot(env, 1);
  assert(checkpointSnapshot, 'checkpoint snapshot 1 exists');
  const frame2Buffer = await readPersistedFrameJournalBuffer(db, runtimeId, 2);
  const frame2 = deserializeTaggedJson<any>(frame2Buffer.toString());

  const replayEnv = createEmptyEnv(seed);
  replayEnv.runtimeId = runtimeId;
  replayEnv.dbNamespace = runtimeId;
  replayEnv.height = Number((checkpointSnapshot as any).height || 0);
  replayEnv.timestamp = Number((checkpointSnapshot as any).timestamp || 0);
  replayEnv.activeJurisdiction = (checkpointSnapshot as any).activeJurisdiction;
  replayEnv.eReplicas = new Map((checkpointSnapshot as any).eReplicas || []);
  replayEnv.jReplicas = new Map((checkpointSnapshot as any).jReplicas || []);
  if ((checkpointSnapshot as any).browserVMState) {
    replayEnv.browserVMState = (checkpointSnapshot as any).browserVMState;
  }

  const applyAllowedKey = Symbol.for('xln.runtime.env.apply.allowed');
  const replayModeKey = Symbol.for('xln.runtime.env.replay.mode');
  (replayEnv as Record<PropertyKey, unknown>)[replayModeKey] = true;
  (replayEnv as Record<PropertyKey, unknown>)[applyAllowedKey] = true;
  replayEnv.height = 1;
  replayEnv.timestamp = Number(frame2.timestamp ?? replayEnv.timestamp);
  await (await import('../runtime.ts')).applyRuntimeInput(replayEnv, frame2.runtimeInput);
  (replayEnv as Record<PropertyKey, unknown>)[applyAllowedKey] = false;

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
  const replayReplica = Array.from(replayEnv.eReplicas.values()).find((replica: any) => replica.entityId === entityA);
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
    ? Array.from(replayReplica.state.accounts.entries()).map(([key, account]: [string, any]) => ({
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
    liveHeight: (liveSnapshot as any).height,
    replayHeight: (replaySnapshot as any).height,
    liveHash: (await import('../wal/hash')).computePersistedEnvStateHash(liveSnapshot),
    replayHash: (await import('../wal/hash')).computePersistedEnvStateHash(replaySnapshot),
    diffCount: diffs.length,
    diffs,
    firstSerializedDiff: diffContext,
    liveAccounts,
    replayAccounts,
  }, null, 2));

  await closeRuntimeDb(env);
  await closeRuntimeDb(replayEnv);
}

main().catch((error) => {
  console.error('debug-replay-diff failed:', error);
  process.exit(1);
});
