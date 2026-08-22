import { ethers } from 'ethers';

import type { AccountReplica } from '../../types/account';
import {
  PersistentRadixValueMap,
  type RadixFoldMutation,
} from '../../protocol/state/persistent-radix-value-map';
import { createStructuredLogger } from '../../support/logger';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { sealCommittedAccountValue } from '../../account/state/commitment/value-seal';
import { observePerfCount } from '../../support/performance/profile';
import {
  ACCOUNT_WORK_PENDING,
  ACCOUNT_WORK_QUEUED,
  ACCOUNT_WORK_REBALANCE,
  accountWorkMaskHas,
  classifyAccountWork,
  type AccountWorkFlag,
  type AccountWorkMask,
} from '../account/account-work-flags';

const candidateLog = createStructuredLogger('entity.account.candidate');

export type AccountValueHash = (account: AccountReplica) => string;
export type EntityAccountDirtyMutation = RadixFoldMutation<string, AccountReplica>;

const ACCOUNT_RADIX = 16 as const;
const ZERO_VALUE_HASH = `0x${'00'.repeat(32)}`;

// Every Account lookup re-parses the 32-byte counterparty id from hex; the
// id set is small and stable, so memoize the parsed bytes. Callers that store
// key bytes copy them (makeRadixLeaf / fold), lookups only read.
const ACCOUNT_KEY_BYTES_MEMO_MAX = 8192;
const accountKeyBytesMemo = new Map<string, Uint8Array>();
const accountKeyBytes = (entityId: string): Uint8Array => {
  const normalized = entityId.trim().toLowerCase();
  const cached = accountKeyBytesMemo.get(normalized);
  if (cached) return cached;
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`PERSISTENT_ENTITY_ACCOUNT_ID_INVALID:${entityId}`);
  }
  const bytes = ethers.getBytes(normalized);
  if (accountKeyBytesMemo.size >= ACCOUNT_KEY_BYTES_MEMO_MAX) accountKeyBytesMemo.clear();
  accountKeyBytesMemo.set(normalized, bytes);
  return bytes;
};

const accountMapOptions = (valueHash: AccountValueHash) => ({
  radix: ACCOUNT_RADIX,
  ownKey: (entityId: string): string => entityId.trim().toLowerCase(),
  keyBytes: accountKeyBytes,
  valueHash,
  ownValue: sealCommittedAccountValue,
});

const workMapOptions = () => ({
  radix: ACCOUNT_RADIX,
  ownKey: (entityId: string): string => entityId.trim().toLowerCase(),
  keyBytes: accountKeyBytes,
  valueHash: (_value: AccountWorkMask): string => ZERO_VALUE_HASH,
  ownValue: (value: AccountWorkMask): AccountWorkMask => value,
  commitment: false,
});

type AccountWorkCounts = Readonly<{
  queued: number;
  pending: number;
  rebalance: number;
}>;

const emptyWorkCounts = (): AccountWorkCounts => ({ queued: 0, pending: 0, rebalance: 0 });

const countWorkMasks = (masks: Iterable<AccountWorkMask>): AccountWorkCounts => {
  let queued = 0;
  let pending = 0;
  let rebalance = 0;
  for (const mask of masks) {
    if (accountWorkMaskHas(mask, ACCOUNT_WORK_QUEUED)) queued += 1;
    if (accountWorkMaskHas(mask, ACCOUNT_WORK_PENDING)) pending += 1;
    if (accountWorkMaskHas(mask, ACCOUNT_WORK_REBALANCE)) rebalance += 1;
  }
  return { queued, pending, rebalance };
};

const updateWorkCount = (
  count: number,
  previous: AccountWorkMask | undefined,
  next: AccountWorkMask | undefined,
  flag: AccountWorkFlag,
): number => count - Number(accountWorkMaskHas(previous, flag)) + Number(accountWorkMaskHas(next, flag));

/** Typed committed view over the one Account value+Merkle radix. */
export class PersistentEntityAccountMap implements ReadonlyMap<string, AccountReplica> {
  readonly #values: PersistentRadixValueMap<string, AccountReplica>;
  readonly #work: PersistentRadixValueMap<string, AccountWorkMask>;
  readonly #workCounts: AccountWorkCounts;
  readonly #ownerEntityId: string;
  readonly #valueHash: AccountValueHash;

  private constructor(
    values: PersistentRadixValueMap<string, AccountReplica>,
    work: PersistentRadixValueMap<string, AccountWorkMask>,
    workCounts: AccountWorkCounts,
    ownerEntityId: string,
    valueHash: AccountValueHash,
  ) {
    this.#values = values;
    this.#work = work;
    this.#workCounts = workCounts;
    this.#ownerEntityId = ownerEntityId.trim().toLowerCase();
    this.#valueHash = valueHash;
  }

  /** O(n) is permitted only at genesis/recovery/offline migration. */
  static fromMap(
    source: ReadonlyMap<string, AccountReplica>,
    ownerEntityId: string,
    valueHash: AccountValueHash,
  ): PersistentEntityAccountMap {
    return PersistentEntityAccountMap.fromEntries(source, ownerEntityId, valueHash);
  }

  /** Cold boundary builder; the resulting Patricia map is the live value store. */
  static fromEntries(
    source: Iterable<readonly [string, AccountReplica]>,
    ownerEntityId: string,
    valueHash: AccountValueHash,
  ): PersistentEntityAccountMap {
    const values = PersistentRadixValueMap.fromMap(source, accountMapOptions(valueHash));
    const work = new Map<string, AccountWorkMask>();
    for (const [counterpartyId, account] of values) {
      const mask = classifyAccountWork(ownerEntityId, counterpartyId, account);
      if (mask !== 0) work.set(counterpartyId, mask);
    }
    return new PersistentEntityAccountMap(
      values,
      PersistentRadixValueMap.fromMap(work, workMapOptions()),
      countWorkMasks(work.values()),
      ownerEntityId,
      valueHash,
    );
  }

  static empty(ownerEntityId: string, valueHash: AccountValueHash): PersistentEntityAccountMap {
    return new PersistentEntityAccountMap(
      PersistentRadixValueMap.empty(accountMapOptions(valueHash)),
      PersistentRadixValueMap.empty(workMapOptions()),
      emptyWorkCounts(),
      ownerEntityId,
      valueHash,
    );
  }

  /** Entity whose scheduler owns this Account index. */
  get ownerEntityId(): string {
    return this.#ownerEntityId;
  }

  updated(
    entityId: string,
    account: AccountReplica,
  ): PersistentEntityAccountMap {
    const previous = this.#work.get(entityId);
    const next = classifyAccountWork(this.#ownerEntityId, entityId, account);
    const work = next === 0 ? this.#work.removed(entityId) : this.#work.updated(entityId, next);
    return new PersistentEntityAccountMap(
      this.#values.updated(entityId, account),
      work,
      {
        queued: updateWorkCount(this.#workCounts.queued, previous, next || undefined, ACCOUNT_WORK_QUEUED),
        pending: updateWorkCount(this.#workCounts.pending, previous, next || undefined, ACCOUNT_WORK_PENDING),
        rebalance: updateWorkCount(this.#workCounts.rebalance, previous, next || undefined, ACCOUNT_WORK_REBALANCE),
      },
      this.#ownerEntityId,
      this.#valueHash,
    );
  }

  removed(entityId: string): PersistentEntityAccountMap {
    const previous = this.#work.get(entityId);
    return new PersistentEntityAccountMap(
      this.#values.removed(entityId),
      this.#work.removed(entityId),
      {
        queued: updateWorkCount(this.#workCounts.queued, previous, undefined, ACCOUNT_WORK_QUEUED),
        pending: updateWorkCount(this.#workCounts.pending, previous, undefined, ACCOUNT_WORK_PENDING),
        rebalance: updateWorkCount(this.#workCounts.rebalance, previous, undefined, ACCOUNT_WORK_REBALANCE),
      },
      this.#ownerEntityId,
      this.#valueHash,
    );
  }

  /**
   * Publish one Entity-frame Account overlay with two Patricia folds: the
   * committed Account values and their RAM-only scheduler masks. Repeating
   * `updated()` per dirty Account would allocate the shared ancestor path for
   * every mutation; one fold groups all dirty children before path-copy.
   */
  foldDirty(
    mutations: Iterable<EntityAccountDirtyMutation>,
    reset = false,
  ): PersistentEntityAccountMap {
    const last = new Map<string, EntityAccountDirtyMutation>();
    for (const mutation of mutations) {
      const entityId = mutation.key.trim().toLowerCase();
      last.set(entityId, mutation.kind === 'put'
        ? { kind: 'put', key: entityId, value: mutation.value }
        : { kind: 'delete', key: entityId });
    }
    const ordered = [...last.values()].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const workBase = reset ? this.#work.emptied() : this.#work;
    let counts = reset ? emptyWorkCounts() : this.#workCounts;
    const workMutations: RadixFoldMutation<string, AccountWorkMask>[] = [];
    for (const mutation of ordered) {
      const previous = workBase.get(mutation.key);
      const next = mutation.kind === 'put'
        ? classifyAccountWork(this.#ownerEntityId, mutation.key, mutation.value)
        : 0;
      workMutations.push(next === 0
        ? { kind: 'delete', key: mutation.key }
        : { kind: 'put', key: mutation.key, value: next });
      counts = {
        queued: updateWorkCount(counts.queued, previous, next || undefined, ACCOUNT_WORK_QUEUED),
        pending: updateWorkCount(counts.pending, previous, next || undefined, ACCOUNT_WORK_PENDING),
        rebalance: updateWorkCount(counts.rebalance, previous, next || undefined, ACCOUNT_WORK_REBALANCE),
      };
    }
    return new PersistentEntityAccountMap(
      this.#values.foldMutations(ordered, reset),
      this.#work.foldMutations(workMutations, reset),
      counts,
      this.#ownerEntityId,
      this.#valueHash,
    );
  }

  emptied(): PersistentEntityAccountMap {
    return new PersistentEntityAccountMap(
      this.#values.emptied(),
      this.#work.emptied(),
      emptyWorkCounts(),
      this.#ownerEntityId,
      this.#valueHash,
    );
  }

  workMask(entityId: string): AccountWorkMask | undefined {
    return this.#work.get(entityId);
  }

  workCount(flag: AccountWorkFlag): number {
    if (flag === ACCOUNT_WORK_QUEUED) return this.#workCounts.queued;
    if (flag === ACCOUNT_WORK_PENDING) return this.#workCounts.pending;
    return this.#workCounts.rebalance;
  }

  *workKeys(flag: AccountWorkFlag): IterableIterator<string> {
    for (const [entityId, mask] of this.#work) {
      if (accountWorkMaskHas(mask, flag)) yield entityId;
    }
  }

  rootHash(): string {
    return this.#values.rootHash();
  }

  get hash(): string {
    return this.rootHash();
  }

  get size(): number {
    return this.#values.size;
  }

  get(entityId: string): AccountReplica | undefined {
    return this.#values.get(entityId);
  }

  has(entityId: string): boolean {
    return this.#values.has(entityId);
  }

  entries(): MapIterator<[string, AccountReplica]> {
    return this.#values.entries();
  }

  keys(): MapIterator<string> {
    return this.#values.keys();
  }

  values(): MapIterator<AccountReplica> {
    return this.#values.values();
  }

  [Symbol.iterator](): MapIterator<[string, AccountReplica]> {
    return this.entries();
  }

  forEach(
    callback: (value: AccountReplica, key: string, map: ReadonlyMap<string, AccountReplica>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

}

/**
 * Entity-frame overlay. Owns a bounded writable AccountReplica shell per
 * written Account and shares committed PersistentAccountStateMap roots.
 */
export class EntityAccountCandidateMap implements ReadonlyMap<string, AccountReplica> {
  readonly #base: PersistentEntityAccountMap;
  readonly #shells = new Map<string, AccountReplica>();
  readonly #deleted = new Set<string>();
  #cleared = false;
  #active = true;
  // Projection of the current shells; every write boundary drops it. Hashing
  // the same candidate twice per frame (commitments + seal) must not re-hash
  // every dirty Account leaf.
  #projection: PersistentEntityAccountMap | undefined;
  // Operational conflict clock for speculative Account-machine jobs. It is
  // deliberately outside committed state: worker completion order must never
  // affect Entity bytes, while every claimed/replaced Account invalidates a
  // result prepared from an older shell.
  readonly #revisions = new Map<string, number>();
  #clearRevision = 0;
  #mutationClock = 0;

  constructor(base: PersistentEntityAccountMap) {
    this.#base = base;
  }

  get size(): number {
    if (this.#cleared) return this.#shells.size;
    let size = this.#base.size - this.#deleted.size;
    for (const entityId of this.#shells.keys()) {
      if (!this.#base.has(entityId)) size += 1;
    }
    return size;
  }

  get(entityId: string): AccountReplica | undefined {
    this.#requireActive();
    if (this.#deleted.has(entityId)) return undefined;
    const shell = this.#shells.get(entityId);
    if (shell) return shell;
    return this.#cleared ? undefined : this.#base.get(entityId);
  }

  getForWrite(entityId: string): AccountReplica | undefined {
    this.#requireActive();
    this.#projection = undefined;
    if (this.#deleted.has(entityId)) return undefined;
    const existing = this.#shells.get(entityId);
    if (existing) {
      this.#bumpRevision(entityId);
      if (existing === this.#base.get(entityId)) {
        const shell = forkAccountReplicaShell(existing);
        this.#shells.set(entityId, shell);
        candidateLog.debug('account.claimed_resealed', { entityId: entityId.slice(-8) });
        return shell;
      }
      return existing;
    }
    if (this.#cleared) return undefined;
    const committed = this.#base.get(entityId);
    if (!committed) return undefined;
    this.#bumpRevision(entityId);
    const shell = forkAccountReplicaShell(committed);
    this.#shells.set(entityId, shell);
    candidateLog.debug('account.claimed', { entityId: entityId.slice(-8), height: shell.currentHeight });
    return shell;
  }

  has(entityId: string): boolean {
    this.#requireActive();
    if (this.#deleted.has(entityId)) return false;
    return this.#shells.has(entityId) || (!this.#cleared && this.#base.has(entityId));
  }

  set(entityId: string, account: AccountReplica): this {
    this.#requireActive();
    this.#projection = undefined;
    this.#deleted.delete(entityId);
    this.#shells.set(entityId, account);
    this.#bumpRevision(entityId);
    candidateLog.debug('account.replaced', { entityId: entityId.slice(-8), height: account.currentHeight });
    return this;
  }

  delete(entityId: string): boolean {
    this.#requireActive();
    this.#projection = undefined;
    const existed = this.has(entityId);
    this.#shells.delete(entityId);
    if (!this.#cleared && this.#base.has(entityId)) this.#deleted.add(entityId);
    if (existed) this.#bumpRevision(entityId);
    return existed;
  }

  clear(): void {
    this.#requireActive();
    this.#projection = undefined;
    this.#shells.clear();
    this.#deleted.clear();
    this.#cleared = true;
    this.#mutationClock += 1;
    this.#clearRevision = this.#mutationClock;
  }

  *entries(): MapIterator<[string, AccountReplica]> {
    this.#requireActive();
    if (!this.#cleared) {
      for (const [entityId, account] of this.#base.entries()) {
        if (this.#deleted.has(entityId)) continue;
        yield [entityId, this.#shells.get(entityId) ?? account];
      }
    }
    for (const [entityId, account] of this.#shells) {
      if (!this.#cleared && this.#base.has(entityId)) continue;
      yield [entityId, account];
    }
  }

  *keys(): MapIterator<string> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<AccountReplica> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[string, AccountReplica]> {
    return this.entries();
  }

  forEach(
    callback: (value: AccountReplica, key: string, map: ReadonlyMap<string, AccountReplica>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

  rootHash(): string {
    return this.snapshotCandidate().rootHash();
  }

  snapshotCandidate(): PersistentEntityAccountMap {
    this.#requireActive();
    this.#projection ??= this.#project(false);
    return this.#projection;
  }

  /** Hash/seal after in-place envelope mutation must not reuse a stale fork. */
  dropCachedProjection(): void {
    this.#requireActive();
    this.#projection = undefined;
  }

  getCertifiedBase(entityId: string): AccountReplica | undefined {
    return this.#cleared ? undefined : this.#base.get(entityId);
  }

  sealCandidate(): PersistentEntityAccountMap {
    // Fold dirty Account shells into the Patricia base. Hash stays lazy until
    // `.hash` / `rootHash()` is read at the Entity state-root boundary.
    const committed = this.#projection ?? this.#project(true);
    this.#active = false;
    candidateLog.debug('candidate.sealed', {
      base: this.#base.size,
      changed: this.#shells.size,
      deleted: this.#deleted.size,
    });
    return committed;
  }

  get hash(): string {
    return this.rootHash();
  }

  dirtyKeys(): ReadonlySet<string> {
    return new Set([...this.#shells.keys(), ...this.#deleted]);
  }

  /** Exact frame-local revision used only to reject stale worker results. */
  revision(entityId: string): number {
    this.#requireActive();
    return Math.max(this.#clearRevision, this.#revisions.get(entityId) ?? 0);
  }

  workMask(entityId: string): AccountWorkMask | undefined {
    if (this.#deleted.has(entityId)) return undefined;
    const account = this.#shells.get(entityId);
    if (account) return classifyAccountWork(this.#base.ownerEntityId, entityId, account) || undefined;
    return this.#cleared ? undefined : this.#base.workMask(entityId);
  }

  workCount(flag: AccountWorkFlag): number {
    if (this.#cleared) {
      let count = 0;
      for (const [entityId, account] of this.#shells) {
        if (accountWorkMaskHas(classifyAccountWork(this.#base.ownerEntityId, entityId, account), flag)) count += 1;
      }
      return count;
    }
    let count = this.#base.workCount(flag);
    for (const entityId of this.dirtyKeys()) {
      count -= Number(accountWorkMaskHas(this.#base.workMask(entityId), flag));
      count += Number(accountWorkMaskHas(this.workMask(entityId), flag));
    }
    return count;
  }

  *workKeys(flag: AccountWorkFlag): IterableIterator<string> {
    const keys = new Set<string>();
    if (!this.#cleared) {
      for (const entityId of this.#base.workKeys(flag)) {
        if (!this.#deleted.has(entityId) && !this.#shells.has(entityId)) keys.add(entityId);
      }
    }
    for (const entityId of this.#shells.keys()) {
      if (accountWorkMaskHas(this.workMask(entityId), flag)) keys.add(entityId);
    }
    yield* [...keys].sort();
  }

  stats(): Readonly<{ base: number; changed: number; deleted: number }> {
    return {
      base: this.#base.size,
      changed: this.#shells.size,
      deleted: this.#deleted.size,
    };
  }

  #project(finalize: boolean): PersistentEntityAccountMap {
    this.#requireActive();
    const mutations: EntityAccountDirtyMutation[] = [...this.#deleted]
      .sort()
      .map(entityId => ({ kind: 'delete', key: entityId }));
    for (const [entityId, account] of [...this.#shells].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)) {
      mutations.push({
        kind: 'put',
        key: entityId,
        value: finalize ? account : forkAccountReplicaShell(account),
      });
    }
    observePerfCount('entity.accountProjection.calls');
    observePerfCount('entity.accountProjection.mutations', mutations.length);
    observePerfCount(
      finalize ? 'entity.accountProjection.finalize' : 'entity.accountProjection.snapshot',
    );
    return this.#base.foldDirty(mutations, this.#cleared);
  }

  #requireActive(): void {
    if (!this.#active) throw new Error('ENTITY_ACCOUNT_CANDIDATE_SEALED');
  }

  #bumpRevision(entityId: string): void {
    this.#mutationClock += 1;
    this.#revisions.set(entityId, this.#mutationClock);
  }

}

export const ENTITY_ACCOUNT_VALUE_MAP_RADIX = ACCOUNT_RADIX;

export type EntityAccountMap = PersistentEntityAccountMap | EntityAccountCandidateMap;

/** Entity-frame-only publication; committed Account roots reject mutation. */
export const putEntityAccountCandidate = (
  accounts: EntityAccountMap,
  entityId: string,
  account: AccountReplica,
): void => {
  if (!(accounts instanceof EntityAccountCandidateMap)) {
    throw new Error('ENTITY_ACCOUNT_WRITE_OUTSIDE_CANDIDATE');
  }
  accounts.set(entityId, account);
};

/** Named write boundary. Committed get() never allocates a shell. */
export const getEntityAccountForWrite = (
  accounts: EntityAccountMap,
  entityId: string,
): AccountReplica | undefined => {
  if (!(accounts instanceof EntityAccountCandidateMap)) {
    throw new Error('ENTITY_ACCOUNT_WRITE_OUTSIDE_CANDIDATE');
  }
  return accounts.getForWrite(entityId);
};
