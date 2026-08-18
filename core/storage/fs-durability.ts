import { createStructuredLogger } from '../support/logger';

const durabilityLog = createStructuredLogger('runtime.storage');

type StorageFileHandle = {
  writeFile(data: string, options?: { encoding?: BufferEncoding }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type StorageDirectoryHandle = {
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type StorageDurabilityBoundary =
  | 'after-file-write'
  | 'after-file-sync'
  | 'after-file-rename'
  | 'before-parent-dir-sync'
  | 'after-parent-dir-sync';

type StorageDurabilityHook = (boundary: StorageDurabilityBoundary) => void | Promise<void>;

export type StorageDurabilityOptions = {
  onBoundary?: StorageDurabilityHook;
  syncFile?: (handle: StorageFileHandle) => Promise<void>;
  syncDirectory?: (handle: StorageDirectoryHandle) => Promise<void>;
};

export type StorageDirectoryFsyncResult =
  | { status: 'synced' }
  | { status: 'unsupported'; code: string };

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || 'UNKNOWN')
    : 'UNKNOWN';

const durabilityError = (kind: string, targetPath: string, error: unknown): Error =>
  new Error(`${kind}:code=${errorCode(error)}:path=${targetPath}`, { cause: error });

const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

/**
 * A rename is only a durable recovery fence after its parent directory is
 * synced. Treating EIO/EPERM as "best effort" can let rotation continue after
 * the marker rename was never made durable. Only errno values that explicitly
 * mean directory fsync is unsupported are downgraded, and that downgrade is
 * both logged and returned to the caller for observability.
 */
export const fsyncStorageParentDirectory = async (
  targetPath: string,
  options: StorageDurabilityOptions = {},
): Promise<StorageDirectoryFsyncResult> => {
  const fs = await import('fs/promises');
  const path = await import('path');
  const parentPath = path.dirname(targetPath);
  let directory: StorageDirectoryHandle;
  try {
    directory = await fs.open(parentPath, 'r') as StorageDirectoryHandle;
  } catch (error) {
    throw durabilityError('STORAGE_PARENT_DIR_OPEN_FAILED', parentPath, error);
  }

  try {
    await options.onBoundary?.('before-parent-dir-sync');
    try {
      await (options.syncDirectory ?? ((handle) => handle.sync()))(directory);
    } catch (error) {
      const code = errorCode(error);
      if (DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(code)) {
        durabilityLog.warn('storage_epoch.parent_dir_fsync_unsupported', {
          code,
          path: parentPath,
        });
        return { status: 'unsupported', code };
      }
      throw durabilityError('STORAGE_PARENT_DIR_FSYNC_FAILED', parentPath, error);
    }
    await options.onBoundary?.('after-parent-dir-sync');
    return { status: 'synced' };
  } finally {
    await directory.close();
  }
};

/**
 * Publish a small canonical file with the ordering required by crash recovery:
 * complete tmp body -> file fsync -> atomic rename -> parent-directory fsync.
 * Renaming an unsynced tmp first is tempting, but after a machine crash it can
 * leave a canonical marker name whose body was never durable. Any failure here
 * is intentionally fatal so DB-directory rotation cannot start without its
 * recovery fence.
 */
export const writeDurableFile = async (
  targetPath: string,
  body: string,
  options: StorageDurabilityOptions = {},
): Promise<void> => {
  if (!body) throw new Error(`STORAGE_FILE_BODY_EMPTY:path=${targetPath}`);
  const fs = await import('fs/promises');
  const tmpPath = `${targetPath}.tmp`;
  let file: StorageFileHandle;
  try {
    file = await fs.open(tmpPath, 'w', 0o600) as StorageFileHandle;
  } catch (error) {
    throw durabilityError('STORAGE_FILE_TMP_OPEN_FAILED', tmpPath, error);
  }

  try {
    try {
      await file.writeFile(body, { encoding: 'utf8' });
    } catch (error) {
      throw durabilityError('STORAGE_FILE_WRITE_FAILED', tmpPath, error);
    }
    await options.onBoundary?.('after-file-write');
    try {
      await (options.syncFile ?? ((handle) => handle.sync()))(file);
    } catch (error) {
      throw durabilityError('STORAGE_FILE_FSYNC_FAILED', tmpPath, error);
    }
    await options.onBoundary?.('after-file-sync');
  } finally {
    await file.close();
  }

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    throw durabilityError('STORAGE_FILE_RENAME_FAILED', targetPath, error);
  }
  await options.onBoundary?.('after-file-rename');
  await fsyncStorageParentDirectory(targetPath, options);
};
