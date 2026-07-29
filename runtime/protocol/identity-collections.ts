import {
  formatReplicaKey,
  parseReplicaKey,
  type EntityId,
  type ReplicaKey,
} from './identity';

/** Map wrapper that preserves the canonical `entityId:signerId` storage key. */
export class ReplicaMap<T> {
  private readonly map = new Map<string, T>();

  get(key: ReplicaKey): T | undefined { return this.map.get(formatReplicaKey(key)); }
  set(key: ReplicaKey, value: T): this {
    this.map.set(formatReplicaKey(key), value);
    return this;
  }
  has(key: ReplicaKey): boolean { return this.map.has(formatReplicaKey(key)); }
  delete(key: ReplicaKey): boolean { return this.map.delete(formatReplicaKey(key)); }
  get size(): number { return this.map.size; }

  *entries(): IterableIterator<[ReplicaKey, T]> {
    for (const [key, value] of this.map.entries()) {
      yield [parseReplicaKey(key), value];
    }
  }
  *keys(): IterableIterator<ReplicaKey> {
    for (const key of this.map.keys()) yield parseReplicaKey(key);
  }
  *values(): IterableIterator<T> { yield* this.map.values(); }
  forEach(callback: (value: T, key: ReplicaKey, map: ReplicaMap<T>) => void): void {
    this.map.forEach((value, key) => callback(value, parseReplicaKey(key), this));
  }
  toMap(): Map<string, T> { return new Map(this.map); }

  static fromMap<T>(map: Map<string, T>): ReplicaMap<T> {
    const replicas = new ReplicaMap<T>();
    for (const [key, value] of map.entries()) replicas.map.set(key, value);
    return replicas;
  }
}

export class EntityMap<T> {
  private readonly map = new Map<EntityId, T>();

  get(key: EntityId): T | undefined { return this.map.get(key); }
  set(key: EntityId, value: T): this {
    this.map.set(key, value);
    return this;
  }
  has(key: EntityId): boolean { return this.map.has(key); }
  delete(key: EntityId): boolean { return this.map.delete(key); }
  get size(): number { return this.map.size; }
  *entries(): IterableIterator<[EntityId, T]> { yield* this.map.entries(); }
  *keys(): IterableIterator<EntityId> { yield* this.map.keys(); }
  *values(): IterableIterator<T> { yield* this.map.values(); }
  forEach(callback: (value: T, key: EntityId, map: EntityMap<T>) => void): void {
    this.map.forEach((value, key) => callback(value, key, this));
  }
}
