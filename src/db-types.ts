/**
 * XLN Database Types
 *
 * Sovereign type definitions for database layer.
 * No 'any' types allowed.
 */

import type { Level } from 'level';

/**
 * XLN uses LevelDB for persistent storage
 * Key and value encodings are Buffer for efficiency
 */
export type XLNDatabase = Level<Buffer, Buffer>;

/**
 * Database key prefixes for different domains
 * Each domain is sovereign with its own keyspace
 */
export enum DBPrefix {
  ENTITY_STATE = 'entity:state:',
  ENTITY_PROFILE = 'entity:profile:',
  NAME_INDEX = 'name:index:',
  CHANNEL_STATE = 'channel:state:',
  ACCOUNT_STATE = 'account:state:',
  J_BLOCK = 'j:block:',
  SNAPSHOT = 'snapshot:',
  ORDERBOOK = 'orderbook:'
}

/**
 * Helper to create prefixed keys
 */
export function createDBKey(prefix: DBPrefix, id: string): Buffer {
  return Buffer.from(`${prefix}${id}`);
}

/**
 * Helper to parse prefixed keys
 */
export function parseDBKey(key: Buffer): { prefix: string; id: string } {
  const keyStr = key.toString();
  const colonIndex = keyStr.lastIndexOf(':');
  if (colonIndex === -1) {
    return { prefix: '', id: keyStr };
  }
  return {
    prefix: keyStr.substring(0, colonIndex + 1),
    id: keyStr.substring(colonIndex + 1)
  };
}