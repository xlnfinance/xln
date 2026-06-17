#!/usr/bin/env bun

import { createHash } from 'crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { Level } from 'level';
import type { ServerWebSocket } from 'bun';
import { ethers } from 'ethers';

import { deriveRuntimeAdapterCapabilityToken } from '../radapter/auth';
import { decodeRuntimeAdapterMessage } from '../radapter/codec';
import { RemoteRuntimeAdapter } from '../radapter/remote';
import type { RuntimeAdapterReadQuery } from '../radapter/types';
import { createBook, createOrderbookExtState, DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import {
  broadcastRuntimeAdapterTick,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../radapter/server';
import { encodeBuffer, writeBatch } from '../storage/codec';
import { docRefCellKey, docRefForDoc, docValueKey, liveKeyForDoc } from '../storage/doc-refs';
import { prepareStorageStateHashes, storageMerkleCellHexKey } from '../storage/hashes';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_HEAD,
  normalizeEntityId,
  keyMerkleBranch,
  keyMerkleLeaf,
  keyMerkleRoot,
} from '../storage/keys';
import { inspectStorage } from '../storage/inspect';
import { createSnapshot, seedFreshStorageEpoch } from '../storage/lifecycle';
import { buildHexKeyedMerkleMaterialized, packRadixMerklePath } from '../storage/merkle';
import { projectEntityCoreDoc } from '../storage/projections';
import {
  listStorageLiveEntityIds,
  loadEntityAccountDocFromStorage,
  loadEntityViewPageFromStorage,
  readStorageHead,
} from '../storage/read';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDoc,
  StorageEntityHashDoc,
  StorageHead,
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
} from '../storage/types';
import type { AccountMachine, EntityReplica, EntityState, Env, RuntimeInput } from '../types';

type Cli = {
  accounts: number;
  hotPercent: number;
  hotAccounts: number;
  books: number;
  chunk: number;
  pageLimit: number;
  trafficRounds: number;
  touchPerRound: number;
  newAfterRead: number;
  rssCapBytes: number;
  maxReadP99Ms: number;
  maxDurableP99Ms: number;
  maxColdOpenMs: number;
  maxColdReadMs: number;
  seed: string;
  dbRoot: string;
  port: number;
  keepDb: boolean;
  memory: 'hot' | 'all' | 'none';
  seedMode: 'bulk' | 'incremental';
  rotationProbe: boolean;
  rotationRetainSnapshots: number;
  rotationEpochBytes: number;
  maxSnapshotMs: number;
  maxEpochSeedMs: number;
  maxRotationProbeMs: number;
};

type TimedEvent = {
  label: string;
  atMs: number;
  deltaMs: number;
  heapUsed: number;
  rss: number;
  extra?: Record<string, unknown>;
};

const argv = process.argv.slice(2);

const readArg = (name: string, fallback: string): string => {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] ?? fallback : fallback;
};

const hasFlag = (name: string): boolean => argv.includes(name) || argv.includes(`${name}=1`) || argv.includes(`${name}=true`);

const readInt = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(readArg(name, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const readFloat = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(readArg(name, String(fallback)));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
};

const summarizeMs = (values: number[]): Record<string, number> => {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (pct: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))]!;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    count: sorted.length,
    min: round(sorted[0]!),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    p99: round(pick(0.99)),
    max: round(sorted[sorted.length - 1]!),
  };
};

const assertMetricCap = (label: string, value: number, cap: number): void => {
  if (cap <= 0 || value <= cap) return;
  throw new Error(`${label}_CAP_EXCEEDED: value=${value} cap=${cap}`);
};

const dirBytes = (path: string): number => {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    let total = 0;
    for (const entry of readdirSync(path)) total += dirBytes(join(path, entry));
    return total;
  } catch {
    return 0;
  }
};

const nowMs = (): number => performance.now();

class Trace {
  private readonly startedAt = nowMs();
  private lastAt = this.startedAt;
  readonly events: TimedEvent[] = [];

  mark(label: string, extra?: Record<string, unknown>): void {
    const at = nowMs();
    const mem = process.memoryUsage();
    const event: TimedEvent = {
      label,
      atMs: Math.round((at - this.startedAt) * 1000) / 1000,
      deltaMs: Math.round((at - this.lastAt) * 1000) / 1000,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      ...(extra ? { extra } : {}),
    };
    this.lastAt = at;
    this.events.push(event);
    console.log(
      `[bench] ${event.label} at=${event.atMs.toFixed(1)}ms delta=${event.deltaMs.toFixed(1)}ms ` +
        `heap=${formatBytes(event.heapUsed)} rss=${formatBytes(event.rss)}` +
        (extra ? ` ${JSON.stringify(extra)}` : ''),
    );
  }
}

const readCli = (): Cli => {
  const accounts = readInt('--accounts', 1_000_000);
  const hotPercent = readFloat('--hot-percent', 1);
  const hotAccounts = readInt('--hot-accounts', Math.max(1, Math.floor(accounts * hotPercent / 100)));
  const rssCapMb = readFloat('--rss-cap-mb', 0);
  const defaultRssCapBytes = rssCapMb > 0 ? Math.floor(rssCapMb * 1024 * 1024) : 0;
  const memory = readArg('--memory', 'hot') as Cli['memory'];
  if (memory !== 'hot' && memory !== 'all' && memory !== 'none') throw new Error(`BAD_MEMORY_MODE: ${memory}`);
  const seedMode = readArg('--seed-mode', 'bulk') as Cli['seedMode'];
  if (seedMode !== 'bulk' && seedMode !== 'incremental') throw new Error(`BAD_SEED_MODE: ${seedMode}`);
  return {
    accounts,
    hotPercent,
    hotAccounts: Math.min(accounts, hotAccounts),
    books: readInt('--books', 0),
    chunk: Math.max(1, readInt('--chunk', 10_000)),
    pageLimit: Math.max(1, readInt('--page-limit', 10)),
    trafficRounds: Math.max(0, readInt('--traffic-rounds', 10)),
    touchPerRound: Math.max(1, readInt('--touch-per-round', 100)),
    newAfterRead: Math.max(0, readInt('--new-after-read', 100)),
    rssCapBytes: Math.max(0, readInt('--rss-cap-bytes', defaultRssCapBytes)),
    maxReadP99Ms: Math.max(0, readFloat('--max-read-p99-ms', 0)),
    maxDurableP99Ms: Math.max(0, readFloat('--max-durable-p99-ms', 0)),
    maxColdOpenMs: Math.max(0, readFloat('--max-cold-open-ms', 0)),
    maxColdReadMs: Math.max(0, readFloat('--max-cold-read-ms', 0)),
    seed: readArg('--seed', 'xln-radapter-1m-hub-production-bench'),
    dbRoot: readArg('--db-root', 'db-tmp/radapter-hub-1m'),
    port: readInt('--port', 0),
    keepDb: hasFlag('--keep-db'),
    memory,
    seedMode,
    rotationProbe: hasFlag('--rotation-probe'),
    rotationRetainSnapshots: Math.max(1, readInt('--rotation-retain-snapshots', 2)),
    rotationEpochBytes: Math.max(0, readInt('--rotation-epoch-bytes', 1024 * 1024 * 1024)),
    maxSnapshotMs: Math.max(0, readFloat('--max-snapshot-ms', 0)),
    maxEpochSeedMs: Math.max(0, readFloat('--max-epoch-seed-ms', 0)),
    maxRotationProbeMs: Math.max(0, readFloat('--max-rotation-probe-ms', 0)),
  };
};

const randomEntityId = (seed: string, index: number): string =>
  `0x${createHash('sha256').update(seed).update(':account:').update(String(index)).digest('hex')}`;

const hubEntityId = (seed: string): string =>
  `0x${createHash('sha256').update(seed).update(':hub').digest('hex')}`;

const makeAccount = (leftEntity: string, rightEntity: string, height: number, timestamp: number): AccountMachine => ({
  leftEntity,
  rightEntity,
  watchSeed: `0x${'a1'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height,
    timestamp,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    stateHash: `0x${'00'.repeat(32)}`,
    deltas: [],
  },
  deltas: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 1_000_000_000n, peerLimit: 1_000_000_000n },
  currentHeight: height,
  pendingSignatures: [],
  rollbackCount: 0,
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nonce: height },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  onChainSettlementNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  rebalancePolicy: new Map(),
});

const makeAccountDoc = (leftEntity: string, rightEntity: string, height: number, timestamp: number): StorageAccountDoc =>
  makeAccount(leftEntity, rightEntity, height, timestamp) as StorageAccountDoc;

const makeHubState = (entityId: string, height: number, timestamp: number): EntityState => ({
  entityId,
  height,
  timestamp,
  messages: [],
  nonces: new Map(),
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: ['bench-signer'], shares: { 'bench-signer': 1n } },
  reserves: new Map([[1, 1_000_000_000_000_000_000n]]),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: 'bench-pub',
  entityEncPrivKey: 'bench-priv',
  profile: { name: 'H1 1M Hub Bench', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const seedBooks = (state: EntityState, count: number): void => {
  if (count <= 0) return;
  const supportedPairs = Array.from({ length: count }, (_, index) => `1/${index + 2}`);
  const ext = createOrderbookExtState({
    entityId: state.entityId,
    name: state.profile.name,
    spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
    referenceTokenId: 1,
    minTradeSize: 1n,
    supportedPairs,
  });
  for (const pairId of supportedPairs) {
    ext.books.set(pairId, createBook({
      bucketWidthTicks: 1n,
      maxOrders: 1000,
      stpPolicy: 0,
    }));
  }
  state.orderbookExt = ext;
  state.swapTradingPairs = supportedPairs.map((pairId) => {
    const [baseTokenId, quoteTokenId] = pairId.split('/').map((value) => Number(value));
    return {
      pairId,
      baseTokenId: baseTokenId || 1,
      quoteTokenId: quoteTokenId || 2,
    };
  });
};

const makeEnv = (seed: string, entityId: string, state: EntityState): Env => ({
  height: state.height,
  timestamp: state.timestamp,
  runtimeSeed: seed,
  runtimeId: `radapter-hub-1m-${entityId.slice(2, 10)}`,
  eReplicas: new Map<string, EntityReplica>([
    [`${entityId}:bench-signer`, {
      entityId,
      signerId: 'bench-signer',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica],
  ]),
  runtimeState: {},
} as Env);

const makeHead = (height: number): StorageHead => ({
  schemaVersion: 1,
  latestHeight: height,
  latestMaterializedHeight: height,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 256 * 1024 * 1024,
  accountMerkleRadix: 16,
  retainedHistoryBytes: 0,
});

const writeDocs = async (
  db: RuntimeDbLike,
  docs: StorageDoc[],
  entityHashDocs: Map<string, StorageEntityHashDoc>,
  headHeight: number,
): Promise<Map<string, StorageEntityHashDoc>> => {
  const prepared = await prepareStorageStateHashes({
    db,
    puts: docs,
    dels: [],
    entityHashDocs,
  });
  const batch = db.batch();
  for (const doc of docs) {
    const raw = prepared.docValueBuffers.get(docValueKey(doc));
    if (!raw) throw new Error(`DOC_BUFFER_MISSING: ${docValueKey(doc)}`);
    batch.put(liveKeyForDoc(doc), raw);
  }
  for (const key of prepared.merkleDels) batch.del?.(key);
  for (const put of prepared.merklePuts) batch.put(put.key, put.value);
  batch.put(KEY_HEAD, encodeBuffer(makeHead(headHeight)));
  await writeBatch(batch);
  return prepared.entityHashDocs;
};

const encodedDoc = (doc: StorageDoc): { raw: Buffer; hash: string; hashBytes: Buffer } => {
  const raw = encodeBuffer(doc.value);
  const hash = ethers.keccak256(raw);
  return { raw, hash, hashBytes: Buffer.from(hash.slice(2), 'hex') };
};

const writeBatchEntries = async (
  db: RuntimeDbLike,
  entries: Array<{ key: Buffer; value?: Buffer }>,
): Promise<void> => {
  const chunkSize = 1000;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const batch = db.batch();
    for (const entry of entries.slice(offset, offset + chunkSize)) {
      if (entry.value) batch.put(entry.key, entry.value);
      else batch.del?.(entry.key);
    }
    await writeBatch(batch);
  }
};

const forceGc = (trace: Trace, label: string): void => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    trace.mark(label, { gc: 'unavailable', hint: 'run with bun --expose-gc' });
    return;
  }
  const before = process.memoryUsage();
  const started = nowMs();
  gc();
  const after = process.memoryUsage();
  trace.mark(label, {
    gcMs: Math.round((nowMs() - started) * 1000) / 1000,
    heapDelta: after.heapUsed - before.heapUsed,
    rssDelta: after.rss - before.rss,
  });
};

const seedHubBulk = async (
  cli: Cli,
  trace: Trace,
  db: RuntimeDbLike,
  entityId: string,
  state: EntityState,
): Promise<Map<string, StorageEntityHashDoc>> => {
  const leaves: Array<{ hexKey: string; value: Buffer }> = [];
  let pending: Array<{ key: Buffer; value: Buffer }> = [];
  const flushPending = async (label: string, extra: Record<string, unknown>): Promise<void> => {
    if (pending.length === 0) return;
    await writeBatchEntries(db, pending);
    pending = [];
    trace.mark(label, extra);
  };

  const appendDoc = (doc: StorageDoc): void => {
    const encoded = encodedDoc(doc);
    const ref = docRefForDoc(doc);
    pending.push({ key: liveKeyForDoc(doc), value: encoded.raw });
    leaves.push({ hexKey: storageMerkleCellHexKey(docRefCellKey(ref)), value: encoded.hashBytes });
  };

  state.height = 2;
  state.timestamp = 1_002;
  appendDoc({
    family: 'entity',
    entityId,
    value: projectEntityCoreDoc(state, { signerId: 'bench-signer', isProposer: true }),
  });
  for (let offset = 0; offset < cli.accounts; offset += cli.chunk) {
    const end = Math.min(cli.accounts, offset + cli.chunk);
    for (let index = offset; index < end; index += 1) {
      const counterpartyId = normalizeEntityId(randomEntityId(cli.seed, index));
      const accountHeight = 2;
      const timestamp = 1_000 + accountHeight;
      const account = makeAccount(entityId, counterpartyId, accountHeight, timestamp);
      appendDoc({ family: 'account', entityId, counterpartyId, value: account as StorageAccountDoc });
      if (cli.memory === 'all' || (cli.memory === 'hot' && index < cli.hotAccounts)) {
        state.accounts.set(counterpartyId, account);
      }
    }
    await flushPending('seed.bulk.docs', { accounts: end, pendingLeaves: leaves.length });
  }

  trace.mark('seed.bulk.build-merkle.start', { leaves: leaves.length });
  const built = buildHexKeyedMerkleMaterialized(leaves, { radix: DEFAULT_ACCOUNT_MERKLE_RADIX });
  trace.mark('seed.bulk.build-merkle.done', {
    leaves: built.leafCount,
    branches: built.branches.length,
    root: built.root,
    maxDepth: built.maxDepth,
  });

  const rootDoc: StorageMerkleRootDoc = {
    entityId,
    namespace: 'runtime-roots',
    radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
    rootHash: built.root,
    rootKind: built.rootKind,
    rootPath: built.rootPath,
    leafCount: built.leafCount,
  };
  const entityHashDoc: StorageEntityHashDoc = { entityId, hash: built.root, cellCount: built.leafCount };
  const merkleRows: Array<{ key: Buffer; value: Buffer }> = [
    { key: keyMerkleRoot(entityId, 'runtime-roots'), value: encodeBuffer(rootDoc) },
    { key: KEY_HEAD, value: encodeBuffer(makeHead(state.height)) },
  ];
  for (const branch of built.branches) {
    const doc: StorageMerkleBranchDoc = {
      entityId,
      namespace: 'runtime-roots',
      radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
      path: branch.path,
      hash: branch.hash,
      children: branch.children,
    };
    merkleRows.push({
      key: keyMerkleBranch(entityId, 'runtime-roots', packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, branch.path)),
      value: encodeBuffer(doc),
    });
  }
  for (const leaf of built.leaves) {
    const doc: StorageMerkleLeafDoc = {
      entityId,
      namespace: 'runtime-roots',
      radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
      path: leaf.path,
      key: leaf.key,
      valueHash: leaf.valueHash,
      hash: leaf.hash,
    };
    merkleRows.push({
      key: keyMerkleLeaf(entityId, 'runtime-roots', packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, leaf.path)),
      value: encodeBuffer(doc),
    });
  }
  await writeBatchEntries(db, merkleRows);
  trace.mark('seed.bulk.persist-merkle.done', {
    accounts: cli.accounts,
    inMemoryAccounts: state.accounts.size,
    rows: merkleRows.length,
  });
  return new Map([[entityId, entityHashDoc]]);
};

const seedHub = async (
  cli: Cli,
  trace: Trace,
  db: RuntimeDbLike,
  entityId: string,
  state: EntityState,
): Promise<Map<string, StorageEntityHashDoc>> => {
  let height = 1;
  let entityHashDocs = new Map<string, StorageEntityHashDoc>();
  entityHashDocs = await writeDocs(db, [{
    family: 'entity',
    entityId,
    value: projectEntityCoreDoc(state, { signerId: 'bench-signer', isProposer: true }),
  }], entityHashDocs, height);
  trace.mark('seed.core', { height });

  for (let offset = 0; offset < cli.accounts; offset += cli.chunk) {
    const docs: StorageDoc[] = [];
    const end = Math.min(cli.accounts, offset + cli.chunk);
    for (let index = offset; index < end; index += 1) {
      const counterpartyId = normalizeEntityId(randomEntityId(cli.seed, index));
      const accountHeight = height + 1;
      const timestamp = 1_000 + accountHeight;
      docs.push({
        family: 'account',
        entityId,
        counterpartyId,
        value: makeAccountDoc(entityId, counterpartyId, accountHeight, timestamp),
      });
      if (cli.memory === 'all' || (cli.memory === 'hot' && index < cli.hotAccounts)) {
        state.accounts.set(counterpartyId, makeAccount(entityId, counterpartyId, accountHeight, timestamp));
      }
    }
    height += 1;
    entityHashDocs = await writeDocs(db, docs, entityHashDocs, height);
    if (offset === 0 || end === cli.accounts || end % (cli.chunk * 10) === 0) {
      trace.mark('seed.accounts.chunk', { accounts: end, height, chunk: docs.length });
    }
  }

  state.height = height + 1;
  state.timestamp = 1_000 + state.height;
  entityHashDocs = await writeDocs(db, [{
    family: 'entity',
    entityId,
    value: projectEntityCoreDoc(state, { signerId: 'bench-signer', isProposer: true }),
  }], entityHashDocs, state.height);
  trace.mark('seed.final-core', { height: state.height, inMemoryAccounts: state.accounts.size });
  return entityHashDocs;
};

const touchAccounts = async (
  cli: Cli,
  db: RuntimeDbLike,
  env: Env,
  entityHashDocsRef: { current: Map<string, StorageEntityHashDoc> },
  entityId: string,
  startIndex: number,
  count: number,
): Promise<number> => {
  const state = Array.from(env.eReplicas.values())[0]!.state;
  const docs: StorageDoc[] = [];
  const limit = Math.min(cli.accounts, startIndex + count);
  env.height = Math.max(0, Math.floor(Number(env.height ?? 0))) + 1;
  env.timestamp = Math.max(0, Math.floor(Number(env.timestamp ?? 0))) + 100;
  state.height = env.height;
  state.timestamp = env.timestamp;
  for (let index = startIndex; index < limit; index += 1) {
    const counterpartyId = normalizeEntityId(randomEntityId(cli.seed, index));
    const account = makeAccount(entityId, counterpartyId, env.height, env.timestamp);
    account.currentFrame.prevFrameHash = `bench-${env.height - 1}`;
    account.currentFrame.stateHash = `0x${createHash('sha256').update(`${env.height}:${counterpartyId}`).digest('hex')}`;
    if (state.accounts.has(counterpartyId)) state.accounts.set(counterpartyId, account);
    docs.push({ family: 'account', entityId, counterpartyId, value: account as StorageAccountDoc });
  }
  docs.push({
    family: 'entity',
    entityId,
    value: projectEntityCoreDoc(state, { signerId: 'bench-signer', isProposer: true }),
  });
  const writeStarted = nowMs();
  entityHashDocsRef.current = await writeDocs(db, docs, entityHashDocsRef.current, env.height);
  return nowMs() - writeStarted;
};

const insertNewAccountsAfterRead = async (
  cli: Cli,
  db: RuntimeDbLike,
  env: Env,
  entityHashDocsRef: { current: Map<string, StorageEntityHashDoc> },
  entityId: string,
  startIndex: number,
  count: number,
): Promise<number> => {
  if (count <= 0) return 0;
  const state = Array.from(env.eReplicas.values())[0]!.state;
  const docs: StorageDoc[] = [];
  env.height = Math.max(0, Math.floor(Number(env.height ?? 0))) + 1;
  env.timestamp = Math.max(0, Math.floor(Number(env.timestamp ?? 0))) + 100;
  state.height = env.height;
  state.timestamp = env.timestamp;
  for (let index = startIndex; index < startIndex + count; index += 1) {
    const counterpartyId = normalizeEntityId(randomEntityId(`${cli.seed}:new-after-read`, index));
    const account = makeAccount(entityId, counterpartyId, env.height, env.timestamp);
    account.currentFrame.prevFrameHash = `bench-${env.height - 1}`;
    account.currentFrame.stateHash = `0x${createHash('sha256').update(`${env.height}:${counterpartyId}`).digest('hex')}`;
    if (cli.memory !== 'none') state.accounts.set(counterpartyId, account);
    docs.push({ family: 'account', entityId, counterpartyId, value: account as StorageAccountDoc });
  }
  docs.push({
    family: 'entity',
    entityId,
    value: projectEntityCoreDoc(state, { signerId: 'bench-signer', isProposer: true }),
  });
  const writeStarted = nowMs();
  entityHashDocsRef.current = await writeDocs(db, docs, entityHashDocsRef.current, env.height);
  return nowMs() - writeStarted;
};

type RotationProbeResult = {
  height: number;
  liveDocs: number;
  snapshotDocs: number;
  snapshotBytes: number;
  snapshotMs: number;
  epochSeedMs: number;
  totalMs: number;
  seedLiveBytes: number;
  seedDocCount: number;
  currentLiveBytes: number;
  historyBytes: number;
  nextLiveBytes: number;
  nextRetainedHistoryBytes: number;
  epochBytes: number;
};

const runSnapshotRotationProbe = async (
  cli: Cli,
  trace: Trace,
  db: RuntimeDbLike,
  dbPath: string,
  env: Env,
): Promise<RotationProbeResult | null> => {
  if (!cli.rotationProbe) return null;
  const historyPath = `${dbPath}-rotation-frames`;
  const nextPath = `${dbPath}-rotation-next`;
  rmSync(historyPath, { recursive: true, force: true });
  rmSync(nextPath, { recursive: true, force: true });

  const historyDb = new Level<Buffer, Buffer>(historyPath, { valueEncoding: 'buffer', keyEncoding: 'binary' });
  const nextDb = new Level<Buffer, Buffer>(nextPath, { valueEncoding: 'buffer', keyEncoding: 'binary' });
  const started = nowMs();
  try {
    await historyDb.open();
    await nextDb.open();
    const head = await readStorageHead(db);
    if (!head) throw new Error('ROTATION_PROBE_HEAD_MISSING');
    const currentStats = await inspectStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
    });
    if (!currentStats) throw new Error('ROTATION_PROBE_CURRENT_STATS_MISSING');
    const liveDocs = currentStats.liveEntityCount + currentStats.liveAccountCount + currentStats.liveBookCount;
    const historyHead: StorageHead = {
      ...head,
      retainSnapshots: cli.rotationRetainSnapshots,
      epochMaxBytes: cli.rotationEpochBytes,
      retainedHistoryBytes: cli.rotationEpochBytes + 1,
    };
    const historyBatch = historyDb.batch();
    historyBatch.put(KEY_HEAD, encodeBuffer(historyHead));
    await writeBatch(historyBatch);

    const snapshotStarted = nowMs();
    const snapshot = await createSnapshot(db, historyDb, head.latestHeight, env.timestamp);
    const snapshotMs = nowMs() - snapshotStarted;
    if (snapshot.docCount !== liveDocs) {
      throw new Error(`ROTATION_PROBE_SNAPSHOT_DOC_MISMATCH: snapshot=${snapshot.docCount} live=${liveDocs}`);
    }

    const seedStarted = nowMs();
    const seed = await seedFreshStorageEpoch({
      sourceDb: db,
      targetDb: nextDb,
      snapshotHeight: head.latestHeight,
    });
    const epochSeedMs = nowMs() - seedStarted;
    const nextHead = await readStorageHead(nextDb);
    if (!nextHead) throw new Error('ROTATION_PROBE_NEXT_HEAD_MISSING');
    if (nextHead.latestSnapshotHeight !== head.latestHeight || nextHead.latestMaterializedHeight !== head.latestHeight) {
      throw new Error(
        `ROTATION_PROBE_NEXT_HEAD_MISMATCH: snapshot=${nextHead.latestSnapshotHeight} materialized=${nextHead.latestMaterializedHeight} expected=${head.latestHeight}`,
      );
    }
    if (nextHead.retainedHistoryBytes !== 0) {
      throw new Error(`ROTATION_PROBE_NEXT_HISTORY_NOT_RESET: retained=${nextHead.retainedHistoryBytes}`);
    }
    const nextStats = await inspectStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => nextDb,
    });
    if (!nextStats) throw new Error('ROTATION_PROBE_NEXT_STATS_MISSING');
    if (
      nextStats.liveEntityCount !== currentStats.liveEntityCount ||
      nextStats.liveAccountCount !== currentStats.liveAccountCount ||
      nextStats.liveBookCount !== currentStats.liveBookCount ||
      nextStats.merkleLeafCount !== currentStats.merkleLeafCount
    ) {
      throw new Error(
        `ROTATION_PROBE_NEXT_LIVE_MISMATCH: current=${currentStats.liveAccountCount}/${currentStats.merkleLeafCount} ` +
          `next=${nextStats.liveAccountCount}/${nextStats.merkleLeafCount}`,
      );
    }
    const historyStats = await inspectStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => historyDb,
    });
    const totalMs = nowMs() - started;
    assertMetricCap('SNAPSHOT_MS', snapshotMs, cli.maxSnapshotMs);
    assertMetricCap('EPOCH_SEED_MS', epochSeedMs, cli.maxEpochSeedMs);
    assertMetricCap('ROTATION_PROBE_MS', totalMs, cli.maxRotationProbeMs);
    const result: RotationProbeResult = {
      height: head.latestHeight,
      liveDocs,
      snapshotDocs: snapshot.docCount,
      snapshotBytes: snapshot.bytes,
      snapshotMs: Math.round(snapshotMs * 1000) / 1000,
      epochSeedMs: Math.round(epochSeedMs * 1000) / 1000,
      totalMs: Math.round(totalMs * 1000) / 1000,
      seedLiveBytes: seed.liveBytes,
      seedDocCount: seed.docCount,
      currentLiveBytes: currentStats.liveBytes,
      historyBytes: historyStats?.historyBytes ?? 0,
      nextLiveBytes: nextStats.liveBytes,
      nextRetainedHistoryBytes: nextHead.retainedHistoryBytes,
      epochBytes: cli.rotationEpochBytes,
    };
    trace.mark('rotation.probe.done', {
      height: result.height,
      liveDocs: result.liveDocs,
      snapshotBytes: result.snapshotBytes,
      snapshotMs: result.snapshotMs,
      epochSeedMs: result.epochSeedMs,
      nextRetainedHistoryBytes: result.nextRetainedHistoryBytes,
    });
    return result;
  } finally {
    try {
      await historyDb.close();
    } catch {}
    try {
      await nextDb.close();
    } catch {}
    if (!cli.keepDb) {
      rmSync(historyPath, { recursive: true, force: true });
      rmSync(nextPath, { recursive: true, force: true });
    }
  }
};

async function main() {
  const cli = readCli();
  const trace = new Trace();
  const entityId = normalizeEntityId(hubEntityId(cli.seed));
  const dbPath = join(cli.dbRoot, entityId.slice(2, 18));

  console.log(`[bench] config ${JSON.stringify({ ...cli, entityId, dbPath })}`);
  if (!cli.keepDb) rmSync(dbPath, { recursive: true, force: true });
  mkdirSync(cli.dbRoot, { recursive: true });

  let db = new Level<Buffer, Buffer>(dbPath, { valueEncoding: 'buffer', keyEncoding: 'binary' });
  const state = makeHubState(entityId, 1, 1_001);
  seedBooks(state, cli.books);
  const env = makeEnv(cli.seed, entityId, state);
  process.env['XLN_RADAPTER_AUTH_SEED'] = cli.seed;
  process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] || String(4 * 1024 * 1024);

  let server: ReturnType<typeof Bun.serve> | null = null;
  const entityHashDocsRef = { current: new Map<string, StorageEntityHashDoc>() };
  let pendingWrite: Promise<number> = Promise.resolve(0);
  const readLatencyMs: number[] = [];
  const touchDurableMs: number[] = [];
  let newAfterReadMs = 0;
  let newAfterReadDurableMs = 0;
  let coldRestartOpenMs = 0;
  let coldRestartReadMs = 0;
  let coldRestartHead: StorageHead | null = null;
  let storageReadHeight = 0;
  let rotationProbeResult: RotationProbeResult | null = null;
  try {
    trace.mark('start');
    entityHashDocsRef.current = cli.seedMode === 'bulk'
      ? await seedHubBulk(cli, trace, db, entityId, state)
      : await seedHub(cli, trace, db, entityId, state);
    env.height = state.height;
    env.timestamp = state.timestamp;
    storageReadHeight = state.height;
    env.height = storageReadHeight + 1;
    env.timestamp += 1;
    trace.mark('storage-read.probe-height', {
      persistedHeight: storageReadHeight,
      runtimeCurrentHeight: env.height,
      storageBackedReason: 'atHeight below current runtime height',
    });
    forceGc(trace, 'post-seed.gc');

    const readHead = async (): Promise<StorageHead | null> => readStorageHead(db);
    const loadEntityViewPage = async (
      targetEnv: Env,
      targetEntityId: string,
      height: number,
      query?: RuntimeAdapterReadQuery,
    ) => loadEntityViewPageFromStorage({
      env: targetEnv,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId: targetEntityId,
      height,
      accountQuery: {
        ...(query?.accountsCursor || query?.cursor ? { cursor: query.accountsCursor ?? query.cursor } : {}),
        ...(query?.accountsLimit !== undefined ? { limit: query.accountsLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
        ...(query?.sortDir ? { sortDir: query.sortDir } : {}),
      },
      bookQuery: {
        ...(query?.booksCursor ? { cursor: query.booksCursor } : {}),
        ...(query?.booksLimit !== undefined ? { limit: query.booksLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
      },
    });

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: cli.port,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === '/rpc' && bunServer.upgrade(request)) return undefined;
        return new Response('XLN radapter 1M hub bench', { status: 200 });
      },
      websocket: {
        async message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
          try {
            const decoded = decodeRuntimeAdapterMessage<Record<string, unknown>>(message);
            await handleRuntimeAdapterMessage(ws, decoded, env, {
              readHead,
              loadEntityAccountDoc: async (
                targetEnv,
                targetEntityId,
                counterpartyId,
                height,
              ) => loadEntityAccountDocFromStorage({
                env: targetEnv,
                tryOpenDb: async () => true,
                getRuntimeDb: () => db,
                entityId: targetEntityId,
                counterpartyId,
                height,
              }),
              loadEntityViewPage,
              listEntityIdsAtHeight: async () => listStorageLiveEntityIds(db),
              enqueueRuntimeInput: (_targetEnv, input: RuntimeInput) => {
                const data = ((input.entityInputs?.[0]?.entityTxs?.[0] as { data?: { start?: number; count?: number } } | undefined)?.data ?? {});
                const start = Math.max(0, Math.floor(Number(data.start ?? 0))) % Math.max(1, cli.hotAccounts);
                const count = Math.max(1, Math.floor(Number(data.count ?? cli.touchPerRound)));
                pendingWrite = pendingWrite
                  .then(() => touchAccounts(cli, db, env, entityHashDocsRef, entityId, start, count))
                  .then(async (durableMs) => {
                    await broadcastRuntimeAdapterTick(env);
                    return durableMs;
                  });
              },
            });
          } catch (error) {
            closeInvalidRuntimeAdapterMessage(ws, error);
          }
        },
        close(ws: ServerWebSocket<unknown>) {
          forgetRuntimeAdapterClient(ws);
        },
      },
    });

    const wsUrl = `ws://127.0.0.1:${server.port}/rpc`;
    trace.mark('server.ready', { wsUrl });

    const adapter = new RemoteRuntimeAdapter();
    const token = deriveRuntimeAdapterCapabilityToken(cli.seed, 'full', Date.now() + 60 * 60 * 1000, {
      audience: String(env.runtimeId || 'radapter-hub-1m'),
      keyId: 'bench',
      tokenId: 'bench-client',
    });
    await adapter.connect({ mode: 'remote', wsUrl, authKey: token, requestTimeoutMs: 30_000 });
    trace.mark('adapter.connected', { height: adapter.currentHeight, authLevel: adapter.authLevel });

    let readStarted = nowMs();
    const first = await adapter.read<{
      height: number;
      activeEntity: { accounts: { items: unknown[]; nextCursor: string | null; totalItems?: number; pageCount?: number } };
    }>('view-frame', { entityId, accountsLimit: cli.pageLimit, booksLimit: cli.pageLimit, atHeight: storageReadHeight });
    readLatencyMs.push(nowMs() - readStarted);
    if (cli.accounts > cli.pageLimit && !first.activeEntity.accounts.nextCursor) {
      throw new Error(`STORAGE_PAGE_CURSOR_MISSING: accounts=${cli.accounts} limit=${cli.pageLimit}`);
    }
    trace.mark('adapter.read.storage.first-page', {
      height: first.height,
      items: first.activeEntity.accounts.items.length,
      nextCursor: first.activeEntity.accounts.nextCursor,
      totalItems: first.activeEntity.accounts.totalItems,
      pageCount: first.activeEntity.accounts.pageCount,
    });

    if (first.activeEntity.accounts.nextCursor) {
      readStarted = nowMs();
      const second = await adapter.read<{
        activeEntity: { accounts: { items: unknown[]; nextCursor: string | null; pageIndex?: number } };
      }>('view-frame', {
        entityId,
        accountsLimit: cli.pageLimit,
        booksLimit: cli.pageLimit,
        accountsCursor: first.activeEntity.accounts.nextCursor,
        atHeight: storageReadHeight,
      });
      readLatencyMs.push(nowMs() - readStarted);
      trace.mark('adapter.read.storage.second-page', {
        items: second.activeEntity.accounts.items.length,
        nextCursor: second.activeEntity.accounts.nextCursor,
        pageIndex: second.activeEntity.accounts.pageIndex,
      });
    }

    readStarted = nowMs();
    const desc = await adapter.read<{
      activeEntity: { accounts: { items: unknown[]; nextCursor: string | null } };
    }>('view-frame', {
      entityId,
      accountsLimit: cli.pageLimit,
      booksLimit: cli.pageLimit,
      sortDir: 'desc',
      atHeight: storageReadHeight,
    });
    readLatencyMs.push(nowMs() - readStarted);
    trace.mark('adapter.read.storage.desc-page', {
      items: desc.activeEntity.accounts.items.length,
      nextCursor: desc.activeEntity.accounts.nextCursor,
    });

    const coldAccountIndex = Math.max(0, cli.accounts - 1);
    const coldAccountId = normalizeEntityId(randomEntityId(cli.seed, coldAccountIndex));
    if (cli.memory === 'hot' && coldAccountIndex >= cli.hotAccounts && state.accounts.has(coldAccountId)) {
      throw new Error(`COLD_ACCOUNT_UNEXPECTEDLY_IN_MEMORY: ${coldAccountId}`);
    }
    readStarted = nowMs();
    const coldAccount = await adapter.read<{
      items: Array<{ rightEntity: string; currentHeight: number }>;
      totalItems?: number;
    }>(`entity/${entityId}/accounts`, {
      accountId: coldAccountId,
      accountsLimit: 1,
      atHeight: storageReadHeight,
    });
    readLatencyMs.push(nowMs() - readStarted);
    if (coldAccount.items[0]?.rightEntity !== coldAccountId) {
      throw new Error(`COLD_ACCOUNT_LOOKUP_MISSING: ${coldAccountId}`);
    }
    trace.mark('adapter.read.storage.cold-account-id', {
      accountId: coldAccountId,
      accountIndex: coldAccountIndex,
      inMemory: state.accounts.has(coldAccountId),
      items: coldAccount.items.length,
      totalItems: coldAccount.totalItems,
    });

    if (cli.books > 0) {
      readStarted = nowMs();
      const booksFirst = await adapter.read<{
        activeEntity: { books: { items: unknown[]; nextCursor: string | null; totalItems?: number; pageCount?: number } };
      }>('view-frame', {
        entityId,
        accountsLimit: 1,
        booksLimit: cli.pageLimit,
        atHeight: storageReadHeight,
      });
      readLatencyMs.push(nowMs() - readStarted);
      trace.mark('adapter.read.storage.books-first-page', {
        items: booksFirst.activeEntity.books.items.length,
        nextCursor: booksFirst.activeEntity.books.nextCursor,
        totalItems: booksFirst.activeEntity.books.totalItems,
        pageCount: booksFirst.activeEntity.books.pageCount,
      });
      if (booksFirst.activeEntity.books.nextCursor) {
        readStarted = nowMs();
        const booksSecond = await adapter.read<{
          activeEntity: { books: { items: unknown[]; nextCursor: string | null; pageIndex?: number } };
        }>('view-frame', {
          entityId,
          accountsLimit: 1,
          booksLimit: cli.pageLimit,
          booksCursor: booksFirst.activeEntity.books.nextCursor,
          atHeight: storageReadHeight,
        });
        readLatencyMs.push(nowMs() - readStarted);
        trace.mark('adapter.read.storage.books-second-page', {
          pageIndex: booksSecond.activeEntity.books.pageIndex,
          items: booksSecond.activeEntity.books.items.length,
          nextCursor: booksSecond.activeEntity.books.nextCursor,
        });
      }
    }

    if (cli.newAfterRead > 0) {
      const started = nowMs();
      newAfterReadDurableMs = await insertNewAccountsAfterRead(cli, db, env, entityHashDocsRef, entityId, cli.accounts, cli.newAfterRead);
      await broadcastRuntimeAdapterTick(env);
      newAfterReadMs = nowMs() - started;
      touchDurableMs.push(newAfterReadDurableMs);
      trace.mark('adapter.write.new-after-read', {
        count: cli.newAfterRead,
        durableMs: Math.round(newAfterReadMs * 1000) / 1000,
        storageWriteMs: Math.round(newAfterReadDurableMs * 1000) / 1000,
        inMemoryAccounts: state.accounts.size,
        height: env.height,
      });
    }

    for (let round = 0; round < cli.trafficRounds; round += 1) {
      const start = (round * cli.touchPerRound) % Math.max(1, cli.hotAccounts);
      const sendStarted = nowMs();
      await adapter.send({
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: 'bench-signer',
          entityTxs: [{ type: 'benchTouchAccounts', data: { start, count: cli.touchPerRound } } as never],
        }],
      });
      const wireMs = nowMs() - sendStarted;
      const durableMs = await pendingWrite;
      touchDurableMs.push(durableMs);
      trace.mark('adapter.send.touch-round', {
        round: round + 1,
        start,
        count: cli.touchPerRound,
        wireMs: Math.round(wireMs * 1000) / 1000,
        durableMs: Math.round(durableMs * 1000) / 1000,
        height: env.height,
      });
    }

    forceGc(trace, 'post-traffic.gc');
    await adapter.disconnect();
    trace.mark('adapter.disconnected');
    server?.stop(true);
    server = null;

    await db.close();
    forceGc(trace, 'cold-restart.before-open.gc');
    db = new Level<Buffer, Buffer>(dbPath, { valueEncoding: 'buffer', keyEncoding: 'binary' });
    const coldOpenStarted = nowMs();
    await db.open();
    coldRestartOpenMs = nowMs() - coldOpenStarted;
    coldRestartHead = await readStorageHead(db);
    trace.mark('cold-restart.open', {
      openMs: Math.round(coldRestartOpenMs * 1000) / 1000,
      latestHeight: coldRestartHead?.latestHeight ?? 0,
      latestMaterializedHeight: coldRestartHead?.latestMaterializedHeight ?? coldRestartHead?.latestSnapshotHeight ?? 0,
    });

    const coldReadStarted = nowMs();
    const coldView = await loadEntityViewPageFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
      height: coldRestartHead?.latestHeight ?? env.height,
      accountQuery: { limit: cli.pageLimit },
      bookQuery: { limit: cli.pageLimit },
    });
    coldRestartReadMs = nowMs() - coldReadStarted;
    trace.mark('cold-restart.read-first-page', {
      readMs: Math.round(coldRestartReadMs * 1000) / 1000,
      accounts: coldView?.accounts.items.length ?? 0,
      books: coldView?.books.items.length ?? 0,
    });
    rotationProbeResult = await runSnapshotRotationProbe(cli, trace, db, dbPath, env);

    const head = coldRestartHead ?? await readStorageHead(db);
    const dbBytes = dirBytes(dbPath);
    const peakRss = Math.max(...trace.events.map(event => event.rss));
    const readLatencySummary = summarizeMs(readLatencyMs);
    const touchDurableSummary = summarizeMs(touchDurableMs);
    if (cli.rssCapBytes > 0 && peakRss > cli.rssCapBytes) {
      throw new Error(`RSS_CAP_EXCEEDED: peak=${peakRss} cap=${cli.rssCapBytes}`);
    }
    assertMetricCap('READ_P99_MS', readLatencySummary['p99'] ?? 0, cli.maxReadP99Ms);
    assertMetricCap('DURABLE_P99_MS', touchDurableSummary['p99'] ?? 0, cli.maxDurableP99Ms);
    assertMetricCap('COLD_OPEN_MS', coldRestartOpenMs, cli.maxColdOpenMs);
    assertMetricCap('COLD_READ_MS', coldRestartReadMs, cli.maxColdReadMs);
    console.log('');
    console.log(JSON.stringify({
      ok: true,
      entityId,
      accounts: cli.accounts,
      hotAccounts: cli.hotAccounts,
      books: cli.books,
      memoryMode: cli.memory,
      dbPath,
      dbBytes,
      dbBytesHuman: formatBytes(dbBytes),
      peakRss,
      peakRssHuman: formatBytes(peakRss),
      rssCapBytes: cli.rssCapBytes,
      rssCapHuman: cli.rssCapBytes > 0 ? formatBytes(cli.rssCapBytes) : null,
      head,
      inMemoryAccounts: state.accounts.size,
      storageReadHeight,
      readLatencyMs: readLatencySummary,
      touchDurableMs: touchDurableSummary,
      newAfterReadMs: Math.round(newAfterReadMs * 1000) / 1000,
      newAfterReadDurableMs: Math.round(newAfterReadDurableMs * 1000) / 1000,
      coldRestart: {
        openMs: Math.round(coldRestartOpenMs * 1000) / 1000,
        readFirstPageMs: Math.round(coldRestartReadMs * 1000) / 1000,
        latestHeight: coldRestartHead?.latestHeight ?? 0,
      },
      rotationProbe: rotationProbeResult,
      events: trace.events,
    }, null, 2));
  } finally {
    try {
      server?.stop(true);
    } catch {}
    try {
      await db.close();
    } catch {}
    if (!cli.keepDb) rmSync(dbPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('bench-radapter-hub-1m failed:', error);
  process.exit(1);
});
