import { EntityStorage } from './types.js';
import { createMPTStorage } from './entity-mpt.js';
import { DEBUG } from './utils.js';

// Extended interface for cached storage with additional utility methods
interface CachedEntityStorageInterface extends EntityStorage {
  getCacheStats(): {
    hits: number;
    misses: number;
    writes: number;
    hitRate: string;
    cacheSize: number;
    indexCacheSize: number;
  };
  resetCacheStats(): void;
  invalidateCache(): void;
}

// LRU Cache implementation for entity storage
function createLRUCache<T>(maxSize = 1000) {
  const cache = new Map<string, T>();

  function get(key: string): T | undefined {
    const value = cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      cache.delete(key);
      cache.set(key, value);
    }
    return value;
  }

  function set(key: string, value: T): void {
    // Remove if already exists
    if (cache.has(key)) {
      cache.delete(key);
    }
    // Evict least recently used if at capacity
    else if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey) {
        cache.delete(firstKey);
      }
    }

    cache.set(key, value);
  }

  function deleteKey(key: string): boolean {
    return cache.delete(key);
  }

  function clear(): void {
    cache.clear();
  }

  function size(): number {
    return cache.size;
  }

  // Expose internal cache for compatibility with existing code
  function getInternalCache() {
    return cache;
  }

  return {
    get,
    set,
    delete: deleteKey,
    clear,
    size,
    getInternalCache,
  };
}

export function createCachedEntityStorage(persistentStorage: EntityStorage): CachedEntityStorageInterface {
  const cache = createLRUCache<any>(2000); // Cache up to 2000 items
  const indexCache = createLRUCache<string[]>(100); // Cache type indexes
  let rootCache: string | null = null;
  const cacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
  };

  async function get<T>(type: string, key: string): Promise<T | undefined> {
    const cacheKey = `${type}:${key}`;

    // Try cache first
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      cacheStats.hits++;
      // if (DEBUG) console.log(`🎯 Cache HIT for ${cacheKey}`);
      return cached as T;
    }

    // Cache miss - fetch from persistent storage
    cacheStats.misses++;
    const value = await persistentStorage.get<T>(type, key);

    if (value !== undefined) {
      cache.set(cacheKey, value);
      // if (DEBUG) console.log(`💾 Cache MISS for ${cacheKey}, loaded from disk`);
    }

    return value;
  }

  async function set<T>(type: string, key: string, value: T): Promise<void> {
    const cacheKey = `${type}:${key}`;
    cacheStats.writes++;

    // Write-through: update both cache and persistent storage
    cache.set(cacheKey, value);
    await persistentStorage.set(type, key, value);

    // Invalidate root cache since state changed
    rootCache = null;

    // Invalidate type index cache since we may have added a new key
    indexCache.delete(type);

    // if (DEBUG) console.log(`✍️  Write-through for ${cacheKey}`);
  }

  async function getRoot(): Promise<string> {
    // Cache root hash since it's frequently accessed during consensus
    if (rootCache === null) {
      rootCache = await persistentStorage.getRoot();
      if (DEBUG) console.log(`🌳 Root cache miss, loaded: ${rootCache.slice(0, 16)}...`);
    }
    return rootCache;
  }

  async function getProof(type: string, key: string): Promise<any> {
    // Proofs are always fetched from persistent storage (no caching)
    return persistentStorage.getProof(type, key);
  }

  async function getAll<T>(type: string): Promise<T[]> {
    // Check if we have the index cached
    let keys = indexCache.get(type);
    if (!keys) {
      // Get all keys for this type from persistent storage
      const allItems = await persistentStorage.getAll<T>(type);

      // We need to extract keys somehow - let's fetch the index directly
      // This is a bit hacky but works with current MPT implementation
      const indexKey = `${type}:_index`;
      const cachedIndex = cache.get(indexKey);
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
      const val = await get<T>(type, key);
      if (val !== undefined) items.push(val);
    }
    return items;
  }

  async function clear(type: string): Promise<void> {
    // Clear from persistent storage first
    await persistentStorage.clear(type);

    // Clear cache entries for this type
    const keysToDelete: string[] = [];
    for (const [cacheKey] of cache.getInternalCache()) {
      if (cacheKey.startsWith(`${type}:`)) {
        keysToDelete.push(cacheKey);
      }
    }

    keysToDelete.forEach(key => cache.delete(key));
    indexCache.delete(type);
    rootCache = null; // Invalidate root

    // if (DEBUG) console.log(`🧹 Cleared cache for type: ${type}`);
  }

  // Utility methods for monitoring cache performance
  function getCacheStats() {
    const hitRate = cacheStats.hits / (cacheStats.hits + cacheStats.misses) || 0;
    return {
      ...cacheStats,
      hitRate: (hitRate * 100).toFixed(2) + '%',
      cacheSize: cache.size(),
      indexCacheSize: indexCache.size(),
    };
  }

  function resetCacheStats() {
    cacheStats.hits = 0;
    cacheStats.misses = 0;
    cacheStats.writes = 0;
  }

  // Force cache invalidation (useful for debugging)
  function invalidateCache() {
    cache.clear();
    indexCache.clear();
    rootCache = null;
    // if (DEBUG) console.log('🔄 Cache completely invalidated');
  }

  return {
    get,
    set,
    getRoot,
    getProof,
    getAll,
    clear,
    getCacheStats,
    resetCacheStats,
    invalidateCache,
  };
}

export async function createCachedMPTStorage(path: string): Promise<EntityStorage> {
  const persistentStorage = await createMPTStorage(path);
  return createCachedEntityStorage(persistentStorage);
}

// Backward compatibility: export CachedEntityStorage as an alias to createCachedEntityStorage
export const CachedEntityStorage = createCachedEntityStorage;
