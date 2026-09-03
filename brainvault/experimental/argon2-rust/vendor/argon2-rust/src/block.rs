//! [`Block`], [`Instance`] and [`Position`] — the working set of the
//! compression loop.
//!
//! Mirrors `block`, `argon2_instance_t` and `argon2_position_t` from
//! `phc-winner-argon2/src/core.h`.

use crate::params::{Algorithm, BLOCK_SIZE, Params, QWORDS_IN_BLOCK, SYNC_POINTS, Version};
#[cfg(test)]
use crate::params::{Memory, TagLen};

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

/// A 1 KiB Argon2 memory block: 128 little-endian 64-bit words.
///
/// `#[repr(C, align(64))]` so that a `Block` inside the arena is 64-byte
/// aligned and AVX-512 loads land on a cache-line boundary. The SIMD backends
/// still use *unaligned* loads and stores, exactly like `src/opt.c` does.
///
/// The inner array is public because the backends need raw word access.
#[derive(Clone, Copy)]
#[repr(C, align(64))]
pub struct Block(pub [u64; QWORDS_IN_BLOCK]);

impl Block {
    /// An all-zero block (`init_block_value(b, 0)`).
    pub const ZERO: Block = Block([0; QWORDS_IN_BLOCK]);

    /// `init_block_value()`: set every *byte* of the block to `byte`.
    #[inline]
    pub fn fill(&mut self, byte: u8) {
        let word = u64::from_ne_bytes([byte; 8]);
        self.0 = [word; QWORDS_IN_BLOCK];
    }

    /// `copy_block()`.
    #[inline]
    pub fn copy_from(&mut self, src: &Block) {
        self.0 = src.0;
    }

    /// `xor_block()`: `self ^= src`, word by word.
    #[inline]
    pub fn xor_with(&mut self, src: &Block) {
        for i in 0..QWORDS_IN_BLOCK {
            self.0[i] ^= src.0[i];
        }
    }

    /// `load_block()`: read 128 little-endian `u64`s out of `bytes`.
    #[inline]
    pub fn load_le(&mut self, bytes: &[u8; BLOCK_SIZE]) {
        for (word, chunk) in self.0.iter_mut().zip(bytes.chunks_exact(8)) {
            // `chunks_exact(8)` yields 8-byte slices; the try_into cannot fail.
            let mut buf = [0u8; 8];
            buf.copy_from_slice(chunk);
            *word = u64::from_le_bytes(buf);
        }
    }

    /// `store_block()`: write 128 little-endian `u64`s into `out`.
    #[inline]
    pub fn store_le(&self, out: &mut [u8; BLOCK_SIZE]) {
        for (word, chunk) in self.0.iter().zip(out.chunks_exact_mut(8)) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
    }

    /// [`Block::load_le`] as a constructor.
    #[inline]
    #[must_use]
    pub fn from_le_bytes(bytes: &[u8; BLOCK_SIZE]) -> Block {
        let mut b = Block::ZERO;
        b.load_le(bytes);
        b
    }

    /// [`Block::store_le`] into a fresh array.
    // Takes `&self` on purpose: `Block` is `Copy` but it is a whole kilobyte, so
    // by-value would add a pointless 1 KiB memcpy at every call site.
    #[allow(clippy::wrong_self_convention)]
    #[inline]
    #[must_use]
    pub fn to_le_bytes(&self) -> [u8; BLOCK_SIZE] {
        let mut out = [0u8; BLOCK_SIZE];
        self.store_le(&mut out);
        out
    }

    /// A raw byte view of the block, in **native** byte order.
    ///
    /// Use this for wiping and for unaligned SIMD loads. For anything that
    /// crosses an ABI boundary (BLAKE2b input, the final tag) use
    /// [`Block::store_le`] / [`Block::to_le_bytes`], which are endian-correct.
    #[inline]
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; BLOCK_SIZE] {
        // SAFETY: `[u64; 128]` and `[u8; 1024]` have the same size, `u8` has
        // alignment 1 (so any `u64`-aligned pointer is `u8`-aligned), `[u64]`
        // has no padding, and every bit pattern is a valid `u8`.
        unsafe { &*self.0.as_ptr().cast::<[u8; BLOCK_SIZE]>() }
    }

    /// Mutable counterpart of [`Block::as_bytes`], in **native** byte order.
    #[inline]
    #[must_use]
    pub fn as_bytes_mut(&mut self) -> &mut [u8; BLOCK_SIZE] {
        // SAFETY: see `as_bytes`.
        unsafe { &mut *self.0.as_mut_ptr().cast::<[u8; BLOCK_SIZE]>() }
    }

    /// Pointer to word 0, for SIMD loads.
    #[inline]
    #[must_use]
    pub fn as_ptr(&self) -> *const u64 {
        self.0.as_ptr()
    }

    /// Mutable pointer to word 0, for SIMD stores.
    #[inline]
    #[must_use]
    pub fn as_mut_ptr(&mut self) -> *mut u64 {
        self.0.as_mut_ptr()
    }
}

impl Default for Block {
    #[inline]
    fn default() -> Block {
        Block::ZERO
    }
}

impl core::ops::Index<usize> for Block {
    type Output = u64;
    #[inline]
    fn index(&self, index: usize) -> &u64 {
        &self.0[index]
    }
}

impl core::ops::IndexMut<usize> for Block {
    #[inline]
    fn index_mut(&mut self, index: usize) -> &mut u64 {
        &mut self.0[index]
    }
}

impl PartialEq for Block {
    /// Word-wise equality. **Not** constant time; never use it on a tag.
    #[inline]
    fn eq(&self, other: &Block) -> bool {
        self.0 == other.0
    }
}

impl Eq for Block {}

impl core::fmt::Debug for Block {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "Block([{:#018x}, {:#018x}, .., {:#018x}])",
            self.0[0],
            self.0[1],
            self.0[QWORDS_IN_BLOCK - 1]
        )
    }
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/// Where the compression loop currently is (`argon2_position_t`).
///
/// `slice` is a `u8` in C; a `u32` here avoids a pile of casts. It is always
/// in `0..SYNC_POINTS`, so nothing overflows differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Position {
    /// Pass index, `0..instance.passes`.
    pub pass: u32,
    /// Lane index, `0..instance.lanes`.
    pub lane: u32,
    /// Slice index, `0..SYNC_POINTS`.
    pub slice: u32,
    /// Block index inside the segment, `0..instance.segment_length`.
    pub index: u32,
}

impl Position {
    /// Build a position.
    #[inline]
    #[must_use]
    pub const fn new(pass: u32, lane: u32, slice: u32, index: u32) -> Position {
        Position {
            pass,
            lane,
            slice,
            index,
        }
    }
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

/// A live Argon2 computation (`argon2_instance_t`).
///
/// `Instance` borrows the block arena as a raw pointer rather than a slice.
/// That is what lets [`crate::fill_block::FillSegmentFn`] be
/// `unsafe fn(&Instance, Position)`: `fill_segment` writes into the arena
/// through a shared `&Instance`, which several lanes hold at once.
///
/// # Safety invariants
///
/// Every `unsafe` accessor below assumes:
///
/// * `memory` is valid for reads and writes of `memory_len` `Block`s for as
///   long as this `Instance` is used, and is 64-byte aligned;
/// * `memory_len == memory_blocks as usize`;
/// * the index passed in is `< memory_len`.
///
/// `Instance` is intentionally **not** `Send`/`Sync`: sharing it across lanes
/// is `core`'s job, behind its own newtype with its own safety argument.
///
/// # Aliasing note for backend authors
///
/// Inside one `fill_segment` iteration, `prev_offset`, `ref_index` and
/// `curr_offset` may collide only as `prev == ref`; `curr` is always distinct
/// from both, because `index_alpha` never selects the block being written.
/// So `&*block_ptr(prev)`, `&*block_ptr(ref)` and `&mut *block_ptr(curr)`
/// can coexist. The one place the reference genuinely aliases is
/// `next_addresses`, which calls `fill_block(zero, address, address, 0)` —
/// copy the address block first (`Block` is `Copy`) instead of forming two
/// references to it.
#[derive(Debug)]
pub struct Instance {
    memory: *mut Block,
    memory_len: usize,
    /// `instance.version`.
    pub version: Version,
    /// `instance.passes` (`t_cost`).
    pub passes: u32,
    /// `instance.memory_blocks`.
    pub memory_blocks: u32,
    /// `instance.segment_length`.
    pub segment_length: u32,
    /// `instance.lane_length` = `segment_length * SYNC_POINTS`.
    pub lane_length: u32,
    /// `instance.lanes`.
    pub lanes: u32,
    /// `instance.threads`, already clamped to `min(threads, lanes)`.
    pub threads: u32,
    /// `instance.type`.
    pub algorithm: Algorithm,
}

impl Instance {
    /// Build an instance over an existing arena, deriving the block counts
    /// from `params` exactly as step 2 of `argon2_ctx()` does.
    ///
    /// # Safety
    ///
    /// `memory` must be valid for reads and writes of `memory_len` `Block`s,
    /// 64-byte aligned, and must outlive every use of the returned `Instance`.
    /// `memory_len` must equal `params.memory_blocks() as usize`.
    #[must_use]
    pub unsafe fn new(
        memory: *mut Block,
        memory_len: usize,
        algorithm: Algorithm,
        version: Version,
        params: &Params,
    ) -> Instance {
        let (memory_blocks, segment_length, lane_length) = params.memory_layout();
        Instance {
            memory,
            memory_len,
            version,
            passes: params.passes(),
            memory_blocks,
            segment_length,
            lane_length,
            lanes: params.lanes(),
            threads: params.effective_threads(),
            algorithm,
        }
    }

    /// Raw arena pointer.
    #[inline]
    #[must_use]
    pub fn memory_ptr(&self) -> *mut Block {
        self.memory
    }

    /// Number of blocks the arena holds.
    #[inline]
    #[must_use]
    pub fn memory_len(&self) -> usize {
        self.memory_len
    }

    /// Pointer to block `index`.
    ///
    /// # Safety
    ///
    /// `index` must be `< self.memory_len()`.
    #[inline]
    #[must_use]
    pub unsafe fn block_ptr(&self, index: u32) -> *mut Block {
        debug_assert!((index as usize) < self.memory_len);
        // SAFETY: the caller guarantees `index` is in bounds, so the result is
        // inside the same allocation as `self.memory`.
        unsafe { self.memory.add(index as usize) }
    }

    /// Shared reference to block `index`.
    ///
    /// # Safety
    ///
    /// `index` must be `< self.memory_len()`, and no `&mut Block` to the same
    /// index may be live.
    #[inline]
    #[must_use]
    pub unsafe fn block(&self, index: u32) -> &Block {
        // SAFETY: guaranteed by the caller, see the method contract.
        unsafe { &*self.block_ptr(index) }
    }

    /// Exclusive reference to block `index`, through a shared `&self`.
    ///
    /// This is the interior-mutability escape hatch that makes
    /// `unsafe fn(&Instance, Position)` workable.
    ///
    /// # Safety
    ///
    /// `index` must be `< self.memory_len()`, and no other reference to that
    /// block may be live — in particular no other lane may be writing it. See
    /// the type-level aliasing note.
    #[inline]
    #[must_use]
    #[allow(clippy::mut_from_ref)]
    pub unsafe fn block_mut(&self, index: u32) -> &mut Block {
        // SAFETY: guaranteed by the caller, see the method contract.
        unsafe { &mut *self.block_ptr(index) }
    }

    /// Whether this position uses data-independent addressing.
    ///
    /// From `fill_segment` in `src/ref.c`:
    /// `type == Argon2_i || (type == Argon2_id && pass == 0 && slice < SYNC_POINTS / 2)`.
    #[inline]
    #[must_use]
    pub fn data_independent_addressing(&self, position: &Position) -> bool {
        matches!(self.algorithm, Algorithm::Argon2i)
            || (matches!(self.algorithm, Algorithm::Argon2id)
                && position.pass == 0
                && position.slice < SYNC_POINTS / 2)
    }

    /// The `with_xor` flag `fill_segment` passes to `fill_block`.
    ///
    /// Version `0x10` always overwrites; version `0x13` XORs from pass 1 on.
    #[inline]
    #[must_use]
    pub fn with_xor(&self, pass: u32) -> bool {
        !matches!(self.version, Version::V0x10) && pass != 0
    }

    /// The seed block `fill_segment` builds for data-independent addressing.
    ///
    /// ```text
    /// input_block.v[0] = position.pass;
    /// input_block.v[1] = position.lane;
    /// input_block.v[2] = position.slice;
    /// input_block.v[3] = instance->memory_blocks;
    /// input_block.v[4] = instance->passes;
    /// input_block.v[5] = instance->type;
    /// ```
    ///
    /// `v[6]` is the counter `next_addresses` increments; the rest stays zero.
    #[inline]
    #[must_use]
    pub fn address_input_block(&self, position: &Position) -> Block {
        let mut b = Block::ZERO;
        b.0[0] = u64::from(position.pass);
        b.0[1] = u64::from(position.lane);
        b.0[2] = u64::from(position.slice);
        b.0[3] = u64::from(self.memory_blocks);
        b.0[4] = u64::from(self.passes);
        b.0[5] = u64::from(self.algorithm.as_u32());
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_is_1kib_and_64_byte_aligned() {
        assert_eq!(size_of::<Block>(), BLOCK_SIZE);
        assert_eq!(align_of::<Block>(), 64);
    }

    #[test]
    fn fill_sets_every_byte() {
        let mut b = Block::ZERO;
        b.fill(0xAB);
        assert!(b.as_bytes().iter().all(|&x| x == 0xAB));
        b.fill(0);
        assert_eq!(b, Block::ZERO);
    }

    #[test]
    fn le_round_trip() {
        let mut bytes = [0u8; BLOCK_SIZE];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        let b = Block::from_le_bytes(&bytes);
        assert_eq!(b.0[0], u64::from_le_bytes([0, 1, 2, 3, 4, 5, 6, 7]));
        assert_eq!(b.to_le_bytes(), bytes);
    }

    #[test]
    fn xor_and_copy() {
        let mut a = Block::ZERO;
        a.fill(0xF0);
        let mut b = Block::ZERO;
        b.fill(0x0F);
        a.xor_with(&b);
        assert!(a.as_bytes().iter().all(|&x| x == 0xFF));
        a.copy_from(&b);
        assert_eq!(a, b);
    }

    #[test]
    fn with_xor_follows_version() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 12))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let mut arena = [Block::ZERO; 2];
        // SAFETY: `arena` outlives `inst`, and we never index it here.
        let inst = unsafe {
            Instance::new(
                arena.as_mut_ptr(),
                arena.len(),
                Algorithm::Argon2id,
                Version::V0x13,
                &params,
            )
        };
        assert!(!inst.with_xor(0));
        assert!(inst.with_xor(1));

        // SAFETY: same as above.
        let inst10 = unsafe {
            Instance::new(
                arena.as_mut_ptr(),
                arena.len(),
                Algorithm::Argon2id,
                Version::V0x10,
                &params,
            )
        };
        assert!(!inst10.with_xor(0));
        assert!(!inst10.with_xor(1));
    }

    #[test]
    fn data_independent_addressing_matches_ref_c() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 12))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let mut arena = [Block::ZERO; 2];
        let ptr = arena.as_mut_ptr();
        let len = arena.len();
        let mk = |alg| {
            // SAFETY: `arena` outlives the instance and is never indexed here.
            unsafe { Instance::new(ptr, len, alg, Version::V0x13, &params) }
        };

        let i = mk(Algorithm::Argon2i);
        let d = mk(Algorithm::Argon2d);
        let id = mk(Algorithm::Argon2id);

        for pass in 0..2 {
            for slice in 0..SYNC_POINTS {
                let p = Position::new(pass, 0, slice, 0);
                assert!(i.data_independent_addressing(&p));
                assert!(!d.data_independent_addressing(&p));
                assert_eq!(
                    id.data_independent_addressing(&p),
                    pass == 0 && slice < 2,
                    "argon2id pass={pass} slice={slice}"
                );
            }
        }
    }

    #[test]
    fn address_input_block_layout() {
        let params = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(3)
            .lanes(2)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let mut arena = [Block::ZERO; 2];
        // SAFETY: `arena` outlives `inst`; no indexing happens.
        let inst = unsafe {
            Instance::new(
                arena.as_mut_ptr(),
                arena.len(),
                Algorithm::Argon2i,
                Version::V0x13,
                &params,
            )
        };
        let b = inst.address_input_block(&Position::new(1, 1, 3, 0));
        assert_eq!(b.0[0], 1);
        assert_eq!(b.0[1], 1);
        assert_eq!(b.0[2], 3);
        assert_eq!(b.0[3], u64::from(params.memory_blocks()));
        assert_eq!(b.0[4], 3);
        assert_eq!(b.0[5], Algorithm::Argon2i.as_u32() as u64);
        assert_eq!(b.0[6], 0);
    }
}
