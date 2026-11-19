import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { Level } from 'level';
import { deriveSignerAddressSync } from '../../../../../core/account/crypto';
import { readStorageHead } from '../../../../../core/storage';
import { readVaultSeed } from '../../identities';
import { sessionRoles, type SessionConfig } from './config';

const library =
  process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
if (!library) throw new Error('USDC_SESSION_LOCK_PLATFORM_UNSUPPORTED');
const native = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });

/** Host ownership only, never recovery state. Never unlink this inode; the
 * kernel releases its descriptor lock on exit, including SIGKILL. */
export const acquireStoreOwnership = (stores: readonly (readonly [string, string])[]): (() => void) => {
  const descriptors: number[] = [];
  try {
    for (const [role, path] of stores) {
      const fd = openSync(join(path, '.poc-owner.lock'), 'a', 0o600);
      descriptors.push(fd);
      if (native.symbols.flock(fd, 2 | 4) !== 0) throw new Error(`USDC_SESSION_STORE_BUSY:${role}`);
    }
  } catch (error) {
    for (const fd of descriptors.reverse()) closeSync(fd);
    throw error;
  }
  return () => {
    for (const fd of descriptors.reverse()) closeSync(fd);
  };
};

export const acquireSessionStores = (config: SessionConfig): (() => void) =>
  acquireStoreOwnership(sessionRoles(config).map(role => [role, config.stores[role]] as const));

export const assertCommittedSessionStores = async (config: SessionConfig): Promise<void> => {
  for (const role of sessionRoles(config)) {
    const seed = readVaultSeed(join(config.directory, role));
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const db = new Level<Buffer, Buffer>(join(config.stores[role], 'db', `${runtimeId}-wal`), {
      createIfMissing: false,
      keyEncoding: 'binary',
      valueEncoding: 'buffer',
    });
    try {
      await db.open();
      const head = await readStorageHead(db);
      if (!head || head.latestHeight <= 0) throw new Error(`USDC_SESSION_COMMITTED_STORE_REQUIRED:${role}`);
    } finally {
      await db.close();
    }
  }
};
