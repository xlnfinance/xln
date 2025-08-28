import { EntityStorage } from './types.js';
import { createMPTStorage } from './entity-mpt.js';
import { DEBUG } from './utils.js';

// LRU Cache implementation for entity storage
class LRUCache<T> {
  private cache = new Map<string, T>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // Remove if already exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict least recently used if at capacity
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    
    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export class CachedEntityStorage implements EntityStorage {
  private persistentStorage: EntityStorage;
  private cache = new LRUCache<any>(2000); // Cache up to 2000 items
  private indexCache = new LRUCache<string[]>(100); // Cache type indexes
  private rootCache: string | null = null;
  private cacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
  };

  constructor(persistentStorage: EntityStorage) {
    this.persistentStorage = persistentStorage;
  }

  async get<T>(type: string, key: string): Promise<T | undefined> {
    const cacheKey = `${type}:${key}`;
    
    // Try cache first
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.cacheStats.hits++;
      if (DEBUG) console.log(`🎯 Cache HIT for ${cacheKey}`);
      return cached as T;
    }

    // Cache miss - fetch from persistent storage
    this.cacheStats.misses++;
    const value = await this.persistentStorage.get<T>(type, key);
    
    if (value !== undefined) {
      this.cache.set(cacheKey, value);
      if (DEBUG) console.log(`💾 Cache MISS for ${cacheKey}, loaded from disk`);
    }
    
    return value;
  }

  async set<T>(type: string, key: string, value: T): Promise<void> {
    const cacheKey = `${type}:${key}`;
    this.cacheStats.writes++;

    // Write-through: update both cache and persistent storage
    this.cache.set(cacheKey, value);
    await this.persistentStorage.set(type, key, value);

    // Invalidate root cache since state changed
    this.rootCache = null;
    
    // Invalidate type index cache since we may have added a new key
    this.indexCache.delete(type);

    if (DEBUG) console.log(`✍️  Write-through for ${cacheKey}`);
  }

  async getRoot(): Promise<string> {
    // Cache root hash since it's frequently accessed during consensus
    if (this.rootCache === null) {
      this.rootCache = await this.persistentStorage.getRoot();
      if (DEBUG) console.log(`🌳 Root cache miss, loaded: ${this.rootCache.slice(0, 16)}...`);
    }
    return this.rootCache;
  }

  async getProof(type: string, key: string): Promise<any> {
    // Proofs are always fetched from persistent storage (no caching)
    return this.persistentStorage.getProof(type, key);
  }

  async getAll<T>(type: string): Promise<T[]> {
    // Check if we have the index cached
    let keys = this.indexCache.get(type);
    if (!keys) {
      // Get all keys for this type from persistent storage
      const allItems = await this.persistentStorage.getAll<T>(type);
      
      // We need to extract keys somehow - let's fetch the index directly
      // This is a bit hacky but works with current MPT implementation
      const indexKey = `${type}:_index`;
      const cachedIndex = this.cache.get(indexKey);
      if (cachedIndex) {
        keys = cachedIndex as string[];
      } else {
        // Fallback: return what persistent storage gave us
        return allItems;
      }
    }

    // Fetch each item, utilizing cache
    const items: T[] = [];
    for (const key of keys) {
      const val = await this.get<T>(type, key);
      if (val !== undefined) items.push(val);
    }
    return items;
  }

  async clear(type: string): Promise<void> {
    // Clear from persistent storage first
    await this.persistentStorage.clear(type);

    // Clear cache entries for this type
    const keysToDelete: string[] = [];
    for (const [cacheKey] of this.cache['cache']) {
      if (cacheKey.startsWith(`${type}:`)) {
        keysToDelete.push(cacheKey);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
    this.indexCache.delete(type);
    this.rootCache = null; // Invalidate root

    if (DEBUG) console.log(`🧹 Cleared cache for type: ${type}`);
  }

  // Utility methods for monitoring cache performance
  getCacheStats() {
    const hitRate = this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) || 0;
    return {
      ...this.cacheStats,
      hitRate: (hitRate * 100).toFixed(2) + '%',
      cacheSize: this.cache.size(),
      indexCacheSize: this.indexCache.size(),
    };
  }

  resetCacheStats() {
    this.cacheStats = { hits: 0, misses: 0, writes: 0 };
  }

  // Force cache invalidation (useful for debugging)
  invalidateCache() {
    this.cache.clear();
    this.indexCache.clear();
    this.rootCache = null;
    if (DEBUG) console.log('🔄 Cache completely invalidated');
  }
}

export async function createCachedMPTStorage(path: string): Promise<EntityStorage> {
  const persistentStorage = await createMPTStorage(path);
  return new CachedEntityStorage(persistentStorage);
}
