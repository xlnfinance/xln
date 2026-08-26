import { describe, expect, test } from 'bun:test';

import type { RscoreCheckpointChanges } from '../../../../rscore/checkpoint/checkpoint-wire';
import type { RscoreWireValue } from '../../../../rscore/client';
import { MAX_PHYSICAL_STORAGE_VALUE_BYTES } from '../../../../storage/codec/bounded-value';
import { keyRscoreAccountNodePrefix } from '../../../../storage/keys';
import {
  loadRscoreCheckpoint,
  prepareRscoreCheckpointStorage,
  type PreparedRscoreCheckpointStorage,
} from '../../../../storage/schema/rscore/checkpoint';
import type { RuntimeDbLike } from '../../../../storage/types';
import {
  getAccountJClaimKey,
  hashAccountJClaimNode,
} from '../../../../account/j-claims/j-claim-codec';
import { jClaimNodeWire } from '../../../../rscore/process/j-claim-wire';
import type {
  AccountJClaimNode,
  AccountJClaimRecord,
} from '../../../../types/finance/account-j-claims';

const OWNER = `0x${'aa'.repeat(32)}`;
const ACCOUNT = `0x${'bb'.repeat(32)}`;
const FINGERPRINT = `0x${'cc'.repeat(32)}`;
const NODE_PATH = Buffer.from([1, 2, 3]);
const NODE_KEY = Buffer.alloc(32, 0x44);

const makeMemoryDb = () => {
  const rows = new Map<string, { key: Buffer; value: Buffer }>();
  const db: RuntimeDbLike = {
    get: async key => {
      const row = rows.get(key.toString('hex'));
      if (row) return Buffer.from(row.value);
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    },
    batch: () => {
      const ops: Array<
        | { kind: 'put'; key: Buffer; value: Buffer }
        | { kind: 'del'; key: Buffer }
      > = [];
      return {
        put: (key, value) => { ops.push({ kind: 'put', key: Buffer.from(key), value: Buffer.from(value) }); },
        del: key => { ops.push({ kind: 'del', key: Buffer.from(key) }); },
        write: async () => {
          for (const op of ops) {
            const id = op.key.toString('hex');
            if (op.kind === 'put') rows.set(id, { key: op.key, value: op.value });
            else rows.delete(id);
          }
        },
      };
    },
    keys: async function* (options = {}) {
      const keys = [...rows.values()].map(row => row.key).sort(Buffer.compare);
      if (options.reverse) keys.reverse();
      for (const key of keys) {
        if (options.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
  return { db, rows };
};

const apply = async (db: RuntimeDbLike, plan: PreparedRscoreCheckpointStorage): Promise<void> => {
  const batch = db.batch();
  for (const key of plan.dels) batch.del(key);
  for (const put of plan.puts) batch.put(put.key, put.value);
  await batch.write();
};

const token = (baseRevision: number, revision: number, accountCount: number) => [
  baseRevision,
  revision,
  Buffer.alloc(32, revision),
  Buffer.alloc(32, 0x55),
  accountCount,
] as RscoreCheckpointChanges['commitToken'];

const checkpoint = (
  baseRevision: number,
  revision: number,
  options: Readonly<{
    leafValue?: Uint8Array;
    branchValue?: Uint8Array;
    deleteNodes?: boolean;
    jClaimPuts?: readonly RscoreWireValue[];
    jClaimDels?: readonly Uint8Array[];
    removeAccount?: boolean;
  }> = {},
): RscoreCheckpointChanges => {
  const commitToken = token(baseRevision, revision, options.removeAccount ? 0 : 1);
  const restoreToken = token(revision, revision, options.removeAccount ? 0 : 1);
  if (options.removeAccount) {
    return {
      commitToken,
      restoreToken,
      accounts: [],
      removed: [Buffer.from(ACCOUNT.slice(2), 'hex')],
    };
  }
  const puts: RscoreWireValue[] = [];
  const dels: RscoreWireValue[] = [];
  if (options.branchValue) puts.push([0, NODE_PATH, options.branchValue]);
  if (options.leafValue) puts.push([1, NODE_PATH, NODE_KEY, options.leafValue]);
  if (options.deleteNodes) {
    dels.push([0, NODE_PATH]);
    dels.push([1, NODE_PATH, NODE_KEY]);
  }
  const emptyTree: RscoreWireValue = [[], []];
  const account: RscoreWireValue[] = [
    Buffer.from(ACCOUNT.slice(2), 'hex'),
    Buffer.alloc(32, revision),
    [Buffer.from(OWNER.slice(2), 'hex'), null, null, null, null, null, null, null, null],
    [null, null, null, null, null],
    [puts, dels],
    emptyTree,
    emptyTree,
    emptyTree,
    emptyTree,
    [options.jClaimPuts ?? [], options.jClaimDels ?? []],
    [null, null, null, null, null, null, null, null, null, null, null],
  ];
  return { commitToken, restoreToken, accounts: [account], removed: [] };
};

describe('rscore physical checkpoint storage', () => {
  test('persists and deletes content-verified J-claim nodes by their exact digest', async () => {
    const { db } = makeMemoryDb();
    const record: AccountJClaimRecord = {
      version: 1,
      accountKey: `0x${'11'.repeat(32)}`,
      side: 'left',
      jHeight: 7,
      jBlockHash: `0x${'22'.repeat(32)}`,
      eventsHash: `0x${'33'.repeat(32)}`,
    };
    const node: AccountJClaimNode = {
      version: 1,
      type: 'leaf',
      key: getAccountJClaimKey(record),
      record,
    };
    const hash = hashAccountJClaimNode(node);
    const hashBytes = Buffer.from(hash.slice(2), 'hex');
    const put: RscoreWireValue = [hashBytes, jClaimNodeWire(node)];
    const input = (value: RscoreCheckpointChanges) => [{
      ownerEntityId: OWNER,
      protocolFingerprint: FINGERPRINT,
      checkpoint: value,
    }];

    const inserted = await prepareRscoreCheckpointStorage(
      db,
      input(checkpoint(0, 1, { jClaimPuts: [put] })),
    );
    await apply(db, inserted);
    expect((await loadRscoreCheckpoint(db, OWNER))?.accounts[0]?.[8]).toEqual([put]);

    const deleted = await prepareRscoreCheckpointStorage(
      db,
      input(checkpoint(1, 2, { jClaimDels: [hashBytes] })),
    );
    await apply(db, deleted);
    expect((await loadRscoreCheckpoint(db, OWNER))?.accounts[0]?.[8]).toEqual([]);
  });

  test('rejects a semantic leaf stored under a different physical key', async () => {
    const { db, rows } = makeMemoryDb();
    const plan = await prepareRscoreCheckpointStorage(db, [{
      ownerEntityId: OWNER,
      protocolFingerprint: FINGERPRINT,
      checkpoint: checkpoint(0, 1, { leafValue: Buffer.from([9]) }),
    }]);
    await apply(db, plan);

    const prefix = keyRscoreAccountNodePrefix(OWNER, ACCOUNT, 1, 1);
    const original = [...rows.values()].find(row => row.key.subarray(0, prefix.byteLength).equals(prefix));
    if (!original) throw new Error('expected stored leaf');
    const wrongKey = Buffer.concat([prefix, Buffer.alloc(32, 0x99)]);
    rows.set(wrongKey.toString('hex'), { key: wrongKey, value: Buffer.from(original.value) });

    await expect(loadRscoreCheckpoint(db, OWNER))
      .rejects.toThrow('STORAGE_RSCORE_STORED_LEAF_KEY_MISMATCH');
  });

  test('bounds branch and leaf rows and removes every continuation on replace, delete and account removal', async () => {
    const { db, rows } = makeMemoryDb();
    const input = (value: RscoreCheckpointChanges) => [{
      ownerEntityId: OWNER,
      protocolFingerprint: FINGERPRINT,
      checkpoint: value,
    }];

    const first = await prepareRscoreCheckpointStorage(db, input(checkpoint(0, 1, {
      branchValue: Buffer.alloc(24_000, 0x61),
      leafValue: Buffer.alloc(27_000, 0x62),
    })));
    expect(first.puts.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);
    const firstContinuationKeys = first.puts
      .filter(row => row.value.byteLength === 9_000)
      .map(row => row.key.toString('hex'));
    expect(firstContinuationKeys.length).toBeGreaterThan(4);
    await apply(db, first);
    const firstLoaded = await loadRscoreCheckpoint(db, OWNER);
    const firstAccount = firstLoaded?.accounts[0];
    const firstDeltas = firstAccount?.[3];
    if (!Array.isArray(firstDeltas)) throw new Error('expected restored deltas');
    const firstLeaf = firstDeltas[0];
    if (!(firstLeaf instanceof Uint8Array)) throw new Error('expected restored delta value');
    expect(firstLeaf.byteLength).toBe(27_000);

    const replacement = await prepareRscoreCheckpointStorage(db, input(checkpoint(1, 2, {
      branchValue: Buffer.from([7]),
      leafValue: Buffer.from([8]),
    })));
    await apply(db, replacement);
    for (const key of firstContinuationKeys) expect(rows.has(key)).toBe(false);

    const deleted = await prepareRscoreCheckpointStorage(db, input(checkpoint(2, 3, {
      deleteNodes: true,
    })));
    await apply(db, deleted);
    const deletedAccount = (await loadRscoreCheckpoint(db, OWNER))?.accounts[0];
    expect(deletedAccount?.[3]).toEqual([]);

    const largeAgain = await prepareRscoreCheckpointStorage(db, input(checkpoint(3, 4, {
      branchValue: Buffer.alloc(24_000, 0x71),
      leafValue: Buffer.alloc(27_000, 0x72),
    })));
    await apply(db, largeAgain);
    const secondContinuationKeys = largeAgain.puts
      .filter(row => row.value.byteLength === 9_000)
      .map(row => row.key.toString('hex'));
    const removed = await prepareRscoreCheckpointStorage(db, input(checkpoint(4, 5, {
      removeAccount: true,
    })));
    await apply(db, removed);
    for (const key of secondContinuationKeys) expect(rows.has(key)).toBe(false);
    expect((await loadRscoreCheckpoint(db, OWNER))?.accounts).toEqual([]);
  });
});
