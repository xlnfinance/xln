/**
 * Offline inspection of one entity's account Patricia tree and of the LevelDB
 * rows that back it.
 *
 * Two questions this answers, both by reading a real hub database:
 *   1. What does the radix-16 accounts tree actually look like — every branch,
 *      its occupied slots, every leaf, and the account state root it commits.
 *   2. Which physical keys a checkpoint writes, by key tag, with byte totals.
 *
 * The accounts tree itself is NOT persisted node-by-node: hydration rebuilds it
 * from the per-account documents (core/storage/read/hydration.ts). Only the
 * per-account collections (deltas, locks, ...) have persisted branch/leaf rows.
 * The dump states both, so the shape can be reviewed against the design.
 *
 * Usage:
 *   XLN_DB_PATH=/tmp/xb-base/prod-mesh/h1 \
 *   bun core/scripts/operations/diagnostics/dump-account-tree.ts \
 *     --seed-file /tmp/xb-base/secrets/main-runtime.seed \
 *     --out /tmp/account-tree.yaml [--entity 0x...] [--max-leaves 40]
 */
import { writeFileSync, readFileSync } from 'node:fs';

import { loadEnvFromDB, closeRuntimeDb } from '../../../runtime/composition';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountReplica } from '../../../types/account';

const flag = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return String(process.argv[index + 1] ?? '').trim() || null;
};

const outputPath = flag('out') ?? '/tmp/account-tree.yaml';
const maxLeaves = Number(flag('max-leaves') ?? '64');
const seedFile = flag('seed-file');
const seed = seedFile ? readFileSync(seedFile, 'utf8').trim() : (process.env['XLN_RUNTIME_SEED'] ?? null);
const runtimeId = flag('runtime-id');
const wantedEntity = flag('entity');

const hex = (value: unknown): string => (typeof value === 'string' ? value : String(value));
const short = (value: string): string => `${value.slice(0, 10)}…${value.slice(-6)}`;

/** Nibble path as the tree prints it: root is `0x-`, then one nibble per hop. */
const pathLabel = (path: readonly number[]): string =>
  path.length === 0 ? '0x-' : `0x${path.map(slot => slot.toString(16)).join('')}`;

const dumpTree = (accounts: PersistentEntityAccountMap): string[] => {
  const lines: string[] = [];
  const branches: string[] = [];
  const leaves: string[] = [];
  let maxDepth = 0;
  let leafCount = 0;
  for (const record of accounts.nodeRecords()) {
    if (record.kind === 'branch') {
      maxDepth = Math.max(maxDepth, record.path.length);
      const indent = '  '.repeat(record.path.length + 1);
      branches.push(`${indent}${pathLabel(record.path)}:`);
      for (const child of record.children) {
        branches.push(
          `${indent}  ${child.slot.toString(16)}: { kind: ${child.kind}, ` +
          `path: ${pathLabel(child.path)}, edge: ${short(hex(child.edgeHash))} }`,
        );
      }
      continue;
    }
    leafCount += 1;
    if (leaves.length >= maxLeaves) continue;
    const account = record.value as AccountReplica;
    const indent = '  '.repeat(record.path.length + 1);
    leaves.push(
      `${indent}${pathLabel(record.path)}: { account: ${short(record.key)}, ` +
      `stateRoot: ${short(hex(account.currentFrame?.accountStateRoot ?? ''))}, ` +
      `deltas: ${short(requirePersistentAccountStateMap(account.state.deltas, 'deltas').rootHash())}, ` +
      `frame: ${account.currentFrame?.height ?? 0} }`,
    );
  }
  lines.push('accountsTree:');
  lines.push(`  root: ${accounts.rootHash()}`);
  lines.push(`  leaves: ${accounts.size}`);
  lines.push(`  maxBranchDepth: ${maxDepth}`);
  lines.push('  branches:');
  lines.push(...branches);
  lines.push(`  leafSample: # ${Math.min(leafCount, maxLeaves)} of ${leafCount}`);
  lines.push(...leaves);
  return lines;
};

const KEY_TAGS: Record<number, string> = {
  0x10: 'FRAME (wal)',
  0x11: 'BOUNDED_VALUE_CHUNK',
  0x12: 'SNAPSHOT_MANIFEST',
  0x13: 'RUNTIME_OUTPUT_PAYLOAD',
  0x14: 'ENTITY_CONTEXT_PAYLOAD',
  0x15: 'RUNTIME_MACHINE_BRANCH (checkpoint)',
  0x16: 'RUNTIME_MACHINE_LEAF (checkpoint)',
  0x20: 'HEAD',
  0x21: 'LIVE_ENTITY',
  0x22: 'LIVE_ACCOUNT',
  0x23: 'LIVE_BOOK',
  0x24: 'LIVE_ACCOUNT_FIELD',
  0x26: 'LIVE_REPLICA_META',
  0x2a: 'CERTIFIED_BOARD_NODE',
  0x2b: 'CONSUMPTION_NODE',
  0x2c: 'ACCOUNT_J_CLAIM_NODE',
  0x2d: 'LIVE_BOOK_BRANCH',
  0x2e: 'LIVE_BOOK_LEAF',
  0x2f: 'LIVE_ACCOUNT_BRANCH',
  0x30: 'LIVE_ACCOUNT_LEAF',
  0x31: 'SNAPSHOT_ENTITY',
  0x32: 'SNAPSHOT_ACCOUNT',
  0x33: 'SNAPSHOT_BOOK',
  0x34: 'SNAPSHOT_REPLICA_META',
  0x35: 'SNAPSHOT_GRAPH',
  0x36: 'LIVE_ENTITY_FIELD',
  0x37: 'LIVE_ENTITY_BRANCH',
  0x38: 'LIVE_ENTITY_LEAF',
};

type LevelLike = {
  iterator: (options: Record<string, unknown>) => AsyncIterable<[Buffer, Buffer]>;
};

const dumpKeyspace = async (db: LevelLike | null | undefined, label: string): Promise<string[]> => {
  if (!db) return [`${label}: {} # database not open`];
  const rows = new Map<number, { keys: number; keyBytes: number; valueBytes: number; sample: string }>();
  for await (const [key, value] of db.iterator({})) {
    const tag = key[0] ?? -1;
    const row = rows.get(tag) ?? { keys: 0, keyBytes: 0, valueBytes: 0, sample: key.toString('hex') };
    row.keys += 1;
    row.keyBytes += key.byteLength;
    row.valueBytes += value?.byteLength ?? 0;
    rows.set(tag, row);
  }
  const lines = [`${label}:`];
  for (const [tag, row] of [...rows].sort((left, right) => right[1].keys - left[1].keys)) {
    lines.push(
      `  0x${tag.toString(16).padStart(2, '0')}: { name: ${KEY_TAGS[tag] ?? 'UNKNOWN'}, ` +
      `keys: ${row.keys}, keyBytes: ${row.keyBytes}, valueBytes: ${row.valueBytes}, ` +
      `sampleKey: ${row.sample.slice(0, 48)} }`,
    );
  }
  return lines;
};

const main = async (): Promise<void> => {
  const env = await loadEnvFromDB(runtimeId, seed);
  if (!env) throw new Error('DUMP_ACCOUNT_TREE_NO_ENV');
  try {
    const byAccounts = [...env.state.eReplicas.entries()]
      .filter(([key]) => (wantedEntity ? key.toLowerCase().startsWith(wantedEntity.toLowerCase()) : true))
      .sort((left, right) => right[1].state.accounts.size - left[1].state.accounts.size);
    const chosen = byAccounts[0];
    if (!chosen) throw new Error('DUMP_ACCOUNT_TREE_NO_REPLICA');
    const [replicaKey, replica] = chosen;
    const accounts = replica.state.accounts;
    if (!(accounts instanceof PersistentEntityAccountMap)) {
      throw new Error('DUMP_ACCOUNT_TREE_NOT_PERSISTENT');
    }
    const lines: string[] = [
      '# xln account tree dump',
      `replica: ${replicaKey}`,
      `entityHeight: ${replica.state.height}`,
      `runtimeHeight: ${env.state.height}`,
      '',
      ...dumpTree(accounts),
      '',
      '# Physical rows. The accounts tree above is derived at hydration from',
      '# LIVE_ACCOUNT documents; LIVE_ACCOUNT_BRANCH/LEAF rows are the',
      '# per-account collections (deltas, locks, ...), not this tree.',
      ...(await dumpKeyspace(
        (env.infrastructure as unknown as { storageDb?: LevelLike }).storageDb,
        'storageCurrentKeys',
      )),
      ...(await dumpKeyspace(
        (env.infrastructure as unknown as { runtimeWalDb?: LevelLike }).runtimeWalDb,
        'walKeys',
      )),
    ];
    writeFileSync(outputPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`ACCOUNT_TREE_DUMP path=${outputPath} accounts=${accounts.size} root=${accounts.rootHash()}`);
  } finally {
    await closeRuntimeDb(env);
  }
};

await main();
