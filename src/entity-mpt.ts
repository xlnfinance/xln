import { MerklePatriciaTrie, createMerkleProof } from '@ethereumjs/mpt';
import { bytesToHex, utf8ToBytes } from '@ethereumjs/util';
import { EntityStorage } from './types.js';
import { Level } from 'level';
import { createLevelDB } from './entity-leveldb.js';
import { encode as snapEncode, decode as snapDecode } from './snapshot-coder.js';

export async function createMPTStorage(path: string): Promise<EntityStorage> {
  const leveldb = new Level(path, { keyEncoding: 'view', valueEncoding: 'view' });
  await leveldb.open();
  const trie = new MerklePatriciaTrie({
    db: createLevelDB(leveldb as any),
  });
  const indexKey = (type: string) => `${type}:_index`;

  const storage: EntityStorage = {
    async get<T>(type: string, key: string): Promise<T | undefined> {
      const value = await trie.get(utf8ToBytes(`${type}:${key}`));
      if (!value) return undefined;
      return snapDecode(Buffer.from(value)) as T;
    },

    async set<T>(type: string, key: string, value: T): Promise<void> {
      // Persist value (supports Map/BigInt via snapshot encoder)
      await trie.put(utf8ToBytes(`${type}:${key}`), snapEncode(value));

      // Maintain per-type index of keys
      const rawIndex = await trie.get(utf8ToBytes(indexKey(type)));
      const keys: string[] = rawIndex ? (snapDecode(Buffer.from(rawIndex)) as string[]) : [];
      if (!keys.includes(key)) {
        keys.push(key);
        await trie.put(utf8ToBytes(indexKey(type)), snapEncode(keys));
      }
    },

    async getRoot(): Promise<string> {
      return bytesToHex(trie.root());
    },

    async getProof(type: string, key: string): Promise<any> {
      return createMerkleProof(trie, Buffer.from(`${type}:${key}`));
    },

    async getAll<T>(type: string): Promise<T[]> {
      const raw = await trie.get(utf8ToBytes(indexKey(type)));
      const keys: string[] = raw ? (snapDecode(Buffer.from(raw)) as string[]) : [];
      const items: T[] = [];
      for (const key of keys) {
        const val = await storage.get<T>(type, key);
        if (val !== undefined) items.push(val);
      }
      return items;
    },

    async clear(type: string): Promise<void> {
      const raw = await trie.get(utf8ToBytes(indexKey(type)));
      const keys: string[] = raw ? (snapDecode(Buffer.from(raw)) as string[]) : [];
      for (const k of keys) {
        await trie.del(utf8ToBytes(`${type}:${k}`));
      }
      await trie.del(utf8ToBytes(indexKey(type)));
    },
  };

  return storage;
}
