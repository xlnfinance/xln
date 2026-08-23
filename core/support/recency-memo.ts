/**
 * Identity memo with recency-bounded retention.
 *
 * Weak collections are prohibited (docs/wal.md §14), and a flat `Map`
 * keyed by object identity pins every historical graph it ever saw. This memo
 * keeps two generations: a hit in the stale generation is promoted, a miss
 * is inserted into the fresh one, and when the fresh generation fills up the
 * stale one is dropped wholesale. An entry therefore survives only while it
 * is touched at least once per `generationSize` insertions, so objects that
 * left the live state are released within two generations.
 */
export class RecencyMemo<K, V> {
  #fresh = new Map<K, V>();
  #stale = new Map<K, V>();
  readonly #generationSize: number;

  constructor(generationSize: number) {
    if (!Number.isSafeInteger(generationSize) || generationSize <= 0) {
      throw new Error(`RECENCY_MEMO_GENERATION_INVALID:${String(generationSize)}`);
    }
    this.#generationSize = generationSize;
  }

  get(key: K): V | undefined {
    const hit = this.#fresh.get(key);
    if (hit !== undefined) return hit;
    const promoted = this.#stale.get(key);
    if (promoted === undefined) return undefined;
    this.#stale.delete(key);
    this.set(key, promoted);
    return promoted;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (!this.#fresh.has(key) && this.#fresh.size >= this.#generationSize) {
      this.#stale = this.#fresh;
      this.#fresh = new Map();
    }
    this.#fresh.set(key, value);
  }

  get size(): number {
    return this.#fresh.size + this.#stale.size;
  }
}

/** Set flavour: membership only. */
export class RecencySet<K> {
  readonly #memo: RecencyMemo<K, true>;

  constructor(generationSize: number) {
    this.#memo = new RecencyMemo(generationSize);
  }

  has(key: K): boolean {
    return this.#memo.has(key);
  }

  add(key: K): void {
    this.#memo.set(key, true);
  }

  get size(): number {
    return this.#memo.size;
  }
}
