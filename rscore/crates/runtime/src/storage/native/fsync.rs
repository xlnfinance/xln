//! Filesystem durability missing from rusty-leveldb's default disk writer.
//!
//! File contents are synced whenever LevelDB flushes a WAL, SST or MANIFEST.
//! Directory metadata is synced once by `NativeRuntimeStore::persist_frame`
//! after the whole LevelDB batch returns and before any output is published.
//! Syncing the same parent after every internal create/delete/rename turns one
//! Runtime frame into dozens of redundant disk barriers during compaction.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use rusty_leveldb::env::{Env, FileLock, Logger, RandomAccess};
use rusty_leveldb::{PosixDiskEnv, Result as LevelDbResult};

use super::NativeStorageError;

/// `rusty-leveldb` 4.0.1 maps a synchronous write to `Write::flush`, but a
/// plain `File::flush` is not an fsync. This Env makes every LevelDB flush a
/// real `sync_all`, including WAL, SST and MANIFEST writers.
#[derive(Clone, Default)]
pub(super) struct DurableEnv {
    inner: PosixDiskEnv,
}

struct DurableWriter(File);

impl Write for DurableWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()?;
        self.0.sync_all()
    }
}

impl Env for DurableEnv {
    fn open_sequential_file(&self, path: &Path) -> LevelDbResult<Box<dyn Read>> {
        self.inner.open_sequential_file(path)
    }

    fn open_random_access_file(&self, path: &Path) -> LevelDbResult<Box<dyn RandomAccess>> {
        self.inner.open_random_access_file(path)
    }

    fn open_writable_file(&self, path: &Path) -> LevelDbResult<Box<dyn Write>> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)?;
        Ok(Box::new(DurableWriter(file)))
    }

    fn open_appendable_file(&self, path: &Path) -> LevelDbResult<Box<dyn Write>> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Box::new(DurableWriter(file)))
    }

    fn exists(&self, path: &Path) -> LevelDbResult<bool> {
        self.inner.exists(path)
    }

    fn children(&self, path: &Path) -> LevelDbResult<Vec<std::path::PathBuf>> {
        self.inner.children(path)
    }

    fn size_of(&self, path: &Path) -> LevelDbResult<usize> {
        self.inner.size_of(path)
    }

    fn delete(&self, path: &Path) -> LevelDbResult<()> {
        self.inner.delete(path)
    }

    fn mkdir(&self, path: &Path) -> LevelDbResult<()> {
        self.inner.mkdir(path)
    }

    fn rmdir(&self, path: &Path) -> LevelDbResult<()> {
        self.inner.rmdir(path)
    }

    fn rename(&self, old: &Path, new: &Path) -> LevelDbResult<()> {
        sync_file(old)?;
        self.inner.rename(old, new)
    }

    fn lock(&self, path: &Path) -> LevelDbResult<FileLock> {
        self.inner.lock(path)
    }

    fn unlock(&self, lock: FileLock) -> LevelDbResult<()> {
        self.inner.unlock(lock)
    }

    fn new_logger(&self, path: &Path) -> LevelDbResult<Logger> {
        self.open_appendable_file(path).map(Logger::new)
    }

    fn micros(&self) -> u64 {
        self.inner.micros()
    }

    fn sleep_for(&self, micros: u32) {
        self.inner.sleep_for(micros);
    }
}

pub(super) fn sync_database_directory(path: &Path) -> Result<(), NativeStorageError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(NativeStorageError::Fsync)
}

fn sync_file(path: &Path) -> LevelDbResult<()> {
    Ok(OpenOptions::new().read(true).open(path)?.sync_all()?)
}
