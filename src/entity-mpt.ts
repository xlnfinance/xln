import { MerklePatriciaTrie, createMPT, createMerkleProof } from '@ethereumjs/mpt';
import { MapDB, bytesToHex, utf8ToBytes } from '@ethereumjs/util';
import { EntityStorage } from './types.js';
import { Level } from 'level';
import { LevelDB } from './entity-leveldb.js';

export async function createMPTStorage(path: string): Promise<EntityStorage> {
  const trie = new MerklePatriciaTrie({
    db: new LevelDB(new Level(path)),
  });
  const indexKey = (type: string) => `${type}:_index`;

  const storage: EntityStorage = {
    async get<T>(type: string, key: string): Promise<T | undefined> {
      const value = await trie.get(Buffer.from(`${type}:${key}`));
      return value ? JSON.parse(value.toString(), (key, val) => {
        // Convert string numbers back to BigInt for known BigInt fields
        if ((key === 'threshold' || key === 'shares') && typeof val === 'string' && /^\d+$/.test(val)) {
          return BigInt(val);
        }
        if (key === 'shares' && typeof val === 'object' && val !== null) {
          // Handle shares object with string values
          const shares: { [key: string]: bigint } = {};
          for (const [shareKey, shareVal] of Object.entries(val)) {
            shares[shareKey] = typeof shareVal === 'string' ? BigInt(shareVal) : shareVal as bigint;
          }
          return shares;
        }
        return val;
      }) : undefined;
    },

    async set<T>(type: string, key: string, value: T): Promise<void> {
      await trie.put(Buffer.from(`${type}:${key}`), Buffer.from(JSON.stringify(value, (key, val) => 
        typeof val === 'bigint' ? val.toString() : val
      )));
    },

    async getRoot(): Promise<string> {
      return bytesToHex(trie.root());
    },

    async getProof(type: string, key: string): Promise<any> {
      return createMerkleProof(trie, Buffer.from(`${type}:${key}`));
    },

    async getAll<T>(type: string): Promise<T[]> {
      const raw = await trie.get(utf8ToBytes(indexKey(type)));
      const keys: string[] = raw ? JSON.parse(raw.toString()) : [];
      const items: T[] = [];
      for (const key of keys) {
        const val = await storage.get<T>(type, key);
        if (val !== undefined) items.push(val);
      }
      return items;
    },

    async clear(type: string): Promise<void> {
      const keys = (await storage.getAll<string>(type)) || [];
      for (const key of keys) {
        await trie.del(utf8ToBytes(`${type}:${key}`));
      }
      await trie.del(utf8ToBytes(indexKey(type)));
    },
  };

  return storage;
}
