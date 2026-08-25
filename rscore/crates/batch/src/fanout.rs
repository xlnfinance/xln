//! Fan out only when the work is worth a thread hop.
//!
//! Rayon's `install` moves the closure onto a pool thread and parks the caller
//! on a latch until it finishes. Measured on this engine that hand-off costs
//! more than the work whenever a wave touches only a few accounts, and it gets
//! worse as the pool grows: one account input in isolation cost 36 us with one
//! worker and 215 us with sixteen, none of it account work. A hub wave carries
//! well under one account input on average, so the pool was the whole bill.
//!
//! Below the threshold the same closure runs inline on the calling thread.
//! `par_iter().map().collect()` into a `Vec` preserves input order, so the
//! results are identical either way and account-local order is untouched.

use rayon::ThreadPool;
use rayon::prelude::*;

/// Item counts at or below this run inline; above it the pool earns its hop.
pub(crate) const SEQUENTIAL_FANOUT_MAX: usize = 16;

/// Root-branch slots holding leaves at or below this count run inline.
pub(crate) const SEQUENTIAL_SLOT_FANOUT_MAX: usize = 4;

/// Map owned work, sequentially for a small batch.
pub(crate) fn map_owned<T, R, F>(pool: &ThreadPool, items: Vec<T>, map: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Sync + Send,
{
    if items.len() <= SEQUENTIAL_FANOUT_MAX {
        return items.into_iter().map(map).collect();
    }
    pool.install(|| items.into_par_iter().map(map).collect())
}

/// Map borrowed work, sequentially for a small batch.
pub(crate) fn map_borrowed<T, R, F>(pool: &ThreadPool, items: &[T], map: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync + Send,
{
    if items.len() <= SEQUENTIAL_FANOUT_MAX {
        return items.iter().map(map).collect();
    }
    pool.install(|| items.par_iter().map(map).collect())
}
