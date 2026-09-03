//! The Argon2 driver: pre-hashing, the fill loop, finalisation, and the public
//! [`Argon2`] entry points.
//!
//! Ported line by line from `phc-winner-argon2/src/core.c` (`initial_hash`,
//! `fill_first_blocks`, `initialize`, `index_alpha`, `fill_memory_blocks`,
//! `fill_memory_blocks_st`, `fill_memory_blocks_mt`, `finalize`) and
//! `phc-winner-argon2/src/argon2.c` (`argon2_ctx`, `argon2_hash`,
//! `argon2_verify`, `argon2_verify_ctx`, `argon2_compare`).

use alloc::string::String;
use alloc::vec::Vec;

use crate::blake2b::{Blake2b, blake2b_long};
use crate::block::{Block, Instance, Position};
use crate::error::Error;
use crate::fill_block::{Backend, FillSegmentFn};
use crate::memory::{Arena, Workspace, clear_internal_memory, clear_internal_memory_u64};
use crate::params::{
    Algorithm, BLOCK_SIZE, MAX_PWD_LENGTH, PREHASH_DIGEST_LENGTH, PREHASH_SEED_LENGTH, Params,
    SYNC_POINTS, Version,
};
#[cfg(test)]
use crate::params::{Memory, TagLen};

/// The KAT trace hook: `internal_kat(instance, pass)` from `src/genkat.c`.
///
/// Invoked after every pass with `(pass_index, whole_arena)`, at a point where
/// every helper is parked at the pass boundary and cannot touch the arena.
/// `tests/kat.rs` uses it to dump the arena the way `genkat` does.
pub type PassTrace<'a> = &'a mut dyn FnMut(u32, &[Block]);

// Structural regression hook for the zeroization boundary: stable hashing must
// never ask `hash_in_arena` to copy H0 out of the blockhash it already wipes.
// Thread-local keeps parallel libtest cases from charging one another.
#[cfg(all(test, feature = "std"))]
std::thread_local! {
    static H0_COPY_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

// ---------------------------------------------------------------------------
// index_alpha  (contract: called by every fill_block backend)
// ---------------------------------------------------------------------------

/// `index_alpha()` from `src/core.c`: the absolute index of the reference block.
///
/// (contract) The `fill_block` backends call this once per block.
///
/// # The two traps
///
/// **1. Deliberate wrapping subtraction.** The C writes
///
/// ```c
/// reference_area_size = position->slice * segment_length
///                     + ((position->index == 0) ? (-1) : 0);
/// ```
///
/// `-1` added to a `uint32_t` wraps, so when `slice * segment_length` is 0 the
/// result is `0xFFFFFFFF`, not a negative number. The same shape appears in the
/// `pass > 0` branch:
///
/// ```c
/// reference_area_size = lane_length - segment_length
///                     + ((position->index == 0) ? (-1) : 0);
/// ```
///
/// In Rust these **must** be [`u32::wrapping_sub`] / [`u32::wrapping_add`].
/// A plain `-` panics in debug and silently differs in release. This is the
/// single most common way an Argon2 port breaks, and it only shows up for
/// lane-crossing references at `index == 0` — which means the official
/// single-lane vectors will not catch it. The `p > 1` vectors and KATs will.
///
/// **2. Exact integer widths in the position mapping.** All of this is `u64`:
///
/// ```text
/// let mut rel = pseudo_rand as u64;          // the LOW u32 of the pseudo-random value
/// rel = (rel * rel) >> 32;
/// rel = (ras as u64) - 1 - (((ras as u64) * rel) >> 32);
/// abs = ((start_position as u64 + rel) % lane_length as u64) as u32;
/// ```
///
/// with one refinement the summary above glosses over and the C source settles:
/// `reference_area_size - 1` is evaluated in **`uint32_t`** (both operands are
/// 32-bit; the `int` literal converts to `unsigned int`) and only *then* widened
/// for the outer subtraction. The two readings differ exactly when
/// `reference_area_size == 0`: 32-bit-first gives `0x0000_0000_FFFF_FFFF`,
/// 64-bit-first gives `0xFFFF_FFFF_FFFF_FFFF`. This port does it the C way.
///
/// # Starting position
///
/// ```text
/// start_position = 0;
/// if pass != 0 {
///     start_position = if slice == SYNC_POINTS - 1 { 0 }
///                      else { (slice + 1) * segment_length };
/// }
/// ```
#[must_use]
pub fn index_alpha(
    instance: &Instance,
    position: &Position,
    pseudo_rand: u32,
    same_lane: bool,
) -> u32 {
    // The C ends with `% instance->lane_length`. For any instance built from
    // validated `Params`, `lane_length == segment_length * SYNC_POINTS >= 8`.
    // This guard exists only so a hand-built degenerate `Instance` cannot turn
    // that `%` into a division-by-zero panic; the crate must never panic.
    if instance.lane_length == 0 {
        return 0;
    }

    let reference_area_size: u32 = if position.pass == 0 {
        // First pass.
        if position.slice == 0 {
            // core.c:210-211 `reference_area_size = position->index - 1;`
            // `fill_segment` starts at index 2 on pass 0 / slice 0, so this is
            // >= 1; `wrapping_sub` only keeps the function panic-free.
            position.index.wrapping_sub(1)
        } else if same_lane {
            // core.c:215-217
            //   position->slice * instance->segment_length + position->index - 1
            position
                .slice
                .wrapping_mul(instance.segment_length)
                .wrapping_add(position.index)
                // core.c:217 `+ position->index - 1`, uint32_t arithmetic.
                .wrapping_sub(1)
        } else {
            // core.c:219-221
            //   position->slice * instance->segment_length
            //       + ((position->index == 0) ? (-1) : 0)
            //
            // Adding the `int` -1 to a uint32_t is a DELIBERATE wrapping
            // subtraction. `wrapping_sub(1)` is the same value as
            // `wrapping_add(0xFFFF_FFFF)`; a plain `-` would panic in debug.
            position
                .slice
                .wrapping_mul(instance.segment_length)
                .wrapping_sub(u32::from(position.index == 0))
        }
    } else if same_lane {
        // core.c:227-229
        //   instance->lane_length - instance->segment_length
        //       + position->index - 1
        instance
            .lane_length
            // core.c:227 `lane_length - segment_length`, uint32_t arithmetic.
            .wrapping_sub(instance.segment_length)
            .wrapping_add(position.index)
            // core.c:229 `+ position->index - 1`, uint32_t arithmetic.
            .wrapping_sub(1)
    } else {
        // core.c:231-233
        //   instance->lane_length - instance->segment_length
        //       + ((position->index == 0) ? (-1) : 0)
        instance
            .lane_length
            // core.c:231-232 `lane_length - segment_length`, uint32_t arithmetic.
            .wrapping_sub(instance.segment_length)
            // core.c:233, the same deliberate wrapping subtraction as above.
            .wrapping_sub(u32::from(position.index == 0))
    };

    // core.c:239-242. 1.2.4. Mapping pseudo_rand to 0..<reference_area_size-1>
    // and producing the relative position.
    //
    // Neither multiplication can overflow: `relative_position` is bounded by
    // `u32::MAX` on entry and by `2^32 - 1` after the shift, and both factors of
    // each product are therefore < 2^32.
    let mut relative_position = u64::from(pseudo_rand);
    relative_position = (relative_position * relative_position) >> 32;
    // core.c:241 `reference_area_size - 1` is uint32_t (see the doc comment),
    // hence the 32-bit `wrapping_sub` inside `u64::from(..)`.
    relative_position = u64::from(reference_area_size.wrapping_sub(1))
        // core.c:241-242, the outer subtraction is uint64_t. It cannot underflow
        // — `(ras * rel) >> 32 <= ras - 1` for every `rel < 2^32` — but
        // `wrapping_sub` keeps that a property rather than an assumption.
        .wrapping_sub((u64::from(reference_area_size) * relative_position) >> 32);

    // core.c:245-251. 1.2.5 Computing the starting position.
    let mut start_position: u32 = 0;
    if position.pass != 0 {
        start_position = if position.slice == SYNC_POINTS - 1 {
            0
        } else {
            position
                .slice
                .wrapping_add(1)
                .wrapping_mul(instance.segment_length)
        };
    }

    // core.c:254-255. 1.2.6. Computing the absolute position. `start_position`
    // is uint32_t and `relative_position` uint64_t, so the sum and the `%` are
    // evaluated in uint64_t and only the result is truncated back to uint32_t.
    ((u64::from(start_position).wrapping_add(relative_position)) % u64::from(instance.lane_length))
        as u32
}

// ---------------------------------------------------------------------------
// Pre-hashing and the fill loop
// ---------------------------------------------------------------------------

/// `initial_hash()` from `src/core.c`, returning the 72-byte `H0` buffer.
///
/// BLAKE2b-512 over, in this order, each `u32` little-endian:
/// `lanes`, `outlen`, `m_cost`, `t_cost`, `version`, `type`,
/// then `pwdlen` and `pwd`, `saltlen` and `salt`, `secretlen` and `secret`,
/// `adlen` and `ad`.
///
/// The first 64 bytes of the result are `H0`; the trailing 8 bytes are left
/// zero and are filled in by [`fill_first_blocks`] with the block index and the
/// lane index. (`initialize()` in the C zeroes them explicitly right after
/// calling `initial_hash`; here they are never written in the first place.)
///
/// The four buffer lengths are hashed as `u32`, exactly as the C hashes
/// `context->pwdlen` and friends. A caller that has run
/// [`Params::validate_for`] first — which every entry point in this module
/// does — cannot reach the truncating cast.
///
/// # Errors
///
/// Only a BLAKE2b parameter error, which cannot happen here: the digest length
/// is the constant 64.
pub fn initial_hash(
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
) -> Result<[u8; PREHASH_SEED_LENGTH], Error> {
    let mut blockhash = [0u8; PREHASH_SEED_LENGTH];
    initial_hash_into(
        algorithm,
        version,
        params,
        pwd,
        salt,
        secret,
        ad,
        &mut blockhash,
    )?;
    Ok(blockhash)
}

/// [`initial_hash`] written directly into its caller's wipe-owned buffer.
///
/// The stable hash path uses this form so returning a 72-byte `Result` cannot
/// make the optimiser leave an intermediate H0 copy behind on the stack.
#[allow(clippy::too_many_arguments)]
fn initial_hash_into(
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    blockhash: &mut [u8; PREHASH_SEED_LENGTH],
) -> Result<(), Error> {
    /// `store32(&value, len); blake2b_update(&BlakeHash, &value, 4);`
    #[inline]
    fn le32(len: usize) -> [u8; 4] {
        (len as u32).to_le_bytes()
    }

    // core.c:547 `blake2b_init(&BlakeHash, ARGON2_PREHASH_DIGEST_LENGTH);`
    let mut state = Blake2b::new(PREHASH_DIGEST_LENGTH)?;

    // core.c:549-565. Six u32 parameters, in this exact order.
    state.update(&params.lanes().to_le_bytes());
    state.update(&le32(params.tag_len_bytes()));
    state.update(&params.memory_kib().to_le_bytes());
    state.update(&params.passes().to_le_bytes());
    state.update(&version.as_u32().to_le_bytes());
    state.update(&algorithm.as_u32().to_le_bytes());

    // core.c:567-607. Four length-prefixed buffers, in this exact order.
    // The C guards each `blake2b_update` with a NULL check; feeding an empty
    // slice is the same no-op. `ARGON2_FLAG_CLEAR_PASSWORD` /
    // `ARGON2_FLAG_CLEAR_SECRET` have no analogue here: this port never takes
    // ownership of the caller's buffers, so it cannot wipe them.
    state.update(&le32(pwd.len()));
    state.update(pwd);

    state.update(&le32(salt.len()));
    state.update(salt);

    state.update(&le32(secret.len()));
    state.update(secret);

    state.update(&le32(ad.len()));
    state.update(ad);

    // core.c:609 `blake2b_final(&BlakeHash, blockhash, ARGON2_PREHASH_DIGEST_LENGTH);`
    state.finalize(&mut blockhash[..PREHASH_DIGEST_LENGTH])?;
    Ok(())
}

/// `fill_first_blocks()` from `src/core.c`.
///
/// For each lane `l`, writes `LE32(0)` then `LE32(l)` at
/// `blockhash[64..72]`, expands the 72 bytes to 1024 with `blake2b_long`, and
/// loads that into block `l * lane_length + 0`; then repeats with `LE32(1)` for
/// block `l * lane_length + 1`.
///
/// # Errors
///
/// [`Error::IncorrectParameter`] if `arena` is too small for
/// `lanes * lane_length` blocks — unreachable from this module, which always
/// sizes the arena from the same [`Params`]. Otherwise only a BLAKE2b parameter
/// error, which cannot happen for the constant length 1024.
pub fn fill_first_blocks(
    blockhash: &mut [u8; PREHASH_SEED_LENGTH],
    arena: &mut [Block],
    lanes: u32,
    lane_length: u32,
) -> Result<(), Error> {
    let mut blockhash_bytes = [0u8; BLOCK_SIZE];

    // Unlike the C helper, this safe internal-api entry point reports a short
    // arena instead of indexing unchecked. Keep every fallible exit inside the
    // closure so the derived block bytes are wiped before the error escapes.
    let result = (|| {
        for lane in 0..lanes {
            // core.c:522-523
            //   store32(blockhash + ARGON2_PREHASH_DIGEST_LENGTH, 0);
            //   store32(blockhash + ARGON2_PREHASH_DIGEST_LENGTH + 4, l);
            blockhash[PREHASH_DIGEST_LENGTH..PREHASH_DIGEST_LENGTH + 4]
                .copy_from_slice(&0u32.to_le_bytes());
            blockhash[PREHASH_DIGEST_LENGTH + 4..PREHASH_SEED_LENGTH]
                .copy_from_slice(&lane.to_le_bytes());

            // core.c:524-525 `blake2b_long(blockhash_bytes, ARGON2_BLOCK_SIZE,
            //                              blockhash, ARGON2_PREHASH_SEED_LENGTH);`
            blake2b_long(&mut blockhash_bytes, blockhash)?;

            // core.c:526-527 `load_block(&instance->memory[l * lane_length + 0], ..)`
            let base = (lane as usize)
                .checked_mul(lane_length as usize)
                .ok_or(Error::IncorrectParameter)?;
            match arena.get_mut(base) {
                Some(block) => block.load_le(&blockhash_bytes),
                None => return Err(Error::IncorrectParameter),
            }

            // core.c:529 `store32(blockhash + ARGON2_PREHASH_DIGEST_LENGTH, 1);`
            blockhash[PREHASH_DIGEST_LENGTH..PREHASH_DIGEST_LENGTH + 4]
                .copy_from_slice(&1u32.to_le_bytes());
            blake2b_long(&mut blockhash_bytes, blockhash)?;

            // core.c:532-533 `load_block(&instance->memory[l * lane_length + 1], ..)`
            let second = base.checked_add(1).ok_or(Error::IncorrectParameter)?;
            match arena.get_mut(second) {
                Some(block) => block.load_le(&blockhash_bytes),
                None => return Err(Error::IncorrectParameter),
            }
        }
        Ok(())
    })();

    // core.c:535 `clear_internal_memory(blockhash_bytes, ARGON2_BLOCK_SIZE);`
    clear_internal_memory(&mut blockhash_bytes);
    result
}

/// `fill_memory_blocks()` from `src/core.c`, with the backend resolved from
/// runtime CPU detection.
///
/// Safe, and the reason it can be: it never lets a caller name the backend. The
/// value comes from [`crate::fill_block::backend`], which only ever returns a
/// backend whose instruction set this CPU was *detected* to have. Every entry
/// point that does take a [`Backend`] is `unsafe` — see
/// [`fill_memory_blocks_traced`].
///
/// # Errors
///
/// [`Error::IncorrectParameter`] if `instance.lanes == 0` (`core.c:377`).
pub fn fill_memory_blocks(instance: &Instance) -> Result<(), Error> {
    // SAFETY: `backend()` is the cached result of the `is_*_feature_detected!`
    // cascade in `fill_block::detect`, so this CPU can execute it. The other two
    // obligations — a valid arena and no concurrent writer — are `Instance`'s
    // own contract, discharged by whoever called `Instance::new`.
    unsafe { fill_memory_blocks_traced(instance, crate::fill_block::backend(), None) }
}

/// `fill_memory_blocks()` with an explicit [`Backend`] and a KAT trace hook.
///
/// The function pointer is resolved **once**, here, before any loop:
///
/// ```text
/// let fill = crate::fill_block::fill_segment_fn(backend);
/// for pass in 0..instance.passes {
///     for slice in 0..SYNC_POINTS {
///         for lane in 0..instance.lanes {
///             fill(instance, Position::new(pass, lane, slice, 0));
///         }
///     }
/// }
/// ```
///
/// Nothing detects or dispatches inside the per-block loop; the cost is one
/// indirect call per *segment*, which is `segment_length` blocks.
///
/// `trace` is `internal_kat()` from `src/genkat.c`: it is invoked after every
/// pass with `(pass_index, whole_arena)`, at a point where every helper is
/// parked at the barrier and cannot touch the arena.
///
/// With the `parallel` feature, `instance.threads > 1` and
/// `instance.lanes > 1`, one
/// [`std::thread::scope`] owns the helpers for the whole fill. They meet at an
/// atomic barrier after each slice, matching the C's sync points without
/// respawning. The single-threaded path holds no raw-pointer sharing at all, so
/// it stays checkable under Miri.
///
/// # Safety
///
/// `backend` selects a `fill_segment` carrying
/// `#[target_feature(enable = ...)]`. Calling one whose feature this CPU lacks
/// is undefined behaviour — in practice `SIGILL` — so the caller must guarantee
/// the CPU can execute it. Either of these discharges that:
///
/// * `backend.is_available()` returned `true`, or
/// * `backend` came from [`crate::fill_block::backend`] / `detect`.
///
/// The one other way to satisfy it is a host *measured* to execute the
/// instructions while hiding them from `cpuid`, which is what the deliberately
/// forced AVX2 tests rely on under Rosetta 2. That is a test-only affordance and
/// never a library path.
///
/// `instance` must also uphold [`Instance::new`]'s contract, and no other thread
/// may be filling this arena.
///
/// # Errors
///
/// [`Error::IncorrectParameter`] if `instance.lanes == 0`.
pub unsafe fn fill_memory_blocks_traced(
    instance: &Instance,
    backend: Backend,
    mut trace: Option<PassTrace<'_>>,
) -> Result<(), Error> {
    // core.c:377-379 `if (instance == NULL || instance->lanes == 0)`.
    if instance.lanes == 0 {
        return Err(Error::IncorrectParameter);
    }

    // Resolve the backend ONCE, before every loop. See `fill_block/mod.rs` for
    // why the `#[target_feature]` boundary sits on `fill_segment`.
    let fill = crate::fill_block::fill_segment_fn(backend);

    // Multi-lane: hand the whole pass/slice/lane nest to the worker pool, which
    // owns its threads for the entire fill instead of for one slice.
    #[cfg(feature = "parallel")]
    if instance.threads > 1 && instance.lanes > 1 {
        // SAFETY: forwarded verbatim from this function's own contract.
        unsafe { fill_pooled(instance, fill, trace) };
        return Ok(());
    }

    for pass in 0..instance.passes {
        for slice in 0..SYNC_POINTS {
            // SAFETY: `fill` is `fill_segment_fn(backend)`, and the caller
            // guarantees this CPU can execute `backend`; `instance` and the
            // absence of a concurrent filler are the caller's obligations too.
            unsafe { fill_slice_st(instance, fill, pass, slice) };
        }

        // genkat.c `internal_kat(instance, r)` — printed after each pass.
        if let Some(callback) = trace.as_mut() {
            // SAFETY: three obligations, and none of them is "the arena is zero".
            //
            //  1. Valid for `memory_len()` `Block`s: that is `Instance::new`'s
            //     own contract, discharged by whoever built `instance`.
            //  2. Every block is *initialised*, which is what makes a `&[Block]`
            //     over them a valid reference. `Arena` guarantees this for its
            //     whole capacity from birth (`alloc_zeroed`) and never gives it
            //     up — initialised memory stays initialised when a `Workspace`
            //     parks and re-lends it. NOTE for the next reader: this used to
            //     be justified by "the arena was zero-initialised by
            //     `Arena::new`". That premise is false for a pooled arena with
            //     `zeroize-memory` off, and it was never the load-bearing one;
            //     *initialised* is.
            //  3. No live `&mut Block`: the parallel path returned above, and
            //     every sequential `fill_slice_st` call has returned before
            //     this shared slice is formed.
            //
            // Separately from soundness, the callback can never observe a
            // previous tenant's bytes even on a reused arena: it fires only
            // after all four slices of a pass have completed, and pass 0 writes
            // every block of every lane exactly once before this point.
            let blocks = unsafe {
                core::slice::from_raw_parts(
                    instance.memory_ptr().cast_const(),
                    instance.memory_len(),
                )
            };
            callback(pass, blocks);
        }
    }

    Ok(())
}

/// `fill_memory_blocks_st()`'s innermost loop (`core.c:265-268`).
///
/// Deliberately free of any cross-thread pointer sharing: the only `unsafe` is
/// the call to `fill`, which every backend requires. That keeps the whole
/// single-threaded path checkable under Miri.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute whatever
/// instruction set `fill` needs.
unsafe fn fill_slice_st(instance: &Instance, fill: FillSegmentFn, pass: u32, slice: u32) {
    for lane in 0..instance.lanes {
        let position = Position::new(pass, lane, slice, 0);
        // SAFETY: three obligations from `FillSegmentFn`.
        //  1. `fill` came from `fill_segment_fn(backend)`, and this function's
        //     caller guarantees the CPU can execute that backend — an
        //     obligation that is now carried in the type system all the way out
        //     to `fill_memory_blocks_traced`, `hash_traced` and
        //     `hash_with_backend`, every one of which is an `unsafe fn`.
        //  2. `instance`'s arena is valid for `memory_len()` blocks — that is
        //     `Instance::new`'s own safety contract, discharged by the caller.
        //  3. `pass < passes`, `slice < SYNC_POINTS` and `lane < lanes` by
        //     construction, and this thread is the only one running, so nothing
        //     else can be writing this segment.
        unsafe { fill(instance, position) };
    }
}

// ---------------------------------------------------------------------------
// Parallel fill
// ---------------------------------------------------------------------------

/// A `&Instance` that may be handed to another thread.
///
/// `Instance` holds the arena as a `*mut Block`, which makes it neither `Send`
/// nor `Sync`, so sharing it across lanes needs this newtype and the safety
/// argument below.
#[cfg(feature = "parallel")]
#[derive(Clone, Copy)]
struct SharedInstance<'a>(&'a Instance);

// SAFETY: sending a `SharedInstance` hands another thread a `&Instance`, and
// through it the arena's `*mut Block`. That is sound for the one way
// `fill_slice_mt` uses it, and only that way:
//
//  * At each sync point, every worker in the whole-fill `std::thread::scope`
//    runs the SAME `(pass, slice)` and pairwise DISTINCT `lane`s: lanes are
//    claimed from a single `fetch_add` counter, so every index is handed out
//    exactly once.
//  * Within one slice, `fill_segment(instance, {pass, lane, slice, ..})`
//    WRITES only blocks `lane * lane_length + slice * segment_length + i` for
//    `i in 0..segment_length` — precisely the one segment that lane owns in
//    this slice. Two different lanes therefore never write the same block, so
//    no two `&mut Block` ever alias.
//  * It READS `prev_offset`, which always stays inside its own lane (the block
//    it just wrote, or the last block of the lane on the wrap-around), and
//    `ref_lane * lane_length + index_alpha(..)`. When `ref_lane != lane`,
//    `index_alpha`'s reference area is `slice * segment_length` blocks from the
//    start of the lane (pass 0) or the `lane_length - segment_length` blocks of
//    the *other three* slices (pass > 0, `start_position` skips the current
//    one). Either way it never lands in another lane's current segment, which
//    is the only region being written concurrently. So no read races a write.
//  * The scope spans the whole fill. At each slice boundary, every helper
//    publishes its writes with `Release` on `arrived`; the leader acquires them,
//    resets the work counters, then releases the next `generation`, which every
//    helper acquires before proceeding. Thus every write of slice `s`
//    happens-before every read in slice `s + 1`, mirroring the C's sync points.
//  * The `Instance` struct itself is only ever read; the interior mutability is
//    confined to the arena it points at, via `Instance::block_mut`.
//
// `Sync` is deliberately NOT implemented: the workers each take their own copy
// of this `Copy` newtype, so a shared reference to it never crosses a thread.
#[cfg(feature = "parallel")]
unsafe impl Send for SharedInstance<'_> {}

/// The sync point, and the state the workers share across one whole fill.
///
/// # Why this exists instead of one `thread::scope` per slice
///
/// The four sync points per pass are algorithmic and cannot be weakened: every
/// lane must finish slice `N` before any lane starts `N + 1`. What is *not*
/// algorithmic is destroying and recreating the worker set at each of them,
/// which is what `std::thread::scope` per slice did — `passes * 4 *
/// (workers - 1)` thread creations for one hash, each a `clone()` plus a stack
/// mapping. Measured on the target, four lanes over 4096-block segments:
///
/// ```text
///   scope + 3 spawns, per slice        63.8 us
///   live pool on std::sync::Barrier    20.7 us   (Mutex + Condvar: a syscall)
///   live pool on this barrier           0.6 us
/// ```
///
/// The threads now live for the whole fill and meet at a barrier instead. That
/// is a 12-to-3 reduction in thread creations at `t = 1, p = 4`, and 48-to-3 at
/// `t = 4`. The barrier is hand-rolled rather than `std::sync::Barrier` for the
/// 20 us in that table: `Barrier` is a `Mutex` + `Condvar`, so every one of the
/// `4 * passes` sync points is a pair of futex round trips.
///
/// # The barrier, and why the ordering is enough
///
/// Sense-reversing, with the *leader* — the thread that called into the hash —
/// always doing the release. Every helper, having finished its lanes:
///
/// ```text
///   arrived.fetch_add(1, Release)          publishes that helper's writes
///   spin until generation != mine (Acquire)
/// ```
///
/// and the leader, having finished its own lanes:
///
/// ```text
///   spin until arrived + lost >= helpers (Acquire)
///                                            acquires every live helper's writes
///   ... KAT trace here, if any: everyone is parked ...
///   next_lane = 0; arrived = 0
///   generation.store(next, Release)        publishes all of it to everyone
/// ```
///
/// The transitivity is the point. A helper's block writes happen-before its
/// `Release` on `arrived`; the leader's `Acquire` on `arrived` makes them
/// happen-before everything it does next, which includes its `Release` on
/// `generation`; and every *other* helper's `Acquire` on `generation` therefore
/// sees them. So lane 0's slice-`N` writes are visible to lane 3 in slice
/// `N + 1`, which is exactly the guarantee `thread::scope`'s join gave for free.
///
/// # Panics, and why `lost` exists
///
/// A spin barrier turns a worker that never arrives into a hang, and a hang is
/// a far worse failure than a panic. `Bail`'s `Drop` marks a helper lost on the
/// way out of an unwind; the leader stops waiting, sets `stop`, and returns, at
/// which point `thread::scope` joins and re-raises the original panic. Nothing
/// in `fill_segment` is supposed to panic — but "supposed to" is not a
/// scheduling primitive.
#[cfg(feature = "parallel")]
struct FillSync {
    /// Lanes handed out for the current slice. Reset by the leader.
    next_lane: core::sync::atomic::AtomicU32,
    /// Helpers that have finished the current slice.
    arrived: core::sync::atomic::AtomicU32,
    /// Bumped once per sync point; helpers wait for their own count to match.
    generation: core::sync::atomic::AtomicU32,
    /// Helpers that unwound out of the fill and will never arrive again.
    lost: core::sync::atomic::AtomicU32,
    /// Tells parked helpers to give up so the scope can join and propagate.
    stop: core::sync::atomic::AtomicBool,
    /// Helpers the OS actually gave us, which is what the leader waits for.
    helpers: u32,
}

/// Iterations of `pause` before falling back to `yield_now`.
///
/// A segment is thousands of blocks, so an arriving worker is normally a few
/// microseconds ahead of the last one and spinning wins outright. Past that the
/// box is oversubscribed — 4 vCPU here is 2 physical cores plus SMT — and
/// yielding the slot to the worker we are waiting for is strictly better than
/// stealing issue bandwidth from its SMT sibling.
#[cfg(feature = "parallel")]
const SPIN_LIMIT: u32 = 1024;

#[cfg(feature = "parallel")]
impl FillSync {
    /// Wait until `cond()` holds, spinning then yielding.
    #[inline]
    fn park_until(mut cond: impl FnMut() -> bool) {
        let mut spins = 0u32;
        while !cond() {
            if spins < SPIN_LIMIT {
                spins += 1;
                core::hint::spin_loop();
            } else {
                std::thread::yield_now();
            }
        }
    }
}

/// Fill every lane of one `(pass, slice)` this worker can claim.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute whatever
/// instruction set `fill` needs.
#[cfg(feature = "parallel")]
unsafe fn drain_lanes(
    shared: SharedInstance<'_>,
    sync: &FillSync,
    fill: FillSegmentFn,
    pass: u32,
    slice: u32,
    lanes: u32,
) {
    use core::sync::atomic::Ordering;

    loop {
        // Relaxed is enough: the counter only partitions work, and the
        // happens-before the *data* needs comes from the barrier below.
        let lane = sync.next_lane.fetch_add(1, Ordering::Relaxed);
        if lane >= lanes {
            return;
        }
        // SAFETY: as in `fill_slice_st`, plus the cross-lane argument written
        // out at `unsafe impl Send for SharedInstance`: this worker owns lane
        // `lane` of slice `slice` for the whole call, and no other worker was
        // handed the same index.
        unsafe { fill(shared.0, Position::new(pass, lane, slice, 0)) };
    }
}

/// The whole pass/slice/lane nest, on a worker pool that outlives every slice.
///
/// Replaces `fill_memory_blocks_mt()` (`core.c:311-357`), which spawns one
/// thread per lane *per slice* and caps concurrency by joining
/// `thread[l - threads]` before creating thread `l`. This spawns
/// `min(threads, lanes)` workers **once for the entire hash**; they pull lanes
/// off a counter and meet at [`FillSync`]'s barrier at each of the `4 * passes`
/// sync points. Same bound on live threads, same (absent) ordering requirement
/// between lanes of one slice, same sync points — and `threads` never affects
/// the tag, only `lanes` does, so the schedules are interchangeable.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute whatever
/// instruction set `fill` needs.
#[cfg(feature = "parallel")]
unsafe fn fill_pooled(instance: &Instance, fill: FillSegmentFn, mut trace: Option<PassTrace<'_>>) {
    use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    let lanes = instance.lanes;
    let passes = instance.passes;
    // `Instance::new` already clamps to `min(threads, lanes)`; re-clamp so a
    // hand-built `Instance` cannot ask for more workers than there are lanes.
    let workers = instance.threads.min(lanes);

    let shared = SharedInstance(instance);
    let sync = FillSync {
        next_lane: AtomicU32::new(0),
        arrived: AtomicU32::new(0),
        generation: AtomicU32::new(0),
        lost: AtomicU32::new(0),
        stop: AtomicBool::new(false),
        // Optimistic: the shortfall from any thread the OS refuses is charged
        // to `lost` right after the spawn loop, which the leader's wait
        // condition already accounts for.
        helpers: workers.saturating_sub(1),
    };
    let sync = &sync;

    std::thread::scope(|scope| {
        /// Releases every parked helper when the leader leaves the scope,
        /// however it leaves.
        ///
        /// Without this the crate deadlocks on any leader unwind — a panicking
        /// KAT trace callback is enough to reach it. The helpers would be
        /// spinning inside `park_until` for a `generation` bump that is never
        /// coming, and `Scope`'s own `Drop` would block for ever trying to join
        /// them. `thread::scope` propagating a panic is only useful if the
        /// threads it is joining can still finish.
        ///
        /// Firing on the normal path too is harmless and is why this is a guard
        /// rather than a `catch_unwind`: by then every helper has completed its
        /// last slice and is on its way out, so `stop` only shortens a wait
        /// whose answer has already been decided.
        struct ReleaseHelpers<'a>(&'a FillSync);
        impl Drop for ReleaseHelpers<'_> {
            fn drop(&mut self) {
                self.0.stop.store(true, Ordering::Relaxed);
                self.0.generation.fetch_add(1, Ordering::Release);
            }
        }
        let _release = ReleaseHelpers(sync);

        let mut spawned = 0u32;

        for _ in 1..workers {
            // `Builder::spawn_scoped` returns an error where `scope.spawn`
            // would panic, and this crate must not panic. A refused thread just
            // means fewer workers: every lane is still claimed from `next_lane`
            // by whoever does exist, and the tag does not depend on the count.
            let handle = std::thread::Builder::new().spawn_scoped(scope, move || {
                // Marks this helper lost if it unwinds, so the leader stops
                // waiting for a barrier arrival that will never come.
                struct Bail<'a>(&'a AtomicU32, bool);
                impl Drop for Bail<'_> {
                    fn drop(&mut self) {
                        if self.1 {
                            self.0.fetch_add(1, Ordering::Release);
                        }
                    }
                }
                let mut bail = Bail(&sync.lost, true);

                let mut generation = 0u32;
                'outer: for pass in 0..passes {
                    for slice in 0..SYNC_POINTS {
                        // SAFETY: forwarded from this function's contract — the
                        // caller guarantees the CPU can execute `fill`. The
                        // cross-thread half is the `unsafe impl Send for
                        // SharedInstance` argument above.
                        unsafe { drain_lanes(shared, sync, fill, pass, slice, lanes) };

                        // Release: publishes this helper's block writes to the
                        // leader's acquire below.
                        sync.arrived.fetch_add(1, Ordering::Release);
                        generation += 1;
                        FillSync::park_until(|| {
                            sync.generation.load(Ordering::Acquire) == generation
                                || sync.stop.load(Ordering::Relaxed)
                        });
                        if sync.stop.load(Ordering::Relaxed) {
                            break 'outer;
                        }
                    }
                }
                bail.1 = false;
            });
            if handle.is_ok() {
                spawned += 1;
            }
        }

        // A thread the OS refused must not be waited for. `helpers` was set
        // optimistically; charge the shortfall to `lost`, which the leader's
        // wait condition already accounts for.
        sync.lost
            .fetch_add(sync.helpers - spawned, Ordering::Relaxed);

        let mut generation = 0u32;
        'outer: for pass in 0..passes {
            for slice in 0..SYNC_POINTS {
                // SAFETY: as in the spawned workers; the leader is just one
                // more of them.
                unsafe { drain_lanes(shared, sync, fill, pass, slice, lanes) };

                // Acquire: makes every helper's slice writes visible here, and
                // therefore — through the release on `generation` below — to
                // every other helper in the next slice.
                FillSync::park_until(|| {
                    sync.arrived.load(Ordering::Acquire) + sync.lost.load(Ordering::Acquire)
                        >= sync.helpers
                });
                if sync.lost.load(Ordering::Relaxed) > sync.helpers - spawned {
                    // A helper unwound. Stop cleanly so `thread::scope` can
                    // join it and re-raise the panic, rather than spinning for
                    // ever on an arrival that is never coming.
                    sync.stop.store(true, Ordering::Relaxed);
                    sync.generation.fetch_add(1, Ordering::Release);
                    break 'outer;
                }

                // genkat.c `internal_kat(instance, r)`, printed after each
                // pass. This is the one place it can go: every helper is parked
                // on `generation`, holding no reference into the arena, and
                // none of them can move until the release below.
                if slice == SYNC_POINTS - 1
                    && let Some(callback) = trace.as_mut()
                {
                    // SAFETY: three obligations, and none of them is "the arena
                    // is zero".
                    //
                    //  1. Valid for `memory_len()` `Block`s: that is
                    //     `Instance::new`'s own contract, discharged by whoever
                    //     built `instance`.
                    //  2. Every block is *initialised*, which is what makes a
                    //     `&[Block]` over them a valid reference. `Arena`
                    //     guarantees that for its whole capacity from birth —
                    //     `alloc_zeroed`, or a kernel-zeroed `MAP_ANONYMOUS`
                    //     mapping — and never gives it up.
                    //  3. No live `&mut Block`: every helper has arrived at the
                    //     barrier for the last slice of this pass and is parked
                    //     inside `park_until`, so every `&mut Block` any of
                    //     them formed is dead. This shared slice is the only
                    //     live reference into the arena.
                    let blocks = unsafe {
                        core::slice::from_raw_parts(
                            instance.memory_ptr().cast_const(),
                            instance.memory_len(),
                        )
                    };
                    callback(pass, blocks);
                }

                sync.next_lane.store(0, Ordering::Relaxed);
                sync.arrived.store(0, Ordering::Relaxed);
                generation += 1;
                // Release: hands every helper everything acquired above.
                sync.generation.store(generation, Ordering::Release);
            }
        }
    });
    // Leaving the scope joins every worker, and re-raises a helper's panic.
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/// `finalize()` from `src/core.c`.
///
/// XORs the last block of every lane together, stores it little-endian, and runs
/// `blake2b_long` over the 1024 bytes into `out`.
///
/// Freeing the arena — the `free_memory()` at the end of the C's `finalize` — is
/// [`Arena`]'s `Drop`, which wipes before it deallocates. On the pooled path
/// (`Hasher`) the same wipe happens in [`Workspace::release`] instead, and
/// only the `dealloc` is deferred; either way the arena is wiped by the time the
/// call that owned it returns.
///
/// # Errors
///
/// [`Error::IncorrectParameter`] for a degenerate instance whose last blocks are
/// out of bounds; otherwise only a BLAKE2b parameter error, which cannot happen
/// for a validated `outlen`.
pub fn finalize(instance: &Instance, out: &mut [u8]) -> Result<(), Error> {
    let lane_length = instance.lane_length as usize;
    if lane_length == 0 || instance.lanes == 0 {
        return Err(Error::IncorrectParameter);
    }

    // SAFETY: `Instance`'s contract guarantees `memory_ptr()` is valid for
    // `memory_len()` initialised `Block`s. `fill_memory_blocks` has returned, so
    // every worker is joined and no `&mut Block` into the arena is live; this
    // shared slice is the only live reference to it.
    let blocks = unsafe {
        core::slice::from_raw_parts(instance.memory_ptr().cast_const(), instance.memory_len())
    };

    // core.c:160 `copy_block(&blockhash, instance->memory + instance->lane_length - 1);`
    let Some(&last_of_lane_0) = blocks.get(lane_length - 1) else {
        return Err(Error::IncorrectParameter);
    };
    let mut blockhash = last_of_lane_0;

    // core.c:163-167. XOR the last block of every other lane.
    for lane in 1..instance.lanes {
        // `l * instance->lane_length + (instance->lane_length - 1)`
        let index = (lane as usize)
            .checked_mul(lane_length)
            .and_then(|base| base.checked_add(lane_length - 1))
            .ok_or(Error::IncorrectParameter)?;
        match blocks.get(index) {
            Some(block) => blockhash.xor_with(block),
            None => return Err(Error::IncorrectParameter),
        }
    }

    // core.c:171-174 `store_block(blockhash_bytes, &blockhash);`
    //                `blake2b_long(context->out, context->outlen,
    //                              blockhash_bytes, ARGON2_BLOCK_SIZE);`
    let mut blockhash_bytes = blockhash.to_le_bytes();
    let result = blake2b_long(out, &blockhash_bytes);

    // core.c:176-177, on every path.
    clear_internal_memory_u64(&mut blockhash.0);
    clear_internal_memory(&mut blockhash_bytes);

    result
}

/// `argon2_compare()` from `src/argon2.c`: a constant-time byte comparison.
///
/// Returns `false` immediately for differing lengths (the C never compares
/// mismatched lengths — `outlen` is fixed by the decoded string).
#[must_use]
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }

    let mut d = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        d |= x ^ y;
    }

    // The accumulator is laundered before it is tested. Nothing downstream may
    // learn that `d` is only ever compared against zero, because a compiler
    // that knows *that* is free to rewrite the loop above into a `bcmp` that
    // stops at the first differing byte — which is precisely the timing leak
    // this function exists to prevent.
    //
    // What this actually emits on aarch64 (`--emit=asm`, release):
    //
    //     LBB_2: ldrb w9,[x0],#1 ; ldrb w10,[x2],#1
    //            eor  w9,w10,w9  ; orr  w8,w9,w8
    //            subs x1,x1,#1   ; b.ne LBB_2      <- branch on the COUNTER
    //            strb w8,[sp,#15]; ldrb w8,[sp,#15] <- the black_box launder
    //            sub  w8,w8,#1   ; ubfx w0,w8,#8,#1 <- branchless verdict
    //
    // One branch, and it is the loop counter; no `bcmp`, no `memcmp`, nothing
    // that depends on the bytes. The launder costs two instructions once per
    // call.
    //
    // `black_box` rather than the `asm!` barrier in `memory::secure_wipe_raw`
    // because the thing being protected is a value in a register, not a store
    // to memory, and because it exists on every target — including wasm and
    // under Miri, where `asm!` does not.
    let d = core::hint::black_box(d);

    // argon2.c:246 `return (int)((1 & ((d - 1) >> 8)) - 1);` — 0 when `d == 0`,
    // -1 otherwise, computed without a branch. Written out rather than reduced
    // to `d == 0` so the constant-time property is on the page, not implied.
    let verdict = (1i32 & ((i32::from(d) - 1) >> 8)) - 1;
    verdict == 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Salt length used by the `*_with_random_salt` entry points, in bytes.
///
/// 16 is what RFC 9106 §4 recommends for password hashing, and is comfortably
/// above [`crate::params::MIN_SALT_LENGTH`]. It is a constant rather than an
/// argument because a caller who wants to choose the length also wants to
/// choose the bytes, and should call [`Argon2::hash_encoded`] with their own
/// salt instead.
#[cfg(feature = "std")]
pub const RANDOM_SALT_LEN: usize = 16;

/// Longest salt the `*_bounded` verify entry points will accept, in bytes.
///
/// [`Params`] carries no salt length, so the pre-decode size gate in
/// [`Argon2::verify_encoded_bounded`] needs one number from somewhere. This is
/// it: generous enough that no real producer is near it — RFC 9106 recommends
/// 16 and [`RANDOM_SALT_LEN`] uses that — and small enough that a hostile string
/// cannot turn the decode into an allocation worth caring about.
///
/// A legitimate string with a salt longer than this is rejected with
/// [`Error::DecodingLengthFail`]; use the unbounded
/// [`Argon2::verify_encoded`] if you genuinely have one.
pub const BOUNDED_MAX_SALT_LEN: u32 = 1024;

/// A configured Argon2 hasher.
///
/// Bundles the algorithm, version and validated [`Params`]. The secret (key) and
/// associated data are passed per call rather than stored, which keeps `Argon2`
/// free of lifetime parameters.
///
/// # Examples
///
/// ```
/// use argon2_rust::{Algorithm, Argon2, Params, Version};
///
/// // m=19456 KiB, t=2, 1 lane, 32-byte tag: `Params::default()`, which is
/// // what a password store should start from. About 8 ms per hash in release,
/// // so this runs as a real doctest rather than only being compiled.
/// let params = Params::default();
/// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
/// let mut tag = [0u8; 32];
/// argon2.hash_into(b"password", b"somesalt", &mut tag)?;
/// assert_eq!(argon2.verify(b"password", b"somesalt", &tag), Ok(()));
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # Two spellings
///
/// Three entry points carry a password-flavoured alias, and only three:
/// [`Argon2::hash_password_into`] for [`Argon2::hash_into`],
/// [`Argon2::hash_password`] for [`Argon2::hash_encoded`], and
/// [`Argon2::verify_password`] for [`Argon2::verify_encoded`]. Each of those
/// three is a pure delegation, same function and same bytes.
///
/// Six other entry points have a base name and nothing else: [`Argon2::hash`],
/// [`Argon2::verify`], [`Argon2::hash_into_with_ad`],
/// [`Argon2::verify_encoded_with_ad`], [`Argon2::verify_encoded_bounded`] and
/// [`Argon2::verify_encoded_bounded_with_ad`]. One runs the other way:
/// `Argon2::hash_password_with_random_salt` has a password name with no base
/// twin, and it is not a delegation either. It draws a fresh salt from the OS
/// before calling [`Argon2::hash_encoded`], so two calls with one password do
/// not return the same string.
///
/// Where the alias does exist, the two families do not spell the *output
/// format* the same way:
///
/// ```text
///                      raw -> caller buffer   raw -> Vec   PHC -> String
///   base:              hash_into              hash         hash_encoded
///   password:          hash_password_into     (none)       hash_password
///                                   ^ raw                  ^ PHC
/// ```
///
/// [`Argon2::hash_password_into`] writes a **raw** tag into `out`, byte for
/// byte what [`Argon2::hash_into`] writes. [`Argon2::hash_password`] returns a
/// **PHC string**, character for character what [`Argon2::hash_encoded`]
/// returns. The only difference between those two names is `_into`, which reads
/// as a destination and not as a format; in the base family the word `encoded`
/// carries that distinction in the name, and in the password family nothing
/// does. Verification is the same shape: [`Argon2::verify_password`] takes a
/// PHC string, like [`Argon2::verify_encoded`], not the raw expected tag that
/// [`Argon2::verify`] takes.
///
/// There is no raw-`Vec` password spelling, which is the empty cell above; for
/// that shape the only name is [`Argon2::hash`].
///
/// ```
/// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
///
/// let params = Params::builder().memory(Memory::kib(1 << 8)).passes(1).build()?;
/// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
///
/// // `_into` picks the destination, and with it the raw format.
/// let mut raw = [0u8; 32];
/// argon2.hash_password_into(b"password", b"somesalt", &mut raw)?;
///
/// // No suffix at all, and the format changes to PHC.
/// let phc = argon2.hash_password(b"password", b"somesalt")?;
/// assert!(phc.starts_with("$argon2id$v=19$m=256,t=1,p=1$c29tZXNhbHQ$"));
///
/// // One tag underneath both: `raw` is the bytes the string base64s.
/// assert_eq!(argon2.hash(b"password", b"somesalt")?, raw);
/// # Ok::<(), argon2_rust::Error>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2 {
    algorithm: Algorithm,
    version: Version,
    params: Params,
}

impl Argon2 {
    /// Build a hasher. `params` is already validated, so this cannot fail.
    #[inline]
    #[must_use]
    pub const fn new(algorithm: Algorithm, version: Version, params: Params) -> Argon2 {
        Argon2 {
            algorithm,
            version,
            params,
        }
    }

    /// The configured algorithm.
    #[inline]
    #[must_use]
    pub const fn algorithm(&self) -> Algorithm {
        self.algorithm
    }

    /// The configured version.
    #[inline]
    #[must_use]
    pub const fn version(&self) -> Version {
        self.version
    }

    /// The configured parameters.
    #[inline]
    #[must_use]
    pub const fn params(&self) -> &Params {
        &self.params
    }

    /// A `Hasher`: this configuration plus scratch memory it keeps between
    /// calls.
    ///
    /// Allocates nothing — the first hash allocates the arena, and every hash
    /// after that reuses it. Use this when one thread hashes repeatedly;
    /// keep using [`Argon2::hash_into`] and friends when it does not.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(8)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    ///
    /// let mut hasher = argon2.hasher();
    /// let mut tag = [0u8; 32];
    /// for salt in [&b"somesalt"[..], &b"othersaltx"[..]] {
    ///     hasher.hash_into(b"password", salt, &mut tag)?;
    /// }
    ///
    /// // Same answer as the one-shot API, every time.
    /// let mut once = [0u8; 32];
    /// argon2.hash_into(b"password", b"somesalt", &mut once)?;
    /// hasher.hash_into(b"password", b"somesalt", &mut tag)?;
    /// assert_eq!(tag, once);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    #[inline]
    #[must_use]
    pub fn hasher(&self) -> Hasher {
        Hasher {
            argon2: *self,
            workspace: Workspace::new(),
        }
    }

    /// Derive a tag into `out`.
    ///
    /// `out.len()` must equal [`Params::tag_len_bytes`].
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Error, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    ///
    /// let mut tag = [0u8; 32];
    /// argon2.hash_into(b"password", b"somesalt", &mut tag)?;
    ///
    /// // Those 32 bytes are what the PHC string base64s, so pinning the string
    /// // pins the tag without spelling out an array of hex.
    /// assert_eq!(
    ///     argon2.hash_encoded(b"password", b"somesalt")?,
    ///     "$argon2id$v=19$m=64,t=1,p=1$c29tZXNhbHQ$cpx6VEQbwTVZvcpxNIxOVUWZ5xnAipUmAe1cg2GMG70",
    /// );
    ///
    /// // `out.len()` is checked against `Params::tag_len_bytes`, never used to
    /// // size the tag: a buffer of the wrong length is an error, not a
    /// // truncated hash.
    /// let mut too_short = [0u8; 16];
    /// assert_eq!(
    ///     argon2.hash_into(b"password", b"somesalt", &mut too_short),
    ///     Err(Error::OutPtrMismatch),
    /// );
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// Whatever [`Params::validate_for`] returns, [`Error::OutPtrMismatch`] if
    /// `out.len()` disagrees with `params.tag_len_bytes()`, or
    /// [`Error::MemoryAllocationError`].
    pub fn hash_into(&self, pwd: &[u8], salt: &[u8], out: &mut [u8]) -> Result<(), Error> {
        self.hash_into_with_ad(pwd, salt, &[], &[], out)
    }

    /// Derive a tag into `out`, with a secret key and associated data.
    ///
    /// For a C-style PHC string of a peppered tag, see
    /// [`Argon2::hash_encoded_with_ad`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash_into_with_ad(
        &self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        out: &mut [u8],
    ) -> Result<(), Error> {
        // SAFETY: the only `Backend` the public API ever names is
        // `fill_block::backend()`, the cached result of the
        // `is_*_feature_detected!` cascade, so this CPU can execute it by
        // construction. That is what keeps this — and every other public entry
        // point — safe while `hash_inner` is not.
        unsafe {
            hash_inner(
                crate::fill_block::backend(),
                self.algorithm,
                self.version,
                &self.params,
                pwd,
                salt,
                secret,
                ad,
                out,
            )
        }
    }

    /// Derive a tag of [`Params::tag_len_bytes`] bytes.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    ///
    /// // The `Vec` is sized from the parameters, so there is no buffer to get
    /// // wrong and no `Error::OutPtrMismatch` to handle.
    /// let tag = argon2.hash(b"password", b"somesalt")?;
    /// assert_eq!(tag.len(), argon2.params().tag_len_bytes());
    ///
    /// // Byte for byte what `hash_into` writes into a buffer you own; this is
    /// // the same function with the allocation moved inside.
    /// let mut into = [0u8; 32];
    /// argon2.hash_into(b"password", b"somesalt", &mut into)?;
    /// assert_eq!(tag, into);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash(&self, pwd: &[u8], salt: &[u8]) -> Result<Vec<u8>, Error> {
        self.hash_with_ad(pwd, salt, &[], &[])
    }

    /// [`Argon2::hash`] with a secret key and associated data.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash_with_ad(
        &self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
    ) -> Result<Vec<u8>, Error> {
        let mut out = try_zeroed_vec(self.params.tag_len_bytes())?;
        self.hash_into_with_ad(pwd, salt, secret, ad, &mut out)?;
        Ok(out)
    }

    /// Derive a tag and format it as a PHC string.
    ///
    /// Always emits `$v=`, exactly as `encode_string()` in the C does, even for
    /// [`Version::V0x10`].
    ///
    /// # Secret and associated data
    ///
    /// This method never takes a `secret` (pepper) or `ad`, matching
    /// `argon2_hash()` (`argon2.h:322`): the C hardcodes
    /// `context.secret = NULL; context.ad = NULL` (`argon2.c:139-142`) and
    /// `encode_string` emits only `$type$v=$m=,t=,p=$salt$hash`.
    ///
    /// [`Argon2::hash_encoded_with_ad`] hashes with a pepper and/or associated
    /// data, then emits that same C-style string — it does **not** write a
    /// `data=` field. The tag is peppered; the string is indistinguishable from
    /// an unpeppered one. [`Argon2::verify_encoded`] on it answers
    /// [`Error::VerifyMismatch`] rather than any "missing pepper" signal; use
    /// [`Argon2::verify_encoded_with_ad`] with the same secret and ad.
    ///
    /// Foreign producers (`@phc/format`, node-argon2) may put associated data
    /// in a `data=` parameter and may write `m`, `t`, `p` in any order. Those
    /// strings are what [`crate::decode_phc`] reads. [`crate::decode_string`]
    /// stays C-strict (`$m=,t=,p=` only, no `data=`).
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    pub fn hash_encoded(&self, pwd: &[u8], salt: &[u8]) -> Result<String, Error> {
        self.hash_encoded_with_ad(pwd, salt, &[], &[])
    }

    /// Derive a peppered tag and format it as a C-style PHC string.
    ///
    /// The secret and associated data feed the tag the same way
    /// [`Argon2::hash_into_with_ad`] does. They are **not** written into the
    /// string: `encode_string` has no field for either, so the result looks like
    /// any other `$type$v=$m=,t=,p=$salt$hash` record. Bindings that must
    /// interoperate with node-argon2 `data=` strings should hash here and
    /// verify through [`crate::decode_phc`].
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    /// let encoded = argon2.hash_encoded_with_ad(
    ///     b"password",
    ///     b"somesalt",
    ///     b"pepper",
    ///     b"ad",
    /// )?;
    /// assert!(encoded.starts_with("$argon2id$v=19$m=64,t=1,p=1$c29tZXNhbHQ$"));
    /// assert!(!encoded.contains("data="));
    /// assert_eq!(
    ///     Argon2::verify_encoded_with_ad(
    ///         &encoded,
    ///         b"password",
    ///         b"pepper",
    ///         b"ad",
    ///         Algorithm::Argon2id,
    ///     ),
    ///     Ok(()),
    /// );
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    pub fn hash_encoded_with_ad(
        &self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
    ) -> Result<String, Error> {
        let mut tag = self.hash_with_ad(pwd, salt, secret, ad)?;
        let encoded = crate::encoding::encode_string_alloc(
            self.algorithm,
            self.version,
            &self.params,
            salt,
            &tag,
        );
        // argon2.c:173 `clear_internal_memory(out, hashlen);`
        clear_internal_memory(&mut tag);
        encoded
    }

    /// Recompute the tag and compare it with `expected` in constant time.
    ///
    /// A length mismatch is a [`Error::VerifyMismatch`], not a separate error:
    /// the C cannot reach that case, because `decode_string` sets
    /// `context->outlen` from the tag it just decoded.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Error, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    ///
    /// // A raw tag stored earlier, alongside the salt that produced it. The
    /// // parameters are yours to remember too, which is what the PHC string
    /// // from `hash_encoded` saves you.
    /// let expected = argon2.hash(b"password", b"somesalt")?;
    /// assert_eq!(argon2.verify(b"password", b"somesalt", &expected), Ok(()));
    ///
    /// // Wrong password.
    /// assert_eq!(
    ///     argon2.verify(b"wrong", b"somesalt", &expected),
    ///     Err(Error::VerifyMismatch),
    /// );
    /// // Wrong salt: the tag is a function of both.
    /// assert_eq!(
    ///     argon2.verify(b"password", b"othersalt", &expected),
    ///     Err(Error::VerifyMismatch),
    /// );
    /// // A truncated `expected` is that same error and not a length error,
    /// // exactly as the paragraph above says.
    /// assert_eq!(
    ///     argon2.verify(b"password", b"somesalt", &expected[..16]),
    ///     Err(Error::VerifyMismatch),
    /// );
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], or [`Error::VerifyMismatch`].
    pub fn verify(&self, pwd: &[u8], salt: &[u8], expected: &[u8]) -> Result<(), Error> {
        self.verify_with_ad(pwd, salt, &[], &[], expected)
    }

    /// [`Argon2::verify`] with a secret key and associated data.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], or [`Error::VerifyMismatch`].
    pub fn verify_with_ad(
        &self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        expected: &[u8],
    ) -> Result<(), Error> {
        let mut computed = try_zeroed_vec(self.params.tag_len_bytes())?;
        let result = self.hash_into_with_ad(pwd, salt, secret, ad, &mut computed);
        // argon2.c:349 `argon2_compare(hash, context->out, context->outlen)`.
        let matched = result.is_ok() && constant_time_eq(&computed, expected);
        clear_internal_memory(&mut computed);

        result?;
        if matched {
            Ok(())
        } else {
            Err(Error::VerifyMismatch)
        }
    }

    /// `argon2_verify()`: decode a PHC string and check `pwd` against it.
    ///
    /// # Errors
    ///
    /// [`Error::DecodingFail`] for a malformed string, [`Error::VerifyMismatch`]
    /// if the password is wrong, or any hashing error.
    pub fn verify_encoded(encoded: &str, pwd: &[u8], algorithm: Algorithm) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        // argon2.c:289 `decode_string(&ctx, encoded, type)`.
        let decoded = crate::encoding::decode_string(encoded, algorithm)?;

        // argon2.c:302 `argon2_verify_ctx(&ctx, desired_result, type)`.
        Argon2::new(decoded.algorithm, decoded.version, decoded.params).verify(
            pwd,
            &decoded.salt,
            &decoded.hash,
        )
    }

    /// `argon2_verify_ctx()`: decode a PHC string and check `pwd` against it,
    /// with a secret key and associated data.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded`], plus the secret/ad validation errors of
    /// [`Argon2::hash_into_with_ad`].
    pub fn verify_encoded_with_ad(
        encoded: &str,
        pwd: &[u8],
        secret: &[u8],
        ad: &[u8],
        algorithm: Algorithm,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        // argon2.c:289 `decode_string(&ctx, encoded, type)`.
        let decoded = crate::encoding::decode_string(encoded, algorithm)?;

        // argon2.c:302 `argon2_verify_ctx(&ctx, desired_result, type)`.
        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);
        let mut computed = try_zeroed_vec(argon2.params.tag_len_bytes())?;
        let result =
            argon2.hash_into_with_ad(pwd, &decoded.salt, secret, ad, &mut computed);
        let matched = result.is_ok() && constant_time_eq(&computed, &decoded.hash);
        clear_internal_memory(&mut computed);

        result?;
        if matched {
            Ok(())
        } else {
            Err(Error::VerifyMismatch)
        }
    }

    // -----------------------------------------------------------------
    // Password-flavoured spellings of the three entry points above
    // -----------------------------------------------------------------
    //
    // Same functions, the names the C's three public entry points suggest:
    // `argon2_hash` with a raw output buffer, `argon2_hash` with an encoded
    // output buffer, and `argon2_verify`. They exist so a caller can read the
    // API as "hash a password" rather than "hash some bytes"; the shorter
    // spellings stay because that is what this crate's own tests and benches
    // already call.
    //
    // That last half is an internal reason. The user-facing one is that these
    // are the names a C caller already knows: the per-algorithm wrappers it
    // links against are `argon2id_hash_raw` (argon2.c:230),
    // `argon2id_hash_encoded` (argon2.c:219) and `argon2id_verify`
    // (argon2.c:325), each a single `return` into `argon2_hash`/`argon2_verify`
    // and nothing else in the body. Only `argon2id_verify` fits on one line
    // (argon2.c:327); the two hash wrappers each spend three on the argument
    // list alone (argon2.c:225-227 and argon2.c:234-236), which is line
    // wrapping and not work. The raw/encoded choice is made entirely by which
    // out-pointer those wrappers pass as non-NULL (argon2.c:160 `if (hash)`,
    // argon2.c:165 `if (encoded && encodedlen)`).
    //
    // Note what the C's names do that these do not: they carry the output
    // format, `raw` against `encoded`. Here the only difference between
    // `hash_password_into` and `hash_password` is `_into`, which names a
    // destination, not a format. So the format asymmetry is stated on the type
    // (`Argon2`'s `# Two spellings`) and again on the first line of each method
    // below, where a reader scanning the method list will actually see it.

    /// Derive a **raw** tag into `out`, not a PHC string.
    ///
    /// `argon2_hash()` with `hash != NULL` (`argon2.c:160`). The same function
    /// as [`Argon2::hash_into`]: `_into` picks the destination, and the format
    /// that comes with it is bytes. `out.len()` must equal
    /// [`Params::tag_len_bytes`]. For the PHC string, [`Argon2::hash_password`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    #[inline]
    pub fn hash_password_into(&self, pwd: &[u8], salt: &[u8], out: &mut [u8]) -> Result<(), Error> {
        self.hash_into(pwd, salt, out)
    }

    /// Derive a tag and return the **PHC string** for it, not the raw bytes.
    ///
    /// `argon2_hash()` with `encoded != NULL` (`argon2.c:165`). The same
    /// function as [`Argon2::hash_encoded`]; for the raw tag, its sibling
    /// [`Argon2::hash_password_into`] or [`Argon2::hash`].
    ///
    /// Always emits `$v=`, just like `encode_string()` in the C, even for
    /// [`Version::V0x10`] — the `v=0x10` reference strings in `src/test.c`
    /// predate that field, so they have no `$v=` and are one field shorter than
    /// what this returns. Both forms decode, see [`Argon2::verify_password`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    #[inline]
    pub fn hash_password(&self, pwd: &[u8], salt: &[u8]) -> Result<String, Error> {
        self.hash_encoded(pwd, salt)
    }

    /// Derive a PHC string with a fresh salt from the OS entropy source.
    ///
    /// Convenience for the common case where the caller does not manage its own
    /// salt. The salt is [`RANDOM_SALT_LEN`] bytes — the length RFC 9106 §4
    /// recommends — and lands in the returned string, so verification needs
    /// nothing else kept alongside it.
    ///
    /// The randomness comes straight from the OS, with the entry point chosen
    /// per platform (`getrandom(2)`, `getentropy`, `CCRandomGenerateBytes`,
    /// `ProcessPrng`, WASI `random_get`, or `/dev/urandom`) and declared by
    /// hand, so this costs the crate no dependency. Callers who already run
    /// their own CSPRNG should keep passing their own salt to
    /// [`Argon2::hash_encoded`].
    ///
    /// Hashing many passwords? [`Hasher::hash_password_with_random_salt`] does
    /// this over a pooled arena.
    ///
    /// # Errors
    ///
    /// [`Error::OsRandom`] if every OS entropy source for this platform fails,
    /// plus the errors of [`Argon2::hash_encoded`].
    #[cfg(feature = "std")]
    pub fn hash_password_with_random_salt(&self, pwd: &[u8]) -> Result<String, Error> {
        // Not wiped on the way out, deliberately, and unlike every other
        // buffer in this file: the salt is *published* in the returned string,
        // so scrubbing the stack copy protects nothing that is not already in
        // the caller's hands. `clear_internal_memory` is for secret-derived
        // material; a salt is not that.
        let mut salt = [0u8; RANDOM_SALT_LEN];
        crate::random::os_random(&mut salt)?;
        self.hash_encoded(pwd, &salt)
    }

    /// Check `pwd` against a **PHC string**, not against a raw tag.
    ///
    /// `argon2_verify()` (`argon2.c:249`): decode `encoded`, then recompute and
    /// compare. The same function as [`Argon2::verify_encoded`]. The parameters
    /// come out of the string, so nothing on `self` is consulted, which is why
    /// this is an associated function. To check a raw expected tag with these
    /// parameters instead, [`Argon2::verify`].
    ///
    /// # Errors
    ///
    /// [`Error::DecodingFail`] for a malformed string, [`Error::VerifyMismatch`]
    /// if the password is wrong, or any hashing error.
    #[inline]
    pub fn verify_password(encoded: &str, pwd: &[u8], algorithm: Algorithm) -> Result<(), Error> {
        Argon2::verify_encoded(encoded, pwd, algorithm)
    }

    /// [`Argon2::verify_encoded`], refusing costs above `ceiling` **before**
    /// allocating anything.
    ///
    /// # Why this exists
    ///
    /// `m_cost` in a PHC string is up to ten decimal digits, and the decoder
    /// accepts everything the C accepts — up to
    /// [`MAX_MEMORY`](crate::params::MAX_MEMORY) KiB, which is 4 TiB. Nothing in
    /// [`Argon2::verify_encoded`] sits between that number and the allocation,
    /// because nothing does in `argon2_verify` either; on a login endpoint,
    /// where the string is whatever a database row (or a request) contained,
    /// that is a one-line denial of service. `t_cost` is the same story in CPU
    /// time rather than bytes.
    ///
    /// The plain entry points keep exact C parity and are the right choice when
    /// the string is trusted — a config file, a fixture, your own output. This
    /// one is for when it is not.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// let hostile = "$argon2id$v=19$m=4294967295,t=1,p=1$c29tZXNhbHQ$\
    ///                CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
    /// // 64 MiB, 8 passes, 4 lanes is far more than any sane stored hash.
    /// let ceiling = Params::builder().memory(Memory::mib(64)).passes(8).lanes(4).build()?;
    ///
    /// let err = Argon2::verify_encoded_bounded(
    ///     hostile, b"password", Algorithm::Argon2id, &ceiling,
    /// ).unwrap_err();
    /// // Rejected on the parameters, without ever asking for 4 TiB.
    /// assert_eq!(err, argon2_rust::Error::MemoryTooMuch);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # What is bounded
    ///
    /// Both the cost *and* the allocation. The length of `encoded` is checked
    /// against the longest string `ceiling` could have produced — with
    /// [`BOUNDED_MAX_SALT_LEN`] allowed for the salt — **before** the decoder
    /// runs, because the decoder sizes its salt and tag buffers from the input.
    /// Then the decoded parameters are held to all four of the ceiling's
    /// numbers.
    ///
    /// # Worker threads
    ///
    /// `ceiling.threads()` bounds them, and it is a *fifth*, independent knob —
    /// none of the four checks above implies it. Decoding sets `threads = lanes`
    /// (C parity), so the string's own `p` would otherwise choose how many OS
    /// threads this call spawns. A ceiling that leaves
    /// [`ParamsBuilder::threads`](crate::params::ParamsBuilder::threads) unset
    /// has `threads == lanes` and so bounds them together; set it to allow wide
    /// strings without spawning wide:
    ///
    /// ```
    /// use argon2_rust::{Params, params::Memory};
    /// // Accept up to 256 lanes, but never run more than 2 workers.
    /// let ceiling = Params::builder()
    ///     .memory(Memory::mib(64))
    ///     .passes(8)
    ///     .lanes(256)
    ///     .threads(2)
    ///     .build()?;
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// Clamping is always safe: `threads` is a scheduling knob that cannot
    /// change the tag — only `lanes` can — so a bounded verify accepts exactly
    /// the same strings whatever the budget.
    ///
    /// # Errors
    ///
    /// The errors of [`Argon2::verify_encoded`], plus — checked in this order,
    /// and reusing the C's own codes rather than inventing new ones —
    /// [`Error::DecodingLengthFail`] if `encoded` is longer than `ceiling` could
    /// have produced, [`Error::OutputTooLong`] if the decoded tag is longer than
    /// `ceiling.tag_len_bytes()`, [`Error::MemoryTooMuch`] if the decoded `m_cost`
    /// exceeds `ceiling.memory_kib()`, [`Error::TimeTooLarge`] if `t_cost` exceeds
    /// `ceiling.passes()`, and [`Error::LanesTooMany`] if `lanes` exceeds
    /// `ceiling.lanes()`.
    pub fn verify_encoded_bounded(
        encoded: &str,
        pwd: &[u8],
        algorithm: Algorithm,
        ceiling: &Params,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        let decoded = decode_bounded(encoded, algorithm, ceiling)?;

        Argon2::new(decoded.algorithm, decoded.version, decoded.params).verify(
            pwd,
            &decoded.salt,
            &decoded.hash,
        )
    }

    /// [`Argon2::verify_encoded_with_ad`] with the cost ceiling of
    /// [`Argon2::verify_encoded_bounded`].
    ///
    /// A keyed deployment is *more* likely to be the one parsing untrusted
    /// strings, not less, so the bounded form exists for both.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded_bounded`], plus the secret/ad validation
    /// errors of [`Argon2::hash_into_with_ad`].
    pub fn verify_encoded_bounded_with_ad(
        encoded: &str,
        pwd: &[u8],
        secret: &[u8],
        ad: &[u8],
        algorithm: Algorithm,
        ceiling: &Params,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        let decoded = decode_bounded(encoded, algorithm, ceiling)?;

        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);
        let mut computed = try_zeroed_vec(argon2.params.tag_len_bytes())?;
        let result = argon2.hash_into_with_ad(pwd, &decoded.salt, secret, ad, &mut computed);
        let matched = result.is_ok() && constant_time_eq(&computed, &decoded.hash);
        clear_internal_memory(&mut computed);

        result?;
        if matched {
            Ok(())
        } else {
            Err(Error::VerifyMismatch)
        }
    }
}

/// Decode `encoded` and hold it to `ceiling`, for the `*_bounded` entry points.
///
/// # Why the length gate comes first
///
/// Checking the ceiling *after* decoding is not enough, and an earlier revision
/// of this function got that wrong. [`crate::encoding::decode_string`] sizes its
/// salt and tag buffers from the input string, so the decode itself is an
/// attacker-controlled allocation before any ceiling is consulted. Measured with
/// an allocator spy against the previous version: a well-formed string with
/// `m=8,t=1,p=1` and a 16 MiB Base64 tag peaked at **36 MiB** of live
/// allocation, then ran a full Argon2 and a 12 MiB comparison — under a ceiling
/// whose tag length was 32 bytes. Every cost was inside the ceiling; the tag was
/// never looked at.
///
/// So the size of the string is checked against what the ceiling could
/// legitimately produce *before* anything is parsed, and the decoded tag length
/// is then checked against `ceiling.tag_len_bytes()` as well. A ceiling is four
/// numbers, and all four now mean something.
fn decode_bounded(
    encoded: &str,
    algorithm: Algorithm,
    ceiling: &Params,
) -> Result<crate::encoding::Decoded, Error> {
    // The longest string the ceiling could have produced. `num_len` is monotone
    // in its argument and the costs are themselves capped below, so taking the
    // ceiling's own values gives a true upper bound. `encoded_len` counts the
    // C's NUL, so this is permissive by exactly one byte.
    let max_encoded = crate::encoding::encoded_len(
        algorithm,
        ceiling.passes(),
        ceiling.memory_kib(),
        ceiling.lanes(),
        BOUNDED_MAX_SALT_LEN,
        // The tag length is bounded by MAX_OUTLEN, so this cast cannot truncate.
        ceiling.tag_len_bytes() as u32,
    );
    if encoded.len() > max_encoded {
        // ARGON2_DECODING_LENGTH_FAIL: "Some of encoded parameters are too long
        // or too short". The C defines it for exactly this and never returns it;
        // it is the right code and it costs no new error variant.
        return Err(Error::DecodingLengthFail);
    }

    let mut decoded = crate::encoding::decode_string(encoded, algorithm)?;

    if decoded.params.tag_len_bytes() > ceiling.tag_len_bytes() {
        return Err(Error::OutputTooLong);
    }
    if decoded.params.memory_kib() > ceiling.memory_kib() {
        return Err(Error::MemoryTooMuch);
    }
    if decoded.params.passes() > ceiling.passes() {
        return Err(Error::TimeTooLarge);
    }
    if decoded.params.lanes() > ceiling.lanes() {
        return Err(Error::LanesTooMany);
    }

    // The four checks above do **not** imply a worker-thread bound, and the
    // ceiling's `threads` is a separate field precisely so a caller can say
    // "allow wide strings, but never spawn wide". `decode_string` sets
    // `threads = lanes` (C parity, `argon2.c`), and `fill_pooled` spawns
    // `min(threads, lanes) - 1` helpers — so without this clamp a `p=256`
    // string inside a `lanes` ceiling of 256 spawns 255 OS threads even when
    // the ceiling asked for one worker. That is attacker-chosen concurrency on
    // an authentication path.
    //
    // Lowering `threads` is free: it is a pure scheduling knob that cannot
    // change the tag (only `lanes` can), which `threads_do_not_change_the_tag`
    // pins across both versions and all three algorithms.
    //
    // `min` with `lanes` keeps the value meaningful rather than merely legal —
    // workers above the lane count have nothing to claim — and cannot underflow
    // the `MIN_THREADS = 1` floor, because a validated ceiling has
    // `threads >= 1` and a decoded string has `lanes >= 1`.
    let threads = ceiling.threads().min(decoded.params.lanes());
    if threads != decoded.params.threads() {
        // `to_builder()` carries the four cost values and the tag length across
        // unchanged, so only the one field that actually moves is named here.
        // Re-listing all five through `Params::builder()` would invite exactly
        // the drift this clamp exists to prevent.
        decoded.params = decoded.params.to_builder().threads(threads).build()?;
    }
    Ok(decoded)
}

// ---------------------------------------------------------------------------
// Hasher — the same API, over memory that survives the call
// ---------------------------------------------------------------------------

/// An [`Argon2`] that keeps its block arena between calls.
///
/// Build one with [`Argon2::hasher`]. Every method mirrors the [`Argon2`]
/// method of the same name and returns the same bytes; the only difference is
/// that the arena is borrowed from a pool instead of allocated and freed each
/// time. Nothing else about the computation changes — same backend dispatch,
/// same threading, same wipe.
///
/// ```
/// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
///
/// let params = Params::builder().memory(Memory::kib(1 << 8)).passes(1).build()?;
/// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
/// let mut hasher = argon2.hasher();
///
/// let encoded = hasher.hash_encoded(b"password", b"somesalt")?;
/// assert!(hasher.verify_encoded(&encoded, b"password", Algorithm::Argon2id).is_ok());
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # What it is worth, measured
///
/// Reuse skips the `mmap`, the first-touch page faults over the whole arena,
/// and the `munmap`. Interleaved A/B against [`Argon2::hash_into`], 15 paired
/// rounds on Linux/x86-64 (Sapphire Rapids, AVX-512):
///
/// ```text
///   m_cost   t   p |  one-shot |    pooled |  delta
///  ---------|-----|-----------|-----------|--------
///     8 KiB   1   1 |  20.4 us |   20.3 us |  -0.7%
///    64 KiB   1   1 |  27.9 us |   26.5 us |  -5.3%
///     1 MiB   1   1 |  212 us  |   185 us  | -11.7%
///     4 MiB   1   1 |  989 us  |   786 us  | -19.9%
///     4 MiB   1   4 |  806 us  |   592 us  | -26.9%
///    64 MiB   1   1 |  25.89 ms|  19.43 ms | -24.9%
///    64 MiB   1   4 |  11.65 ms|   8.40 ms | -34.0%
///   256 MiB   1   1 | 111.74 ms|  86.17 ms | -23.3%
///   256 MiB   1   4 |  46.14 ms|  35.09 ms | -24.0%
///   256 MiB   3   4 | 109.85 ms|  99.26 ms |  -9.7%
/// ```
///
/// The `t = 3` rows are smaller for the obvious reason: the same one-time
/// acquisition is spread over three passes of filling.
///
/// It does **not** remove allocator calls — there was only ever one per hash,
/// 1.7 us out of 306 ms at `m_cost = 1 GiB`.
///
/// # Wiping
///
/// Unchanged from the one-shot API. The arena is wiped when the call that
/// borrowed it returns — success, `?` error or unwind alike — so the window in
/// which a password's derived material is resident is exactly as long as it was
/// before. What reuse changes is that the wipe now doubles as the *next* call's
/// zeroing, instead of being followed by a fresh `alloc_zeroed` that zeroes
/// again.
///
/// Dropping the `Hasher` releases the arena to the allocator, wiped.
///
/// # Threading
///
/// One `Hasher` per thread. It is [`Send`], so it can move to whichever worker
/// picks up a request, and deliberately **not** [`Sync`]: two threads hashing
/// through one `Hasher` would be two hashes sharing one arena. The multi-lane
/// fill inside a single hash is unaffected — one [`std::thread::scope`] owns
/// its helper pool for the whole fill, over the arena this `Hasher` lent it for
/// the duration of that one call.
///
/// ```compile_fail
/// # use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
/// # let params = Params::builder().memory(Memory::kib(8)).passes(1).build().unwrap();
/// # let hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();
/// fn needs_sync<T: Sync>(_: &T) {}
/// needs_sync(&hasher);
/// ```
///
/// # Two spellings
///
/// Every alias mirrors [`Argon2`], trap included: [`Hasher::hash_password_into`]
/// writes a **raw** tag while [`Hasher::hash_password`] returns a **PHC
/// string**, because `_into` names a destination and not a format. See
/// [`Argon2`'s section of the same name](Argon2#two-spellings) for the table.
///
/// ```
/// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
///
/// let params = Params::builder().memory(Memory::kib(1 << 8)).passes(1).build()?;
/// let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();
///
/// // Same prefix, same arena, different return type and different format.
/// let mut raw = [0u8; 32];
/// hasher.hash_password_into(b"password", b"somesalt", &mut raw)?;
/// let phc = hasher.hash_password(b"password", b"somesalt")?;
///
/// assert!(phc.starts_with("$argon2id$v=19$m=256,t=1,p=1$c29tZXNhbHQ$"));
/// assert_eq!(hasher.hash(b"password", b"somesalt")?, raw);
/// # Ok::<(), argon2_rust::Error>(())
/// ```
pub struct Hasher {
    argon2: Argon2,
    workspace: Workspace,
}

impl Hasher {
    /// The configuration this hasher applies.
    #[inline]
    #[must_use]
    pub const fn argon2(&self) -> &Argon2 {
        &self.argon2
    }

    /// Point the hasher at a different configuration, keeping the memory.
    ///
    /// For a process that has to hash at more than one parameter set — a
    /// password migration, say. The arena grows if the new `m_cost` needs more
    /// blocks and is kept as-is if it needs fewer, so the steady state is one
    /// allocation sized to the largest configuration seen.
    #[inline]
    pub fn set_argon2(&mut self, argon2: Argon2) {
        self.argon2 = argon2;
    }

    /// The configured algorithm.
    #[inline]
    #[must_use]
    pub const fn algorithm(&self) -> Algorithm {
        self.argon2.algorithm
    }

    /// The configured version.
    #[inline]
    #[must_use]
    pub const fn version(&self) -> Version {
        self.argon2.version
    }

    /// The configured parameters.
    #[inline]
    #[must_use]
    pub const fn params(&self) -> &Params {
        &self.argon2.params
    }

    /// Allocate the arena now instead of during the first hash.
    ///
    /// Only moves the cost; it does not remove it. Worth doing when the first
    /// request must not be the slow one, or to find out at start-up rather than
    /// under load that `m_cost` does not fit in memory.
    ///
    /// # Errors
    ///
    /// [`Error::MemoryAllocationError`].
    pub fn reserve(&mut self) -> Result<(), Error> {
        self.workspace.reserve(self.argon2.params.memory_blocks() as usize)
    }

    /// Blocks of arena the hasher is holding on to. 1 KiB each.
    ///
    /// 0 before the first hash, or after [`clear`](Hasher::clear). Diagnostic:
    /// it is how a test proves that reuse is actually happening.
    #[inline]
    #[must_use]
    pub fn reserved_blocks(&self) -> usize {
        self.workspace.capacity()
    }

    /// Give the arena back to the allocator, wiped, and keep the configuration.
    ///
    /// For a worker going idle that would rather not sit on `m_cost` KiB. The
    /// next hash allocates again.
    pub fn clear(&mut self) {
        self.workspace.clear();
    }

    /// Derive a tag into `out`. [`Argon2::hash_into`], reusing the arena.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    /// let mut hasher = argon2.hasher();
    ///
    /// // `Argon2::hasher` allocates nothing; the first hash sizes the arena.
    /// assert_eq!(hasher.reserved_blocks(), 0);
    ///
    /// let mut tags = Vec::new();
    /// for pwd in [&b"first"[..], &b"second"[..]] {
    ///     let mut tag = [0u8; 32];
    ///     hasher.hash_into(pwd, b"somesalt", &mut tag)?;
    ///     tags.push(tag);
    /// }
    ///
    /// // Two hashes, one arena: 64 blocks of 1 KiB, the `m_cost` above. The
    /// // second call neither allocated nor grew it.
    /// assert_eq!(hasher.reserved_blocks(), 64);
    /// assert_ne!(tags[0], tags[1]);
    ///
    /// // Reuse changes where the memory came from and nothing else.
    /// assert_eq!(argon2.hash(b"second", b"somesalt")?, tags[1]);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    #[inline]
    pub fn hash_into(&mut self, pwd: &[u8], salt: &[u8], out: &mut [u8]) -> Result<(), Error> {
        self.hash_into_with_ad(pwd, salt, &[], &[], out)
    }

    /// [`Argon2::hash_into_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash_into_with_ad(
        &mut self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        out: &mut [u8],
    ) -> Result<(), Error> {
        let argon2 = self.argon2;
        self.hash_into_using(&argon2, pwd, salt, secret, ad, out)
    }

    /// [`Argon2::hash`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash(&mut self, pwd: &[u8], salt: &[u8]) -> Result<Vec<u8>, Error> {
        self.hash_with_ad(pwd, salt, &[], &[])
    }

    /// [`Argon2::hash_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    pub fn hash_with_ad(
        &mut self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
    ) -> Result<Vec<u8>, Error> {
        let mut out = try_zeroed_vec(self.argon2.params.tag_len_bytes())?;
        self.hash_into_with_ad(pwd, salt, secret, ad, &mut out)?;
        Ok(out)
    }

    /// [`Argon2::hash_encoded`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    pub fn hash_encoded(&mut self, pwd: &[u8], salt: &[u8]) -> Result<String, Error> {
        self.hash_encoded_with_ad(pwd, salt, &[], &[])
    }

    /// [`Argon2::hash_encoded_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    pub fn hash_encoded_with_ad(
        &mut self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
    ) -> Result<String, Error> {
        let argon2 = self.argon2;
        let mut tag = self.hash_with_ad(pwd, salt, secret, ad)?;
        let encoded = crate::encoding::encode_string_alloc(
            argon2.algorithm,
            argon2.version,
            &argon2.params,
            salt,
            &tag,
        );
        // argon2.c:173 `clear_internal_memory(out, hashlen);`
        clear_internal_memory(&mut tag);
        encoded
    }

    /// [`Argon2::verify`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], or [`Error::VerifyMismatch`].
    pub fn verify(&mut self, pwd: &[u8], salt: &[u8], expected: &[u8]) -> Result<(), Error> {
        self.verify_with_ad(pwd, salt, &[], &[], expected)
    }

    /// [`Argon2::verify_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], or [`Error::VerifyMismatch`].
    pub fn verify_with_ad(
        &mut self,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        expected: &[u8],
    ) -> Result<(), Error> {
        let argon2 = self.argon2;
        self.verify_using_ad(&argon2, pwd, salt, secret, ad, expected)
    }

    /// [`Argon2::verify_encoded`], reusing the arena.
    ///
    /// The parameters come from `encoded`, **not** from this hasher — that is
    /// what verifying a stored PHC string means, and it is what lets one hasher
    /// check strings written at several different `m_cost`s.
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Error, Params, Version, params::Memory};
    ///
    /// let params = Params::builder().memory(Memory::kib(64)).passes(1).build()?;
    /// let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();
    ///
    /// // Registration: one string, carrying the salt and the parameters.
    /// let stored = hasher.hash_encoded(b"password", b"somesalt")?;
    /// assert_eq!(
    ///     stored,
    ///     "$argon2id$v=19$m=64,t=1,p=1$c29tZXNhbHQ$cpx6VEQbwTVZvcpxNIxOVUWZ5xnAipUmAe1cg2GMG70",
    /// );
    ///
    /// // Two logins, over the arena the registration already paid for.
    /// assert_eq!(
    ///     hasher.verify_encoded(&stored, b"password", Algorithm::Argon2id),
    ///     Ok(()),
    /// );
    /// assert_eq!(
    ///     hasher.verify_encoded(&stored, b"wrong", Algorithm::Argon2id),
    ///     Err(Error::VerifyMismatch),
    /// );
    ///
    /// // The string's `m=64` is not above what this hasher already holds, so
    /// // the pool served both verifies and did not grow. See below for what
    /// // happens when a decoded `m_cost` is larger.
    /// assert_eq!(hasher.reserved_blocks(), 64);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    ///
    /// # The string cannot grow this hasher — but it can still be huge
    ///
    /// Read this one first: what follows bounds what an untrusted `m_cost` can
    /// **retain**, and nothing at all about what it can **allocate**. A decoded
    /// `m_cost` of `0xFFFFFFFF` still asks for a 4 TiB arena here, exactly as it
    /// does in [`Argon2::verify_encoded`] and exactly as it does in the C. If
    /// `encoded` comes from anywhere an attacker can write, bound it first —
    /// [`Hasher::verify_encoded_bounded`] does that — or the process dies on the
    /// allocation regardless of everything below.
    ///
    /// `encoded` is untrusted input: on a login endpoint it is whatever the
    /// database row said, and a `m_cost` field is four bytes of decimal that can
    /// ask for 4 TiB. A pooled arena is *retained*, so if a decoded `m_cost`
    /// were allowed to size it, one string would set a permanent high-water mark
    /// on a long-lived per-worker hasher — memory the process never gives back,
    /// chosen by the caller rather than by this hasher's owner.
    ///
    /// So it is not allowed to. A decoded `m_cost` that fits in memory this
    /// hasher already holds — [`reserved_blocks`](Hasher::reserved_blocks), or
    /// the [`params`](Hasher::params) it is configured for — is served from the
    /// pool as usual. One that would have to *grow* the pool gets a private
    /// arena instead, allocated, wiped and freed inside this call exactly as
    /// [`Argon2::verify_encoded`] does. Verifying still works at any `m_cost`
    /// the decoder accepts — including ones that will not fit in this machine.
    /// It just cannot leave anything behind.
    ///
    /// That mirrors the C, where `finalize()` ends every `argon2_ctx` with
    /// `free_memory(...)` (`core.c:184`), so `argon2_verify` never retains an
    /// arena sized by the string it was handed.
    ///
    /// To verify *and* keep the memory — a migration that re-hashes upward, say
    /// — call [`set_argon2`](Hasher::set_argon2) first. Then the size is the
    /// owner's choice, which is the whole distinction being drawn here.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded`].
    pub fn verify_encoded(
        &mut self,
        encoded: &str,
        pwd: &[u8],
        algorithm: Algorithm,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        // argon2.c:289 `decode_string(&ctx, encoded, type)`.
        let decoded = crate::encoding::decode_string(encoded, algorithm)?;

        // argon2.c:302 `argon2_verify_ctx(&ctx, desired_result, type)`.
        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);

        if decoded.params.memory_blocks() as usize > self.pooled_ceiling() {
            // Bigger than any arena this hasher's *owner* asked for. Run it on a
            // private arena that is freed on the way out, so an attacker-chosen
            // `m_cost` cannot pin memory to a worker for the rest of its life.
            return argon2.verify(pwd, &decoded.salt, &decoded.hash);
        }
        self.verify_using(&argon2, pwd, &decoded.salt, &decoded.hash)
    }

    /// [`Argon2::verify_encoded_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded_with_ad`].
    pub fn verify_encoded_with_ad(
        &mut self,
        encoded: &str,
        pwd: &[u8],
        secret: &[u8],
        ad: &[u8],
        algorithm: Algorithm,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        // argon2.c:289 `decode_string(&ctx, encoded, type)`.
        let decoded = crate::encoding::decode_string(encoded, algorithm)?;

        // argon2.c:302 `argon2_verify_ctx(&ctx, desired_result, type)`.
        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);

        if decoded.params.memory_blocks() as usize > self.pooled_ceiling() {
            // As `verify_encoded`: keep an attacker-chosen `m_cost` off the
            // pooled arena by running on a one-shot arena instead.
            let mut computed = try_zeroed_vec(argon2.params.tag_len_bytes())?;
            let result =
                argon2.hash_into_with_ad(pwd, &decoded.salt, secret, ad, &mut computed);
            let matched = result.is_ok() && constant_time_eq(&computed, &decoded.hash);
            clear_internal_memory(&mut computed);
            result?;
            return if matched {
                Ok(())
            } else {
                Err(Error::VerifyMismatch)
            };
        }
        self.verify_using_ad(&argon2, pwd, &decoded.salt, secret, ad, &decoded.hash)
    }

    // -----------------------------------------------------------------
    // Password-flavoured spellings, matching `Argon2`'s
    // -----------------------------------------------------------------

    /// Derive a **raw** tag into `out`, not a PHC string, reusing the arena.
    ///
    /// [`Argon2::hash_password_into`] over pooled memory, which is the same
    /// function as [`Hasher::hash_into`]. `out.len()` must equal
    /// [`Params::tag_len_bytes`]. For the PHC string, [`Hasher::hash_password`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`].
    #[inline]
    pub fn hash_password_into(
        &mut self,
        pwd: &[u8],
        salt: &[u8],
        out: &mut [u8],
    ) -> Result<(), Error> {
        self.hash_into(pwd, salt, out)
    }

    /// Derive a tag and return the **PHC string** for it, reusing the arena.
    ///
    /// [`Argon2::hash_password`] over pooled memory, which is the same function
    /// as [`Hasher::hash_encoded`]. For the raw tag instead, its sibling
    /// [`Hasher::hash_password_into`] or [`Hasher::hash`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::hash_into`], plus [`Error::EncodingFail`].
    #[inline]
    pub fn hash_password(&mut self, pwd: &[u8], salt: &[u8]) -> Result<String, Error> {
        self.hash_encoded(pwd, salt)
    }

    /// Derive a **PHC string** with a fresh salt from the OS entropy source,
    /// reusing the arena.
    ///
    /// [`Argon2::hash_password_with_random_salt`] over pooled memory, which is
    /// [`Hasher::hash_encoded`] with a [`RANDOM_SALT_LEN`]-byte salt drawn for
    /// you and carried in the returned string. There is no raw-tag counterpart:
    /// a caller who keeps the tag has to keep the salt too, and then generating
    /// it here saves nothing.
    ///
    /// This is the spelling that matters for the case the type exists to serve:
    /// a long-lived per-worker hasher registering many users, where every hash
    /// wants both the pooled arena *and* a fresh salt.
    ///
    /// # Errors
    ///
    /// [`Error::OsRandom`] if every OS entropy source fails, plus the errors of
    /// [`Hasher::hash_encoded`].
    #[cfg(feature = "std")]
    pub fn hash_password_with_random_salt(&mut self, pwd: &[u8]) -> Result<String, Error> {
        // Not wiped on the way out, deliberately, and unlike every other
        // buffer in this file: the salt is *published* in the returned string,
        // so scrubbing the stack copy protects nothing that is not already in
        // the caller's hands. `clear_internal_memory` is for secret-derived
        // material; a salt is not that.
        let mut salt = [0u8; RANDOM_SALT_LEN];
        crate::random::os_random(&mut salt)?;
        self.hash_encoded(pwd, &salt)
    }

    /// Check `pwd` against a **PHC string**, not a raw tag, reusing the arena.
    ///
    /// [`Argon2::verify_password`] over pooled memory, which is the same
    /// function as [`Hasher::verify_encoded`] and inherits its pooled-arena
    /// rule: a decoded `m_cost` above this hasher's high-water mark runs on a
    /// private arena that is freed on the way out, so the string cannot grow
    /// the pool. To check a raw expected tag instead, [`Hasher::verify`].
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded`].
    #[inline]
    pub fn verify_password(
        &mut self,
        encoded: &str,
        pwd: &[u8],
        algorithm: Algorithm,
    ) -> Result<(), Error> {
        self.verify_encoded(encoded, pwd, algorithm)
    }

    /// [`Argon2::verify_encoded_bounded`], reusing the arena.
    ///
    /// The ceiling is checked before anything is allocated, so it bounds the
    /// *allocation* — which is the half [`Hasher::verify_encoded`] does not
    /// address. Note that the pooled-arena rule still applies underneath: a
    /// decoded `m_cost` within `ceiling` but above this hasher's own high-water
    /// mark runs on a private arena, so passing a generous `ceiling` cannot
    /// enlarge the pool either.
    ///
    /// `ceiling.threads()` bounds the worker threads exactly as it does on
    /// [`Argon2::verify_encoded_bounded`] — worth knowing here in particular,
    /// since a `Hasher` is what a server holds while verifying strings it did
    /// not write, and the arena it reuses is not the only resource a wide `p`
    /// can spend.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded_bounded`].
    pub fn verify_encoded_bounded(
        &mut self,
        encoded: &str,
        pwd: &[u8],
        algorithm: Algorithm,
        ceiling: &Params,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        let decoded = decode_bounded(encoded, algorithm, ceiling)?;

        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);
        if decoded.params.memory_blocks() as usize > self.pooled_ceiling() {
            // As `verify_encoded`: keep an m_cost this hasher's owner never
            // asked for off the retained arena.
            return argon2.verify(pwd, &decoded.salt, &decoded.hash);
        }
        self.verify_using(&argon2, pwd, &decoded.salt, &decoded.hash)
    }

    /// [`Argon2::verify_encoded_bounded_with_ad`], reusing the arena.
    ///
    /// # Errors
    ///
    /// As [`Argon2::verify_encoded_bounded_with_ad`].
    pub fn verify_encoded_bounded_with_ad(
        &mut self,
        encoded: &str,
        pwd: &[u8],
        secret: &[u8],
        ad: &[u8],
        algorithm: Algorithm,
        ceiling: &Params,
    ) -> Result<(), Error> {
        // argon2.c:260-262 `if (pwdlen > ARGON2_MAX_PWD_LENGTH)`.
        if pwd.len() > MAX_PWD_LENGTH as usize {
            return Err(Error::PwdTooLong);
        }

        let decoded = decode_bounded(encoded, algorithm, ceiling)?;

        let argon2 = Argon2::new(decoded.algorithm, decoded.version, decoded.params);
        if decoded.params.memory_blocks() as usize > self.pooled_ceiling() {
            // As `verify_encoded_with_ad`: an m_cost this hasher's owner never
            // asked for runs on a one-shot arena.
            let mut computed = try_zeroed_vec(argon2.params.tag_len_bytes())?;
            let result = argon2.hash_into_with_ad(pwd, &decoded.salt, secret, ad, &mut computed);
            let matched = result.is_ok() && constant_time_eq(&computed, &decoded.hash);
            clear_internal_memory(&mut computed);
            result?;
            return if matched {
                Ok(())
            } else {
                Err(Error::VerifyMismatch)
            };
        }
        self.verify_using_ad(&argon2, pwd, &decoded.salt, secret, ad, &decoded.hash)
    }

    // -----------------------------------------------------------------
    // The two private workers every public method above funnels through
    // -----------------------------------------------------------------

    /// The largest arena an *untrusted* `m_cost` may borrow from the pool.
    ///
    /// Two sources, both chosen by whoever owns this hasher, never by an input:
    /// the configuration it was built or [`set_argon2`](Hasher::set_argon2)'d
    /// with, and whatever the workspace already holds (which
    /// [`reserve`](Hasher::reserve) or an earlier, larger configuration may have
    /// made bigger than the current one).
    ///
    /// The guarantee is a ceiling, not a freeze: a decoded `m_cost` under this
    /// bound may still be the thing that allocates the arena, on a hasher whose
    /// owner has not hashed yet. What it cannot do is push the retained arena
    /// past a size the owner has already asked for — so the worst an input can
    /// cost is memory the very next `hash_into` was going to take anyway, and
    /// there is no ratchet.
    ///
    /// The one caller is [`verify_encoded`](Hasher::verify_encoded), because it
    /// is the only method whose `m_cost` does not come from `self`.
    #[inline]
    fn pooled_ceiling(&self) -> usize {
        core::cmp::max(
            self.workspace.capacity(),
            self.argon2.params.memory_blocks() as usize,
        )
    }

    /// `argon2_ctx()` with `argon2`'s configuration and this hasher's memory.
    ///
    /// `argon2` is passed explicitly rather than read from `self` so that
    /// [`verify_encoded`](Hasher::verify_encoded) can use the parameters it
    /// decoded from the string. It is [`Copy`], so callers hand in a copy and
    /// the borrow checker never has to reconcile it with `&mut self.workspace`.
    fn hash_into_using(
        &mut self,
        argon2: &Argon2,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        out: &mut [u8],
    ) -> Result<(), Error> {
        // SAFETY: the same argument that makes `Argon2::hash_into_with_ad`
        // safe — the only `Backend` this crate's safe API ever names is
        // `fill_block::backend()`, the cached result of the
        // `is_*_feature_detected!` cascade, so this CPU can execute it by
        // construction.
        unsafe {
            hash_in_workspace(
                &mut self.workspace,
                crate::fill_block::backend(),
                argon2.algorithm,
                argon2.version,
                &argon2.params,
                pwd,
                salt,
                secret,
                ad,
                out,
                None,
                None,
            )
        }
    }

    /// [`Argon2::verify`]'s body, over this hasher's memory.
    fn verify_using(
        &mut self,
        argon2: &Argon2,
        pwd: &[u8],
        salt: &[u8],
        expected: &[u8],
    ) -> Result<(), Error> {
        self.verify_using_ad(argon2, pwd, salt, &[], &[], expected)
    }

    fn verify_using_ad(
        &mut self,
        argon2: &Argon2,
        pwd: &[u8],
        salt: &[u8],
        secret: &[u8],
        ad: &[u8],
        expected: &[u8],
    ) -> Result<(), Error> {
        let mut computed = try_zeroed_vec(argon2.params.tag_len_bytes())?;
        let result = self.hash_into_using(argon2, pwd, salt, secret, ad, &mut computed);
        // argon2.c:349 `argon2_compare(hash, context->out, context->outlen)`.
        let matched = result.is_ok() && constant_time_eq(&computed, expected);
        clear_internal_memory(&mut computed);

        result?;
        if matched {
            Ok(())
        } else {
            Err(Error::VerifyMismatch)
        }
    }
}

impl core::fmt::Debug for Hasher {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Hasher")
            .field("argon2", &self.argon2)
            .field("reserved_blocks", &self.reserved_blocks())
            .finish()
    }
}

/// A zeroed `Vec<u8>` of `len` bytes, without the abort-on-OOM of
/// `Vec::with_capacity`.
fn try_zeroed_vec(len: usize) -> Result<Vec<u8>, Error> {
    let mut v = Vec::new();
    v.try_reserve(len)
        .map_err(|_| Error::MemoryAllocationError)?;
    // Cannot reallocate: the capacity was just reserved.
    v.resize(len, 0);
    Ok(v)
}

/// `argon2_ctx()`: validate, size the arena, initialise, fill, finalise.
///
/// The one place the whole computation lives; every public entry point funnels
/// through here. `backend` is resolved by the caller so the forced-backend test
/// hook and the normal path share this body.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute `backend`.
// One parameter per `argon2_context` field this port needs; collapsing them into
// a struct would just move the same list somewhere else.
#[allow(clippy::too_many_arguments)]
unsafe fn hash_inner(
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
) -> Result<(), Error> {
    // SAFETY: forwarded verbatim from this function's own contract.
    unsafe {
        hash_owned(
            backend, algorithm, version, params, pwd, salt, secret, ad, out, None, None,
        )
    }
}

/// One-shot hashing over a freshly allocated arena.
///
/// `h0_out` is `None` on every stable API path. That distinction is
/// security-relevant: normal hashing must not materialise a second copy of H0
/// merely to throw it away after the computation. The unstable KAT hook passes
/// a destination because H0 is one of its requested outputs.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute `backend`.
#[allow(clippy::too_many_arguments)]
unsafe fn hash_owned(
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
    trace: Option<PassTrace<'_>>,
    h0_out: Option<&mut [u8; PREHASH_DIGEST_LENGTH]>,
) -> Result<(), Error> {
    let memory_blocks = validate_and_size(params, pwd, salt, secret, ad, out)?;

    // core.c:621 "1. Memory allocation". A fresh allocation every call, freed
    // on the way out. `Hasher` runs the same computation over an arena borrowed
    // from a `Workspace`.
    let mut arena = Arena::new(memory_blocks)?;

    // SAFETY: `backend` is forwarded verbatim from this function's own
    // contract. `arena` was just sized from the same `params`, and it lives
    // until the end of this function, i.e. past every use inside.
    unsafe {
        hash_in_arena(
            &mut arena, backend, algorithm, version, params, pwd, salt, secret, ad, out, trace,
            h0_out,
        )
    }
    // `arena` drops here: `Arena::drop` wipes it (`zeroize-memory`) and frees
    // it, which is core.c:184's `free_memory(...)`. It drops on `Ok`, `Err` and
    // unwind alike. The two `?`s above fire before the arena exists.
}

/// `argon2_ctx()` with the two hooks `src/genkat.c` needs.
///
/// Returns the 64-byte pre-hashing digest `H0` that `initial_kat()` prints, and
/// invokes `trace(pass, whole_arena)` after each pass, which is what
/// `internal_kat()` prints. `tests/kat.rs` reaches this through `__internal`.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute `backend`,
/// which `backend.is_available()` or [`crate::fill_block::backend`] establishes.
/// Nothing else here is unsafe — validation, allocation and finalisation are all
/// ordinary safe code — but a `Backend` this CPU lacks makes the fill loop jump
/// into a `#[target_feature]` function it cannot run.
///
/// # Errors
///
/// As [`Argon2::hash_into`].
#[allow(clippy::too_many_arguments)]
pub unsafe fn hash_traced(
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
    trace: Option<PassTrace<'_>>,
) -> Result<[u8; PREHASH_DIGEST_LENGTH], Error> {
    let mut h0 = [0u8; PREHASH_DIGEST_LENGTH];
    // SAFETY: forwarded verbatim from this function's own contract.
    let result = unsafe {
        hash_owned(
            backend,
            algorithm,
            version,
            params,
            pwd,
            salt,
            secret,
            ad,
            out,
            trace,
            Some(&mut h0),
        )
    };
    if let Err(error) = result {
        // H0 was requested as output, but an error means it will not leave this
        // function. Do not turn that failed internal trace into stack residue.
        clear_internal_memory(&mut h0);
        return Err(error);
    }
    Ok(h0)
}

/// Steps 1 and 2 of `argon2_ctx()`: validate every input, then align the memory
/// size. Returns the block count the arena must have.
///
/// Split out so that both arena sources — [`hash_traced`]'s one-shot
/// [`Arena::new`] and [`Hasher`]'s pooled [`Workspace`] — reject bad input
/// *before* anything is allocated, and reject it identically.
///
/// # Errors
///
/// Whatever [`Params::validate_for`] returns, or [`Error::OutPtrMismatch`].
fn validate_and_size(
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &[u8],
) -> Result<usize, Error> {
    // argon2.c:41 "1. Validate all inputs".
    params.validate_for(pwd.len(), salt.len(), secret.len(), ad.len())?;

    // argon2.c:49-51 `ARGON2_INCORRECT_TYPE` cannot fire: `Algorithm` is a
    // closed enum, so there is no "no such version of Argon2".
    //
    // Rust-only check. The C's `context->out` and `context->outlen` are one
    // object; here the buffer and the configured length are separate, so they
    // can disagree. `ARGON2_OUT_PTR_MISMATCH` is defined in `argon2.h` but
    // never returned by the C, which makes it exactly the right code for this.
    if out.len() != params.tag_len_bytes() {
        return Err(Error::OutPtrMismatch);
    }

    // argon2.c:55-70 "2. Align memory size". See `Params::memory_layout`.
    Ok(params.memory_layout().0 as usize)
}

/// Steps 3 to 5 of `argon2_ctx()` over an arena the caller already sized.
///
/// The whole computation lives here — pre-hash, first blocks, fill, finalise —
/// so the one-shot and pooled paths cannot drift apart. Everything they do not
/// share is on either side of this call: where the arena came from, and what
/// happens to it afterwards.
///
/// Deliberately does **not** zero the arena. Argon2 does not need it (pass 0
/// writes every block before anything reads one) and [`Arena`] already
/// guarantees the only property that matters for soundness, which is that every
/// block is *initialised*. See the module docs on [`crate::memory`].
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute `backend`.
///
/// # Errors
///
/// [`Error::MemoryAllocationError`] if `arena.len()` disagrees with
/// `params.memory_layout()`, plus whatever [`initial_hash`],
/// [`fill_first_blocks`], [`fill_memory_blocks_traced`] and [`finalize`] return.
#[allow(clippy::too_many_arguments)]
unsafe fn hash_in_arena(
    arena: &mut Arena,
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
    trace: Option<PassTrace<'_>>,
    h0_out: Option<&mut [u8; PREHASH_DIGEST_LENGTH]>,
) -> Result<(), Error> {
    let (memory_blocks, _segment_length, lane_length) = params.memory_layout();

    // `Instance::new`'s safety contract is `memory_len == memory_blocks`, and
    // below it is handed `arena.len()`. Both callers size the arena from this
    // same `params`, so this can only fire if someone wires up a third one
    // wrongly — at which point it must be an error, not undefined behaviour.
    // A pooled arena whose *capacity* is larger is fine and expected; it is the
    // visible `len()` that has to match.
    if arena.len() != memory_blocks as usize {
        return Err(Error::MemoryAllocationError);
    }

    // The release wipe may use as many threads as the caller sanctioned. It
    // cannot affect the tag, so `threads()` — the OS-thread budget — is the
    // right number here rather than `effective_threads()`, which is
    // `min(threads, lanes)` and describes the *algorithmic* parallelism.
    arena.set_workers(params.threads());

    // core.c:631 "2. Initial hashing". The 8 bytes after `H0` are already zero,
    // which is what core.c:633 achieves with `clear_internal_memory`.
    let mut blockhash = [0u8; PREHASH_SEED_LENGTH];
    if let Err(error) = initial_hash_into(
        algorithm,
        version,
        params,
        pwd,
        salt,
        secret,
        ad,
        &mut blockhash,
    ) {
        clear_internal_memory(&mut blockhash);
        return Err(error);
    }
    if let Some(h0) = h0_out {
        #[cfg(all(test, feature = "std"))]
        H0_COPY_COUNT.with(|count| count.set(count.get() + 1));
        h0.copy_from_slice(&blockhash[..PREHASH_DIGEST_LENGTH]);
    }

    // core.c:643 "3. Creating first blocks".
    let fill_first = fill_first_blocks(
        &mut blockhash,
        arena.as_mut_slice(),
        params.lanes(),
        lane_length,
    );
    // core.c:645 `clear_internal_memory(blockhash, ARGON2_PREHASH_SEED_LENGTH);`
    clear_internal_memory(&mut blockhash);
    fill_first?;

    // SAFETY: `arena` is borrowed for the whole of this function and `instance`
    // does not escape it, so the arena outlives every use of the pointer. It
    // owns `arena.len()` initialised, `ARENA_ALIGN`-aligned `Block`s — that is
    // `Arena`'s invariant 1, and it holds for a pooled arena exactly as it does
    // for a fresh one, since neither reuse nor the release wipe can
    // de-initialise memory. `arena.len() == memory_blocks` was just checked,
    // which is `Instance::new`'s remaining requirement.
    let instance =
        unsafe { Instance::new(arena.as_mut_ptr(), arena.len(), algorithm, version, params) };

    // argon2.c:89 "4. Filling memory".
    // SAFETY: the CPU's ability to execute `backend` is forwarded verbatim from
    // this function's own contract. `instance` was just built from an `Arena`
    // that outlives it, and the arena is uniquely borrowed (`&mut Arena`), so no
    // other thread holds a handle on it.
    unsafe { fill_memory_blocks_traced(&instance, backend, trace) }?;

    // argon2.c:95 "5. Finalization". Wiping and releasing the arena is the
    // caller's job, and it happens on this function's error paths too because
    // both callers do it in a `Drop`.
    finalize(&instance, out)?;

    Ok(())
}

/// [`hash_traced`] over an arena borrowed from `workspace` instead of a fresh
/// one. The engine behind every [`Hasher`] method.
///
/// # Safety
///
/// As [`fill_memory_blocks_traced`]: this CPU must be able to execute `backend`.
///
/// # Errors
///
/// As [`hash_traced`].
#[allow(clippy::too_many_arguments)]
unsafe fn hash_in_workspace(
    workspace: &mut Workspace,
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
    trace: Option<PassTrace<'_>>,
    h0_out: Option<&mut [u8; PREHASH_DIGEST_LENGTH]>,
) -> Result<(), Error> {
    let memory_blocks = validate_and_size(params, pwd, salt, secret, ad, out)?;

    // The whole point: no allocator call and no zeroing memset when the parked
    // arena is already big enough. `acquire` only reallocates when it has to
    // grow, and the previous release left the blocks zeroed.
    let mut arena = workspace.acquire(memory_blocks)?;

    // SAFETY: `backend` is forwarded verbatim from this function's own
    // contract, and `arena` was just sized from the same `params`.
    unsafe {
        hash_in_arena(
            &mut arena, backend, algorithm, version, params, pwd, salt, secret, ad, out, trace,
            h0_out,
        )
    }
    // The `ArenaGuard` drops here and hands the arena back to `workspace` after
    // a `clear_internal_memory_blocks` over exactly the blocks this hash could
    // reach. It drops whether the call above returned `Ok` or `Err`, and on
    // unwind — that is the reason to take a guard rather than an owned `Arena`.
    // Same wipe as `Arena::drop`, same `zeroize-memory` gate, just before the
    // free instead of together with it. The next acquisition therefore starts
    // from a zeroed arena without a second memset, and that saved memset is the
    // entire measured win. The two `?`s above fire before the guard exists.
}

/// Run a hash with a specific [`Backend`], bypassing runtime detection.
///
/// Test and bench hook: lets the suite exercise every backend the host can
/// execute, not just the fastest one.
///
/// # Safety
///
/// This bypasses detection, so **the caller** must establish what detection
/// otherwise would: that this CPU can execute `backend`. `backend.is_available()`
/// is the portable way to do it. See [`fill_memory_blocks_traced`] for the full
/// contract.
///
/// Guarded, and therefore fine:
///
/// ```
/// # use argon2_rust::{Algorithm, Backend, Params, Version, params::Memory};
/// # use argon2_rust::__internal::hash_with_backend;
/// # let params = Params::builder().memory(Memory::kib(8)).passes(1).build().unwrap();
/// # let mut out = [0u8; 32];
/// for &backend in Backend::ALL {
///     if !backend.is_available() {
///         continue; // this CPU would SIGILL
///     }
///     // SAFETY: `is_available()` just said this CPU can execute `backend`.
///     unsafe {
///         hash_with_backend(
///             backend, Algorithm::Argon2id, Version::V0x13, &params,
///             b"password", b"somesaltsomesalt", &[], &[], &mut out,
///         ).unwrap();
///     }
/// }
/// ```
///
/// The **same snippet with the `unsafe` block deleted** must not compile, which
/// is the whole point: safe code cannot reach a `#[target_feature]` function
/// whose feature was never detected. Keep these two in sync — the pair is the
/// regression test, and the runnable one above is what proves the failing one
/// below fails for the right reason rather than through some unrelated typo:
///
/// ```compile_fail
/// # use argon2_rust::{Algorithm, Backend, Params, Version, params::Memory};
/// # use argon2_rust::__internal::hash_with_backend;
/// # let params = Params::builder().memory(Memory::kib(8)).passes(1).build().unwrap();
/// # let mut out = [0u8; 32];
/// for &backend in Backend::ALL {
///     if !backend.is_available() {
///         continue; // this CPU would SIGILL
///     }
///     hash_with_backend(
///         backend, Algorithm::Argon2id, Version::V0x13, &params,
///         b"password", b"somesaltsomesalt", &[], &[], &mut out,
///     ).unwrap();
/// }
/// ```
///
/// # Errors
///
/// As [`Argon2::hash_into`].
///
/// # Panics
///
/// Never.
#[cfg(feature = "internal-api")]
#[allow(clippy::too_many_arguments)]
pub unsafe fn hash_with_backend(
    backend: Backend,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    pwd: &[u8],
    salt: &[u8],
    secret: &[u8],
    ad: &[u8],
    out: &mut [u8],
) -> Result<(), Error> {
    // SAFETY: forwarded verbatim from this function's own contract.
    unsafe {
        hash_inner(
            backend, algorithm, version, params, pwd, salt, secret, ad, out,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // decode_bounded — the worker-thread clamp
    // ------------------------------------------------------------------

    /// The ceiling's `threads` is an OS-thread budget that none of the four
    /// magnitude checks implies.
    ///
    /// Decoding sets `threads = lanes`, and `fill_pooled` spawns
    /// `min(threads, lanes) - 1` helpers, so a string whose `p` is *within* the
    /// `lanes` ceiling used to hand an attacker that many OS threads on an
    /// authentication path. Measured before the clamp: a `p=256` string against
    /// a ceiling of `threads = 1` really did spawn 255 helpers.
    ///
    /// Asserted here rather than by sampling the live thread count, because the
    /// hash is over in milliseconds and a sampler misses the peak — which is
    /// exactly how this was nearly written off as unreproducible.
    #[test]
    fn decode_bounded_clamps_workers_to_the_ceilings_thread_budget() {
        const LANES: u32 = 256;
        let params = Params::builder()
            .memory(Memory::kib(u64::from(8 * LANES)))
            .passes(1)
            .lanes(LANES)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let encoded = argon2.hash_encoded(b"pw", b"somesalt").expect("encode");

        // "Strings this wide are allowed; spawning this wide is not."
        let ceiling = Params::builder()
            .memory(Memory::kib(u64::from(8 * LANES)))
            .passes(1)
            .lanes(LANES)
            .threads(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("ceiling");
        let decoded =
            decode_bounded(&encoded, Algorithm::Argon2id, &ceiling).expect("within the ceiling");

        assert_eq!(decoded.params.lanes(), LANES, "lanes must survive: it picks the tag");
        assert_eq!(decoded.params.threads(), 1, "workers must obey the ceiling");
        assert_eq!(decoded.params.effective_threads(), 1);
    }

    /// The clamp only ever lowers. A ceiling that permits more workers than the
    /// string needs must leave the decoded value alone, so the ordinary ceiling
    /// with `.threads()` left unset (where `threads == lanes`) keeps full
    /// parallelism.
    #[test]
    fn decode_bounded_leaves_workers_alone_when_the_ceiling_is_generous() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 10))
            .passes(1)
            .lanes(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let encoded = argon2.hash_encoded(b"pw", b"somesalt").expect("encode");

        // `.threads()` unset means threads = lanes = 8, more than the string's 4.
        let ceiling = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(8)
            .lanes(8)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("ceiling");
        let decoded =
            decode_bounded(&encoded, Algorithm::Argon2id, &ceiling).expect("within the ceiling");

        assert_eq!(decoded.params.lanes(), 4);
        assert_eq!(decoded.params.threads(), 4, "clamped to lanes, not raised to 8");
    }

    // ------------------------------------------------------------------
    // index_alpha
    // ------------------------------------------------------------------

    fn instance_for(params: &Params, algorithm: Algorithm, arena: &mut [Block]) -> Instance {
        // SAFETY: `arena` outlives the returned `Instance` at every call site
        // below, and none of these tests index into it.
        unsafe {
            Instance::new(
                arena.as_mut_ptr(),
                arena.len(),
                algorithm,
                Version::V0x13,
                params,
            )
        }
    }

    #[test]
    fn index_alpha_pass0_slice0_is_all_but_the_previous() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 12))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let inst = instance_for(&params, Algorithm::Argon2i, &mut arena);

        // reference_area_size = index - 1, start_position = 0, so the result is
        // always < index: index_alpha never returns the block being written.
        for index in 2..64u32 {
            for pseudo in [0u32, 1, 0x7FFF_FFFF, 0x8000_0000, u32::MAX] {
                let pos = Position::new(0, 0, 0, index);
                let alpha = index_alpha(&inst, &pos, pseudo, true);
                assert!(alpha < index, "index={index} pseudo={pseudo} -> {alpha}");
            }
        }
    }

    #[test]
    fn index_alpha_never_selects_the_current_or_a_concurrent_block() {
        // This is the property the parallel safety argument rests on.
        let params = Params::builder()
            .memory(Memory::kib(1024))
            .passes(3)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let inst = instance_for(&params, Algorithm::Argon2d, &mut arena);
        let seg = inst.segment_length;

        for pass in 0..3u32 {
            for slice in 0..SYNC_POINTS {
                for index in 0..seg {
                    if pass == 0 && slice == 0 && index < 2 {
                        continue;
                    }
                    let pos = Position::new(pass, 1, slice, index);
                    for pseudo in [0u32, 1, 12345, 0x8000_0000, u32::MAX] {
                        // Cross-lane: must land outside the current slice.
                        // `fill_segment` pins `ref_lane = position.lane` on
                        // pass 0 / slice 0, so `same_lane == false` is not
                        // reachable there and the C's answer (block 0, the only
                        // candidate) is a same-lane reference anyway.
                        if !(pass == 0 && slice == 0) {
                            let alpha = index_alpha(&inst, &pos, pseudo, false);
                            let alpha_slice = alpha / seg;
                            assert_ne!(
                                alpha_slice, slice,
                                "cross-lane reference into the live slice: \
                                 pass={pass} slice={slice} index={index} pseudo={pseudo}"
                            );
                        }

                        // Same lane: may be in this slice, but strictly before
                        // the block being written.
                        let alpha = index_alpha(&inst, &pos, pseudo, true);
                        if alpha / seg == slice {
                            assert!(
                                alpha % seg < index,
                                "same-lane reference at or past the current block: \
                                 pass={pass} slice={slice} index={index} -> {alpha}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn index_alpha_wraps_at_index_zero_across_lanes() {
        // The `((index == 0) ? (-1) : 0)` branch. With slice = 1 and
        // segment_length = 2 the C computes reference_area_size = 2 - 1 = 1,
        // so the only legal answer is block 0.
        let params = Params::builder()
            .memory(Memory::kib(8))
            .passes(1)
            .lanes(1)
            .threads(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let inst = instance_for(&params, Algorithm::Argon2i, &mut arena);
        assert_eq!(inst.segment_length, 2);

        let pos = Position::new(0, 0, 1, 0);
        for pseudo in [0u32, 1, 0x1234_5678, u32::MAX] {
            assert_eq!(index_alpha(&inst, &pos, pseudo, false), 0);
        }
    }

    #[test]
    fn index_alpha_start_position_skips_the_current_slice() {
        // pass > 0: start_position = (slice + 1) * segment_length, except for
        // the last slice where it is 0.
        let params = Params::builder()
            .memory(Memory::kib(1024))
            .passes(2)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let inst = instance_for(&params, Algorithm::Argon2d, &mut arena);
        let seg = inst.segment_length;

        // pseudo_rand = 0 makes relative_position = ras - 1, the far end of the
        // window, so the answer is (start_position + ras - 1) % lane_length.
        for slice in 0..SYNC_POINTS {
            let pos = Position::new(1, 0, slice, 5);
            let ras = inst.lane_length - seg + 5 - 1;
            let start = if slice == SYNC_POINTS - 1 {
                0
            } else {
                (slice + 1) * seg
            };
            assert_eq!(
                index_alpha(&inst, &pos, 0, true),
                (start + ras - 1) % inst.lane_length
            );
        }
    }

    /// `reference_area_size - 1` is evaluated in **`uint32_t`**, not `uint64_t`.
    ///
    /// This is the one place the task brief's summary and `core.c` disagree, and
    /// it is invisible to every other test in this repository — mutating
    /// `u64::from(ras.wrapping_sub(1))` into `u64::from(ras).wrapping_sub(1)`
    /// leaves the whole suite green, including all 26 official vectors, the
    /// KATs and a 95 040-case differential against the C. So it is pinned here
    /// directly, against values dumped from the real `index_alpha`.
    ///
    /// The two readings differ only when `reference_area_size == 0`, where the
    /// C gives `relative_position = 0x0000_0000_FFFF_FFFF` and the 64-bit-first
    /// reading gives `0xFFFF_FFFF_FFFF_FFFF`. Both then go through
    /// `% lane_length`, which hides the difference whenever `lane_length`
    /// divides `2^64 - 2^32 = 2^32 * (2^32 - 1)`. Since
    /// `2^32 - 1 = 3 * 5 * 17 * 257 * 65537`, that is true for every power of
    /// two and for `lane_length` 12 and 20 — which is why a grid of "nice"
    /// segment lengths cannot see it. `segment_length` 7, 11, 13, 100 and 341
    /// can.
    ///
    /// `reference_area_size == 0` needs `pass = 0`, `slice = 0`, `index = 1`,
    /// which `fill_segment` never produces (it starts at `index = 2` there), so
    /// this is unreachable through the public API — but it is still what the C
    /// computes, and the next person to "simplify" this line needs a test that
    /// stops them.
    #[test]
    fn index_alpha_reference_area_size_zero_uses_32_bit_arithmetic() {
        // Dumped from the C, `index_alpha(&inst, &{0,0,0,1}, r, 1)`:
        //   seg=2   lane_length=8    -> 7      (does NOT discriminate)
        //   seg=3   lane_length=12   -> 3      (does NOT discriminate)
        //   seg=5   lane_length=20   -> 15     (does NOT discriminate)
        //   seg=7   lane_length=28   -> 3      (64-bit-first would give 15)
        //   seg=11  lane_length=44   -> 3      (64-bit-first would give 15)
        //   seg=13  lane_length=52   -> 47     (64-bit-first would give 15)
        //   seg=100 lane_length=400  -> 95     (64-bit-first would give 15)
        //   seg=341 lane_length=1364 -> 3      (64-bit-first would give 15)
        const CASES: [(u32, u32); 8] = [
            (2, 7),
            (3, 3),
            (5, 15),
            (7, 3),
            (11, 3),
            (13, 47),
            (100, 95),
            (341, 3),
        ];

        let params = Params::builder()
            .memory(Memory::kib(1 << 12))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let mut inst = instance_for(&params, Algorithm::Argon2i, &mut arena);

        for (segment_length, expected) in CASES {
            inst.segment_length = segment_length;
            inst.lane_length = segment_length * SYNC_POINTS;
            // pass 0, slice 0, index 1  =>  reference_area_size = 1 - 1 = 0.
            let pos = Position::new(0, 0, 0, 1);
            for pseudo in [0u32, 1, 0x7FFF_FFFF, 0x8000_0000, u32::MAX, 0xDEAD_BEEF] {
                // `reference_area_size == 0` makes `(ras * rel) >> 32` zero for
                // every `pseudo_rand`, so the answer does not depend on it.
                assert_eq!(
                    index_alpha(&inst, &pos, pseudo, true),
                    expected,
                    "segment_length={segment_length} pseudo={pseudo:#010x}"
                );
                assert_eq!(index_alpha(&inst, &pos, pseudo, false), expected);
            }
        }
    }

    #[test]
    fn index_alpha_degenerate_instance_does_not_panic() {
        // lane_length == 0 would divide by zero in the C.
        let params = Params::builder()
            .memory(Memory::kib(8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = [Block::ZERO; 2];
        let mut inst = instance_for(&params, Algorithm::Argon2i, &mut arena);
        inst.lane_length = 0;
        inst.segment_length = 0;
        assert_eq!(index_alpha(&inst, &Position::new(0, 0, 0, 0), 7, true), 0);
    }

    // ------------------------------------------------------------------
    // constant_time_eq
    // ------------------------------------------------------------------

    #[test]
    fn constant_time_eq_matches_argon2_compare() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
        // A single differing bit in the last byte.
        assert!(!constant_time_eq(&[0u8; 32], &{
            let mut b = [0u8; 32];
            b[31] = 1;
            b
        }));
        // 0x80 in the high bit: the C's `d - 1` must not sign-extend wrongly.
        assert!(!constant_time_eq(&[0u8; 4], &[0, 0, 0, 0x80]));
    }

    /// Structural guard for the two stable call sites: neither may request the
    /// optional H0 output copy from `hash_in_arena`. This observes that API
    /// choice, not stack contents; the traced call below proves the counter is
    /// live and reserves the copy for the unstable KAT API that returns H0.
    #[cfg(feature = "std")]
    #[test]
    fn stable_hashes_do_not_request_an_h0_output_copy() {
        H0_COPY_COUNT.with(|count| count.set(0));

        let params = Params::builder()
            .memory(Memory::kib(32))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut tag = [0u8; 32];
        argon2
            .hash_into(b"password", b"somesalt", &mut tag)
            .expect("one-shot hash");
        let mut hasher = argon2.hasher();
        hasher
            .hash_into(b"password", b"somesalt", &mut tag)
            .expect("pooled hash");
        H0_COPY_COUNT.with(|count| assert_eq!(count.get(), 0, "stable paths copied H0"));

        // The hook itself must be live or the zero above would prove nothing.
        // SAFETY: the scalar backend is available on every CPU.
        let mut h0 = unsafe {
            hash_traced(
                Backend::Scalar,
                argon2.algorithm,
                argon2.version,
                &argon2.params,
                b"password",
                b"somesalt",
                &[],
                &[],
                &mut tag,
                None,
            )
        }
        .expect("traced hash");
        H0_COPY_COUNT.with(|count| assert_eq!(count.get(), 1, "trace did not copy H0"));
        clear_internal_memory(&mut h0);
    }

    #[test]
    fn fill_first_blocks_rejects_a_short_internal_arena() {
        let mut blockhash = [0xA5; PREHASH_SEED_LENGTH];
        let mut arena = [];
        assert_eq!(
            fill_first_blocks(&mut blockhash, &mut arena, 1, 8),
            Err(Error::IncorrectParameter)
        );
    }

    // ------------------------------------------------------------------
    // initial_hash
    // ------------------------------------------------------------------

    #[test]
    fn initial_hash_matches_the_genkat_pre_hashing_digest() {
        // `phc-winner-argon2/kats/argon2id`, first "Pre-hashing digest" line:
        //   t_cost 3, m_cost 32, lanes 4, outlen 32,
        //   pwd 32 x 0x01, salt 16 x 0x02, secret 8 x 0x03, ad 12 x 0x04.
        let params = Params::builder()
            .memory(Memory::kib(32))
            .passes(3)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let h = initial_hash(
            Algorithm::Argon2id,
            Version::V0x13,
            &params,
            &[1u8; 32],
            &[2u8; 16],
            &[3u8; 8],
            &[4u8; 12],
        )
        .expect("initial_hash");

        let expected = "2889de487eb42ae500c0007ed9252f1069eadec40d5765b485de6dc2437a67b8\
                        546a2f0acc1a0882db8fcf74714b472e94df421a5da1112ffa11434370a1e997";
        let mut hex = String::new();
        for byte in &h[..PREHASH_DIGEST_LENGTH] {
            hex.push_str(&alloc::format!("{byte:02x}"));
        }
        assert_eq!(hex, expected);
        // The 8 trailing bytes must be zero before `fill_first_blocks` fills them.
        assert_eq!(&h[PREHASH_DIGEST_LENGTH..], &[0u8; 8]);
    }

    #[test]
    fn initial_hash_field_order_is_load_bearing() {
        // Swapping any two parameters must change H0. Compare `lanes` against
        // `outlen`: both are 4, so a transposition would be invisible unless the
        // values differ.
        let a = Params::builder()
            .memory(Memory::kib(64))
            .passes(1)
            .lanes(2)
            .threads(2)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let b = Params::builder()
            .memory(Memory::kib(64))
            .passes(1)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let ha = initial_hash(
            Algorithm::Argon2i,
            Version::V0x13,
            &a,
            b"p",
            b"salt",
            &[],
            &[],
        )
        .expect("h");
        let hb = initial_hash(
            Algorithm::Argon2i,
            Version::V0x13,
            &b,
            b"p",
            b"salt",
            &[],
            &[],
        )
        .expect("h");
        assert_ne!(ha, hb);

        // Version and type are hashed separately.
        let h10 = initial_hash(
            Algorithm::Argon2i,
            Version::V0x10,
            &a,
            b"p",
            b"salt",
            &[],
            &[],
        )
        .expect("h");
        assert_ne!(ha, h10);
        let hid = initial_hash(
            Algorithm::Argon2id,
            Version::V0x13,
            &a,
            b"p",
            b"salt",
            &[],
            &[],
        )
        .expect("h");
        assert_ne!(ha, hid);

        // The length prefixes make "ab" || "" different from "a" || "b".
        let h1 = initial_hash(
            Algorithm::Argon2i,
            Version::V0x13,
            &a,
            b"ab",
            b"saltsalt",
            &[],
            &[],
        )
        .expect("h");
        let h2 = initial_hash(
            Algorithm::Argon2i,
            Version::V0x13,
            &a,
            b"a",
            b"bsaltsalt",
            &[],
            &[],
        )
        .expect("h");
        assert_ne!(h1, h2);
    }

    // ------------------------------------------------------------------
    // The whole pipeline
    // ------------------------------------------------------------------

    fn hex(bytes: &[u8]) -> String {
        let mut s = String::new();
        for byte in bytes {
            s.push_str(&alloc::format!("{byte:02x}"));
        }
        s
    }

    #[test]
    fn one_official_vector_end_to_end() {
        // test.c: Argon2i v=19 t=2 m=1<<16 p=1 "password" / "somesalt".
        let params = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2i, Version::V0x13, params);
        let tag = argon2.hash(b"password", b"somesalt").expect("hash");
        assert_eq!(
            hex(&tag),
            "c1628832147d9720c5bd1cfd61367078729f6dfb6f8fea9ff98158e0d7816ed0"
        );
    }

    #[test]
    fn genkat_tag_matches_for_all_three_types() {
        // The final "Tag:" line of each `phc-winner-argon2/kats/*` file:
        // t_cost 3, m_cost 32, lanes 4, outlen 32, pwd 32 x 0x01,
        // salt 16 x 0x02, secret 8 x 0x03, ad 12 x 0x04.
        let params = Params::builder()
            .memory(Memory::kib(32))
            .passes(3)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        for (algorithm, version, expected) in [
            (
                Algorithm::Argon2d,
                Version::V0x13,
                "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb",
            ),
            (
                Algorithm::Argon2i,
                Version::V0x13,
                "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8",
            ),
            (
                Algorithm::Argon2id,
                Version::V0x13,
                "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
            ),
            (
                Algorithm::Argon2d,
                Version::V0x10,
                "96a9d4e5a1734092c85e29f410a45914a5dd1f5cbf08b2670da68a0285abf32b",
            ),
            (
                Algorithm::Argon2i,
                Version::V0x10,
                "87aeedd6517ab830cd9765cd8231abb2e647a5dee08f7c05e02fcb763335d0fd",
            ),
            (
                Algorithm::Argon2id,
                Version::V0x10,
                "b64615f07789b66b645b67ee9ed3b377ae350b6bfcbb0fc95141ea8f322613c0",
            ),
        ] {
            let argon2 = Argon2::new(algorithm, version, params);
            let mut tag = [0u8; 32];
            argon2
                .hash_into_with_ad(&[1u8; 32], &[2u8; 16], &[3u8; 8], &[4u8; 12], &mut tag)
                .expect("hash");
            assert_eq!(hex(&tag), expected, "{algorithm:?} {version:?}");
        }
    }

    /// The whole single-threaded pipeline on the smallest legal instance.
    ///
    /// `m_cost = MIN_MEMORY = 8` blocks, one lane, so the arena is 8 KiB and one
    /// pass is 4 slices of `segment_length = 2`. Small enough that
    /// `cargo +nightly miri test --lib tiny_` can run allocate → `initial_hash`
    /// → `fill_first_blocks` → `fill_segment` → `finalize` → wipe → free end to
    /// end. Ground truth from the C reference:
    ///
    /// ```text
    /// printf password | ./argon2 somesalt -{i,d,id} -t 1 -m 3 -p 1 -l 32 -r
    /// ```
    #[test]
    fn tiny_single_threaded_hash_matches_the_c_reference() {
        let params = Params::builder()
            .memory(Memory::kib(8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        assert_eq!(params.memory_layout(), (8, 2, 8));
        for (algorithm, expected) in [
            (
                Algorithm::Argon2i,
                "cbf2bce47e6d23999626143fabc5db69164743ee000ddd3f8895a6f82cfb9a6e",
            ),
            (
                Algorithm::Argon2d,
                "c519e603ac603ec1aeb5b71ec44a6179e3f3975b14c0c97e3914c79e6363e178",
            ),
            (
                Algorithm::Argon2id,
                "f137f8e186a403a679ccd0606e5ab5dcdafe43c1640855ac8c6e33e9bd63eeb3",
            ),
        ] {
            let mut tag = [0u8; 32];
            Argon2::new(algorithm, Version::V0x13, params)
                .hash_into(b"password", b"somesalt", &mut tag)
                .expect("hash");
            assert_eq!(hex(&tag), expected, "{algorithm:?}");
        }
    }

    /// The same, two lanes and two passes, so the multi-threaded path and the
    /// cross-lane `index_alpha` branches are exercised under Miri too.
    ///
    /// ```text
    /// printf password | ./argon2 somesalt -{i,d,id} -t 2 -m 4 -p 2 -l 32 -r
    /// ```
    #[test]
    fn tiny_two_lane_hash_matches_the_c_reference() {
        let params = Params::builder()
            .memory(Memory::kib(16))
            .passes(2)
            .lanes(2)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        assert_eq!(params.memory_layout(), (16, 2, 8));
        for (algorithm, expected) in [
            (
                Algorithm::Argon2i,
                "7fbb85db7e9636115f2fd0f29ea4214baaada18b39fffed7875eeb9fa9b308c5",
            ),
            (
                Algorithm::Argon2d,
                "59f20a66a4c31bf0438a2f494867c32120409a91380f0687aefee984ba86bda8",
            ),
            (
                Algorithm::Argon2id,
                "747d7631b182faf749d7efc31aec31df4ecfe3b57c792f53800ac2c9978b4888",
            ),
        ] {
            let mut tag = [0u8; 32];
            Argon2::new(algorithm, Version::V0x13, params)
                .hash_into(b"password", b"somesalt", &mut tag)
                .expect("hash");
            assert_eq!(hex(&tag), expected, "{algorithm:?} (threads = lanes = 2)");
        }
    }

    #[test]
    fn out_length_mismatch_is_out_ptr_mismatch() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut out = [0u8; 16];
        assert_eq!(
            argon2.hash_into(b"password", b"somesalt", &mut out),
            Err(Error::OutPtrMismatch)
        );
    }

    #[test]
    fn trace_fires_once_per_pass_with_the_whole_arena() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(3)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut passes = alloc::vec::Vec::new();
        let mut out = [0u8; 32];
        let mut trace = |pass: u32, blocks: &[Block]| {
            passes.push((pass, blocks.len()));
        };
        // SAFETY: `backend()` is what runtime detection picked for this CPU.
        let h0 = unsafe {
            hash_traced(
                crate::fill_block::backend(),
                Algorithm::Argon2id,
                Version::V0x13,
                &params,
                b"password",
                b"somesalt",
                &[],
                &[],
                &mut out,
                Some(&mut trace),
            )
        }
        .expect("hash_traced");

        assert_eq!(passes, alloc::vec![(0, 256), (1, 256), (2, 256)]);
        assert_eq!(h0.len(), PREHASH_DIGEST_LENGTH);
    }

    /// A panic on the leader must propagate, not deadlock the pool.
    ///
    /// The worker pool spans the whole fill and its helpers park on a spin
    /// barrier between slices. If the leader unwinds out of `thread::scope`
    /// without releasing them, `Scope`'s `Drop` blocks for ever joining threads
    /// that are waiting for a `generation` bump that is never coming — the
    /// crate hangs instead of failing. This test reaches that path through the
    /// one leader-side callback that exists, and it is the reason
    /// `ReleaseHelpers` is a `Drop` guard rather than a line at the end of the
    /// loop.
    ///
    /// If this regresses, it does not fail — it hangs. That is the point.
    #[test]
    #[cfg(feature = "parallel")]
    // wasip1 is panic=abort: there is no unwinding to test there.
    #[cfg_attr(target_arch = "wasm32", ignore = "no unwinding on wasi (panic=abort)")]
    fn a_panicking_trace_callback_unwinds_instead_of_deadlocking_the_pool() {
        // 4 lanes and 4 threads, so there really are helpers parked on the
        // barrier when the callback runs.
        let params = Params::builder()
            .memory(Memory::kib(64))
            .passes(2)
            .lanes(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = Arena::new(params.memory_blocks() as usize).expect("arena");
        let mut blockhash = initial_hash(
            Algorithm::Argon2id,
            Version::V0x13,
            &params,
            b"password",
            b"somesaltsomesalt",
            &[],
            &[],
        )
        .expect("H0");
        let (_, _, lane_length) = params.memory_layout();
        fill_first_blocks(
            &mut blockhash,
            arena.as_mut_slice(),
            params.lanes(),
            lane_length,
        )
        .expect("first blocks");

        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // SAFETY: `arena` was sized from `params` and outlives `instance`.
            let instance = unsafe {
                Instance::new(
                    arena.as_mut_ptr(),
                    arena.len(),
                    Algorithm::Argon2id,
                    Version::V0x13,
                    &params,
                )
            };
            let mut boom = |_pass: u32, _blocks: &[Block]| panic!("trace exploded");
            // SAFETY: `Backend::Scalar` runs anywhere, and `instance` is valid.
            unsafe {
                fill_memory_blocks_traced(&instance, Backend::Scalar, Some(&mut boom)).expect("fill")
            };
        }));

        assert!(caught.is_err(), "the callback's panic must reach the caller");
    }

    #[test]
    fn threads_do_not_change_the_tag() {
        // Spec item (12): only `lanes` affects the tag.
        for lanes in [2u32, 4] {
            let single = Params::builder()
                .memory(Memory::kib(1 << 10))
                .passes(2)
                .lanes(lanes)
                .threads(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let multi = Params::builder()
                .memory(Memory::kib(1 << 10))
                .passes(2)
                .lanes(lanes)
                .threads(lanes)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let a = Argon2::new(Algorithm::Argon2id, Version::V0x13, single)
                .hash(b"password", b"somesalt")
                .expect("st");
            let b = Argon2::new(Algorithm::Argon2id, Version::V0x13, multi)
                .hash(b"password", b"somesalt")
                .expect("mt");
            assert_eq!(a, b, "lanes={lanes}");
        }
    }

    #[test]
    fn verify_round_trips_and_rejects() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let encoded = argon2.hash_encoded(b"password", b"somesalt").expect("enc");
        assert!(encoded.starts_with("$argon2id$v=19$m=256,t=2,p=1$c29tZXNhbHQ$"));

        assert_eq!(
            Argon2::verify_encoded(&encoded, b"password", Algorithm::Argon2id),
            Ok(())
        );
        assert_eq!(
            Argon2::verify_encoded(&encoded, b"passwore", Algorithm::Argon2id),
            Err(Error::VerifyMismatch)
        );
        assert_eq!(
            Argon2::verify_encoded(&encoded, b"password", Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );

        let tag = argon2.hash(b"password", b"somesalt").expect("hash");
        assert_eq!(argon2.verify(b"password", b"somesalt", &tag), Ok(()));
        assert_eq!(
            argon2.verify(b"password", b"somesalt", &tag[..16]),
            Err(Error::VerifyMismatch)
        );
    }

    #[test]
    fn password_flavoured_names_are_the_same_functions() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        argon2
            .hash_into(b"password", b"somesalt", &mut a)
            .expect("hash_into");
        argon2
            .hash_password_into(b"password", b"somesalt", &mut b)
            .expect("hash_password_into");
        assert_eq!(a, b);

        let encoded = argon2.hash_password(b"password", b"somesalt").expect("enc");
        assert_eq!(
            encoded,
            argon2.hash_encoded(b"password", b"somesalt").expect("enc")
        );
        assert!(encoded.starts_with("$argon2id$v=19$m=256,t=2,p=1$c29tZXNhbHQ$"));

        assert_eq!(
            Argon2::verify_password(&encoded, b"password", Algorithm::Argon2id),
            Ok(())
        );
        assert_eq!(
            Argon2::verify_password(&encoded, b"passwore", Algorithm::Argon2id),
            Err(Error::VerifyMismatch)
        );
    }

    // ------------------------------------------------------------------
    // Hasher — the pooled arena
    // ------------------------------------------------------------------

    /// Everything one hash can be observed to produce: the pre-hashing digest,
    /// the whole arena after every pass, and the tag.
    ///
    /// The arena dumps are the point. A tag comparison would prove the two
    /// paths agree; a word-by-word arena comparison proves they agree *for the
    /// same reason*, and says exactly which block diverged when they do not.
    /// This is `genkat.c`'s `internal_kat` output in memory instead of on
    /// stdout — the same evidence `tests/kat.rs` checks against the golden
    /// files, applied to the one axis those files cannot see: where the arena
    /// came from.
    type Dump = (
        alloc::vec::Vec<(u32, alloc::vec::Vec<Block>)>,
        [u8; PREHASH_DIGEST_LENGTH],
        [u8; 32],
    );

    /// One hash down the one-shot path (`Arena::new` .. `Arena::drop`).
    ///
    /// # Safety
    ///
    /// This CPU must be able to execute `backend`.
    unsafe fn dump_one_shot(backend: Backend, argon2: &Argon2, pwd: &[u8], salt: &[u8]) -> Dump {
        let mut tag = [0u8; 32];
        let mut passes: alloc::vec::Vec<(u32, alloc::vec::Vec<Block>)> = alloc::vec::Vec::new();
        let mut trace = |pass: u32, blocks: &[Block]| passes.push((pass, blocks.to_vec()));
        // SAFETY: forwarded verbatim from this function's own contract.
        let h0 = unsafe {
            hash_traced(
                backend,
                argon2.algorithm,
                argon2.version,
                &argon2.params,
                pwd,
                salt,
                &[3u8; 8],
                &[4u8; 12],
                &mut tag,
                Some(&mut trace),
            )
        }
        .expect("one-shot hash");
        (passes, h0, tag)
    }

    /// The same hash over an arena borrowed from `workspace`.
    ///
    /// # Safety
    ///
    /// This CPU must be able to execute `backend`.
    unsafe fn dump_pooled(
        workspace: &mut Workspace,
        backend: Backend,
        argon2: &Argon2,
        pwd: &[u8],
        salt: &[u8],
    ) -> Dump {
        let mut tag = [0u8; 32];
        let mut h0 = [0u8; PREHASH_DIGEST_LENGTH];
        let mut passes: alloc::vec::Vec<(u32, alloc::vec::Vec<Block>)> = alloc::vec::Vec::new();
        let mut trace = |pass: u32, blocks: &[Block]| passes.push((pass, blocks.to_vec()));
        // SAFETY: forwarded verbatim from this function's own contract.
        unsafe {
            hash_in_workspace(
                workspace,
                backend,
                argon2.algorithm,
                argon2.version,
                &argon2.params,
                pwd,
                salt,
                &[3u8; 8],
                &[4u8; 12],
                &mut tag,
                Some(&mut trace),
                Some(&mut h0),
            )
        }
        .expect("pooled hash");
        (passes, h0, tag)
    }

    /// Report the *first* divergence, not a 96 KiB `assert_eq!` diff.
    fn assert_same_dump(what: &str, expected: &Dump, actual: &Dump) {
        assert_eq!(actual.1, expected.1, "{what}: H0 differs");
        assert_eq!(actual.0.len(), expected.0.len(), "{what}: pass count");

        for (want, got) in expected.0.iter().zip(actual.0.iter()) {
            assert_eq!(got.0, want.0, "{what}: pass index");
            assert_eq!(
                got.1.len(),
                want.1.len(),
                "{what}: arena length after pass {}",
                want.0
            );
            for (block, (wb, gb)) in want.1.iter().zip(got.1.iter()).enumerate() {
                for (word, (w, g)) in wb.0.iter().zip(gb.0.iter()).enumerate() {
                    assert_eq!(
                        g, w,
                        "{what}: pass {}, block {block}, word {word}",
                        want.0
                    );
                }
            }
        }
        assert_eq!(actual.2, expected.2, "{what}: tag differs");
    }

    /// The headline correctness claim, checked at the strongest granularity
    /// available: a pooled hash must produce a **byte-identical arena** at every
    /// pass boundary, not merely an identical tag.
    ///
    /// Rounds 1 and 2 are the ones that matter — round 0 runs on a
    /// freshly-allocated arena, so only a later round can catch a reused arena
    /// leaking a previous tenant's bytes into the computation. `genkat.c`'s
    /// parameters are used because they are the ones the golden files pin, and
    /// `lanes = threads = 4` puts the `std::thread::scope` path under the same
    /// check as the single-threaded one.
    #[test]
    fn a_pooled_hash_reproduces_the_one_shot_arena_word_for_word() {
        let params = Params::builder()
            .memory(Memory::kib(32))
            .passes(3)
            .lanes(4)
            .threads(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");

        for algorithm in [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id] {
            for version in [Version::V0x10, Version::V0x13] {
                let argon2 = Argon2::new(algorithm, version, params);

                for &backend in Backend::ALL {
                    if !backend.is_available() {
                        continue; // this CPU would SIGILL
                    }
                    // SAFETY: guarded by `is_available()` immediately above.
                    let expected =
                        unsafe { dump_one_shot(backend, &argon2, &[1u8; 32], &[2u8; 16]) };

                    let mut workspace = Workspace::new();
                    for round in 0..3 {
                        // SAFETY: as above.
                        let actual = unsafe {
                            dump_pooled(&mut workspace, backend, &argon2, &[1u8; 32], &[2u8; 16])
                        };
                        assert_same_dump(
                            &alloc::format!("{algorithm:?} {version:?} {backend} round {round}"),
                            &expected,
                            &actual,
                        );
                    }
                }
            }
        }
    }

    /// The `Hasher` API itself, against the one-shot API, over enough parameter
    /// shapes to cover single-threaded, multi-lane threaded, and multi-pass.
    #[test]
    fn hasher_agrees_with_the_one_shot_api() {
        let configs = [
            Params::builder()
                .memory(Memory::kib(8))
                .passes(1)
                .lanes(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("minimum"),
            Params::builder()
                .memory(Memory::kib(1 << 8))
                .passes(2)
                .lanes(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("st"),
            Params::builder()
                .memory(Memory::kib(1 << 9))
                .passes(2)
                .lanes(4)
                .threads(4)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("mt"),
            Params::builder()
                .memory(Memory::kib(64))
                .passes(3)
                .lanes(2)
                .threads(2)
                .tag_len(TagLen::bytes(24))
                .build()
                .expect("odd outlen"),
        ];

        for params in configs {
            for algorithm in [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id] {
                let argon2 = Argon2::new(algorithm, Version::V0x13, params);
                let mut hasher = argon2.hasher();

                for round in 0..4u8 {
                    let pwd = [round; 7];
                    let mut want = alloc::vec![0u8; params.tag_len_bytes()];
                    let mut got = alloc::vec![0u8; params.tag_len_bytes()];

                    argon2.hash_into(&pwd, b"somesalt", &mut want).expect("one");
                    hasher.hash_into(&pwd, b"somesalt", &mut got).expect("pool");
                    assert_eq!(got, want, "{algorithm:?} round {round}");

                    // ...and with a secret and associated data.
                    argon2
                        .hash_into_with_ad(&pwd, b"somesalt", &[3u8; 8], &[4u8; 12], &mut want)
                        .expect("one ad");
                    hasher
                        .hash_into_with_ad(&pwd, b"somesalt", &[3u8; 8], &[4u8; 12], &mut got)
                        .expect("pool ad");
                    assert_eq!(got, want, "{algorithm:?} round {round} with ad");
                }
            }
        }
    }

    /// The pooled counterparts of `tiny_single_threaded_hash_matches_the_c_reference`
    /// and `tiny_two_lane_hash_matches_the_c_reference`, against the same ground
    /// truth from the C reference.
    ///
    /// Sized so that `cargo +nightly miri test --lib tiny_` can run the whole
    /// new path end to end: acquire → hash → release-and-wipe → **re**-acquire →
    /// hash. The two-lane half puts the `std::thread::scope` raw-pointer sharing
    /// over an arena that has already been used once, which is the one piece of
    /// unsafe territory reuse actually changes. The growth step at the end makes
    /// Miri watch the old allocation being freed while the new one is filled.
    #[test]
    fn tiny_pooled_hashes_match_the_c_reference() {
        // `printf password | ./argon2 somesalt -id -t 1 -m 3 -p 1 -l 32 -r`
        let one_lane = Params::builder()
            .memory(Memory::kib(8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        // `printf password | ./argon2 somesalt -id -t 2 -m 4 -p 2 -l 32 -r`
        let two_lane = Params::builder()
            .memory(Memory::kib(16))
            .passes(2)
            .lanes(2)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");

        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, one_lane).hasher();
        let mut tag = [0u8; 32];

        for round in 0..2 {
            hasher
                .hash_into(b"password", b"somesalt", &mut tag)
                .expect("single lane");
            assert_eq!(
                hex(&tag),
                "f137f8e186a403a679ccd0606e5ab5dcdafe43c1640855ac8c6e33e9bd63eeb3",
                "single lane, round {round}"
            );
        }

        // Same hasher, wider configuration: the arena grows once, then reuses.
        hasher.set_argon2(Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            two_lane,
        ));
        for round in 0..2 {
            hasher
                .hash_into(b"password", b"somesalt", &mut tag)
                .expect("two lanes");
            assert_eq!(
                hex(&tag),
                "747d7631b182faf749d7efc31aec31df4ecfe3b57c792f53800ac2c9978b4888",
                "two lanes, round {round}"
            );
        }

        // And back down: the big arena is kept and re-lent as a narrow window.
        hasher.set_argon2(Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            one_lane,
        ));
        hasher
            .hash_into(b"password", b"somesalt", &mut tag)
            .expect("single lane again");
        assert_eq!(
            hex(&tag),
            "f137f8e186a403a679ccd0606e5ab5dcdafe43c1640855ac8c6e33e9bd63eeb3"
        );
        assert_eq!(hasher.reserved_blocks(), two_lane.memory_blocks() as usize);
    }

    /// Reuse is not a claim, it is an address: every hash after the first must
    /// land on the same allocation.
    #[test]
    fn reuse_lands_on_one_allocation() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let blocks = params.memory_blocks() as usize;
        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();

        assert_eq!(hasher.reserved_blocks(), 0, "nothing allocated up front");

        let mut tag = [0u8; 32];
        hasher.hash_into(b"password", b"somesalt", &mut tag).expect("first");
        assert_eq!(hasher.reserved_blocks(), blocks);

        // Peek at the parked arena the way the next hash would. The guard drops
        // at the end of the statement, handing it straight back.
        let first = hasher.workspace.acquire(blocks).expect("peek").as_ptr();
        for round in 0..8 {
            hasher.hash_into(b"password", b"somesalt", &mut tag).expect("again");
            assert_eq!(
                hasher.workspace.acquire(blocks).expect("peek").as_ptr(),
                first,
                "round {round} reallocated"
            );
        }
        assert_eq!(hasher.reserved_blocks(), blocks);
    }

    /// The control for the wipe test below, and a fact worth pinning in its own
    /// right: a finished hash leaves the **whole** arena full of material
    /// derived from that password. There is something real to wipe.
    ///
    /// Without this, `the_arena_a_hash_borrowed_comes_back_wiped` would be
    /// worthless — an arena that was never written would also read as all-zero.
    #[test]
    fn a_finished_hash_leaves_the_whole_arena_full_of_derived_material() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut arena = Arena::new(params.memory_blocks() as usize).expect("arena");
        let mut out = [0u8; 32];

        // SAFETY: `Backend::Scalar` is available on every CPU.
        unsafe {
            hash_in_arena(
                &mut arena,
                Backend::Scalar,
                Algorithm::Argon2id,
                Version::V0x13,
                &params,
                b"password",
                b"somesalt",
                &[],
                &[],
                &mut out,
                None,
                None,
            )
        }
        .expect("hash");

        let dirty = arena.as_slice().iter().filter(|b| **b != Block::ZERO).count();
        assert_eq!(
            dirty,
            arena.len(),
            "every block should still hold derived material before the wipe"
        );
    }

    /// The security property reuse must not weaken: the arena is wiped when the
    /// call that borrowed it returns, so what is parked between calls is zero,
    /// not the last password's derived material.
    ///
    /// Its control is
    /// [`a_finished_hash_leaves_the_whole_arena_full_of_derived_material`],
    /// which proves the bytes this test demands be gone were there to begin
    /// with.
    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn the_arena_a_hash_borrowed_comes_back_wiped() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let blocks = params.memory_blocks() as usize;
        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();

        let mut tag = [0u8; 32];
        for round in 0..3 {
            hasher.hash_into(b"password", b"somesalt", &mut tag).expect("hash");
            let parked = hasher.workspace.acquire(blocks).expect("peek");
            assert!(
                parked.as_slice().iter().all(|b| *b == Block::ZERO),
                "round {round}: the arena still holds derived material"
            );
        }
    }

    /// A hash that fails validation must leave the hasher exactly as it was —
    /// no half-released arena, no lost capacity, no wrong answer afterwards.
    #[test]
    fn an_error_does_not_disturb_reuse() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let blocks = params.memory_blocks() as usize;
        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();

        let mut tag = [0u8; 32];
        hasher.hash_into(b"password", b"somesalt", &mut tag).expect("warm up");
        let before = hasher.workspace.acquire(blocks).expect("peek").as_ptr();

        // Wrong output length: rejected before anything is allocated.
        let mut short = [0u8; 16];
        assert_eq!(
            hasher.hash_into(b"password", b"somesalt", &mut short),
            Err(Error::OutPtrMismatch)
        );
        // Salt too short: rejected by `validate_for`.
        assert!(hasher.hash_into(b"password", b"salt", &mut tag).is_err());

        assert_eq!(hasher.reserved_blocks(), blocks, "capacity survived");
        assert_eq!(
            hasher.workspace.acquire(blocks).expect("peek").as_ptr(),
            before,
            "and it is the same allocation"
        );

        let mut after = [0u8; 32];
        hasher.hash_into(b"password", b"somesalt", &mut after).expect("still works");
        assert_eq!(after, tag);
    }

    /// One hasher, several configurations. Growth reallocates once; shrinking
    /// keeps the big arena; every answer still matches the one-shot API.
    #[test]
    fn changing_the_configuration_keeps_the_memory_and_the_answers() {
        let small = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("small");
        let large = Params::builder()
            .memory(Memory::kib(1 << 10))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("large");
        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, small).hasher();

        let mut tag = [0u8; 32];
        let mut want = [0u8; 32];

        for (params, label) in [(small, "small"), (large, "large"), (small, "small again")] {
            let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
            hasher.set_argon2(argon2);
            assert_eq!(hasher.params().memory_kib(), params.memory_kib(), "{label}");
            assert_eq!(hasher.algorithm(), Algorithm::Argon2id);
            assert_eq!(hasher.version(), Version::V0x13);
            assert_eq!(hasher.argon2(), &argon2);

            hasher.hash_into(b"password", b"somesalt", &mut tag).expect(label);
            argon2.hash_into(b"password", b"somesalt", &mut want).expect(label);
            assert_eq!(tag, want, "{label}");
        }

        assert_eq!(
            hasher.reserved_blocks(),
            large.memory_blocks() as usize,
            "a smaller configuration must not shrink the arena"
        );
    }

    /// `reserve` front-loads the allocation; `clear` gives it back. Neither
    /// changes an answer.
    #[test]
    fn reserve_and_clear_move_the_allocation_around() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut hasher = argon2.hasher();

        hasher.reserve().expect("reserve");
        assert_eq!(hasher.reserved_blocks(), params.memory_blocks() as usize);
        let reserved = hasher
            .workspace
            .acquire(params.memory_blocks() as usize)
            .expect("peek")
            .as_ptr();

        let mut tag = [0u8; 32];
        hasher.hash_into(b"password", b"somesalt", &mut tag).expect("hash");
        assert_eq!(
            hasher
                .workspace
                .acquire(params.memory_blocks() as usize)
                .expect("peek")
                .as_ptr(),
            reserved,
            "the first hash must use the reserved arena, not a new one"
        );

        hasher.clear();
        assert_eq!(hasher.reserved_blocks(), 0);

        let mut again = [0u8; 32];
        hasher.hash_into(b"password", b"somesalt", &mut again).expect("after clear");
        assert_eq!(again, tag);
        assert_eq!(hasher.reserved_blocks(), params.memory_blocks() as usize);
    }

    /// The encoded and verifying halves of the API, including the one method
    /// that takes its parameters from the string rather than from the hasher.
    #[test]
    fn hasher_encodes_and_verifies_like_argon2() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut hasher = argon2.hasher();

        let encoded = hasher.hash_encoded(b"password", b"somesalt").expect("enc");
        assert_eq!(
            encoded,
            argon2.hash_encoded(b"password", b"somesalt").expect("enc")
        );
        assert_eq!(
            encoded,
            hasher.hash_password(b"password", b"somesalt").expect("enc")
        );

        assert_eq!(
            hasher.verify_encoded(&encoded, b"password", Algorithm::Argon2id),
            Ok(())
        );
        assert_eq!(
            hasher.verify_password(&encoded, b"passwore", Algorithm::Argon2id),
            Err(Error::VerifyMismatch)
        );
        assert_eq!(
            hasher.verify_encoded(&encoded, b"password", Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );

        let tag = hasher.hash(b"password", b"somesalt").expect("hash");
        assert_eq!(tag, argon2.hash(b"password", b"somesalt").expect("hash"));
        assert_eq!(hasher.verify(b"password", b"somesalt", &tag), Ok(()));
        assert_eq!(
            hasher.verify(b"password", b"somesalt", &tag[..16]),
            Err(Error::VerifyMismatch)
        );

        let mut into = [0u8; 32];
        hasher
            .hash_password_into(b"password", b"somesalt", &mut into)
            .expect("hash_password_into");
        assert_eq!(&into[..], &tag[..]);
    }

    /// `verify_encoded` reads `m_cost` out of the string, so one hasher can be
    /// pointed at strings written at different costs. All of them must verify —
    /// and none of them may leave the hasher any bigger than its *owner* made
    /// it, because the string is untrusted input and a pooled arena is retained.
    #[test]
    fn verifying_a_mix_of_costs_never_lets_a_string_grow_the_arena() {
        let small = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("small");
        let large = Params::builder()
            .memory(Memory::kib(1 << 10))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("large");

        let encoded_small = Argon2::new(Algorithm::Argon2id, Version::V0x13, small)
            .hash_encoded(b"password", b"somesalt")
            .expect("enc small");
        let encoded_large = Argon2::new(Algorithm::Argon2id, Version::V0x13, large)
            .hash_encoded(b"password", b"somesalt")
            .expect("enc large");

        // Deliberately configured for neither algorithm nor version: those
        // `verify_encoded` does take from the string. The *size* it does not.
        let mut hasher = Argon2::new(Algorithm::Argon2i, Version::V0x10, small).hasher();

        for round in 0..3 {
            assert_eq!(
                hasher.verify_encoded(&encoded_large, b"password", Algorithm::Argon2id),
                Ok(()),
                "round {round} large"
            );
            assert_eq!(
                hasher.verify_encoded(&encoded_small, b"password", Algorithm::Argon2id),
                Ok(()),
                "round {round} small"
            );
            assert_eq!(
                hasher.reserved_blocks(),
                small.memory_blocks() as usize,
                "round {round}: the encoded string set the high-water mark"
            );
        }

        // The owner raising the configuration is a different matter: that is a
        // deliberate choice, so it pools as normal, and a string of that size
        // may then use the arena it paid for.
        hasher.set_argon2(Argon2::new(Algorithm::Argon2id, Version::V0x13, large));
        assert_eq!(
            hasher.verify_encoded(&encoded_large, b"password", Algorithm::Argon2id),
            Ok(())
        );
        assert_eq!(hasher.reserved_blocks(), large.memory_blocks() as usize);
    }

    /// The rule `verify_encoded` enforces is a *ceiling*, and the ceiling is the
    /// owner's configuration — not "whatever is already allocated", which would
    /// be zero on a hasher that has not hashed yet and would therefore send
    /// every verify down the un-pooled path.
    ///
    /// So: a decoded cost below the configured one pools even as the very first
    /// call, and the arena it leaves behind is never larger than the arena the
    /// owner's own next `hash_into` would have taken.
    #[test]
    fn a_decoded_cost_under_the_configured_one_pools_from_the_very_first_call() {
        let tiny = Params::builder()
            .memory(Memory::kib(1 << 7))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("tiny");
        let configured = Params::builder()
            .memory(Memory::kib(1 << 10))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("configured");

        let encoded_tiny = Argon2::new(Algorithm::Argon2id, Version::V0x13, tiny)
            .hash_encoded(b"password", b"somesalt")
            .expect("enc tiny");

        // Nothing allocated yet, and the first thing this hasher ever does is
        // verify somebody else's string.
        let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, configured).hasher();
        assert_eq!(hasher.reserved_blocks(), 0);

        assert_eq!(
            hasher.verify_encoded(&encoded_tiny, b"password", Algorithm::Argon2id),
            Ok(())
        );
        assert_eq!(
            hasher.reserved_blocks(),
            tiny.memory_blocks() as usize,
            "a cost under the ceiling should still use the pool"
        );
        assert!(
            hasher.reserved_blocks() <= configured.memory_blocks() as usize,
            "an input must never push the pool past the owner's configuration"
        );

        // And the owner's own hashing still grows it to the configured size.
        let mut tag = [0u8; 32];
        hasher
            .hash_into(b"password", b"somesalt", &mut tag)
            .expect("hash");
        assert_eq!(
            hasher.reserved_blocks(),
            configured.memory_blocks() as usize
        );
    }

    /// A `Hasher` must be movable to whichever worker picks up a request. The
    /// matching negative — that it is not `Sync` — is the `compile_fail`
    /// doctest on [`Hasher`], which is what stops two threads sharing one arena.
    #[test]
    fn a_hasher_is_send() {
        const fn assert_send<T: Send>() {}
        assert_send::<Hasher>();
    }

    /// `hash_in_arena` is the one place an arena of the wrong size could reach
    /// `Instance::new`, whose safety contract is `memory_len == memory_blocks`.
    /// It must be an error, never undefined behaviour.
    #[test]
    fn a_wrongly_sized_arena_is_an_error_not_undefined_behaviour() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        assert_eq!(params.memory_blocks(), 256);
        let mut arena = Arena::new(64).expect("64 blocks");
        let mut out = [0u8; 32];

        // SAFETY: `Backend::Scalar` is available on every CPU.
        let result = unsafe {
            hash_in_arena(
                &mut arena,
                Backend::Scalar,
                Algorithm::Argon2id,
                Version::V0x13,
                &params,
                b"password",
                b"somesalt",
                &[],
                &[],
                &mut out,
                None,
                None,
            )
        };
        assert_eq!(result.err(), Some(Error::MemoryAllocationError));
        assert_eq!(out, [0u8; 32], "nothing was written");
    }

    #[test]
    fn every_available_backend_agrees_with_scalar() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 9))
            .passes(2)
            .lanes(2)
            .threads(2)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let mut reference = [0u8; 32];
        // SAFETY: `Backend::Scalar` is available on every CPU.
        unsafe {
            hash_inner(
                Backend::Scalar,
                Algorithm::Argon2id,
                Version::V0x13,
                &params,
                b"password",
                b"somesalt",
                &[],
                &[],
                &mut reference,
            )
        }
        .expect("scalar");

        for &backend in Backend::ALL {
            if !backend.is_available() {
                continue;
            }
            let mut out = [0u8; 32];
            // SAFETY: guarded by `is_available()` immediately above.
            unsafe {
                hash_inner(
                    backend,
                    Algorithm::Argon2id,
                    Version::V0x13,
                    &params,
                    b"password",
                    b"somesalt",
                    &[],
                    &[],
                    &mut out,
                )
            }
            .expect("backend");
            assert_eq!(out, reference, "{backend}");
        }
    }
}
