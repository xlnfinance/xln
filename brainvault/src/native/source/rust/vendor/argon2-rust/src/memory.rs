//! The block arena, the reusable [`Workspace`] that owns one across calls, and
//! secure wiping.
//!
//! [`Arena`], [`secure_wipe`] and [`clear_internal_memory`] mirror
//! `allocate_memory`, `free_memory`, `secure_wipe_memory` and
//! `clear_internal_memory` from `phc-winner-argon2/src/core.c`. [`Workspace`]
//! has no counterpart in the C, which allocates and frees the arena on every
//! `argon2_ctx` call.
//!
//! # Where a hash's time actually goes, and why this module owns most of it
//!
//! **This section used to say the opposite of the truth on Linux. It was
//! measured on macOS and generalised, and it sent one investigation down the
//! wrong path entirely. The numbers below are from the Linux target
//! (Sapphire Rapids, 4 KiB pages, `--release`), which is where the problem is.**
//!
//! `Argon2id, m = 256 MiB, t = 1, p = 1`, AVX-512, cold arena every call —
//! i.e. exactly what [`crate::Argon2::hash`] does:
//!
//! ```text
//!   stage                                        before      after
//!   ------------------------------------------  --------   --------
//!   arena acquisition (mmap; pages fault later)  134.9 ms     0.0 ms
//!   fill_memory_blocks, page faults included      77.7 ms    95.4 ms
//!   secure wipe + release the mapping             39.3 ms    13.2 ms
//!   ------------------------------------------  --------   --------
//!   TOTAL                                        251.9 ms   108.8 ms
//! ```
//!
//! **69% of that hash was not Argon2.** It was this module. Three separate
//! defects, all of them here, none of them in the compression loop:
//!
//! 1. `alloc_zeroed` with `ARENA_ALIGN == 64` cannot reach `calloc` (std only
//!    does that for `align <= 16`), so it was `posix_memalign` + an explicit
//!    `memset` over memory the kernel had *just* zeroed. Double work, and the
//!    `memset` was what took all 65536 page faults — on the calling thread,
//!    before any worker existed, which is why the fixed cost was completely
//!    flat in `p` (41.2 / 41.3 / 41.9 ms at p = 1/2/4 for a 64 MiB arena) while
//!    the C's fell 1.9x.
//! 2. Nobody asked for huge pages, so a 256 MiB arena was 65536 4 KiB pages
//!    against a ~2000-entry STLB. THP is `[madvise]` on the target, so it is
//!    opt-in and neither this crate nor the C reference was opting in.
//! 3. The security wipe was one `write_volatile::<u64>` per word — 8.1 GiB/s
//!    against a `memset`'s 23.7 — and single-threaded.
//!
//! What replaced them, and what each is worth at 256 MiB (measured, medians):
//!
//! ```text
//!   acquisition
//!     alloc_zeroed(align 64)                    134.9 ms    1.85 GiB/s  before
//!     mmap + MADV_HUGEPAGE + first-touch x1      28.8 ms    8.67 GiB/s
//!     mmap + MADV_HUGEPAGE + first-touch x2      15.3 ms   16.30 GiB/s
//!     mmap + MADV_HUGEPAGE + first-touch x4      11.7 ms   21.41 GiB/s
//!     ... without MADV_HUGEPAGE (4 KiB pages)    59.5 ms    4.20 GiB/s
//!   release
//!     write_volatile::<u64> loop                 30.8 ms    8.13 GiB/s  before
//!     write_bytes + asm! barrier   x1            10.6 ms   23.71 GiB/s
//!     write_bytes + asm! barrier   x2             5.3 ms   46.97 GiB/s
//!     munmap, 4 KiB pages                         8.5 ms                before
//!     munmap, 2 MiB pages                         0.5 ms
//! ```
//!
//! # Nobody pre-faults the arena, and that was measured too
//!
//! The obvious next step is to fault every page in up front, striped across the
//! worker threads, so the fill never traps. It was implemented, measured, and
//! **removed**, because it is slower:
//!
//! ```text
//!   m = 256 MiB, t = 1, avx512, whole hash, three alternating runs
//!            eager pre-fault        lazy (this)
//!     p = 1  114.7 113.2 116.1      108.2 108.4 109.4     -5.4%
//!     p = 4   48.0  48.3  48.0       46.2  46.2  46.2     -4.0%
//! ```
//!
//! Two reasons, and the second is the one that generalises. A pre-fault pass is
//! a *second* walk over the arena: the kernel zeroes a 2 MiB page, the touch
//! pass moves on, and by the time the fill reaches that page the freshly-zeroed
//! lines have been evicted. Taking the fault inside `fill_segment` instead
//! means the block write lands on lines the kernel wrote moments ago. And the
//! faults are *already* parallel where parallelism exists — each worker faults
//! its own lane's region — which is exactly how the C gets its faults onto its
//! worker threads, and the whole reason its fixed cost scaled with `p` while
//! this crate's did not.
//!
//! So the fix for that defect was never "pre-fault in parallel". It was "stop
//! writing 256 MiB of zeros over memory that the kernel had already zeroed",
//! which is `mmap`, and the faults then land where they always should have.
//!
//! Three further findings worth keeping, all counter-intuitive, all measured:
//!
//! * `madvise(MADV_POPULATE_WRITE)` — the obvious way to fault a range in — does
//!   **not** parallelise: 29.0 / 28.9 / 28.9 ms on 1 / 2 / 4 threads. All 128
//!   huge pages of a 256 MiB region hang off one PMD page table, so they
//!   contend on one `pmd_lock`. A striped first-touch takes the ordinary fault
//!   path and scales 2.47x. If pre-faulting is ever revisited, it is the second
//!   form that has a chance, not the first.
//! * The `[madvise]` defrag setting means `MADV_HUGEPAGE` can enter direct
//!   compaction at fault time. Over 30 cold 256 MiB acquisitions on an idle
//!   target: min 28.4, median 28.8, p90 29.2, max 29.3 ms — no tail at all.
//!   On a **fragmented** host there can be one; the kernel falls back to 4 KiB
//!   silently, so it is a latency risk and never a correctness one.
//! * Huge pages are worth 2x on acquisition (59.5 → 28.8 ms) and **17x** on
//!   release (`munmap` of a resident 256 MiB mapping: 8.5 → 0.5 ms), on top of
//!   what they do for the fill's TLB.
//!
//! # Why a reuse layer exists, and what it is worth *now*
//!
//! It used to be worth one `memset` (1.4-5.1%). With the acquisition above it
//! is worth the acquisition *and* the release: a pooled [`Workspace`] arena
//! stays mapped and stays resident, so [`Workspace::acquire`] does no syscall,
//! takes no fault and writes no byte. At 256 MiB that is 12.7 ms + 0.5 ms of a
//! 109 ms hash — the mapping's ~29 ms of first-touch faults and its 0.5 ms of
//! `munmap` — on top of the wipe that reuse already made do double duty as the
//! next hash's zeroing.
//!
//! # The zeroing contract, stated exactly
//!
//! Argon2 itself does **not** need a zeroed arena. Pass 0 writes every block
//! before anything reads it (`fill_first_blocks` writes blocks 0 and 1 of each
//! lane, `fill_segment` writes the rest, and `ref.c:185-187` passes
//! `with_xor = 0` for pass 0 so `next_block` is never read). The C reference
//! allocates with plain `malloc` (`core.c:105`). What *this* crate needs is
//! weaker than "zero" and stronger than nothing: [`Arena::as_slice`] and
//! [`Arena::as_mut_slice`] are safe `pub fn`s handing out `&[Block]` over the
//! whole arena before any block is written, so the memory must be
//! **initialised**.
//!
//! That requirement is exactly why the arena is an anonymous **mapping** rather
//! than an `alloc` plus a promise. `MAP_ANONYMOUS` memory is zero-filled by the
//! kernel — POSIX guarantees it, and it is the reason `calloc` can skip its
//! `memset` for large requests — so the mapping satisfies "initialised" and
//! "zero" with **no user-space write at all**. `alloc` would have handed back
//! memory that is uninitialised *as far as the language is concerned* even
//! though the same pages are zero in fact, and turning that into a `&[Block]`
//! would have been undefined behaviour dressed up as an optimisation. Off
//! Linux, `alloc_zeroed` still does the job the same way it always did.
//!
//! Once an arena has been used once it is permanently initialised, so the slice
//! API stays sound on a pooled arena even with `zeroize-memory` off.
//!
//! # Wipe on release, never on acquire
//!
//! When a hash returns, 100% of the arena still holds material derived from
//! that password, including the final block that produced the tag. Wiping on
//! *acquire* would park all of it in the workspace for the entire idle period —
//! strictly worse than today. Wiping on *release* preserves today's property
//! exactly: the exposure window closes when the call returns.

#[cfg(feature = "bump-alloc")]
use bumpalo::Bump;

use alloc::alloc::{Layout, alloc_zeroed, dealloc};
use core::mem::ManuallyDrop;
use core::ops::{Deref, DerefMut};
use core::ptr::NonNull;
use core::sync::atomic::{Ordering, compiler_fence};

use crate::block::Block;
use crate::error::Error;

/// Alignment of the arena, in bytes. 64 keeps AVX-512 loads on a cache line.
pub const ARENA_ALIGN: usize = 64;

/// `true` when the `zeroize-memory` feature is on, as a `const` the reuse layer
/// can branch on.
///
/// [`clear_internal_memory_blocks`] compiles to nothing without the feature, so
/// the workspace has to know whether a "wipe" actually zeroed anything before
/// it may claim the arena is zero.
const WIPE_ENABLED: bool = cfg!(feature = "zeroize-memory");

/// Arena size, in bytes, above which the release wipe is worth threading.
///
/// One core reaches 23.7 GiB/s on a `memset`, which saturates an L3-resident
/// arena on this target — 64 MiB measured 2.62 ms on one thread and 2.58 on
/// four, i.e. nothing, against ~60 us of scope-and-spawn. It stops saturating
/// once the arena is bigger than L3: 256 MiB goes 10.6 → 5.3 ms on two stripes.
/// 64 MiB is the break-even, so that is the threshold.
///
/// Read only from the `zeroize-memory` arm of [`Arena::wipe_visible`]; without
/// that feature the wipe compiles to nothing and this has no reader.
#[cfg_attr(not(feature = "zeroize-memory"), allow(dead_code))]
const WIPE_THREAD_THRESHOLD: usize = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Secure wiping
// ---------------------------------------------------------------------------

/// Whether [`secure_wipe_raw`] can use the `asm!`-barrier form.
///
/// `core::arch::asm!` is stable only on a fixed list of architectures. Anywhere
/// else the volatile loop is the fallback, which is correct and merely slow.
/// Miri interprets the crate and does not support inline assembly at all, so
/// it takes the fallback too.
const HAVE_ASM_BARRIER: bool = cfg!(all(not(miri), any(
    target_arch = "x86",
    target_arch = "x86_64",
    target_arch = "arm",
    target_arch = "aarch64",
    target_arch = "riscv32",
    target_arch = "riscv64",
    target_arch = "loongarch64",
    target_arch = "s390x",
)));

/// `secure_wipe_memory()`: zero a region in a way the optimiser may not remove.
///
/// # Why this is not a volatile loop any more, and why it is still safe
///
/// The guarantee being bought is "**the stores are still there at `-O3`**", not
/// "the stores are eight bytes wide". The old implementation delivered the first
/// by way of the second — one [`core::ptr::write_volatile::<u64>`] per word —
/// and LLVM is not allowed to merge, widen or vectorise volatile accesses, so it
/// ran at **8.1 GiB/s against a `memset`'s 23.7**, for the life of the crate,
/// on every platform. At `m = 256 MiB` that was 30.8 ms per hash.
///
/// This is instead `write_bytes` followed by an empty `asm!` block that takes
/// the pointer as an input operand. An `asm!` without `nomem` and without
/// `readonly` is *defined* — by the Rust reference, not by observation of what
/// LLVM currently does — to read and write arbitrary memory. The compiler
/// therefore cannot prove the region dead, and the `memset` cannot be
/// eliminated. This is precisely the construction glibc uses for
/// `explicit_bzero`, which is what `core.c:140` gets for free and this crate was
/// paying 2.9x not to have.
///
/// The [`compiler_fence`] stays. It is not what makes the wipe survive — that
/// was measured: `write_bytes` + `compiler_fence` alone, at
/// `-O -C lto -C codegen-units=1` with the buffer dead afterwards, compiles the
/// **entire wipe away** and leaves a function that is one `ret`. Do not ship
/// that variant, and do not "simplify" this one back into it. The fence is kept
/// because it also orders the wipe against surrounding atomics, which the
/// `asm!` block alone does not promise.
///
/// `tests/allocation_audit.rs` observes the finished product from outside, in
/// `--release`, which is the check that actually matters.
///
/// # What was considered and rejected: non-temporal stores
///
/// A `movnt` loop skips the read-for-ownership and should roughly halve the
/// remaining 10.6 ms at 256 MiB. It is **not** used, and the reason is the
/// pooled path: [`Workspace::release`] wipes an arena and then parks it for the
/// next hash, so a non-temporal wipe would hand the next hash an arena with
/// every line evicted. At `m_cost = 64 MiB` — L3-resident on the target, and
/// the RFC 9106 size — that trades a measured 24-34% reuse win for a 4%
/// one-shot win. The cliff is exactly where the common configuration sits, so
/// the answer is no.
///
/// # Safety
///
/// `ptr` must be valid for writes of `len` bytes, and nothing else may access
/// that region for the duration.
#[inline]
pub unsafe fn secure_wipe_raw(ptr: *mut u8, len: usize) {
    if len == 0 {
        // `write_bytes` is fine with a zero length, but `asm!` would still
        // publish a pointer that may be dangling. Nothing to wipe either way.
        return;
    }

    if HAVE_ASM_BARRIER {
        // SAFETY: the caller guarantees `ptr` is valid for writes of `len`
        // bytes and exclusively ours for the duration. All-zero is a valid bit
        // pattern for every type this crate wipes (`u8`, `u64`, `Block`).
        unsafe { core::ptr::write_bytes(ptr, 0, len) };
        // SAFETY: an empty instruction sequence executes nothing. `nostack`
        // says it does not touch the stack, `preserves_flags` that it does not
        // clobber the condition codes; both are true of no instructions at all.
        // Crucially it does NOT say `nomem` or `readonly`, so the compiler must
        // assume the block reads the memory `ptr` points at, which is what
        // keeps the `write_bytes` above alive.
        #[cfg(any(
            target_arch = "x86",
            target_arch = "x86_64",
            target_arch = "arm",
            target_arch = "aarch64",
            target_arch = "riscv32",
            target_arch = "riscv64",
            target_arch = "loongarch64",
            target_arch = "s390x",
        ))]
        // SAFETY: as described above — an empty instruction sequence with no
        // memory clobber promise, whose only effect is to keep the `memset`
        // alive. It executes nothing, so it cannot be unsound.
        unsafe {
            core::arch::asm!("/* {0} */", in(reg) ptr, options(nostack, preserves_flags));
        }
    } else {
        // Fallback for targets without stable `asm!`. Byte-wise volatile: slow,
        // portable, and it cannot be optimised out either.
        // SAFETY: as above; every offset is `< len`.
        unsafe {
            for i in 0..len {
                core::ptr::write_volatile(ptr.add(i), 0u8);
            }
        }
    }

    compiler_fence(Ordering::SeqCst);
}

/// [`secure_wipe_raw`] over a byte slice.
pub fn secure_wipe(bytes: &mut [u8]) {
    // SAFETY: a `&mut [u8]` is by definition valid for writes of `len()` bytes
    // and uniquely borrowed for the call.
    unsafe { secure_wipe_raw(bytes.as_mut_ptr(), bytes.len()) };
}

/// [`secure_wipe_raw`] over 64-bit words.
pub fn secure_wipe_u64(words: &mut [u64]) {
    // SAFETY: `[u64]` has no padding and all-zero is a valid `u64`, so the
    // whole `len() * 8` byte range may be written as bytes.
    unsafe { secure_wipe_raw(words.as_mut_ptr().cast::<u8>(), size_of_val(words)) };
}

/// [`secure_wipe_raw`] over whole blocks.
///
/// One `memset` for the whole run rather than one per block: a `Block` is
/// `#[repr(C, align(64))]` around `[u64; 128]` with no padding, so a slice of
/// them is one contiguous `len() * 1024`-byte region.
pub fn secure_wipe_blocks(blocks: &mut [Block]) {
    // SAFETY: as in `secure_wipe_u64`. `Block` is `repr(C)` over `[u64; 128]`
    // with no padding and `size_of::<Block>() == 1024`, so `[Block]` is a
    // contiguous byte range and all-zero is `Block::ZERO`.
    unsafe { secure_wipe_raw(blocks.as_mut_ptr().cast::<u8>(), size_of_val(blocks)) };
}

/// `clear_internal_memory()`: wipe only if wiping is enabled.
///
/// The `zeroize-memory` feature plays the role of `FLAG_clear_internal_memory`,
/// which defaults to 1 in `core.c`; the feature is on by default here too.
#[inline]
pub fn clear_internal_memory(bytes: &mut [u8]) {
    #[cfg(feature = "zeroize-memory")]
    secure_wipe(bytes);
    #[cfg(not(feature = "zeroize-memory"))]
    let _ = bytes;
}

/// [`clear_internal_memory`] over 64-bit words.
#[inline]
pub fn clear_internal_memory_u64(words: &mut [u64]) {
    #[cfg(feature = "zeroize-memory")]
    secure_wipe_u64(words);
    #[cfg(not(feature = "zeroize-memory"))]
    let _ = words;
}

/// [`clear_internal_memory`] over whole blocks.
#[inline]
pub fn clear_internal_memory_blocks(blocks: &mut [Block]) {
    #[cfg(feature = "zeroize-memory")]
    secure_wipe_blocks(blocks);
    #[cfg(not(feature = "zeroize-memory"))]
    let _ = blocks;
}

// ---------------------------------------------------------------------------
// The OS mapping the arena prefers to live in
// ---------------------------------------------------------------------------

/// Anonymous mappings, huge pages, and why this is not a `libc` dependency.
///
/// Four symbols — `mmap`, `munmap`, `madvise` and `sysconf` — declared against
/// the platform C ABI. This is **not** a crate dependency: `std` already links
/// the system libc on every unix target, these four have been in POSIX (or, for
/// `MADV_HUGEPAGE`, in Linux's stable uapi) for decades, and adding the `libc`
/// crate to get the same four declarations would put a mandatory dependency in
/// a cryptographic crate that deliberately has none. The whole module is behind
/// `cfg(all(feature = "std", target_os = "linux"))`; every other target keeps
/// the `alloc_zeroed` path unchanged.
///
/// Linux only, on purpose. The problem being solved is Linux's: glibc `munmap`s
/// an arena this size on `free`, so **every** hash re-faults **every** page.
/// macOS `libmalloc` does not return the pages, so a steady-state macOS process
/// faults zero times per hash and would only lose by swapping a cached
/// allocation for a fresh mapping. Measured there, not assumed — see the
/// aarch64 numbers in the commit that introduced this.
#[cfg(all(feature = "std", target_os = "linux"))]
mod os {
    use core::ffi::c_void;

    unsafe extern "C" {
        fn mmap(
            addr: *mut c_void,
            len: usize,
            prot: i32,
            flags: i32,
            fd: i32,
            offset: i64,
        ) -> *mut c_void;
        fn munmap(addr: *mut c_void, len: usize) -> i32;
        fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32;
        fn sysconf(name: i32) -> isize;
    }

    const PROT_READ: i32 = 1;
    const PROT_WRITE: i32 = 2;
    const MAP_PRIVATE: i32 = 0x0002;
    const MAP_ANONYMOUS: i32 = 0x0020;
    const MAP_FAILED: isize = -1;
    /// `_SC_PAGESIZE`.
    const SC_PAGESIZE: i32 = 30;
    /// `MADV_HUGEPAGE`, `linux/mman.h`.
    const MADV_HUGEPAGE: i32 = 14;

    /// x86-64, aarch64 and every other Linux target this crate builds for use a
    /// 2 MiB transparent huge page.
    pub const HUGE_PAGE: usize = 2 * 1024 * 1024;

    /// Below this the mapping cannot contain a single aligned huge page, and two
    /// syscalls cost more than `malloc` does. Small arenas keep the heap path.
    pub const MMAP_THRESHOLD: usize = HUGE_PAGE;

    /// `sysconf(_SC_PAGESIZE)`, clamped to something sane if the call fails.
    pub fn page_size() -> usize {
        // SAFETY: `sysconf` is a pure query with no pointer arguments.
        let n = unsafe { sysconf(SC_PAGESIZE) };
        if n <= 0 { 4096 } else { n as usize }
    }

    /// A private anonymous mapping of `len` bytes whose base is `align`-aligned.
    ///
    /// Over-maps by `align`, then hands the head and tail slack straight back so
    /// the process's address space and RSS stay honest — `tests/rss_isolation.rs`
    /// asks the kernel, not this crate, whether a hasher grew.
    ///
    /// Returns `(base, len)` for [`unmap`], or `None` if the kernel refused.
    /// `len` is `bytes` rounded up to a page.
    pub fn map_aligned(bytes: usize, align: usize) -> Option<(*mut u8, usize)> {
        let page = page_size();
        let len = bytes.checked_next_multiple_of(page)?;
        let over = len.checked_add(align)?;

        // SAFETY: a null `addr` asks the kernel to choose, which is the only
        // form used here; `fd` is ignored for `MAP_ANONYMOUS`.
        let raw = unsafe {
            mmap(
                core::ptr::null_mut(),
                over,
                PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        if raw as isize == MAP_FAILED || raw.is_null() {
            return None;
        }
        let raw = raw.cast::<u8>();

        // `over == len + align`, so `head < align` and `tail == align - head`;
        // neither subtraction can wrap and the two slack pieces plus `len`
        // exactly cover the mapping.
        let head = (raw as usize).next_multiple_of(align) - raw as usize;
        let tail = align - head;
        // SAFETY: both ranges are inside the mapping just returned, and neither
        // overlaps `[base, base + len)`. Unmapping part of a mapping is
        // explicitly allowed. A failure here would only leak address space.
        unsafe {
            if head != 0 {
                munmap(raw.cast(), head);
            }
            let base = raw.add(head);
            if tail != 0 {
                munmap(base.add(len).cast(), tail);
            }
            Some((base, len))
        }
    }

    /// Ask for transparent huge pages over `[base, base + len)`.
    ///
    /// Returns `true` if the kernel accepted the hint. It is only ever a hint:
    /// with `transparent_hugepage/enabled = never`, or when compaction cannot
    /// produce a free 2 MiB block, the kernel silently uses 4 KiB pages and
    /// everything still works — just at the old speed.
    ///
    /// # Safety
    ///
    /// `[base, base + len)` must be a mapping this process owns.
    pub unsafe fn advise_huge(base: *mut u8, len: usize) -> bool {
        // SAFETY: the caller guarantees the range is a live mapping of ours.
        unsafe { madvise(base.cast(), len, MADV_HUGEPAGE) == 0 }
    }

    /// Release a mapping obtained from [`map_aligned`].
    ///
    /// # Safety
    ///
    /// `(base, len)` must be exactly what [`map_aligned`] returned, and nothing
    /// may reference the region afterwards.
    pub unsafe fn unmap(base: *mut u8, len: usize) {
        // SAFETY: guaranteed by the caller.
        unsafe { munmap(base.cast(), len) };
    }
}

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/// A raw pointer that may cross into a scoped worker.
///
/// The two things [`stripe_over`] does with it — faulting a page in, and
/// `memset`ting a byte range — are both confined to that worker's own stripe,
/// and the stripes are disjoint and whole-page aligned, so no two workers ever
/// touch the same byte or the same page-table entry.
#[cfg(feature = "parallel")]
#[derive(Clone, Copy)]
struct StripeBase(*mut u8);

#[cfg(feature = "parallel")]
impl StripeBase {
    /// The stripe starting `off` bytes in.
    ///
    /// A method rather than `base.0.add(off)` at the use site on purpose: with
    /// edition-2021 disjoint capture, touching the field inside a `move`
    /// closure would capture the bare `*mut u8` — which is not `Send` — instead
    /// of the wrapper that carries the safety argument.
    ///
    /// # Safety
    ///
    /// `off` must be within the region `stripe_over` was given.
    #[inline]
    unsafe fn at(self, off: usize) -> *mut u8 {
        // SAFETY: guaranteed by the caller.
        unsafe { self.0.add(off) }
    }
}

// SAFETY: see the type docs. `stripe_over` is the only constructor and the only
// consumer, and it hands each worker a disjoint sub-range.
#[cfg(feature = "parallel")]
unsafe impl Send for StripeBase {}
// SAFETY: as above — the workers share it only to compute their own disjoint
// offset from it.
#[cfg(feature = "parallel")]
unsafe impl Sync for StripeBase {}

/// Split `[base, base + len)` into at most `workers` contiguous stripes, each a
/// whole number of `unit` bytes, and run `f(stripe, stripe_len)` on each.
///
/// Stripes are claimed from one relaxed counter rather than handed out
/// statically, so a thread the OS refuses to create costs throughput and never
/// correctness: whatever workers do exist between them run every stripe. That
/// matters most for the release wipe, where a skipped stripe would be a region
/// left holding somebody's password material.
///
/// `unit` keeps a stripe boundary off the middle of a page, so two workers can
/// never fault the same page or share a cache line at the seam.
///
/// Its only non-test caller is the `zeroize-memory` arm of
/// [`Arena::wipe_visible`], so without that feature the sole user is
/// `striping_partitions_the_region_exactly` — and in a `no_std`-style build
/// with no features at all, nothing at all.
#[cfg(feature = "parallel")]
#[cfg_attr(not(feature = "zeroize-memory"), allow(dead_code))]
fn stripe_over<F>(base: *mut u8, len: usize, workers: u32, unit: usize, f: F)
where
    F: Fn(*mut u8, usize) + Sync,
{
    use core::sync::atomic::AtomicUsize;

    let workers = workers.max(1) as usize;
    // One stripe per worker, rounded up to a whole `unit`.
    let per = len.div_ceil(workers).next_multiple_of(unit.max(1));
    if workers == 1 || per >= len {
        f(base, len);
        return;
    }
    let stripes = len.div_ceil(per);

    let base = StripeBase(base);
    let next = AtomicUsize::new(0);
    let next = &next;
    let f = &f;

    let run = move || {
        loop {
            // Relaxed: the counter only partitions work. The happens-before the
            // *data* needs comes from `thread::scope` joining every worker.
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= stripes {
                return;
            }
            let off = i * per;
            // SAFETY: `off < len` because `i < stripes = ceil(len / per)`, so
            // the stripe lies inside the caller's region.
            f(unsafe { base.at(off) }, per.min(len - off));
        }
    };

    std::thread::scope(|scope| {
        for _ in 1..workers {
            // `Builder::spawn_scoped` returns an error where `scope.spawn`
            // panics, and this crate must not panic. A refused thread just
            // means the remaining workers claim its stripes.
            let _ = std::thread::Builder::new().spawn_scoped(scope, run);
        }
        run();
    });
}

/// Single-threaded build: one stripe, no scope, no atomics.
///
/// Unused for the same reason as the threaded form above — see its note.
#[cfg(not(feature = "parallel"))]
#[cfg_attr(not(feature = "zeroize-memory"), allow(dead_code))]
#[inline]
fn stripe_over<F>(base: *mut u8, len: usize, _workers: u32, _unit: usize, f: F)
where
    F: Fn(*mut u8, usize),
{
    f(base, len);
}

/// Where an [`Arena`]'s bytes came from, and therefore how to give them back.
enum Backing {
    /// [`alloc_zeroed`] / [`dealloc`], sized by [`Arena::layout`]. The only
    /// backing off Linux, and the fallback on Linux when the arena is too small
    /// to be worth a mapping or `mmap` refuses.
    Heap,
    /// A private anonymous mapping. `(base, len)` is exactly what
    /// `os::map_aligned` returned and exactly what `os::unmap` must be given —
    /// `len` is the arena rounded up to a page, which is `>=` the arena itself.
    #[cfg(all(feature = "std", target_os = "linux"))]
    Mapped {
        base: *mut u8,
        len: usize,
        /// The kernel accepted `MADV_HUGEPAGE`. Surfaced through
        /// [`Arena::backing_name`] and otherwise unused: the arena is correct
        /// either way, and only its speed depends on the answer.
        huge: bool,
    },
}

/// A 64-byte-aligned array of initialised [`Block`]s.
///
/// [`Arena::new`] allocates with [`alloc_zeroed`], so a fresh arena is zeroed.
/// Do **not** replace that with `vec![Block::ZERO; n]`, which memsets one
/// kilobyte at a time.
///
/// [`Drop`] wipes the arena (subject to the `zeroize-memory` feature) and then
/// frees it, matching `free_memory()`.
///
/// # Visible length vs capacity
///
/// [`len`](Arena::len) is the *visible* length — the number of blocks
/// [`as_slice`](Arena::as_slice) and [`as_mut_slice`](Arena::as_mut_slice)
/// expose, and the only region a borrower can reach.
/// [`capacity`](Arena::capacity) is the number of blocks actually allocated.
/// [`Arena::new`] makes them equal; only [`Workspace`] ever makes the capacity
/// larger, when it hands the same allocation to a smaller hash.
///
/// # Invariants
///
/// 1. `len() <= capacity()`, and all `capacity()` blocks are allocated and
///    **initialised** — never `MaybeUninit`. This is what makes the safe slice
///    accessors sound.
/// 2. **With `zeroize-memory` on**, blocks `[len(), capacity())` are all zero.
///    Only [`Workspace`] can open that gap, and the induction is: a fresh
///    allocation is zero throughout; a borrower can only ever reach
///    `[0, len())`; and release wipes exactly `[0, len())`, restoring "all of
///    `capacity()` is zero". This is why [`Drop`] and [`Workspace::release`]
///    wipe only `[0, len())` instead of the whole capacity — an oversized
///    workspace must not make a small hash pay for blocks it never touched.
///
///    Without the feature this does **not** hold, and nothing relies on it:
///    every wipe compiles to nothing, so there is no wipe left to skip.
///    [`ensure_zeroed`](Arena::ensure_zeroed) deliberately covers the whole
///    capacity rather than leaning on this.
/// 3. [`is_known_zeroed`](Arena::is_known_zeroed) is conservative and holds in
///    **every** feature configuration: `true` implies all `capacity()` blocks
///    are zero; `false` implies nothing. This is the invariant that decides
///    whether [`Drop`] may skip its wipe, so it is the security-critical one.
pub struct Arena {
    ptr: NonNull<Block>,
    /// Visible length. See the type-level docs.
    blocks: usize,
    /// Allocated length. Always `>= blocks`.
    capacity: usize,
    /// `true` only when blocks `[0, capacity)` are known to be all zero.
    ///
    /// Established at birth — by `alloc_zeroed`, or by `MAP_ANONYMOUS`, which
    /// the kernel zero-fills — cleared by every accessor that could let a caller
    /// write, and re-established by an actual wipe. Being wrong in the `true`
    /// direction would skip a security wipe, so every mutable accessor clears it
    /// unconditionally rather than trying to be clever.
    zeroed: bool,
    /// Threads the release wipe may use. Never affects the tag.
    workers: u32,
    backing: Backing,
}

// SAFETY: `Arena` uniquely owns a heap allocation with no thread affinity, and
// exposes no shared-mutability API, so moving it between threads is sound.
// Deliberately not `Sync`: concurrent lane writes go through raw pointers and
// need `core`'s own safety argument.
unsafe impl Send for Arena {}

impl Arena {
    /// Validate the size without allocating anything.
    ///
    /// Workspace growth calls this before releasing its existing arena, so a
    /// request that can never have a valid allocation cannot destroy usable
    /// memory already paid for by the caller.
    fn checked_layout(blocks: usize) -> Result<(usize, Layout), Error> {
        if blocks == 0 {
            return Err(Error::MemoryAllocationError);
        }

        // Mirrors the multiplication-overflow check in `allocate_memory()`.
        let bytes = blocks
            .checked_mul(size_of::<Block>())
            .ok_or(Error::MemoryAllocationError)?;
        let layout = Layout::from_size_align(bytes, ARENA_ALIGN)
            .map_err(|_| Error::MemoryAllocationError)?;
        Ok((bytes, layout))
    }

    /// Allocate `blocks` zeroed blocks. `capacity() == len() == blocks`.
    ///
    /// # Errors
    ///
    /// [`Error::MemoryAllocationError`] if `blocks` is 0, if
    /// `blocks * size_of::<Block>()` overflows, if the layout is invalid, or if
    /// the allocator returns null. The C reference reports the same code for
    /// all of these (`ARGON2_MEMORY_ALLOCATION_ERROR`).
    pub fn new(blocks: usize) -> Result<Arena, Error> {
        let (_bytes, layout) = Arena::checked_layout(blocks)?;

        // Preferred path: a 2 MiB-aligned anonymous mapping with huge pages
        // asked for. Falls through to the heap for arenas too small to hold an
        // aligned huge page, and if the kernel refuses the mapping.
        #[cfg(all(feature = "std", target_os = "linux"))]
        if _bytes >= os::MMAP_THRESHOLD
            && let Some((base, len)) = os::map_aligned(_bytes, os::HUGE_PAGE)
        {
            // SAFETY: `(base, len)` is the mapping `map_aligned` just made.
            let huge = unsafe { os::advise_huge(base, len) };
            debug_assert_eq!(base as usize % ARENA_ALIGN, 0, "page-aligned implies 64");
            return Ok(Arena {
                // SAFETY: `map_aligned` returns a non-null base on `Some`, and
                // it is 2 MiB-aligned, hence `Block`-aligned.
                ptr: unsafe { NonNull::new_unchecked(base.cast::<Block>()) },
                blocks,
                capacity: blocks,
                // MAP_ANONYMOUS is zero-filled by the kernel. This is a POSIX
                // guarantee about the *contents*, so it establishes both
                // invariant 1 (initialised) and invariant 3 (zero) without a
                // single store — which is the whole reason the arena is a
                // mapping rather than an `alloc`.
                zeroed: true,
                workers: 1,
                backing: Backing::Mapped { base, len, huge },
            });
        }

        // SAFETY: `layout` has a non-zero size (blocks >= 1 and
        // size_of::<Block>() == 1024).
        let raw = unsafe { alloc_zeroed(layout) };

        let ptr = NonNull::new(raw.cast::<Block>()).ok_or(Error::MemoryAllocationError)?;

        Ok(Arena {
            ptr,
            blocks,
            capacity: blocks,
            // `alloc_zeroed` established invariant 3.
            zeroed: true,
            workers: 1,
            backing: Backing::Heap,
        })
    }

    /// Threads the release wipe may use.
    ///
    /// Defaults to 1. The wipe cannot affect the tag, so this is purely a
    /// throughput knob; it comes from `params.threads()` — the caller's stated
    /// OS-thread budget — rather than from `effective_threads()`, because
    /// `min(threads, lanes)` is the *algorithmic* parallelism and has nothing to
    /// do with how many threads may `memset`.
    #[inline]
    pub fn set_workers(&mut self, workers: u32) {
        self.workers = workers.max(1);
    }

    /// Number of blocks a borrower can see. See the type-level docs.
    #[inline]
    #[must_use]
    pub fn len(&self) -> usize {
        self.blocks
    }

    /// Always `false`: [`Arena::new`] rejects a zero-block request and
    /// [`Workspace::acquire`] does too.
    #[inline]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.blocks == 0
    }

    /// Number of blocks actually allocated, `>= len()`.
    #[inline]
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Whether all [`capacity`](Arena::capacity) blocks are known to be zero.
    ///
    /// Conservative in the safe direction: `true` guarantees the arena is
    /// zero, `false` guarantees nothing. Handing out any mutable access clears
    /// it, so this reads `false` for the whole life of a hash.
    #[inline]
    #[must_use]
    pub fn is_known_zeroed(&self) -> bool {
        self.zeroed
    }

    /// Pointer to block 0.
    #[inline]
    #[must_use]
    pub fn as_ptr(&self) -> *const Block {
        self.ptr.as_ptr()
    }

    /// Mutable pointer to block 0. This is what [`crate::block::Instance`] holds.
    ///
    /// Clears [`is_known_zeroed`](Arena::is_known_zeroed): whatever the caller
    /// does with the pointer, the arena must be treated as dirty afterwards.
    #[inline]
    #[must_use]
    pub fn as_mut_ptr(&mut self) -> *mut Block {
        self.zeroed = false;
        self.ptr.as_ptr()
    }

    /// The visible arena as a slice.
    #[inline]
    #[must_use]
    pub fn as_slice(&self) -> &[Block] {
        // SAFETY: invariant 1 — `ptr` is a live allocation of `capacity >=
        // blocks` initialised `Block`s — and `&self` guarantees no concurrent
        // mutation.
        unsafe { core::slice::from_raw_parts(self.ptr.as_ptr(), self.blocks) }
    }

    /// The visible arena as a mutable slice. This is the Miri-checkable access
    /// path; the single-threaded fill loop should prefer it over raw pointers.
    ///
    /// Clears [`is_known_zeroed`](Arena::is_known_zeroed).
    #[inline]
    #[must_use]
    pub fn as_mut_slice(&mut self) -> &mut [Block] {
        self.zeroed = false;
        // SAFETY: as in `as_slice`, and `&mut self` guarantees exclusivity.
        unsafe { core::slice::from_raw_parts_mut(self.ptr.as_ptr(), self.blocks) }
    }

    /// Zero the arena unless it is already known to be zero.
    ///
    /// A plain `memset`, **not** a secure wipe: this establishes zero for a new
    /// borrower, it does not destroy a previous borrower's secrets. That job
    /// belongs to [`Workspace::release`], which runs first.
    ///
    /// Free (a predictable branch, no stores) in the default build, where
    /// release already wiped. With `zeroize-memory` off it costs one `memset`,
    /// which is the price of asking for a guarantee the feature was turned off
    /// to avoid paying for.
    ///
    /// Covers the whole [`capacity`](Arena::capacity), not just the visible
    /// window, because it is what establishes
    /// [`is_known_zeroed`](Arena::is_known_zeroed) and that flag is a claim
    /// about the whole capacity. Zeroing only `[0, len())` here would be a
    /// silent lie the moment a later, wider acquisition exposed the tail: with
    /// `zeroize-memory` off, invariant 2 does not hold on its own, so this
    /// cannot lean on it.
    pub fn ensure_zeroed(&mut self) {
        if self.zeroed {
            return;
        }
        // SAFETY: invariant 1 — `ptr` is valid for writes of `capacity`
        // `Block`s — and `&mut self` makes the write exclusive. `Block` is
        // `Copy` with no padding-sensitive invariant, so all-zero is a valid
        // bit pattern (`Block::ZERO`).
        unsafe { core::ptr::write_bytes(self.ptr.as_ptr(), 0, self.capacity) };
        self.zeroed = true;
    }

    /// Secure-wipe the visible blocks and re-establish invariant 3.
    ///
    /// Only `[0, len())` is wiped: `[len(), capacity())` is already zero by
    /// invariant 2, and it is the borrower's window that holds the secrets.
    ///
    /// Threaded above [`WIPE_THREAD_THRESHOLD`], where the measured 23.7 GiB/s
    /// of a single-threaded `memset` stops being enough: 256 MiB goes 10.6 →
    /// 5.3 ms on two stripes. Below it, threading loses to the ~60 us of
    /// spawning (64 MiB measured 2.62 → 2.58 ms, i.e. nothing).
    ///
    /// The flag is only claimed when the feature actually did something — the
    /// wipe compiles to nothing without `zeroize-memory`, and claiming `zeroed`
    /// after a no-op would let a later [`Drop`] skip a real wipe.
    fn wipe_visible(&mut self) {
        #[cfg(feature = "zeroize-memory")]
        {
            let bytes = self.blocks * size_of::<Block>();
            let workers = if bytes >= WIPE_THREAD_THRESHOLD {
                self.workers
            } else {
                1
            };
            // SAFETY (inside the closure): `stripe_over` hands out disjoint
            // sub-ranges of `[ptr, ptr + bytes)`, which invariant 1 says is a
            // live allocation of `capacity >= blocks` blocks, and `&mut self`
            // makes the whole region exclusively ours for the call.
            stripe_over(
                self.ptr.as_ptr().cast::<u8>(),
                bytes,
                workers,
                ARENA_ALIGN,
                // SAFETY: see the comment above the call.
                |chunk, chunk_len| unsafe { secure_wipe_raw(chunk, chunk_len) },
            );
        }
        self.zeroed |= WIPE_ENABLED;
    }

    /// Shrink or restore the visible length within the existing allocation.
    ///
    /// Returns `false` and changes nothing when `blocks > capacity`. Private:
    /// invariant 2 only survives because [`Workspace`] is the sole caller and
    /// only ever retargets onto a region it knows to be zero.
    fn retarget(&mut self, blocks: usize) -> bool {
        if blocks > self.capacity {
            return false;
        }
        self.blocks = blocks;
        true
    }

    /// `"heap"`, `"mapped"` or `"mapped+huge"` — which [`Backing`] this arena
    /// got, and whether the kernel granted transparent huge pages.
    ///
    /// Diagnostic, and the honest way for a test to say "the global allocator
    /// cannot see this one" instead of quietly asserting nothing.
    #[inline]
    #[must_use]
    pub fn backing_name(&self) -> &'static str {
        match self.backing {
            Backing::Heap => "heap",
            #[cfg(all(feature = "std", target_os = "linux"))]
            Backing::Mapped { huge: true, .. } => "mapped+huge",
            #[cfg(all(feature = "std", target_os = "linux"))]
            Backing::Mapped { huge: false, .. } => "mapped",
        }
    }

    /// The layout the arena was allocated with, needed to free it.
    ///
    /// Sized from `capacity`, not the visible `blocks` — freeing with the wrong
    /// layout would be undefined behaviour.
    #[inline]
    fn layout(&self) -> Layout {
        // `Arena::new` already validated this exact size/align pair, and
        // `capacity` has not changed since.
        match Layout::from_size_align(self.capacity * size_of::<Block>(), ARENA_ALIGN) {
            Ok(layout) => layout,
            // Unreachable: `new` succeeded with the same arguments.
            Err(_) => Layout::new::<Block>(),
        }
    }
}

impl Drop for Arena {
    fn drop(&mut self) {
        // Skip the wipe only when the arena is *known* zero — a workspace
        // release, or an arena that was never handed out. Everything else pays
        // for it, exactly as before the reuse layer existed.
        if !self.zeroed {
            // Never spawn while unwinding: a panic escaping a scoped thread
            // during a panic is an abort, and a slower wipe is a far better
            // outcome than losing the original error.
            #[cfg(feature = "parallel")]
            if std::thread::panicking() {
                self.workers = 1;
            }
            self.wipe_visible();
        }

        // The test-only observation point for "an arena's memory was released,
        // and it was clean when it was". `tests/allocation_audit.rs` used to
        // infer this from global-allocator traffic, which stopped working the
        // moment the arena became a mapping — and would have gone silently
        // green rather than failing, which is the worst way for a security
        // check to break.
        #[cfg(all(feature = "internal-api", feature = "std"))]
        audit::note_release(self.ptr.as_ptr().cast::<u8>(), self.capacity);

        match self.backing {
            Backing::Heap => {
                let layout = self.layout();
                // SAFETY: `ptr` came from `alloc_zeroed` with this exact layout
                // (`capacity` blocks, `ARENA_ALIGN`) and has not been freed yet
                // (`Drop` runs once).
                unsafe { dealloc(self.ptr.as_ptr().cast::<u8>(), layout) };
            }
            #[cfg(all(feature = "std", target_os = "linux"))]
            Backing::Mapped { base, len, .. } => {
                // SAFETY: `(base, len)` is verbatim what `os::map_aligned`
                // returned for this arena, and `Drop` runs once.
                unsafe { os::unmap(base, len) };
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Release observation (test-only)
// ---------------------------------------------------------------------------

/// The release-path observation point `tests/allocation_audit.rs` needs.
///
/// The arena used to come from the global allocator, so a `GlobalAlloc` spy
/// could watch it being handed back and check it was clean. On Linux it is an
/// anonymous mapping now, and a spy on the allocator sees nothing at all — so
/// the check has to happen where the release happens. This is strictly more
/// direct than the spy was: it looks at *the arena*, rather than at "an
/// allocation whose size and alignment match an arena".
///
/// Thread-local for the same reason the spy was: `cargo test` runs a binary's
/// tests concurrently in one process, and several of them free arenas of the
/// same size. Compiled out entirely without `internal-api`.
#[cfg(all(feature = "internal-api", feature = "std"))]
pub mod audit {
    use core::cell::Cell;

    use crate::block::Block;

    std::thread_local! {
        /// Block count this thread is watching for, or 0 when it is off.
        static WATCH: Cell<usize> = const { Cell::new(0) };
        /// Matching arenas released on this thread while armed.
        static RELEASED: Cell<usize> = const { Cell::new(0) };
        /// How many of those still held a non-zero byte at release.
        static RELEASED_DIRTY: Cell<usize> = const { Cell::new(0) };
    }

    /// Watch this thread for arenas of `blocks` blocks, resetting the counters.
    /// `blocks == 0` turns the watch off.
    pub fn watch(blocks: usize) {
        WATCH.with(|c| c.set(blocks));
        RELEASED.with(|c| c.set(0));
        RELEASED_DIRTY.with(|c| c.set(0));
    }

    /// Matching arenas released on this thread since [`watch`].
    #[must_use]
    pub fn released() -> usize {
        RELEASED.with(Cell::get)
    }

    /// How many of those were still dirty. Must be 0 with `zeroize-memory` on.
    #[must_use]
    pub fn released_dirty() -> usize {
        RELEASED_DIRTY.with(Cell::get)
    }

    /// The exact predicate `note_release` applies, on a live arena.
    ///
    /// Exposed so a test can control the *predicate* separately from the
    /// *plumbing*: `released() == 1` proves `Arena::drop` calls the hook, and
    /// this proves the hook would have noticed had the arena been dirty. A
    /// green wipe test needs both, or it cannot tell "the wipe ran" from "the
    /// check never looked" — which is exactly how the allocator spy this
    /// replaces once silently stopped controlling anything.
    #[must_use]
    pub fn is_dirty(arena: &super::Arena) -> bool {
        arena.as_slice().iter().any(|b| *b != Block::ZERO)
    }

    /// Called from `Arena::drop`, after any wipe and before the memory goes.
    pub(crate) fn note_release(ptr: *mut u8, blocks: usize) {
        if WATCH.try_with(Cell::get) != Ok(blocks) || blocks == 0 {
            return;
        }
        RELEASED.with(|c| c.set(c.get() + 1));
        // SAFETY: `Arena`'s invariant 1 — `ptr` is a live allocation of
        // `capacity` initialised `Block`s — still holds here: `Drop` has not
        // released anything yet, and `&mut self` means nothing else can touch
        // it. `[Block]` is a contiguous, padding-free byte range.
        let bytes = unsafe { core::slice::from_raw_parts(ptr, blocks * size_of::<Block>()) };
        if bytes.iter().any(|b| *b != 0) {
            RELEASED_DIRTY.with(|c| c.set(c.get() + 1));
        }
    }
}

impl core::fmt::Debug for Arena {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Arena")
            .field("ptr", &self.ptr.as_ptr())
            .field("blocks", &self.blocks)
            .field("capacity", &self.capacity)
            .field("zeroed", &self.zeroed)
            .field("backing", &self.backing_name())
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/// Scratch memory one hashing worker reuses across many hashes.
///
/// Holds at most one parked [`Arena`], plus — with the non-default
/// `bump-alloc` feature — one reusable `bumpalo::Bump` for small, short-lived buffers.
/// A server hashing passwords at fixed parameters keeps one `Workspace` per
/// worker thread and pays the allocator, and the zeroing memset, once instead
/// of once per request.
///
/// ```
/// use argon2_rust::__internal::Workspace;
///
/// let mut ws = Workspace::new();
/// let first = ws.acquire(64).expect("64 blocks").as_ptr();
/// let second = ws.acquire(64).expect("reused").as_ptr();
/// assert_eq!(first, second); // same allocation, no allocator traffic
/// ```
///
/// It is [`Send`], so a worker can carry one:
///
/// ```
/// # use argon2_rust::__internal::Workspace;
/// fn needs_send<T: Send>(_: T) {}
/// needs_send(Workspace::new());
/// ```
///
/// It is **not** [`Sync`], and this must not compile — see *Threading* below:
///
/// ```compile_fail
/// # use argon2_rust::__internal::Workspace;
/// fn needs_sync<T: Sync>(_: &T) {}
/// needs_sync(&Workspace::new());
/// ```
///
/// # What reuse buys, and what it does not
///
/// It removes the `mmap`, **every first-touch page fault over the arena**, and
/// the `munmap`. Measured on Linux/x86-64, interleaved against the one-shot
/// API, 15 paired rounds: **-23.3% at 256 MiB `p=1`, -34.0% at 64 MiB `p=4`**,
/// falling to -0.7% at `m_cost = 8 KiB` where a hash is mostly BLAKE2b.
///
/// It does **not** remove allocator calls — there was only ever one per hash,
/// and at 1 GiB it was 1.7 us of 306 ms. That was never the prize; the
/// paragraph that used to say reuse was worth "one memset, 1.4-5.1%" was
/// measured on macOS, where `libmalloc` keeps the pages and a steady-state
/// process really does fault zero times per hash. On Linux it faults the whole
/// arena, every hash, which is what the numbers above are made of.
///
/// It does **not** remove the security wipe: a reused arena is still wiped,
/// just at release instead of at release-and-free.
///
/// # Zeroing guarantee
///
/// With `zeroize-memory` on — the default — [`acquire`](Workspace::acquire)
/// **always** returns an all-zero arena, because release wiped it. With the
/// feature off, an arena that has been used before comes back holding the
/// previous hash's derived material; it is still initialised, so every safe
/// accessor stays sound, and Argon2 overwrites all of it in pass 0 before
/// reading any of it. Callers that need zero regardless should call
/// [`Arena::ensure_zeroed`], which is a no-op in the default build.
///
/// # Threading
///
/// `Workspace` is [`Send`] but not [`Sync`], so it can move between threads but
/// not be shared. That is deliberate and it is what keeps the design compatible
/// with the parallel fill: `bumpalo::Bump` is `!Sync`, and the multi-lane fill shares
/// the *arena* across [`std::thread::scope`] workers by raw pointer while the
/// bump is never touched at all. One workspace per worker, never one workspace
/// across workers.
pub struct Workspace {
    /// The parked arena. `None` before the first acquisition, while one is on
    /// loan, and after [`Workspace::clear`].
    ///
    /// While parked its blocks `[0, capacity)` are all zero, provided
    /// `zeroize-memory` is on.
    arena: Option<Arena>,

    /// A bump allocator for buffers that die inside one call.
    ///
    /// Deliberately *reused*, never constructed per call. See
    /// [`Workspace::bump`] for the measurement; the short version is that a
    /// fresh `Bump::new()` costs 18.5 ns before it serves anything, which is
    /// more than the entire `Vec` it would replace.
    #[cfg(feature = "bump-alloc")]
    bump: Bump,
}

impl Workspace {
    /// An empty workspace. Allocates nothing at all.
    ///
    /// The first [`acquire`](Workspace::acquire) allocates the arena; use
    /// [`Workspace::with_capacity`] to front-load that instead.
    ///
    /// Cannot panic even with `bump-alloc` on: `Bump::new()` is
    /// `try_with_capacity(0)`, which returns `Ok` before it touches the
    /// allocator (bumpalo 3.20.3, `src/lib.rs:810-825`), so the `oom()` arm is
    /// unreachable.
    #[must_use]
    pub fn new() -> Workspace {
        Workspace {
            arena: None,
            #[cfg(feature = "bump-alloc")]
            bump: Bump::new(),
        }
    }

    /// A workspace with room for `blocks` blocks already allocated.
    ///
    /// # Errors
    ///
    /// Whatever [`Arena::new`] returns. `blocks == 0` is *not* an error here —
    /// it just yields an empty workspace, since reserving nothing is a no-op.
    pub fn with_capacity(blocks: usize) -> Result<Workspace, Error> {
        let mut workspace = Workspace::new();
        workspace.reserve(blocks)?;
        Ok(workspace)
    }

    /// Blocks the parked arena can hold, or 0 when nothing is parked.
    ///
    /// Reads 0 while an arena is on loan — the capacity travels with the
    /// [`ArenaGuard`].
    #[inline]
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.arena.as_ref().map_or(0, Arena::capacity)
    }

    /// Make sure the parked arena can hold `blocks` blocks, allocating if not.
    ///
    /// Growing **frees the old arena before allocating the new one**, so peak
    /// resident memory stays at one arena rather than two — at `m_cost = 1 GiB`
    /// the difference is 1 GiB of RSS. A size that cannot form a valid allocation
    /// is rejected before the old arena is released. An actual allocator failure
    /// happens after release and therefore leaves the workspace empty; it remains
    /// usable, and the next acquisition allocates fresh.
    ///
    /// # Errors
    ///
    /// Whatever [`Arena::new`] returns.
    pub fn reserve(&mut self, blocks: usize) -> Result<(), Error> {
        if blocks == 0 || self.capacity() >= blocks {
            return Ok(());
        }
        // Validation needs no memory. Do it while the existing arena is still
        // parked; only a request that could genuinely allocate may release it.
        Arena::checked_layout(blocks)?;
        // Free first, then allocate. `Drop` wipes if the arena is not already
        // known zero, so this cannot leak the previous tenant.
        self.arena = None;
        self.arena = Some(Arena::new(blocks)?);
        Ok(())
    }

    /// Borrow an arena of `blocks` blocks, returning it to the workspace on
    /// drop.
    ///
    /// No allocator traffic when the parked arena is already big enough, which
    /// is the whole point. See [`Workspace::reserve`] for what growth costs.
    ///
    /// The guard borrows the workspace, so the bump allocator is unreachable while an
    /// arena is out. That is not a limitation in practice: hashing finishes
    /// before encoding starts. If you need both at once, use
    /// [`Workspace::acquire_owned`] plus [`Workspace::release`].
    ///
    /// # Errors
    ///
    /// [`Error::MemoryAllocationError`] if `blocks` is 0 or the arena could not
    /// be allocated.
    pub fn acquire(&mut self, blocks: usize) -> Result<ArenaGuard<'_>, Error> {
        let arena = self.acquire_owned(blocks)?;
        Ok(ArenaGuard {
            arena: ManuallyDrop::new(arena),
            workspace: self,
        })
    }

    /// [`acquire`](Workspace::acquire) without the guard: the caller owns the
    /// [`Arena`] and must hand it back with [`Workspace::release`].
    ///
    /// Forgetting to release is safe and secure — the arena's own [`Drop`]
    /// wipes and frees it — it just forfeits the reuse. Prefer
    /// [`Workspace::acquire`], which cannot forget, including on the `?` early
    /// returns that a hash is full of.
    ///
    /// # Errors
    ///
    /// [`Error::MemoryAllocationError`] if `blocks` is 0 or the arena could not
    /// be allocated.
    pub fn acquire_owned(&mut self, blocks: usize) -> Result<Arena, Error> {
        if blocks == 0 {
            return Err(Error::MemoryAllocationError);
        }
        if self.capacity() < blocks {
            // As in `reserve`, reject deterministic size/layout failures before
            // `take()` can remove the parked arena.
            Arena::checked_layout(blocks)?;
        }
        match self.arena.take() {
            // Big enough: retarget the visible window and hand it over. No
            // allocator call, and no zeroing — invariant 2 says everything
            // outside the new window is zero, and the release wipe left
            // everything inside it zero too.
            Some(mut arena) if arena.capacity() >= blocks => {
                let fits = arena.retarget(blocks);
                debug_assert!(fits, "capacity was just checked");
                Ok(arena)
            }
            // Too small: free before allocating, as documented on `reserve`.
            Some(arena) => {
                drop(arena);
                Arena::new(blocks)
            }
            None => Arena::new(blocks),
        }
    }

    /// Wipe `arena` and park it for the next acquisition.
    ///
    /// The wipe is `Arena::wipe_visible`, gated on `zeroize-memory` exactly as
    /// [`Arena`]'s own [`Drop`] is. It stripes large arenas across the permitted
    /// worker count and applies [`secure_wipe_raw`] to every stripe; smaller
    /// arenas use one stripe. It covers the visible blocks, precisely the
    /// window the borrower could reach.
    ///
    /// If an arena is already parked, the **larger** of the two is kept and the
    /// other is freed, so a workspace never shrinks under a mixed workload.
    pub fn release(&mut self, mut arena: Arena) {
        arena.wipe_visible();

        let keep_parked = self
            .arena
            .as_ref()
            .is_some_and(|parked| parked.capacity() >= arena.capacity());

        if !keep_parked {
            // Drops (wipes if needed, frees) whatever was parked before.
            self.arena = Some(arena);
        }
        // Otherwise `arena` drops here. It was just wiped, so its `Drop` skips
        // straight to `dealloc`.
    }

    /// Return every byte this workspace holds, back to [`Workspace::new`].
    ///
    /// The arena is wiped on the way out unless it is already known to be zero,
    /// and the bump's scratch is wiped before its chunks are freed. Unlike
    /// [`reset_bump`](Workspace::reset_bump), which deliberately keeps its
    /// largest chunk so the next hash can reuse it, this keeps nothing — it is
    /// for a worker going idle, not for the per-hash path.
    pub fn clear(&mut self) {
        self.arena = None;
        #[cfg(feature = "bump-alloc")]
        {
            // Wipe first, then drop the chunks by replacing the whole `Bump`.
            self.reset_bump();
            self.bump = Bump::new();
        }
    }

    /// The reusable bump allocator, for buffers that do not outlive the call.
    ///
    /// # Use `try_alloc_*`, never `alloc_*`
    ///
    /// bumpalo's infallible `alloc_*` methods abort the process on allocation
    /// failure. This crate guarantees that nothing reachable from its safe
    /// public API panics, so only the `try_alloc_*` family is admissible here.
    ///
    /// # Is it worth it? Measured, and barely
    ///
    /// One hash's worth of small scratch is three buffers — 98 B to encode,
    /// 51 B + 33 B to decode — allocated, used and dropped inside the call.
    /// Marginal cost of all three on this host (interleaved A/B, min of 400
    /// rounds x 4096 iterations, empty-loop control subtracted):
    ///
    /// ```text
    ///   3x Vec::try_reserve + resize            24.30 ns
    ///   3x this bump + reset_bump (wiped)        7.34 ns    -17.0 ns
    ///   3x bumpalo + bare reset (no wipe)        3.43 ns    -20.9 ns
    ///   3x on a FRESH Bump::new per call        16.07 ns     -8.2 ns
    /// ```
    ///
    /// Two things to read off that table. First, the win is real but tiny:
    /// 17 ns against a hash that starts at 10.75 us and is normally 12.7 ms —
    /// 0.16% of the smallest Argon2 hash that exists, 0.00013% of an RFC 9106
    /// one, four orders of magnitude below this machine's run-to-run noise.
    /// **Do not restructure anything for it.**
    ///
    /// Second, the wipe in [`reset_bump`](Workspace::reset_bump) costs 3.9 ns
    /// of the 20.9 available, and only because it uses word-wide stores; a
    /// naive per-byte volatile wipe measured 46.7 ns and turned the whole thing
    /// into a net *loss* against `Vec`. That is why
    /// [`secure_wipe_raw`] exists.
    ///
    /// A fresh `Bump::new()` per call still beats three `Vec`s here, because
    /// its one chunk allocation amortises over three buffers — but it loses to
    /// a single `Vec` (18.5 ns against 9.0 ns) and to this reused bump by 2.2x.
    /// Reuse is the only shape worth shipping.
    #[cfg(feature = "bump-alloc")]
    #[inline]
    #[must_use]
    pub fn bump(&self) -> &Bump {
        &self.bump
    }

    /// Bytes of chunk memory the bump is holding on to, footers excluded.
    ///
    /// This is `Bump::allocated_bytes`, whose name is easy to misread: it is
    /// *reserved* capacity, not bytes currently handed out.
    /// [`reset_bump`](Workspace::reset_bump) leaves it unchanged — retaining
    /// the chunk is the entire point — while [`clear`](Workspace::clear) puts
    /// it back to zero. Diagnostic only.
    #[cfg(feature = "bump-alloc")]
    #[inline]
    #[must_use]
    pub fn bump_reserved_bytes(&self) -> usize {
        self.bump.allocated_bytes()
    }

    /// Reclaim every bump allocation, keeping the largest chunk for next time.
    ///
    /// Call this once per hash, not once per buffer. With `zeroize-memory` on,
    /// the used region of every chunk is securely wiped first, so bump scratch
    /// gets the same treatment as the arena.
    #[cfg(feature = "bump-alloc")]
    pub fn reset_bump(&mut self) {
        #[cfg(feature = "zeroize-memory")]
        {
            // SAFETY: `iter_allocated_chunks_raw` requires that no allocation
            // happens while the iterator is live and that no mutable reference
            // into previously allocated data exists. `&mut self` gives both:
            // every reference bumpalo hands out borrows the `Bump`, so an
            // exclusive borrow of the workspace proves none is live, and the
            // loop body only writes through the raw pointer — it never reads
            // the chunk, never forms a reference into it, and never allocates.
            // Each `(ptr, len)` covers exactly the `len` handed-out, therefore
            // initialised, bytes of that chunk — bumpalo bumps downward, so the
            // pair runs from the current bump finger up to the chunk footer.
            unsafe {
                for (chunk, len) in self.bump.iter_allocated_chunks_raw() {
                    secure_wipe_raw(chunk, len);
                }
            }
        }
        self.bump.reset();
    }
}

impl Default for Workspace {
    fn default() -> Workspace {
        Workspace::new()
    }
}

impl core::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let mut out = f.debug_struct("Workspace");
        out.field("arena", &self.arena);
        #[cfg(feature = "bump-alloc")]
        out.field("bump_reserved_bytes", &self.bump.allocated_bytes());
        out.finish()
    }
}

// ---------------------------------------------------------------------------
// ArenaGuard
// ---------------------------------------------------------------------------

/// An [`Arena`] on loan from a [`Workspace`], returned when the guard drops.
///
/// Derefs to [`Arena`], so it is a drop-in for one: `guard.as_mut_slice()`,
/// `guard.as_mut_ptr()` and `guard.len()` all work.
///
/// Release happens in [`Drop`], so it also happens on the `?` early returns and
/// on unwind. The only way to skip it is [`core::mem::forget`], which leaks the
/// allocation without wiping it — the same caveat that has always applied to
/// forgetting an [`Arena`].
pub struct ArenaGuard<'w> {
    /// `ManuallyDrop` because [`Drop`] moves the arena out to release it,
    /// rather than letting `Arena::drop` free it.
    arena: ManuallyDrop<Arena>,
    workspace: &'w mut Workspace,
}

impl Deref for ArenaGuard<'_> {
    type Target = Arena;

    #[inline]
    fn deref(&self) -> &Arena {
        &self.arena
    }
}

impl DerefMut for ArenaGuard<'_> {
    #[inline]
    fn deref_mut(&mut self) -> &mut Arena {
        &mut self.arena
    }
}

impl Drop for ArenaGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: `Drop::drop` runs at most once, and `self.arena` is never
        // read again afterwards — the guard itself is being destroyed and the
        // field is private, so no other code can observe the moved-out
        // `ManuallyDrop`.
        let arena = unsafe { ManuallyDrop::take(&mut self.arena) };
        self.workspace.release(arena);
    }
}

impl core::fmt::Debug for ArenaGuard<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ArenaGuard")
            .field("arena", &*self.arena)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the bump wipe test needs an owned copy of the scratch bytes.
    #[cfg(all(feature = "bump-alloc", feature = "zeroize-memory"))]
    use alloc::vec::Vec;

    /// All `capacity` blocks, including the ones outside the visible window.
    ///
    /// Only invariant 2 makes this meaningful, and only the wipe tests need it.
    #[cfg(feature = "zeroize-memory")]
    fn whole_capacity(arena: &Arena) -> &[Block] {
        // SAFETY: invariant 1 — `capacity` initialised blocks are live — and
        // `&Arena` rules out concurrent mutation.
        unsafe { core::slice::from_raw_parts(arena.as_ptr(), arena.capacity()) }
    }

    fn is_all_zero(blocks: &[Block]) -> bool {
        blocks.iter().all(|b| *b == Block::ZERO)
    }

    // -----------------------------------------------------------------------
    // Arena — unchanged behaviour
    // -----------------------------------------------------------------------

    #[test]
    fn arena_is_zeroed_and_aligned() {
        let arena = Arena::new(16).expect("16 blocks");
        assert_eq!(arena.len(), 16);
        assert_eq!(arena.capacity(), 16);
        assert_eq!(arena.as_ptr() as usize % ARENA_ALIGN, 0);
        assert!(arena.as_slice().iter().all(|b| *b == Block::ZERO));
    }

    #[test]
    fn arena_rejects_zero_and_overflow() {
        assert!(matches!(
            Arena::new(0).err(),
            Some(Error::MemoryAllocationError)
        ));
        assert!(matches!(
            Arena::new(usize::MAX / 512).err(),
            Some(Error::MemoryAllocationError)
        ));
    }

    #[test]
    fn arena_is_writable_through_the_slice() {
        let mut arena = Arena::new(4).expect("4 blocks");
        arena.as_mut_slice()[3].fill(0xCD);
        assert_eq!(arena.as_slice()[3].0[0], u64::from_ne_bytes([0xCD; 8]));
        assert_eq!(arena.as_slice()[2], Block::ZERO);
    }

    #[test]
    fn wipe_zeroes_everything() {
        let mut bytes = [0xAAu8; 64];
        secure_wipe(&mut bytes);
        assert_eq!(bytes, [0u8; 64]);

        let mut words = [0xDEAD_BEEFu64; 8];
        secure_wipe_u64(&mut words);
        assert_eq!(words, [0u64; 8]);

        let mut blocks = [Block::ZERO; 2];
        blocks[1].fill(0xFF);
        secure_wipe_blocks(&mut blocks);
        assert_eq!(blocks[1], Block::ZERO);
    }

    /// Sweep every start alignment and length through `secure_wipe_raw`, and
    /// check the *neighbours* too. Both the bulk-zero implementation and the
    /// byte-volatile fallback take an arbitrary pointer/length pair; an
    /// over-wipe is as much a bug as an under-wipe, and only the neighbour check
    /// can catch it.
    #[test]
    fn secure_wipe_raw_covers_exactly_the_requested_region() {
        const N: usize = 64;
        for start in 0..16usize {
            for len in 0..=(N - 16) {
                let mut buf = [0xA5u8; N];
                // SAFETY: `start + len <= 16 + 48 == N`, so the region lies
                // inside `buf`, and `&mut buf` makes the write exclusive.
                unsafe { secure_wipe_raw(buf.as_mut_ptr().add(start), len) };

                for (i, byte) in buf.iter().enumerate() {
                    let inside = i >= start && i < start + len;
                    assert_eq!(
                        *byte == 0,
                        inside,
                        "byte {i} wrong for start={start} len={len}: {byte:#04x}"
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // The OS backing
    // -----------------------------------------------------------------------

    /// An arena big enough to be a mapping has to satisfy every invariant a
    /// heap one does — zero, aligned, writable, and freed without complaint.
    ///
    /// 4 MiB is deliberately over `os::MMAP_THRESHOLD`, so on Linux this is the
    /// `mmap` + `MADV_HUGEPAGE` path and nowhere else in the suite goes near it
    /// with a check this direct.
    #[test]
    fn a_mapping_sized_arena_is_zero_aligned_and_writable() {
        const N: usize = 4096; // 4 MiB

        let mut arena = Arena::new(N).expect("4 MiB arena");
        assert_eq!(arena.len(), N);
        assert_eq!(arena.as_ptr() as usize % ARENA_ALIGN, 0);
        assert!(
            is_all_zero(arena.as_slice()),
            "a fresh arena must be zero on every backing — MAP_ANONYMOUS is \
             what makes that true without a single store"
        );

        // Writable end to end, and the two ends are what a bad alignment or a
        // mis-sized mapping would corrupt.
        arena.as_mut_slice()[0].fill(0x11);
        arena.as_mut_slice()[N - 1].fill(0x22);
        assert_eq!(arena.as_slice()[0].0[0], u64::from_ne_bytes([0x11; 8]));
        assert_eq!(arena.as_slice()[N - 1].0[127], u64::from_ne_bytes([0x22; 8]));
        assert_eq!(arena.as_slice()[N / 2], Block::ZERO);
    }

    /// The backing is reported honestly, and the threshold is where it says.
    ///
    /// Not decoration: every performance claim in this module's docs is about
    /// the mapped path, so a silent fall-back to the heap would make those
    /// claims false while every other test stayed green.
    #[test]
    fn the_backing_matches_the_platform_and_the_size() {
        let small = Arena::new(8).expect("8 KiB arena");
        assert_eq!(small.backing_name(), "heap", "8 KiB is below the threshold");

        let large = Arena::new(4096).expect("4 MiB arena");
        if cfg!(all(feature = "std", target_os = "linux")) {
            assert!(
                large.backing_name().starts_with("mapped"),
                "4 MiB should be a mapping on Linux, got {}",
                large.backing_name()
            );
        } else {
            assert_eq!(large.backing_name(), "heap");
        }
    }

    /// Every byte of a striped region is covered, and nothing outside it is.
    ///
    /// This is the release wipe's partition. A stripe that is skipped is a
    /// region of somebody's password material left behind, and a stripe that
    /// runs long is a write past the end of the arena — so the test checks both
    /// directions, at every worker count and over sizes that are deliberately
    /// not multiples of the unit.
    #[test]
    fn striping_partitions_the_region_exactly() {
        use alloc::vec;

        for unit in [1usize, 8, 64] {
            for len in [1usize, 7, 64, 65, 255, 1024] {
                for workers in 1..=5u32 {
                    // Guard bytes on both sides catch an over-run.
                    let mut buf = vec![0xA5u8; len + 32];
                    // SAFETY: `buf` is `len + 32` bytes, so offset 16 is inside
                    // it and `[16, 16 + len)` stays inside it too.
                    let base = unsafe { buf.as_mut_ptr().add(16) };

                    stripe_over(base, len, workers, unit, |chunk, chunk_len| {
                        // SAFETY: `stripe_over`'s contract is that the chunk
                        // lies inside the region it was handed.
                        unsafe { core::ptr::write_bytes(chunk, 0, chunk_len) };
                    });

                    for (i, byte) in buf.iter().enumerate() {
                        let inside = (16..16 + len).contains(&i);
                        assert_eq!(
                            *byte == 0,
                            inside,
                            "byte {i} wrong for unit={unit} len={len} workers={workers}"
                        );
                    }
                }
            }
        }
    }

    /// The wipe has to work at every worker count, including one big enough to
    /// exercise the threaded path on a real arena.
    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn the_release_wipe_clears_everything_on_every_worker_count() {
        for workers in [1u32, 2, 4, 8] {
            let mut arena = Arena::new(4096).expect("4 MiB arena");
            arena.set_workers(workers);
            for block in arena.as_mut_slice() {
                block.fill(0xC3);
            }
            assert!(!arena.is_known_zeroed());

            arena.wipe_visible();
            assert!(
                is_all_zero(arena.as_slice()),
                "workers={workers} left part of the arena unwiped"
            );
            assert!(arena.is_known_zeroed());
        }
    }

    // -----------------------------------------------------------------------
    // The known-zeroed flag — load-bearing for the security wipe
    // -----------------------------------------------------------------------

    #[test]
    fn every_mutable_accessor_marks_the_arena_dirty() {
        let mut arena = Arena::new(2).expect("2 blocks");
        assert!(arena.is_known_zeroed(), "alloc_zeroed establishes it");

        let _ = arena.as_slice();
        let _ = arena.as_ptr();
        assert!(arena.is_known_zeroed(), "shared access cannot write");

        let _ = arena.as_mut_slice();
        assert!(!arena.is_known_zeroed());

        arena.ensure_zeroed();
        assert!(arena.is_known_zeroed());

        let _ = arena.as_mut_ptr();
        assert!(!arena.is_known_zeroed(), "a raw *mut is a write capability");
    }

    #[test]
    fn ensure_zeroed_clears_actual_bytes() {
        let mut arena = Arena::new(3).expect("3 blocks");
        for block in arena.as_mut_slice() {
            block.fill(0xA5);
        }
        assert!(!is_all_zero(arena.as_slice()));

        arena.ensure_zeroed();
        assert!(is_all_zero(arena.as_slice()));
        assert!(arena.is_known_zeroed());
    }

    // -----------------------------------------------------------------------
    // Workspace — reuse
    // -----------------------------------------------------------------------

    #[test]
    fn empty_workspace_allocates_nothing() {
        let ws = Workspace::new();
        assert_eq!(ws.capacity(), 0);
        assert_eq!(Workspace::default().capacity(), 0);
    }

    #[test]
    fn reuse_touches_the_allocator_exactly_once() {
        let mut ws = Workspace::with_capacity(32).expect("32 blocks");
        assert_eq!(ws.capacity(), 32);

        let first = {
            let guard = ws.acquire(32).expect("acquire");
            assert_eq!(guard.len(), 32);
            guard.as_ptr()
        };
        // Ten more round trips must all land on that same allocation.
        for _ in 0..10 {
            let guard = ws.acquire(32).expect("reacquire");
            assert_eq!(guard.as_ptr(), first, "reuse must not reallocate");
        }
        assert_eq!(ws.capacity(), 32, "capacity survives the round trips");
    }

    #[test]
    fn reuse_after_a_smaller_request_keeps_the_big_allocation() {
        let mut ws = Workspace::with_capacity(64).expect("64 blocks");
        let big = ws.acquire(64).expect("acquire 64").as_ptr();

        {
            let guard = ws.acquire(8).expect("acquire 8");
            assert_eq!(guard.len(), 8, "visible window shrinks");
            assert_eq!(guard.capacity(), 64, "allocation does not");
            assert_eq!(guard.as_ptr(), big, "and it is the same allocation");
        }

        // And the full-size window comes back without reallocating.
        let guard = ws.acquire(64).expect("acquire 64 again");
        assert_eq!(guard.len(), 64);
        assert_eq!(guard.as_ptr(), big);
    }

    #[test]
    fn reuse_after_a_larger_request_grows_and_still_reuses() {
        let mut ws = Workspace::with_capacity(4).expect("4 blocks");
        {
            let guard = ws.acquire(4).expect("acquire 4");
            assert_eq!(guard.capacity(), 4);
        }

        // Larger than capacity: one reallocation, then steady state again.
        let grown = {
            let guard = ws.acquire(48).expect("grow to 48");
            assert_eq!(guard.len(), 48);
            assert!(guard.capacity() >= 48);
            guard.as_ptr()
        };
        assert!(ws.capacity() >= 48);

        for _ in 0..4 {
            let guard = ws.acquire(48).expect("reacquire 48");
            assert_eq!(guard.as_ptr(), grown, "growth happens once");
        }
    }

    #[test]
    fn release_keeps_the_larger_of_two_arenas() {
        let mut ws = Workspace::with_capacity(4).expect("4 blocks");
        let small = ws.acquire_owned(4).expect("owned 4");
        let large = Arena::new(64).expect("64 blocks");

        ws.release(large);
        assert_eq!(ws.capacity(), 64);
        ws.release(small);
        assert_eq!(ws.capacity(), 64, "a smaller arena must not evict a larger");
    }

    #[test]
    fn acquire_rejects_zero_blocks() {
        let mut ws = Workspace::new();
        assert!(matches!(
            ws.acquire(0).err(),
            Some(Error::MemoryAllocationError)
        ));
        assert!(matches!(
            ws.acquire_owned(0).err(),
            Some(Error::MemoryAllocationError)
        ));
    }

    #[test]
    fn reserve_is_idempotent_and_never_shrinks() {
        let mut ws = Workspace::new();
        ws.reserve(0).expect("reserving nothing is a no-op");
        assert_eq!(ws.capacity(), 0);

        ws.reserve(32).expect("reserve 32");
        assert_eq!(ws.capacity(), 32);
        ws.reserve(8).expect("reserve 8");
        assert_eq!(ws.capacity(), 32, "reserve never shrinks");
        ws.reserve(32).expect("reserve 32 again");
        assert_eq!(ws.capacity(), 32);
    }

    #[test]
    fn clear_drops_the_parked_arena() {
        let mut ws = Workspace::with_capacity(16).expect("16 blocks");
        assert_eq!(ws.capacity(), 16);
        ws.clear();
        assert_eq!(ws.capacity(), 0);
        // Still usable afterwards.
        assert_eq!(ws.acquire(2).expect("acquire after clear").len(), 2);
    }

    #[test]
    fn owned_acquisition_round_trips_by_hand() {
        let mut ws = Workspace::with_capacity(16).expect("16 blocks");
        let arena = ws.acquire_owned(16).expect("owned");
        let ptr = arena.as_ptr();
        assert_eq!(ws.capacity(), 0, "on loan, so nothing is parked");
        ws.release(arena);
        assert_eq!(ws.capacity(), 16);
        assert_eq!(ws.acquire(16).expect("reacquire").as_ptr(), ptr);
    }

    #[test]
    fn dropping_an_owned_arena_instead_of_releasing_it_is_safe() {
        let mut ws = Workspace::with_capacity(8).expect("8 blocks");
        drop(ws.acquire_owned(8).expect("owned"));
        assert_eq!(ws.capacity(), 0, "reuse forfeited, nothing else");
        // The workspace still works; it just allocates again.
        assert_eq!(ws.acquire(8).expect("acquire").len(), 8);
    }

    // -----------------------------------------------------------------------
    // Workspace — the security properties
    // -----------------------------------------------------------------------

    /// The headline invariant: what one borrower wrote must never be visible to
    /// the next one.
    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn a_reused_arena_cannot_leak_the_previous_tenants_bytes() {
        let mut ws = Workspace::with_capacity(32).expect("32 blocks");

        for round in 0u8..4 {
            let mut guard = ws.acquire(32).expect("acquire");
            assert!(
                is_all_zero(guard.as_slice()),
                "round {round} started dirty — release did not wipe"
            );
            // Stand in for a hash: fill every block with a distinctive pattern.
            for (i, block) in guard.as_mut_slice().iter_mut().enumerate() {
                block.fill(0xC0u8.wrapping_add(round).wrapping_add(i as u8));
            }
            assert!(!is_all_zero(guard.as_slice()), "the pattern must land");
        }

        // And the very last release wiped too, so nothing is parked dirty.
        let parked = ws.arena.as_ref().expect("parked");
        assert!(is_all_zero(whole_capacity(parked)));
        assert!(parked.is_known_zeroed());
    }

    /// Release wipes the *whole* window the borrower had, not a prefix of it,
    /// and the blocks outside a later, smaller window stay zero — invariant 2.
    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn release_wipes_the_whole_borrowed_window() {
        let mut ws = Workspace::with_capacity(64).expect("64 blocks");
        {
            let mut guard = ws.acquire(64).expect("acquire 64");
            for block in guard.as_mut_slice() {
                block.fill(0xEE);
            }
        }

        let parked = ws.arena.as_ref().expect("parked");
        assert_eq!(parked.capacity(), 64);
        assert!(is_all_zero(whole_capacity(parked)), "all 64 blocks wiped");

        // A smaller acquisition must not resurrect the tail.
        let guard = ws.acquire(8).expect("acquire 8");
        assert!(is_all_zero(guard.as_slice()));
        assert!(is_all_zero(whole_capacity(&guard)), "the tail stays zero");
    }

    /// The tail beyond a *small* window must be zero even though release only
    /// ever wipes the visible blocks. This is the induction step of invariant 2
    /// and the one that would break if `release` wiped a prefix instead.
    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn a_small_borrower_cannot_dirty_the_tail() {
        let mut ws = Workspace::with_capacity(64).expect("64 blocks");
        {
            let mut guard = ws.acquire(4).expect("acquire 4");
            for block in guard.as_mut_slice() {
                block.fill(0xB7);
            }
            assert_eq!(guard.len(), 4);
        }
        // Now take the whole thing: blocks 4..64 were never handed out, so they
        // must still be the zeros `alloc_zeroed` produced.
        let guard = ws.acquire(64).expect("acquire 64");
        assert!(is_all_zero(guard.as_slice()));
    }

    #[test]
    #[cfg(feature = "zeroize-memory")]
    fn growth_does_not_carry_bytes_over() {
        let mut ws = Workspace::with_capacity(8).expect("8 blocks");
        {
            let mut guard = ws.acquire(8).expect("acquire 8");
            for block in guard.as_mut_slice() {
                block.fill(0x5C);
            }
        }
        let guard = ws.acquire(96).expect("grow to 96");
        assert!(is_all_zero(guard.as_slice()), "a grown arena is zeroed");
    }

    /// Without `zeroize-memory` the workspace makes no zeroing promise, but
    /// `ensure_zeroed` still does, and the arena is always *initialised*.
    #[test]
    fn ensure_zeroed_holds_regardless_of_the_wipe_feature() {
        let mut ws = Workspace::with_capacity(16).expect("16 blocks");
        {
            let mut guard = ws.acquire(16).expect("acquire");
            for block in guard.as_mut_slice() {
                block.fill(0x93);
            }
        }
        let mut guard = ws.acquire(16).expect("reacquire");
        guard.ensure_zeroed();
        assert!(is_all_zero(guard.as_slice()));

        // Reading every block is sound either way: initialised is the real
        // requirement, zero is not.
        let sum: u64 = guard.as_slice().iter().map(|b| b.0[0]).sum();
        assert_eq!(sum, 0);
    }

    /// Invariant 3 is the security-critical one: `is_known_zeroed()` decides
    /// whether `Drop` may skip a wipe, so it must never be `true` while any
    /// block in the *capacity* is dirty — not just the visible window.
    ///
    /// The trap this guards is real and was live during development: with
    /// `zeroize-memory` off, invariant 2 does not hold, so an `ensure_zeroed`
    /// that only covered `[0, len())` would set the flag while the tail beyond
    /// the window still held the previous hash's bytes. Widening the window
    /// then exposes them under a `true` flag.
    #[test]
    fn known_zeroed_never_lies_about_the_capacity() {
        let mut ws = Workspace::with_capacity(64).expect("64 blocks");

        // Dirty the whole 64-block capacity.
        {
            let mut guard = ws.acquire(64).expect("acquire 64");
            for block in guard.as_mut_slice() {
                block.fill(0x88);
            }
        }
        // Now take a narrow window and ask for the zero guarantee.
        {
            let mut guard = ws.acquire(4).expect("acquire 4");
            guard.ensure_zeroed();
            assert!(guard.is_known_zeroed());
        }
        // Widen again. The flag survived the release (release cannot dirty
        // anything), so if it still claims zero, every block must be zero.
        let guard = ws.acquire(64).expect("acquire 64 again");
        if guard.is_known_zeroed() {
            assert!(
                is_all_zero(guard.as_slice()),
                "is_known_zeroed() claimed zero while the tail was dirty"
            );
        }
    }

    #[test]
    fn a_dropped_workspace_wipes_what_it_parked() {
        // Not directly observable after the free, so assert the flag that
        // decides it: `Drop` wipes exactly when the arena is not known zero.
        let mut arena = Arena::new(4).expect("4 blocks");
        arena.as_mut_slice()[0].fill(0x11);
        assert!(!arena.is_known_zeroed(), "Drop will wipe this one");

        let mut ws = Workspace::with_capacity(4).expect("4 blocks");
        {
            let mut guard = ws.acquire(4).expect("acquire");
            guard.as_mut_slice()[0].fill(0x22);
        }
        assert_eq!(
            ws.arena.as_ref().map(Arena::is_known_zeroed),
            Some(WIPE_ENABLED),
            "release wipes iff the feature is on"
        );
    }

    // -----------------------------------------------------------------------
    // Thread-safety shape
    // -----------------------------------------------------------------------

    /// Everything here must be movable between threads, so a server can hand a
    /// workspace to whichever worker picks the request up.
    ///
    /// The matching negative — that none of them is `Sync` — is the
    /// `compile_fail` doctest on [`Workspace`]. A `Sync` workspace would let a
    /// `Bump` be shared across threads, which is exactly the design the brief
    /// forbids, so that doctest is a real guard and not decoration.
    #[test]
    fn send_but_not_sync() {
        const fn assert_send<T: Send>() {}
        assert_send::<Arena>();
        assert_send::<Workspace>();
        assert_send::<ArenaGuard<'static>>();
    }

    // -----------------------------------------------------------------------
    // Bump
    // -----------------------------------------------------------------------

    #[test]
    #[cfg(feature = "bump-alloc")]
    fn bump_serves_and_recycles_small_buffers() {
        let mut ws = Workspace::new();
        assert_eq!(ws.bump_reserved_bytes(), 0, "Bump::new allocates nothing");

        let first = {
            let buf = ws
                .bump()
                .try_alloc_slice_fill_copy(98usize, 0u8)
                .expect("98 bytes");
            assert_eq!(buf.len(), 98);
            assert!(buf.iter().all(|b| *b == 0));
            buf.as_ptr()
        };
        assert!(ws.bump_reserved_bytes() >= 98);

        // Reset recycles the chunk rather than returning it to the allocator —
        // that is what makes the second hash cheaper than the first, and it is
        // why `reserved` must NOT drop back to zero here.
        ws.reset_bump();
        assert!(
            ws.bump_reserved_bytes() >= 98,
            "reset keeps its chunk; only `clear` gives it back"
        );

        let second = ws
            .bump()
            .try_alloc_slice_fill_copy(98usize, 0u8)
            .expect("98 bytes again")
            .as_ptr();
        assert_eq!(first, second, "reset must reuse the chunk");
    }

    /// The wipe has to be checked by *reading back the same bytes*, not by
    /// allocating a fresh zeroed buffer over them — that would pass whether or
    /// not the wipe ran. So: write a pattern, reset, then re-claim the exact
    /// same region with `try_alloc_layout`, which allocates without writing,
    /// and read what is actually there.
    #[test]
    #[cfg(all(feature = "bump-alloc", feature = "zeroize-memory"))]
    fn reset_bump_wipes_the_scratch() {
        const LEN: usize = 64;

        let mut ws = Workspace::new();
        let written = {
            let buf = ws
                .bump()
                .try_alloc_slice_fill_copy(LEN, 0xABu8)
                .expect("64 bytes");
            assert!(buf.iter().all(|b| *b == 0xAB), "the pattern must land");
            buf.as_ptr()
        };

        ws.reset_bump();

        let layout = Layout::from_size_align(LEN, 1).expect("valid layout");
        let reclaimed = ws.bump().try_alloc_layout(layout).expect("same region");
        assert_eq!(
            reclaimed.as_ptr().cast_const(),
            written,
            "reset must recycle the chunk, or this test proves nothing"
        );

        // SAFETY: `reclaimed` is a fresh, exclusive `LEN`-byte allocation from
        // the bump, and every one of those bytes was initialised above (0xAB,
        // then whatever `reset_bump` left). The chunk is still owned by `ws`,
        // which outlives this read.
        let bytes: Vec<u8> =
            unsafe { core::slice::from_raw_parts(reclaimed.as_ptr(), LEN) }.to_vec();
        assert!(
            bytes.iter().all(|b| *b == 0),
            "reset_bump must wipe scratch before recycling it, found {bytes:02x?}"
        );
    }

    #[test]
    #[cfg(feature = "bump-alloc")]
    fn clear_resets_both_halves() {
        let mut ws = Workspace::with_capacity(8).expect("8 blocks");
        let _ = ws
            .bump()
            .try_alloc_slice_fill_copy(32usize, 0u8)
            .expect("32 bytes");
        assert!(ws.bump_reserved_bytes() >= 32);
        assert_eq!(ws.capacity(), 8);

        ws.clear();
        assert_eq!(ws.capacity(), 0, "the arena went back to the allocator");
        assert_eq!(ws.bump_reserved_bytes(), 0, "and so did the bump chunks");

        // Still usable afterwards, both halves.
        assert_eq!(ws.acquire(8).expect("acquire after clear").len(), 8);
        assert_eq!(
            ws.bump()
                .try_alloc_slice_fill_copy(32usize, 0u8)
                .expect("32 bytes after clear")
                .len(),
            32
        );
    }
}
