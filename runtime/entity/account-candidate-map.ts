import { cloneAccountState } from '../account/state-clone';
import type { AccountState } from '../types';

/**
 * Entity consensus must keep the certified Account map untouched while a
 * multi-signer frame waits for Hanko. Copying that entire map is prohibitive
 * for a hub, so a candidate records only Accounts it reads or replaces.
 *
 * `get()` deliberately clones on first access. Account reducers historically
 * mutate nested Maps and arrays after an ordinary lookup; returning a shared
 * certified Account even for an apparently read-only caller would make one
 * missed mutation annotation consensus-critical.
 */
export class EntityAccountCandidateMap extends Map<string, AccountState> {
  readonly #base: Map<string, AccountState>;
  readonly #changes = new Map<string, AccountState>();
  readonly #deleted = new Set<string>();

  constructor(base: Map<string, AccountState>) {
    super();
    if (base instanceof EntityAccountCandidateMap) {
      throw new Error('ENTITY_ACCOUNT_CANDIDATE_NESTED');
    }
    this.#base = base;
  }

  override get size(): number {
    let size = this.#base.size - this.#deleted.size;
    for (const key of this.#changes.keys()) {
      if (!this.#base.has(key)) size += 1;
    }
    return size;
  }

  override has(key: string): boolean {
    return !this.#deleted.has(key) &&
      (this.#changes.has(key) || this.#base.has(key));
  }

  override get(key: string): AccountState | undefined {
    if (this.#deleted.has(key)) return undefined;
    const changed = this.#changes.get(key);
    if (changed) return changed;
    const certified = this.#base.get(key);
    if (!certified) return undefined;
    const candidate = cloneAccountState(certified);
    this.#changes.set(key, candidate);
    return candidate;
  }

  override set(key: string, value: AccountState): this {
    this.#deleted.delete(key);
    this.#changes.set(key, value);
    return this;
  }

  override delete(key: string): boolean {
    const existed = this.has(key);
    this.#changes.delete(key);
    if (this.#base.has(key)) this.#deleted.add(key);
    return existed;
  }

  override clear(): void {
    this.#changes.clear();
    for (const key of this.#base.keys()) this.#deleted.add(key);
  }

  override *keys(): MapIterator<string> {
    for (const key of this.#base.keys()) {
      if (!this.#deleted.has(key)) yield key;
    }
    for (const key of this.#changes.keys()) {
      if (!this.#base.has(key)) yield key;
    }
  }

  override *values(): MapIterator<AccountState> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value) yield value;
    }
  }

  override *entries(): MapIterator<[string, AccountState]> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value) yield [key, value];
    }
  }

  override [Symbol.iterator](): MapIterator<[string, AccountState]> {
    return this.entries();
  }

  override forEach(
    callback: (
      value: AccountState,
      key: string,
      map: Map<string, AccountState>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }

  /** Build a detached native Map for snapshots without changing certified State. */
  snapshot(): Map<string, AccountState> {
    return new Map(this.entries());
  }

  /**
   * Promote at the single commit point. Mutating the old certified Map is safe
   * only here: the frame is already certified, and a later Runtime WAL failure
   * halts and reloads durable truth instead of exposing or rolling back RAM.
   */
  commit(): Map<string, AccountState> {
    for (const key of this.#deleted) this.#base.delete(key);
    for (const [key, account] of this.#changes) {
      this.#base.set(key, account);
    }
    return this.#base;
  }

  stats(): Readonly<{ base: number; changed: number; deleted: number }> {
    return {
      base: this.#base.size,
      changed: this.#changes.size,
      deleted: this.#deleted.size,
    };
  }
}

export const createEntityAccountCandidateMap = (
  accounts: Map<string, AccountState>,
): EntityAccountCandidateMap => new EntityAccountCandidateMap(accounts);

export const snapshotEntityAccountMap = (
  accounts: Map<string, AccountState>,
): Map<string, AccountState> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.snapshot()
    : accounts;

export const commitEntityAccountCandidate = (
  accounts: Map<string, AccountState>,
): Map<string, AccountState> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.commit()
    : accounts;
