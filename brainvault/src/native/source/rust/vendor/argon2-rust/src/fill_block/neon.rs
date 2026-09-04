//! AArch64 NEON `fill_block` / `fill_segment`.
//!
//! # Provenance
//!
//! There is **no NEON code in the C reference**: `src/opt.c` and
//! `src/blake2/blamka-round-opt.h` are x86-only. This backend is derived from
//! the 128-bit SSE2/SSSE3 path of those two files, translated one intrinsic at a
//! time. The structure — `state[64]` carried across loop iterations, eight
//! column `BLAKE2_ROUND`s then eight row `BLAKE2_ROUND`s, `block_XY` for the
//! `with_xor` fold — is `opt.c`'s, unchanged.
//!
//! # Intrinsic correspondence
//!
//! Each row was verified against a scalar recomputation before being used (see
//! the unit tests at the bottom of this file):
//!
//! | `blamka-round-opt.h` (SSE2/SSSE3)     | NEON                                                | Instruction(s)   |
//! |---------------------------------------|-----------------------------------------------------|------------------|
//! | `_mm_add_epi64(a, b)`                 | `vaddq_u64(a, b)`                                   | `ADD.2d`         |
//! | `_mm_xor_si128(a, b)`                 | `veorq_u64(a, b)`                                   | `EOR.16b`        |
//! | `_mm_mul_epu32(x, y)` (see below)     | `vmull_u32(vmovn_u64(x), vmovn_u64(y))`             | `XTN`×2 + `UMULL`|
//! | `_mm_roti_epi64(x, -32)`              | `vrev64q_u32` on the `u32` reinterpretation         | `REV64.4s`       |
//! | `_mm_roti_epi64(x, -24)` (`r24` table)| `vsriq_n_u64::<24>(vshlq_n_u64::<40>(x), x)`        | `SHL` + `SRI`    |
//! | `_mm_roti_epi64(x, -16)` (`r16` table)| `vsriq_n_u64::<16>(vshlq_n_u64::<48>(x), x)`        | `SHL` + `SRI`    |
//! | `_mm_roti_epi64(x, -63)`              | `veorq_u64(vshrq_n_u64::<63>(x), vaddq_u64(x, x))`  | `USHR`+`ADD`+`EOR`|
//! | `_mm_alignr_epi8(hi, lo, 8)`          | `vextq_u64::<1>(lo, hi)`                            | `EXT.16b`        |
//!
//! `_mm_mul_epu32` keeps only the **low 32 bits** of each 64-bit lane before
//! multiplying, which is exactly `vmovn_u64` (`XTN`, truncating narrow) followed
//! by the widening `vmull_u32` (`UMULL`). That is what makes this equal to the
//! scalar `fBlaMka`'s `(x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)`.
//!
//! That row is the *transcription*, not what this backend ships. It is the one
//! place where NEON is not a one-for-one re-spelling of SSE2, and the difference
//! is worth a paragraph because it is where this backend's speed comes from.
//! `_mm_mul_epu32` takes the low halves **implicitly and for free**; NEON has no
//! such instruction, so the operands have to be narrowed explicitly. But NEON's
//! widening multiply is *half-width* — `UMULL` reads a `uint32x2_t` and there is
//! a second form, `UMULL2` (`vmull_high_u32`), that reads the **upper** half of
//! the same 128-bit register. So one narrowed vector feeds two multiplies, and
//! the narrowing can be shared between the two independent `fBlaMka`s that every
//! `G` step performs back to back:
//!
//! | for two `fBlaMka`s | instructions |
//! |---|---|
//! | `XTN`×2 + `UMULL`, twice (the transcription) | `XTN XTN UMULL XTN XTN UMULL` = **6** |
//! | `UZP1`×2 + `UMULL` + `UMULL2` (shipped)      | `UZP1 UZP1 UMULL UMULL2` = **4** |
//!
//! `UZP1 Vd.4S, Vn.4S, Vm.4S` keeps the even-numbered 32-bit elements of
//! `Vn:Vm`, and on little-endian the even elements of a `u64x2` are precisely
//! its two lanes' low halves — the same operand selection `_mm_mul_epu32` makes.
//! It costs no extra latency either: `UZP1` sits exactly where `XTN` sat, one
//! shuffle ahead of the multiply, reading two operands that were both already
//! live. See `f_blamka2`, and the measurements under "Spelling of the
//! primitives" below.
//!
//! **This trick is NEON-only.** It exists because NEON's widening multiply is
//! half-width and its narrowing is explicit. On x86 there is nothing to save:
//! `_mm_mul_epu32` / `_mm256_mul_epu32` / `_mm512_mul_epu32` already do the
//! selection inside the multiply, so `sse2.rs`, `avx2.rs` and `avx512.rs` are
//! already at the minimum instruction count for `fBlaMka` and no analogue of
//! this change applies to them.
//!
//! `_mm_alignr_epi8(a, b, 8)` concatenates `a:b` and shifts right by 8 bytes,
//! so its lanes are `(b.lane1, a.lane0)`. `vextq_u64::<1>(p, q)` yields
//! `(p.lane1, q.lane0)`. Hence the arguments swap: `alignr(a, b, 8)` is
//! `vextq_u64::<1>(b, a)`. See `alignr8`.
//!
//! # Shape of `fill_block`: fused prologue/epilogue, two rounds at a time
//!
//! `opt.c` writes `fill_block` as five sequential passes over the 1 KiB block:
//! a prologue loop, eight column rounds, eight row rounds, an epilogue loop.
//! Written that way the `state` array round-trips through the stack between
//! every pass, because 64 x 128-bit does not fit in 32 registers.
//!
//! Two structural changes remove most of that traffic, and neither changes a
//! single output bit (`tests::every_tuning_variant_agrees_at_segment_level`):
//!
//! * **Fusion.** The eight column rounds partition `state` into the contiguous
//!   groups `8k .. 8k+8`, and the eight row rounds into the strided groups
//!   `{ j, 8+j, ..., 56+j }`. Both partitions are exact, so the elementwise
//!   prologue can run inside the column round that is about to use those
//!   registers, and the elementwise epilogue inside the row round that just
//!   produced them. See `col_group!` and `row_group!`.
//! * **Interleaving.** The eight rounds of each pass are independent of one
//!   another. Emitting two of them with their `G` steps adjacent gives the
//!   scheduler four independent `fBlaMka` chains instead of two, on a
//!   compression function whose critical path is a chain of dependent
//!   multiplies. See `round8x2!`.
//!
//! Measured by `tests::fill_block_variant_shootout` on the Apple M5 Max, two
//! full passes over the arena, minimum of 15 rotated round-robin reps:
//!
//! | `fill_block` shape                | 4 MiB, in cache | 64 MiB, DRAM-bound |
//! |-----------------------------------|----------------:|-------------------:|
//! | fused, one round at a time (`FUSED`)      | 158 – 160 ns/blk | 206 – 224 ns/blk |
//! | **fused, two rounds interleaved (`FUSED2`)** | **141 – 145** | **190 – 215**   |
//! | fused, four rounds interleaved (`FUSED4`) | 155 – 156        | 223 – 236        |
//!
//! All three rows are live knobs on [`fill_segment_variant`], so the table can
//! be re-taken on another CPU or another LLVM by running that test. Ranges are
//! the spread of consecutive runs. Absolute `ns/blk` moves with machine state,
//! so only compare rows measured in the *same* run — which is what the
//! round-robin in that test is for, and why the DRAM-bound column is so much
//! wider than the cache-resident one.
//!
//! **Two-way interleaving is the maximum this register file supports, and that
//! is now measured rather than asserted.** `tests::two_way_vs_four_way_interleaving`
//! is a strictly paired head-to-head; four-way lost **0 of 31 reps at every one
//! of six working-set sizes**, by 8 % in cache and up to 16 % DRAM-bound. The
//! reason is visible in the emitted code — counting inside `neon::fill_segment`:
//!
//! | shape | `ldr q` | `str q` | total instructions |
//! |---|---:|---:|---:|
//! | `FUSED2` (shipped) | 484 | 613 | 8013 |
//! | `FUSED4`           | 826 | 829 | 8694 |
//!
//! Four rounds need 32 live vectors before a single temporary, i.e. the entire
//! register file, so the extra instruction-level parallelism is paid for — and
//! then some — in spill traffic. This was re-tested *after* the paired-`UZP1`
//! narrowing landed, because that change freed two temporaries per `fBlaMka`
//! pair and so genuinely changed the register budget; four-way still loses.
//!
//! Two further shapes were tried during the port and are **not** knobs, so their
//! figures are not reproducible from this file and are recorded only as
//! conclusions:
//!
//! * `opt.c`'s literal five-pass shape was the slowest of all, ~13 % behind
//!   the one-round fused shape.
//! * Zeroing `block_XY` instead of leaving it uninitialised cost a little on its
//!   own — the 1 KiB `bl _bzero` it adds to the per-block loop is largely
//!   absorbed by the store buffer — but leaving it uninitialised is what lets
//!   the two `with_xor` arms collapse into one basic block, which is the
//!   precondition for fusing at all.
//!
//! ## Carrying `state`, and why it stays carried
//!
//! `opt.c` carries `state` across `fill_block` calls, so the row groups store
//! all 64 slots **twice**: once into `next_block` and once back into `state`.
//! Both stores write the same value, and `fill_segment` maintains a
//! `prev_offset` that points at exactly the block just written, so the second
//! store is redundant and the value could be re-read from `memory[prev_offset]`
//! instead. That is `FUSED2_PREV`, and it really is cheaper *as code*: 7778
//! instructions against 8013, and 359/418 `ldr q`/`str q` against 484/613.
//!
//! It is **not** shipped, because cheaper code is not the same as faster code
//! here. `tests::carried_state_vs_reread_prev`, paired, 31 reps per size:
//!
//! | working set | 1 MiB | 4 MiB | 16 MiB | 64 MiB (t=1) | 64 MiB | 256 MiB |
//! |---|---:|---:|---:|---:|---:|---:|
//! | re-read vs carry | 1.024x | 1.034x | 1.049x | 0.957x | 0.976x | **0.915x** |
//! | reps won (of 31) | 25 | 26 | 24 | 7 | 7 | **1** |
//!
//! It wins by 2 – 5 % while the arena is cache-resident and loses by up to 9 %
//! once it is not, decisively (1 of 31 reps at 256 MiB). The reason is that the
//! stack copy of `state` is a *guaranteed*-resident 1 KiB, whereas re-reading
//! `memory[prev_offset]` puts that 1 KiB back into a cache that is already being
//! thrashed by the random reference block. Trading 5 % away in the memory-hard
//! regime — which is the regime a password hash is configured for — to gain
//! 3 % in the regime nobody tunes for is the wrong trade, so `state` stays
//! carried, which also keeps this backend structurally identical to `opt.c`.
//!
//! # Spelling of the primitives
//!
//! Each of these is a `const` knob on [`fill_segment_variant`], so the numbers
//! below can be reproduced, and re-taken on another CPU or another LLVM. Same
//! units and same three runs as above, all on top of the shipped shape. Each
//! row changes exactly **one** knob relative to the row it is compared against,
//! so the pairs isolate the primitive rather than the whole variant:
//!
//! | primitive | spelling | 4 MiB | 64 MiB | verdict |
//! |---|---|---:|---:|---|
//! | `ror32` | `EOR` + `REV64.4s` | 146 – 149 | 207 – 217 | rejected |
//! | `ror32` | rotate, fuses to one `XAR` | **141 – 145** | **190 – 215** | **kept** |
//! | `ror24`/`ror16` | `SHL` + `SRI`, fuses to `XAR` | **141 – 145** | **190 – 215** | **kept** |
//! | `ror24`/`ror16` | `TBL` with the C's `r24`/`r16` tables | 154 – 157 | 209 – 229 | rejected |
//! | `fBlaMka` | `XTN` x2 + `UMULL` + 3 `ADD` (the C) | 157 – 162 | 205 – 226 | rejected |
//! | `fBlaMka` | `XTN` x2 + `ADD` + `UMLAL` x2 | 156 – 162 | 208 – 219 | rejected |
//! | `fBlaMka` | `UZP1(x,y)` + `UMULL` + 3 `ADD` | 161 – 163 | 212 – 230 | rejected |
//! | `fBlaMka` | **`UZP1`x2 + `UMULL` + `UMULL2`, paired** | **141 – 145** | **190 – 215** | **kept** |
//! | `fBlaMka` | that, with `UMLAL`/`UMLAL2` for the doubling | 142 – 146 | 205 – 215 | rejected |
//!
//! Read this table with its regimes in mind. **In cache the spelling decides a
//! consistent and reproducible difference; once DRAM-bound it shrinks, because a
//! random 1 KiB reference block in a 64 MiB working set is a memory-latency
//! problem rather than an instruction-selection one.** The kept spelling won the
//! 4 MiB column in every run of every pair above.
//!
//! The paired `fBlaMka` is the largest single win in this file and is the one
//! row worth stating as a controlled experiment rather than a ranking. From
//! `tests::shipped_multiply_vs_the_spelling_it_replaced` — same shape, same
//! rotations, *only* the narrowing changed, strictly paired, 31 reps per size,
//! three runs:
//!
//! | working set     | 1 MiB | 4 MiB | 16 MiB | 64 MiB (t=1) | 64 MiB | 256 MiB |
//! |---|---:|---:|---:|---:|---:|---:|
//! | speedup (min)   | 1.11 – 1.14x | 1.10x | 1.07 – 1.13x | 1.08 – 1.12x | 1.05 – 1.07x | 1.00 – 1.02x |
//! | reps won (of 31)| 29 – 31 | 29 – 31 | 30 – 31 | 28 – 31 | 28 – 29 | 14 – 25 |
//!
//! It never loses; it simply stops mattering once DRAM latency dominates, which
//! is the expected shape for any instruction-count change. In the emitted code
//! `neon::fill_segment` goes from **9528 to 8013 instructions (-15.9 %)**, and
//! the isolated `fill_block` from 2797 to 2360 (-15.6 %) — 512 `XTN` and 256
//! `UMULL` per block become 256 `UZP1`, 128 `UMULL` and 128 `UMULL2`.
//!
//! Notes on the rejects, because the reasons are not obvious:
//!
//! * `TBL` costs a real `TBL` and, worse, blocks the `EOR` + rotate fusion that
//!   `FEAT_SHA3` provides. `SHL` + `SRI` never materialises at all — LLVM turns
//!   the pair into one `XAR`. Confirmed in the disassembly: the shipped
//!   `fill_segment` contains **0** `tbl`, **0** `sri`, **0** `shl` and **0**
//!   `rev64`, and 992 `xar.2d` — 248 each at `#32`, `#24`(+`#56`), `#16` and
//!   `#63`, i.e. every one of the four BLAMKA rotations fused with the `EOR`
//!   that feeds it. The `TBL` build instead has 496 `xar` and 496 `tbl`.
//! * `UMLAL` looks like one instruction less per `fBlaMka`, which would be 256
//!   fewer per block. It is not: **LLVM canonicalises `UMLAL` back into
//!   `UMULL` + `ADD`.** This was re-checked against the *paired* form, where the
//!   saving would have been another 256 per block: building with
//!   `MUL_UZP_PAIR_MLAL` emits **0 `umlal` and 0 `umlal2`**, the same 256
//!   `umull`/`umull2` and the same 768 `add.2d` as `MUL_UZP_PAIR`, and differs
//!   by 3 instructions of register-allocation jitter (2357 against 2360). The
//!   measured difference is therefore noise by construction, which is exactly
//!   what the table shows.
//! * `UZP1(x, y)` — pairing the two operands of a *single* `fBlaMka` rather than
//!   across two of them — also removes an `XTN`, but the one `UZP1` then has to
//!   be split apart again with a `mov` before `UMULL`, and it serialises two
//!   narrowings that used to issue in parallel. Same instruction count, longer
//!   chain. Pairing across the two independent `fBlaMka`s instead keeps both
//!   halves of the `UZP1` result useful, which is why `MUL_UZP_PAIR` wins
//!   where `MUL_UZP` does not.
//!
//! `ror32` is the one case where the best spelling depends on the CPU: the
//! rotate form is a win only with `FEAT_SHA3`, and one instruction worse
//! without it, so `ROR32_DEFAULT` picks by `cfg(target_feature = "sha3")`.
//! Measured both ways in the disassembly: with the rotate spelling, 992 `xar`
//! and 0 `rev64`; with the shuffle spelling, 744 `xar` and 248 `rev64` — the
//! 248 `ror32`s stop fusing and their `EOR`s come back as separate
//! instructions.
//!
//! # Loads and stores
//!
//! AArch64 has no aligned/unaligned distinction to exploit: `LDR q` / `STR q`
//! have no alignment requirement and there is no faster aligned form (the
//! alignment hints on `LD1` are AArch32-only). [`Block`] is
//! `#[repr(C, align(64))]` and the arena is 64-byte aligned, so every 16-byte
//! access here is naturally aligned already, and `vld1q_u64` is the right
//! intrinsic either way.
//!
//! What the shape change *did* buy is pairing: because a fused two-round group
//! touches sixteen adjacent slots, LLVM forms `LDP`/`STP` where it would
//! otherwise emit single `LDR`/`STR`. Counted in the emitted assembly for
//! `neon::fill_segment` (`cargo rustc --release --lib -- --emit=asm`), changing
//! only `SHAPE_DEFAULT` and holding everything else at the shipped settings:
//!
//! | shape | `ldp` | `stp` | `ldr q` | `str q` | instructions |
//! |---|---:|---:|---:|---:|---:|
//! | one round at a time (`FUSED`)     |  81 | 15 | 480 | 635 | 7998 |
//! | **two rounds (`FUSED2`, shipped)** | **99** | **55** | **484** | **613** | **8013** |
//! | four rounds (`FUSED4`)            | 144 | 99 | 826 | 829 | 8694 |
//!
//! `FUSED` and `FUSED2` are within 15 instructions of each other, so the 1.13x
//! between them is scheduling, not instruction count; `FUSED4` is a different
//! story and is discussed above.
//!
//! `LD1`/`ST1` x4 (`vld1q_u64_x4`) was tried in the original port and is ~4 %
//! slower; it is multi-uop on this core. It is not a knob here.
//!
//! ## How much of the 1 KiB actually lives in registers
//!
//! Not much of it, and it cannot: 64 x 128-bit is 1 KiB against a 512-byte
//! register file, so `state` is a stack array in this backend exactly as it is
//! in `opt.c`. What "carrying `state`" buys is not registers, it is **not
//! re-reading the previous block from the arena** — the value stays in the same
//! hot stack slots from one `fill_block` to the next.
//!
//! Within one `fill_block` the fusion does keep sixteen slots in registers
//! across a whole round, and the residual traffic is close to the algorithmic
//! minimum. Counted inside `fill_block_isolated`, which is one block:
//!
//! | | stack ld | stack st | arena ld | arena st |
//! |---|---:|---:|---:|---:|
//! | algorithmic minimum | 128 | 128 | 128 | 64 |
//! | measured (shipped)  | 174 | 184 | 192 | 64 |
//!
//! The stack minimum is `block_XY` written once and read once (64 + 64) plus
//! `state` handed from the column groups to the row groups (64 + 64); the arena
//! minimum is `ref_block` plus the previous block, and 64 stores of
//! `next_block`. The measured arena figure is 192 rather than 128 only because
//! `with_xor` is a runtime flag, so the `next_block` re-read of its taken arm is
//! counted here too. The ~50 extra stack accesses are genuine register-allocator
//! spill, i.e. about 8 % over the floor — which is what makes four-way
//! interleaving, at 826/829, so obviously the wrong trade.
//!
//! # What to expect from this backend
//!
//! Whole-hash, argon2id v0x13, on the Apple M5 Max, from `benches/argon2.rs`
//! (`cargo bench --bench argon2 -- grid`). The `neon/scalar` column is the one
//! to read: criterion runs the two backends of a config back to back, so drift
//! between them is small, whereas drift *across* a whole bench run is not —
//! measured, on this machine, at 3 – 8 % on the **unchanged** scalar backend
//! between two runs a couple of hours apart. Never compare an absolute
//! millisecond figure here against one from a different session.
//!
//! | config | scalar | neon | neon/scalar |
//! |---|---:|---:|---:|
//! | `m4096 t1 p1`   | 1.096 ms | 0.681 ms | **x1.61** |
//! | `m4096 t3 p1`   | 3.178 ms | 1.932 ms | **x1.65** |
//! | `m65536 t1 p1`  | 22.999 ms | 15.668 ms | **x1.47** |
//! | `m65536 t3 p1`  | 69.256 ms | 49.201 ms | **x1.41** |
//! | `m65536 t3 p4`  | 19.269 ms | 14.159 ms | **x1.36** |
//! | `m262144 t1 p1` | 99.060 ms | 69.322 ms | **x1.43** |
//! | `m262144 t3 p1` | 310.29 ms | 229.90 ms | **x1.35** |
//!
//! `p4` means `lanes = threads = 4`, i.e. genuinely four threads.
//!
//! Cross-checked by `tests::neon_matches_scalar_on_large_arenas`, which
//! interleaves the two backends best-of-5 within one process rather than
//! relying on criterion's ordering: `m1024 t3 p1` x1.63 (0.77 → 0.47 ms) and
//! `m65536 t3 p1` x1.46 (65.08 → 44.65 ms). The two methods agree.
//!
//! That test prints those ratios but does not fail on them — a shared CI runner
//! can hand one candidate a contention window the other never sees. It asserts
//! that the two backends produce the same tag; regressions in the numbers are
//! CodSpeed's job.
//!
//! The C reference is `phc-winner-argon2` built from `src/ref.c` at `-O3`; the C
//! has **no** SIMD path on `aarch64` (`src/opt.c` is x86-only), so it lands
//! within a few percent of this crate's scalar backend, and the `neon/scalar`
//! column is also, to that accuracy, `neon`-against-the-C.
//!
//! Isolating the compression function from arena traffic (`fill_block` alone,
//! L1-resident, `tests::compression_throughput_by_backend`) gives NEON **x1.54**
//! over scalar, at 150.0 ns/block against 231.6. That confirms the whole-hash
//! win is instruction-level and not a measurement artefact — and it is a *lower*
//! bound on the real gain, not an upper one: `fill_block_isolated` reloads
//! `state` from `prev_block` on every call, which the real `fill_segment` does
//! not, and those ~64 extra loads are a constant added to both backends, which
//! compresses the ratio.
//!
//! For context on where these numbers came from: the original port measured
//! x1.07 – x1.13 over scalar, with the C *ahead* of NEON at `p = 4`. Fusing the
//! prologue/epilogue into the rounds and interleaving two rounds took that to
//! x1.30 – x1.53. Sharing the operand narrowing between paired `fBlaMka`s — the
//! `UZP1` + `UMULL`/`UMULL2` row above — took it to the table shown here.
//!
//! At `m = 262144` (256 MiB) the gap narrows: the working set fits no cache, so
//! a large share of every block is a DRAM round trip for its random reference
//! block that no backend can avoid.
//!
//! The remaining lever there is software-prefetching the reference block, which
//! is possible for Argon2i (and the first half-pass of Argon2id) because the
//! address block is computed 128 blocks ahead. It is deliberately not done
//! here: it is a `fill_segment` change that would apply to every backend
//! equally, and it has no counterpart in `opt.c`.
//!
//! Dropping the carried `state` and reading `memory[prev_offset]` straight from
//! the arena each iteration *was* implemented and measured — it is
//! `FUSED2_PREV` — and it loses precisely here, at the sizes where it would
//! have had to pay off. See "Carrying `state`, and why it stays carried" above.
//!
//! # Why `#[target_feature(enable = "neon")]` is on `fill_segment`
//!
//! See the module docs of the parent `fill_block` module. On `aarch64` the `neon` feature
//! is part of the baseline, so the attribute is a no-op in practice; it is
//! present so every backend has the same shape and so the inlining boundary is
//! documented where it matters. `fill_block` is `#[inline(always)]` and has no
//! attribute of its own, which lets it inline into `fill_segment` and keeps
//! `state` in the caller's frame across iterations.

use core::arch::aarch64::{
    uint8x16_t, uint64x2_t, vaddq_u64, vdupq_n_u64, veorq_u64, vextq_u64, vget_high_u32,
    vget_low_u32, vld1q_u8, vld1q_u64, vmlal_high_u32, vmlal_u32, vmovn_u64, vmull_high_u32,
    vmull_u32, vqtbl1q_u8, vreinterpretq_u8_u64, vreinterpretq_u32_u64, vreinterpretq_u64_u8,
    vreinterpretq_u64_u32, vrev64q_u32, vshlq_n_u64, vshrq_n_u64, vsriq_n_u64, vst1q_u64,
    vuzp1q_u32,
};
use core::mem::MaybeUninit;

use crate::block::{Block, Instance, Position};
use crate::params::{ADDRESSES_IN_BLOCK, OWORDS_IN_BLOCK};

/// `ARGON2_ADDRESSES_IN_BLOCK` as a `u32`, for the `i % 128` in `fill_segment`.
const ADDRESSES_IN_BLOCK_U32: u32 = ADDRESSES_IN_BLOCK as u32;

/// Rotate `ror24`/`ror16` with `SHL` + `SRI`. The default, see the module docs.
const SHIFT_ROTATES: bool = false;
/// Rotate `ror24`/`ror16` with `TBL` and the C's `r24`/`r16` byte tables.
const TABLE_ROTATES: bool = true;

/// `fBlaMka` as the C spells it: two `XTN`, `UMULL`, then three `ADD`s.
const MUL_UMULL: u8 = 0;
/// `fBlaMka` as two `XTN`, one `ADD` and two accumulating `UMLAL`s.
///
/// On paper one instruction less than [`MUL_UMULL`]; in practice **LLVM
/// canonicalises `UMLAL` straight back to `UMULL` + `ADD`**, so the emitted
/// arithmetic is byte-for-byte the same. Measured, see the module docs. Kept
/// as a knob only so the finding can be re-checked on another LLVM.
const MUL_UMLAL: u8 = 1;
/// `fBlaMka` narrowing both operands with a single `UZP1` instead of two `XTN`.
const MUL_UZP: u8 = 2;
/// **Two** `fBlaMka`s at once, narrowing all four operands with two `UZP1`s and
/// taking both products with `UMULL` + `UMULL2`. See [`f_blamka2`].
const MUL_UZP_PAIR: u8 = 3;
/// [`MUL_UZP_PAIR`], with the two `+ z` folded into accumulating
/// `UMLAL`/`UMLAL2`. Two instructions less per pair on paper; see the module
/// docs for why it is not, in fact, less.
const MUL_UZP_PAIR_MLAL: u8 = 4;
/// Which `fBlaMka` this build uses. See the module docs for the measurement.
const MUL_DEFAULT: u8 = MUL_UZP_PAIR;

/// `ror32` as `EOR` + `REV64.4s`: two instructions, portable.
const ROR32_REV: bool = false;
/// `ror32` as a real rotate, so `FEAT_SHA3` fuses `EOR` + rotate into one `XAR`.
const ROR32_XAR: bool = true;
/// Which `ror32` this build uses.
///
/// The rotate spelling is a win **only** with `FEAT_SHA3`, where it saves the
/// separate `REV64`; without it the rotate lowers to `SHL` + `SRI` and the
/// `EOR` stays, which is one instruction *worse* than the shuffle. This is a
/// compile-time choice about how to spell one operation inside an
/// already-runtime-selected backend, not a backend selection — `aarch64`
/// still reaches this code only through [`crate::fill_block::detect`].
///
/// Spelled with the two named constants rather than as a bare `cfg!` so that the
/// choice reads as the choice it is — and so neither name is dead code in a
/// build without `cfg(test)`.
const ROR32_DEFAULT: bool = if cfg!(target_feature = "sha3") {
    ROR32_XAR
} else {
    ROR32_REV
};

/// `fill_block` shape: `block_XY` left uninitialised (as `opt.c` declares it),
/// the prologue fused into the eight column rounds and the epilogue into the
/// eight row rounds, one round at a time.
const FUSED: u8 = 2;
/// As `FUSED`, but with two independent rounds interleaved; see `round8x2!`.
/// The default — see the interleaving-depth table in the module docs.
const FUSED2: u8 = 3;
/// As [`FUSED2`], but the previous block is **re-read from the arena** instead
/// of being carried in `state` across `fill_block` calls.
///
/// `opt.c` carries `state`, so at the end of `fill_block` the row groups have to
/// write every one of the 64 slots twice: once into `next_block` and once back
/// into `state`. Those two stores hold the same value — `state` is *defined* to
/// end up equal to the block just written — and `fill_segment` maintains a
/// `prev_offset` that points at exactly that block, so the second store is
/// redundant and the value can be re-read from `memory[prev_offset]` instead.
/// See `fill_segment_impl` for why `memory[prev_offset]` is always the carried
/// state, including across the `curr_offset % lane_length == 1` rotation.
///
/// Trades 64 stack stores + 64 stack loads per block for 64 arena loads of a
/// block that was written one iteration ago and is therefore L1-hot: 64 fewer
/// memory operations per block. Measured, see the module docs.
const FUSED2_PREV: u8 = 4;
/// As [`FUSED2`], but with **four** independent rounds interleaved; see
/// `round8x4!`. Thirty-two live vectors, i.e. the whole register file.
const FUSED4: u8 = 5;
/// Which shape this build uses.
const SHAPE_DEFAULT: u8 = FUSED2;

// ---------------------------------------------------------------------------
// blamka-round-opt.h, 128-bit path
// ---------------------------------------------------------------------------

/// An all-zero `uint64x2_t`. Lowers to `MOVI.2d v, #0`.
#[inline(always)]
unsafe fn zero() -> uint64x2_t {
    // SAFETY: touches no memory; `DUP` of an immediate is unconditionally
    // available wherever NEON is.
    unsafe { vdupq_n_u64(0) }
}

/// `fBlaMka(x, y)` from `blamka-round-opt.h`:
///
/// ```c
/// const __m128i z = _mm_mul_epu32(x, y);
/// return _mm_add_epi64(_mm_add_epi64(x, y), _mm_add_epi64(z, z));
/// ```
///
/// Lane-wise this is the scalar `x + y + 2 * (lo32(x) * lo32(y))` with `u64`
/// wraparound, which NEON's `ADD.2d` provides for free.
///
/// [`MUL_UMULL`] transcribes the C: `UMULL` + three `ADD`s, six instructions
/// counting the two `XTN`s. [`MUL_UMLAL`] folds the multiply and one of the
/// doublings into `UMLAL`, which is five. [`MUL_UZP`] narrows both operands with
/// one `UZP1`. All compute the same `u64` value; see
/// `tests::f_blamka_matches_the_scalar_definition`.
///
/// The two *paired* spellings are implemented by [`f_blamka2`] and reach this
/// function only as dead monomorphisations, where they behave as
/// [`MUL_UMULL`].
#[inline(always)]
unsafe fn f_blamka<const MUL: u8>(x: uint64x2_t, y: uint64x2_t) -> uint64x2_t {
    // Reject an unknown spelling at monomorphisation time rather than letting it
    // silently pick the `else` arm — same guard, same reason, as `fill_block`'s
    // shape check. `f_blamka2` dispatches on `MUL` with an ordinary `if`, so
    // both of its arms are monomorphised and the paired values reach here too;
    // they must therefore be listed.
    const {
        assert!(
            MUL == MUL_UMULL
                || MUL == MUL_UMLAL
                || MUL == MUL_UZP
                || MUL == MUL_UZP_PAIR
                || MUL == MUL_UZP_PAIR_MLAL,
            "unknown fBlaMka spelling"
        )
    };

    // SAFETY: all NEON, no memory touched. `vmovn_u64` (`XTN`) truncates each
    // 64-bit lane to its low 32 bits, which is `_mm_mul_epu32`'s implicit
    // operand selection, and `vmull_u32` / `vmlal_u32` (`UMULL` / `UMLAL`)
    // widen the 32x32 products back to 64 bits. `vuzp1q_u32` (`UZP1`) picks the
    // same low halves out of both operands at once.
    unsafe {
        if MUL == MUL_UZP {
            // UZP1 + MOV + UMULL instead of XTN + XTN + UMULL: the same three
            // instructions, but `UZP1` reads *both* x and y, so the two
            // narrowings serialise into one op instead of issuing in parallel.
            let u = vuzp1q_u32(vreinterpretq_u32_u64(x), vreinterpretq_u32_u64(y));
            let z = vmull_u32(vget_low_u32(u), vget_high_u32(u));
            vaddq_u64(vaddq_u64(x, y), vaddq_u64(z, z))
        } else {
            let lx = vmovn_u64(x);
            let ly = vmovn_u64(y);
            if MUL == MUL_UMLAL {
                // (x + y) + z + z, with each `+ z` an accumulating multiply.
                let s = vaddq_u64(x, y);
                vmlal_u32(vmlal_u32(s, lx, ly), lx, ly)
            } else {
                let z = vmull_u32(lx, ly);
                vaddq_u64(vaddq_u64(x, y), vaddq_u64(z, z))
            }
        }
    }
}

/// Two independent `fBlaMka`s, sharing their operand narrowing.
///
/// Every `G` step applies `fBlaMka` to two independent register pairs back to
/// back (`A0 = fBlaMka(A0, B0); A1 = fBlaMka(A1, B1)` in `blamka-round-opt.h`),
/// and NEON's widening multiply is *half-width*: `UMULL` consumes a
/// `uint32x2_t`, so one 128-bit vector of narrowed operands feeds **two** of
/// them — `UMULL` for the low half and `UMULL2` (`vmull_high_u32`) for the high
/// half. So the two `fBlaMka`s can share their narrowing:
///
/// ```text
/// MUL_UMULL, twice     XTN XTN UMULL  XTN XTN UMULL          = 6 instructions
/// MUL_UZP_PAIR         UZP1 UZP1 UMULL UMULL2                = 4 instructions
/// ```
///
/// `UZP1 Vd.4S, Vn.4S, Vm.4S` keeps the even-numbered 32-bit elements of
/// `Vn:Vm`, and on little-endian the even elements of a `u64x2` are exactly the
/// two lanes' low halves — the operand selection `_mm_mul_epu32` does
/// implicitly. So
///
/// ```text
/// ux = UZP1(x0, x1) = [lo(x0.0), lo(x0.1), lo(x1.0), lo(x1.1)]
/// uy = UZP1(y0, y1) = [lo(y0.0), lo(y0.1), lo(y1.0), lo(y1.1)]
/// UMULL (low halves)  = lo(x0) * lo(y0)   <- the z of the first  fBlaMka
/// UMULL2 (high halves)= lo(x1) * lo(y1)   <- the z of the second fBlaMka
/// ```
///
/// This saves two instructions per pair, i.e. **256 per block** out of roughly
/// 2400, and it does *not* lengthen the dependency chain: `UZP1` sits exactly
/// where `XTN` sat, one shuffle before the multiply, and reads only operands
/// that were both already live. `vget_low_u32` is a register-subset view and
/// costs nothing.
///
/// Contrast [`MUL_UZP`], which pairs `x` with `y` *within* one `fBlaMka`: that
/// also removes an `XTN`, but the single `UZP1` then has to be split back apart
/// with a `mov` before `UMULL`, and it serialises the two narrowings that used
/// to issue in parallel. Pairing across the two independent `fBlaMka`s instead
/// keeps both halves of the `UZP1` result useful.
///
/// For every `MUL` other than [`MUL_UZP_PAIR`] this is just [`f_blamka`] twice,
/// so the knob still selects between all four spellings. All of them compute
/// the same two values; see `tests::f_blamka_matches_the_scalar_definition`.
#[inline(always)]
unsafe fn f_blamka2<const MUL: u8>(
    x0: uint64x2_t,
    y0: uint64x2_t,
    x1: uint64x2_t,
    y1: uint64x2_t,
) -> (uint64x2_t, uint64x2_t) {
    // SAFETY: all NEON, no memory touched. See `f_blamka` for the arithmetic.
    unsafe {
        if MUL == MUL_UZP_PAIR || MUL == MUL_UZP_PAIR_MLAL {
            let ux = vuzp1q_u32(vreinterpretq_u32_u64(x0), vreinterpretq_u32_u64(x1));
            let uy = vuzp1q_u32(vreinterpretq_u32_u64(y0), vreinterpretq_u32_u64(y1));
            if MUL == MUL_UZP_PAIR_MLAL {
                let lx = vget_low_u32(ux);
                let ly = vget_low_u32(uy);
                let s0 = vaddq_u64(x0, y0);
                let s1 = vaddq_u64(x1, y1);
                (
                    vmlal_u32(vmlal_u32(s0, lx, ly), lx, ly),
                    vmlal_high_u32(vmlal_high_u32(s1, ux, uy), ux, uy),
                )
            } else {
                let z0 = vmull_u32(vget_low_u32(ux), vget_low_u32(uy));
                let z1 = vmull_high_u32(ux, uy);
                (
                    vaddq_u64(vaddq_u64(x0, y0), vaddq_u64(z0, z0)),
                    vaddq_u64(vaddq_u64(x1, y1), vaddq_u64(z1, z1)),
                )
            }
        } else {
            (f_blamka::<MUL>(x0, y0), f_blamka::<MUL>(x1, y1))
        }
    }
}

/// `_mm_roti_epi64(x, -32)`: `_mm_shuffle_epi32(x, _MM_SHUFFLE(2, 3, 0, 1))`,
/// i.e. swap the two 32-bit halves of each 64-bit lane.
///
/// `XAR == false` says it as a shuffle (`REV64.4s`), which is one instruction
/// on every AArch64 CPU but cannot fuse with the `EOR` that always precedes it.
/// `XAR == true` says it as a rotate, which a `FEAT_SHA3` CPU fuses with that
/// `EOR` into a single `XAR` — and which costs `SHL` + `SRI` + `EOR`, one
/// instruction *more*, on a CPU without it. Hence [`ROR32_DEFAULT`].
#[inline(always)]
unsafe fn ror32<const XAR: bool>(x: uint64x2_t) -> uint64x2_t {
    if XAR {
        // SAFETY: all NEON. As `ror24`, with 32 and 32.
        unsafe { vsriq_n_u64::<32>(vshlq_n_u64::<32>(x), x) }
    } else {
        // SAFETY: all NEON. `REV64.4s` reverses the two 32-bit elements inside
        // each 64-bit doubleword, which is a rotate by 32 of that doubleword.
        unsafe { vreinterpretq_u64_u32(vrev64q_u32(vreinterpretq_u32_u64(x))) }
    }
}

/// The `r24` byte table from `blamka-round-opt.h`.
#[inline(always)]
unsafe fn r24_table() -> uint8x16_t {
    // _mm_setr_epi8(3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10)
    const T: [u8; 16] = [3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10];
    // SAFETY: `T` is 16 bytes, so it is valid for a full `LD1` of a `uint8x16_t`.
    unsafe { vld1q_u8(T.as_ptr()) }
}

/// The `r16` byte table from `blamka-round-opt.h`.
#[inline(always)]
unsafe fn r16_table() -> uint8x16_t {
    // _mm_setr_epi8(2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9)
    const T: [u8; 16] = [2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9];
    // SAFETY: as `r24_table`.
    unsafe { vld1q_u8(T.as_ptr()) }
}

/// `_mm_roti_epi64(x, -24)`, i.e. `rotate_right(24)` in every 64-bit lane.
///
/// `TBL == true` mirrors the SSSE3 `_mm_shuffle_epi8(x, r24)`; `TBL == false`
/// uses `SHL` + `SRI`. Both were verified equal to `u64::rotate_right(24)`.
#[inline(always)]
unsafe fn ror24<const TBL: bool>(x: uint64x2_t) -> uint64x2_t {
    if TBL {
        // SAFETY: all NEON. `TBL` indexes bytes of `x` by the constant table;
        // every index is < 16 so no lane can be zeroed.
        unsafe { vreinterpretq_u64_u8(vqtbl1q_u8(vreinterpretq_u8_u64(x), r24_table())) }
    } else {
        // SAFETY: all NEON. `SRI` keeps the top 24 bits of its first operand and
        // fills the low 40 with `x >> 24`; the first operand is `x << 40`, whose
        // top 24 bits are the low 24 bits of `x`. That is `rotate_right(24)`.
        unsafe { vsriq_n_u64::<24>(vshlq_n_u64::<40>(x), x) }
    }
}

/// `_mm_roti_epi64(x, -16)`, i.e. `rotate_right(16)` in every 64-bit lane.
#[inline(always)]
unsafe fn ror16<const TBL: bool>(x: uint64x2_t) -> uint64x2_t {
    if TBL {
        // SAFETY: as `ror24`.
        unsafe { vreinterpretq_u64_u8(vqtbl1q_u8(vreinterpretq_u8_u64(x), r16_table())) }
    } else {
        // SAFETY: as `ror24`, with 16 and 48.
        unsafe { vsriq_n_u64::<16>(vshlq_n_u64::<48>(x), x) }
    }
}

/// `_mm_roti_epi64(x, -63)`, transcribed straight from the C:
/// `_mm_xor_si128(_mm_srli_epi64(x, 63), _mm_add_epi64(x, x))`.
///
/// `x + x` is `x << 1`, and the two halves cannot overlap, so the `XOR` acts as
/// an `OR`: the result is `rotate_right(63)` = `rotate_left(1)`.
#[inline(always)]
unsafe fn ror63(x: uint64x2_t) -> uint64x2_t {
    // SAFETY: all NEON.
    unsafe { veorq_u64(vshrq_n_u64::<63>(x), vaddq_u64(x, x)) }
}

/// `_mm_alignr_epi8(hi, lo, 8)`.
///
/// The x86 intrinsic forms the 32-byte value `hi:lo`, shifts it right by 8
/// bytes and keeps the low 16, giving lanes `(lo.lane1, hi.lane0)`.
/// `vextq_u64::<1>(p, q)` gives `(p.lane1, q.lane0)`, so the operands swap.
#[inline(always)]
unsafe fn alignr8(hi: uint64x2_t, lo: uint64x2_t) -> uint64x2_t {
    // SAFETY: all NEON, `EXT.16b` with a constant 8-byte index.
    unsafe { vextq_u64::<1>(lo, hi) }
}

// The four round macros below are deliberate transliterations of the C macros of
// the same name. Taking the eight vectors as `ident`s (rather than as function
// arguments) keeps the assignment structure — and therefore the read/write order
// — identical to the C, which is what makes them auditable side by side.
//
// They expand bare intrinsic calls, so every invocation must sit inside an
// `unsafe` block. All call sites are in `fill_block`, which provides one.

/// `G1(A0, B0, C0, D0, A1, B1, C1, D1)` from `blamka-round-opt.h`.
macro_rules! g1 {
    ($tbl:ident, $ml:ident, $x32:ident,
                 $a0:ident, $b0:ident, $c0:ident, $d0:ident,
                 $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        ($a0, $a1) = f_blamka2::<$ml>($a0, $b0, $a1, $b1);

        $d0 = veorq_u64($d0, $a0);
        $d1 = veorq_u64($d1, $a1);

        $d0 = ror32::<$x32>($d0);
        $d1 = ror32::<$x32>($d1);

        ($c0, $c1) = f_blamka2::<$ml>($c0, $d0, $c1, $d1);

        $b0 = veorq_u64($b0, $c0);
        $b1 = veorq_u64($b1, $c1);

        $b0 = ror24::<$tbl>($b0);
        $b1 = ror24::<$tbl>($b1);
    }};
}

/// `G2(A0, B0, C0, D0, A1, B1, C1, D1)` from `blamka-round-opt.h`.
macro_rules! g2 {
    ($tbl:ident, $ml:ident,
                 $a0:ident, $b0:ident, $c0:ident, $d0:ident,
                 $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        ($a0, $a1) = f_blamka2::<$ml>($a0, $b0, $a1, $b1);

        $d0 = veorq_u64($d0, $a0);
        $d1 = veorq_u64($d1, $a1);

        $d0 = ror16::<$tbl>($d0);
        $d1 = ror16::<$tbl>($d1);

        ($c0, $c1) = f_blamka2::<$ml>($c0, $d0, $c1, $d1);

        $b0 = veorq_u64($b0, $c0);
        $b1 = veorq_u64($b1, $c1);

        $b0 = ror63($b0);
        $b1 = ror63($b1);
    }};
}

/// `DIAGONALIZE` from the **SSSE3** branch of `blamka-round-opt.h`.
///
/// With `A0 = (v0, v1)`, `A1 = (v2, v3)`, `B0 = (v4, v5)`, `B1 = (v6, v7)`,
/// `C0 = (v8, v9)`, `C1 = (v10, v11)`, `D0 = (v12, v13)`, `D1 = (v14, v15)`
/// this produces
///
/// ```text
/// B0 = (v5, v6)    B1 = (v7,  v4)
/// C0 = (v10, v11)  C1 = (v8,  v9)
/// D0 = (v15, v12)  D1 = (v13, v14)
/// ```
///
/// so lane 0 of `(A0, B0, C0, D0)` is `(v0, v5, v10, v15)`, lane 1 is
/// `(v1, v6, v11, v12)`, lane 0 of `(A1, B1, C1, D1)` is `(v2, v7, v8, v13)`
/// and lane 1 is `(v3, v4, v9, v14)` — exactly the four diagonal `G`s of
/// `BLAKE2_ROUND_NOMSG`. The `D0 = t1; D1 = t0;` swap at the end (which looks
/// like a typo next to the `B` block) is what puts `v15` in lane 0; it is
/// deliberate and must be kept.
macro_rules! diagonalize {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        let t0 = alignr8($b1, $b0);
        let t1 = alignr8($b0, $b1);
        $b0 = t0;
        $b1 = t1;

        core::mem::swap(&mut $c0, &mut $c1);

        let t0 = alignr8($d1, $d0);
        let t1 = alignr8($d0, $d1);
        $d0 = t1;
        $d1 = t0;
    }};
}

/// `UNDIAGONALIZE` from the **SSSE3** branch of `blamka-round-opt.h`, the exact
/// inverse of [`diagonalize`].
macro_rules! undiagonalize {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        let t0 = alignr8($b0, $b1);
        let t1 = alignr8($b1, $b0);
        $b0 = t0;
        $b1 = t1;

        core::mem::swap(&mut $c0, &mut $c1);

        let t0 = alignr8($d0, $d1);
        let t1 = alignr8($d1, $d0);
        $d0 = t1;
        $d1 = t0;
    }};
}

/// `BLAKE2_ROUND(A0, A1, B0, B1, C0, C1, D0, D1)` on eight vectors already held
/// in locals, updated in place.
///
/// The C macro's parameter order is `(A0, A1, B0, B1, C0, C1, D0, D1)` while its
/// body calls `G1(A0, B0, C0, D0, A1, B1, C1, D1)`; the argument list here is in
/// the macro's own order.
macro_rules! round8 {
    ($tbl:ident, $ml:ident, $x32:ident,
                 $a0:ident, $a1:ident, $b0:ident, $b1:ident,
                 $c0:ident, $c1:ident, $d0:ident, $d1:ident) => {{
        g1!($tbl, $ml, $x32, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g2!($tbl, $ml, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);

        diagonalize!($a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);

        g1!($tbl, $ml, $x32, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g2!($tbl, $ml, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);

        undiagonalize!($a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
    }};
}

/// One **column** round with `fill_block`'s prologue fused into it.
///
/// The eight column rounds partition `state[0..64]` into the eight contiguous
/// groups `8k .. 8k+8`, so the `state[i] ^= ref[i]` / `block_xy[i] = ...`
/// prologue for a group can be done in the same registers the round is about to
/// use. That removes one store and one reload of all 64 state slots per block:
/// the values never round-trip through the stack array between the two steps.
///
/// The `with_xor` diamond sits between the XOR and the round rather than around
/// the whole group, so the round itself is emitted once.
macro_rules! col_group {
    ($tbl:ident, $ml:ident, $x32:ident,
     $s:expr, $xy:expr, $refp:expr, $nextp:expr, $with_xor:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr) => {{
        // state[i] = state[i] ^ ref_block[i]
        let mut a0 = veorq_u64($s[$i0], vld1q_u64($refp.add(2 * $i0)));
        let mut a1 = veorq_u64($s[$i1], vld1q_u64($refp.add(2 * $i1)));
        let mut b0 = veorq_u64($s[$i2], vld1q_u64($refp.add(2 * $i2)));
        let mut b1 = veorq_u64($s[$i3], vld1q_u64($refp.add(2 * $i3)));
        let mut c0 = veorq_u64($s[$i4], vld1q_u64($refp.add(2 * $i4)));
        let mut c1 = veorq_u64($s[$i5], vld1q_u64($refp.add(2 * $i5)));
        let mut d0 = veorq_u64($s[$i6], vld1q_u64($refp.add(2 * $i6)));
        let mut d1 = veorq_u64($s[$i7], vld1q_u64($refp.add(2 * $i7)));

        if $with_xor {
            // block_XY[i] = state[i] ^ next_block[i]
            $xy[$i0] = MaybeUninit::new(veorq_u64(a0, vld1q_u64($nextp.add(2 * $i0))));
            $xy[$i1] = MaybeUninit::new(veorq_u64(a1, vld1q_u64($nextp.add(2 * $i1))));
            $xy[$i2] = MaybeUninit::new(veorq_u64(b0, vld1q_u64($nextp.add(2 * $i2))));
            $xy[$i3] = MaybeUninit::new(veorq_u64(b1, vld1q_u64($nextp.add(2 * $i3))));
            $xy[$i4] = MaybeUninit::new(veorq_u64(c0, vld1q_u64($nextp.add(2 * $i4))));
            $xy[$i5] = MaybeUninit::new(veorq_u64(c1, vld1q_u64($nextp.add(2 * $i5))));
            $xy[$i6] = MaybeUninit::new(veorq_u64(d0, vld1q_u64($nextp.add(2 * $i6))));
            $xy[$i7] = MaybeUninit::new(veorq_u64(d1, vld1q_u64($nextp.add(2 * $i7))));
        } else {
            // block_XY[i] = state[i]
            $xy[$i0] = MaybeUninit::new(a0);
            $xy[$i1] = MaybeUninit::new(a1);
            $xy[$i2] = MaybeUninit::new(b0);
            $xy[$i3] = MaybeUninit::new(b1);
            $xy[$i4] = MaybeUninit::new(c0);
            $xy[$i5] = MaybeUninit::new(c1);
            $xy[$i6] = MaybeUninit::new(d0);
            $xy[$i7] = MaybeUninit::new(d1);
        }

        round8!($tbl, $ml, $x32, a0, a1, b0, b1, c0, c1, d0, d1);

        $s[$i0] = a0;
        $s[$i1] = a1;
        $s[$i2] = b0;
        $s[$i3] = b1;
        $s[$i4] = c0;
        $s[$i5] = c1;
        $s[$i6] = d0;
        $s[$i7] = d1;
    }};
}

/// One **row** round with `fill_block`'s epilogue fused into it.
///
/// The eight row rounds partition `state[0..64]` into the eight strided groups
/// `{ j, 8+j, ..., 56+j }`, and the epilogue
/// `state[i] ^= block_XY[i]; next_block[i] = state[i]` is elementwise, so it can
/// run on the round's results while they are still in registers. That removes
/// one reload of all 64 state slots per block.
///
/// `state` is still written back, because `fill_segment` carries it into the
/// next iteration as the previous block.
///
/// # Safety
///
/// Every slot of `$xy` must have been initialised by [`col_group`] first.
macro_rules! row_group {
    ($tbl:ident, $ml:ident, $x32:ident, $s:expr, $xy:expr, $nextp:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr) => {{
        let mut a0 = $s[$i0];
        let mut a1 = $s[$i1];
        let mut b0 = $s[$i2];
        let mut b1 = $s[$i3];
        let mut c0 = $s[$i4];
        let mut c1 = $s[$i5];
        let mut d0 = $s[$i6];
        let mut d1 = $s[$i7];

        round8!($tbl, $ml, $x32, a0, a1, b0, b1, c0, c1, d0, d1);

        a0 = veorq_u64(a0, $xy[$i0].assume_init());
        a1 = veorq_u64(a1, $xy[$i1].assume_init());
        b0 = veorq_u64(b0, $xy[$i2].assume_init());
        b1 = veorq_u64(b1, $xy[$i3].assume_init());
        c0 = veorq_u64(c0, $xy[$i4].assume_init());
        c1 = veorq_u64(c1, $xy[$i5].assume_init());
        d0 = veorq_u64(d0, $xy[$i6].assume_init());
        d1 = veorq_u64(d1, $xy[$i7].assume_init());

        $s[$i0] = a0;
        $s[$i1] = a1;
        $s[$i2] = b0;
        $s[$i3] = b1;
        $s[$i4] = c0;
        $s[$i5] = c1;
        $s[$i6] = d0;
        $s[$i7] = d1;

        vst1q_u64($nextp.add(2 * $i0), a0);
        vst1q_u64($nextp.add(2 * $i1), a1);
        vst1q_u64($nextp.add(2 * $i2), b0);
        vst1q_u64($nextp.add(2 * $i3), b1);
        vst1q_u64($nextp.add(2 * $i4), c0);
        vst1q_u64($nextp.add(2 * $i5), c1);
        vst1q_u64($nextp.add(2 * $i6), d0);
        vst1q_u64($nextp.add(2 * $i7), d1);
    }};
}

/// Two independent [`round8`]s interleaved at `G`-step granularity.
///
/// The eight column rounds are independent of each other, and so are the eight
/// row rounds — each touches a disjoint eighth of `state`. Emitting two of them
/// with their `G` steps adjacent hands the scheduler four independent `fBlaMka`
/// chains instead of two, which is the only lever left on a compression
/// function whose critical path is a chain of dependent multiplies.
///
/// Costs sixteen live vectors instead of eight, out of thirty-two.
macro_rules! round8x2 {
    ($tbl:ident, $ml:ident, $x32:ident,
     $a0:ident, $a1:ident, $b0:ident, $b1:ident, $c0:ident, $c1:ident, $d0:ident, $d1:ident, $e0:ident, $e1:ident, $f0:ident, $f1:ident, $g0:ident, $g1v:ident, $h0:ident, $h1:ident) => {{
        g1!($tbl, $ml, $x32, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g1!($tbl, $ml, $x32, $e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);
        g2!($tbl, $ml, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g2!($tbl, $ml, $e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);

        diagonalize!($a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        diagonalize!($e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);

        g1!($tbl, $ml, $x32, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g1!($tbl, $ml, $x32, $e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);
        g2!($tbl, $ml, $a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        g2!($tbl, $ml, $e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);

        undiagonalize!($a0, $b0, $c0, $d0, $a1, $b1, $c1, $d1);
        undiagonalize!($e0, $f0, $g0, $h0, $e1, $f1, $g1v, $h1);
    }};
}

/// [`col_group`] for two column rounds at once, on top of [`round8x2`].
macro_rules! col_group2 {
    ($tbl:ident, $ml:ident, $x32:ident, $carry:expr, $prevp:expr,
     $s:expr, $xy:expr, $refp:expr, $nextp:expr, $with_xor:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr, $i8:expr, $i9:expr, $i10:expr, $i11:expr, $i12:expr, $i13:expr, $i14:expr, $i15:expr) => {{
        let mut a0 = veorq_u64(
            if $carry {
                $s[$i0]
            } else {
                vld1q_u64($prevp.add(2 * $i0))
            },
            vld1q_u64($refp.add(2 * $i0)),
        );
        let mut a1 = veorq_u64(
            if $carry {
                $s[$i1]
            } else {
                vld1q_u64($prevp.add(2 * $i1))
            },
            vld1q_u64($refp.add(2 * $i1)),
        );
        let mut b0 = veorq_u64(
            if $carry {
                $s[$i2]
            } else {
                vld1q_u64($prevp.add(2 * $i2))
            },
            vld1q_u64($refp.add(2 * $i2)),
        );
        let mut b1 = veorq_u64(
            if $carry {
                $s[$i3]
            } else {
                vld1q_u64($prevp.add(2 * $i3))
            },
            vld1q_u64($refp.add(2 * $i3)),
        );
        let mut c0 = veorq_u64(
            if $carry {
                $s[$i4]
            } else {
                vld1q_u64($prevp.add(2 * $i4))
            },
            vld1q_u64($refp.add(2 * $i4)),
        );
        let mut c1 = veorq_u64(
            if $carry {
                $s[$i5]
            } else {
                vld1q_u64($prevp.add(2 * $i5))
            },
            vld1q_u64($refp.add(2 * $i5)),
        );
        let mut d0 = veorq_u64(
            if $carry {
                $s[$i6]
            } else {
                vld1q_u64($prevp.add(2 * $i6))
            },
            vld1q_u64($refp.add(2 * $i6)),
        );
        let mut d1 = veorq_u64(
            if $carry {
                $s[$i7]
            } else {
                vld1q_u64($prevp.add(2 * $i7))
            },
            vld1q_u64($refp.add(2 * $i7)),
        );
        let mut e0 = veorq_u64(
            if $carry {
                $s[$i8]
            } else {
                vld1q_u64($prevp.add(2 * $i8))
            },
            vld1q_u64($refp.add(2 * $i8)),
        );
        let mut e1 = veorq_u64(
            if $carry {
                $s[$i9]
            } else {
                vld1q_u64($prevp.add(2 * $i9))
            },
            vld1q_u64($refp.add(2 * $i9)),
        );
        let mut f0 = veorq_u64(
            if $carry {
                $s[$i10]
            } else {
                vld1q_u64($prevp.add(2 * $i10))
            },
            vld1q_u64($refp.add(2 * $i10)),
        );
        let mut f1 = veorq_u64(
            if $carry {
                $s[$i11]
            } else {
                vld1q_u64($prevp.add(2 * $i11))
            },
            vld1q_u64($refp.add(2 * $i11)),
        );
        let mut g0 = veorq_u64(
            if $carry {
                $s[$i12]
            } else {
                vld1q_u64($prevp.add(2 * $i12))
            },
            vld1q_u64($refp.add(2 * $i12)),
        );
        let mut g1v = veorq_u64(
            if $carry {
                $s[$i13]
            } else {
                vld1q_u64($prevp.add(2 * $i13))
            },
            vld1q_u64($refp.add(2 * $i13)),
        );
        let mut h0 = veorq_u64(
            if $carry {
                $s[$i14]
            } else {
                vld1q_u64($prevp.add(2 * $i14))
            },
            vld1q_u64($refp.add(2 * $i14)),
        );
        let mut h1 = veorq_u64(
            if $carry {
                $s[$i15]
            } else {
                vld1q_u64($prevp.add(2 * $i15))
            },
            vld1q_u64($refp.add(2 * $i15)),
        );

        if $with_xor {
            $xy[$i0] = MaybeUninit::new(veorq_u64(a0, vld1q_u64($nextp.add(2 * $i0))));
            $xy[$i1] = MaybeUninit::new(veorq_u64(a1, vld1q_u64($nextp.add(2 * $i1))));
            $xy[$i2] = MaybeUninit::new(veorq_u64(b0, vld1q_u64($nextp.add(2 * $i2))));
            $xy[$i3] = MaybeUninit::new(veorq_u64(b1, vld1q_u64($nextp.add(2 * $i3))));
            $xy[$i4] = MaybeUninit::new(veorq_u64(c0, vld1q_u64($nextp.add(2 * $i4))));
            $xy[$i5] = MaybeUninit::new(veorq_u64(c1, vld1q_u64($nextp.add(2 * $i5))));
            $xy[$i6] = MaybeUninit::new(veorq_u64(d0, vld1q_u64($nextp.add(2 * $i6))));
            $xy[$i7] = MaybeUninit::new(veorq_u64(d1, vld1q_u64($nextp.add(2 * $i7))));
            $xy[$i8] = MaybeUninit::new(veorq_u64(e0, vld1q_u64($nextp.add(2 * $i8))));
            $xy[$i9] = MaybeUninit::new(veorq_u64(e1, vld1q_u64($nextp.add(2 * $i9))));
            $xy[$i10] = MaybeUninit::new(veorq_u64(f0, vld1q_u64($nextp.add(2 * $i10))));
            $xy[$i11] = MaybeUninit::new(veorq_u64(f1, vld1q_u64($nextp.add(2 * $i11))));
            $xy[$i12] = MaybeUninit::new(veorq_u64(g0, vld1q_u64($nextp.add(2 * $i12))));
            $xy[$i13] = MaybeUninit::new(veorq_u64(g1v, vld1q_u64($nextp.add(2 * $i13))));
            $xy[$i14] = MaybeUninit::new(veorq_u64(h0, vld1q_u64($nextp.add(2 * $i14))));
            $xy[$i15] = MaybeUninit::new(veorq_u64(h1, vld1q_u64($nextp.add(2 * $i15))));
        } else {
            $xy[$i0] = MaybeUninit::new(a0);
            $xy[$i1] = MaybeUninit::new(a1);
            $xy[$i2] = MaybeUninit::new(b0);
            $xy[$i3] = MaybeUninit::new(b1);
            $xy[$i4] = MaybeUninit::new(c0);
            $xy[$i5] = MaybeUninit::new(c1);
            $xy[$i6] = MaybeUninit::new(d0);
            $xy[$i7] = MaybeUninit::new(d1);
            $xy[$i8] = MaybeUninit::new(e0);
            $xy[$i9] = MaybeUninit::new(e1);
            $xy[$i10] = MaybeUninit::new(f0);
            $xy[$i11] = MaybeUninit::new(f1);
            $xy[$i12] = MaybeUninit::new(g0);
            $xy[$i13] = MaybeUninit::new(g1v);
            $xy[$i14] = MaybeUninit::new(h0);
            $xy[$i15] = MaybeUninit::new(h1);
        }

        round8x2!(
            $tbl, $ml, $x32, a0, a1, b0, b1, c0, c1, d0, d1, e0, e1, f0, f1, g0, g1v, h0, h1
        );

        $s[$i0] = a0;
        $s[$i1] = a1;
        $s[$i2] = b0;
        $s[$i3] = b1;
        $s[$i4] = c0;
        $s[$i5] = c1;
        $s[$i6] = d0;
        $s[$i7] = d1;
        $s[$i8] = e0;
        $s[$i9] = e1;
        $s[$i10] = f0;
        $s[$i11] = f1;
        $s[$i12] = g0;
        $s[$i13] = g1v;
        $s[$i14] = h0;
        $s[$i15] = h1;
    }};
}

/// [`row_group`] for two row rounds at once, on top of [`round8x2`].
///
/// # Safety
///
/// Every slot of `$xy` must have been initialised by [`col_group2`] first.
macro_rules! row_group2 {
    ($tbl:ident, $ml:ident, $x32:ident, $carry:expr, $s:expr, $xy:expr, $nextp:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr, $i8:expr, $i9:expr, $i10:expr, $i11:expr, $i12:expr, $i13:expr, $i14:expr, $i15:expr) => {{
        let mut a0 = $s[$i0];
        let mut a1 = $s[$i1];
        let mut b0 = $s[$i2];
        let mut b1 = $s[$i3];
        let mut c0 = $s[$i4];
        let mut c1 = $s[$i5];
        let mut d0 = $s[$i6];
        let mut d1 = $s[$i7];
        let mut e0 = $s[$i8];
        let mut e1 = $s[$i9];
        let mut f0 = $s[$i10];
        let mut f1 = $s[$i11];
        let mut g0 = $s[$i12];
        let mut g1v = $s[$i13];
        let mut h0 = $s[$i14];
        let mut h1 = $s[$i15];

        round8x2!(
            $tbl, $ml, $x32, a0, a1, b0, b1, c0, c1, d0, d1, e0, e1, f0, f1, g0, g1v, h0, h1
        );

        a0 = veorq_u64(a0, $xy[$i0].assume_init());
        a1 = veorq_u64(a1, $xy[$i1].assume_init());
        b0 = veorq_u64(b0, $xy[$i2].assume_init());
        b1 = veorq_u64(b1, $xy[$i3].assume_init());
        c0 = veorq_u64(c0, $xy[$i4].assume_init());
        c1 = veorq_u64(c1, $xy[$i5].assume_init());
        d0 = veorq_u64(d0, $xy[$i6].assume_init());
        d1 = veorq_u64(d1, $xy[$i7].assume_init());
        e0 = veorq_u64(e0, $xy[$i8].assume_init());
        e1 = veorq_u64(e1, $xy[$i9].assume_init());
        f0 = veorq_u64(f0, $xy[$i10].assume_init());
        f1 = veorq_u64(f1, $xy[$i11].assume_init());
        g0 = veorq_u64(g0, $xy[$i12].assume_init());
        g1v = veorq_u64(g1v, $xy[$i13].assume_init());
        h0 = veorq_u64(h0, $xy[$i14].assume_init());
        h1 = veorq_u64(h1, $xy[$i15].assume_init());

        // Only when `state` is carried across `fill_block` calls; see
        // `FUSED2_PREV`. `$carry` is a const-generic comparison, so one arm
        // of this is folded away at monomorphisation.
        if $carry {
            $s[$i0] = a0;
            $s[$i1] = a1;
            $s[$i2] = b0;
            $s[$i3] = b1;
            $s[$i4] = c0;
            $s[$i5] = c1;
            $s[$i6] = d0;
            $s[$i7] = d1;
            $s[$i8] = e0;
            $s[$i9] = e1;
            $s[$i10] = f0;
            $s[$i11] = f1;
            $s[$i12] = g0;
            $s[$i13] = g1v;
            $s[$i14] = h0;
            $s[$i15] = h1;
        }

        vst1q_u64($nextp.add(2 * $i0), a0);
        vst1q_u64($nextp.add(2 * $i1), a1);
        vst1q_u64($nextp.add(2 * $i2), b0);
        vst1q_u64($nextp.add(2 * $i3), b1);
        vst1q_u64($nextp.add(2 * $i4), c0);
        vst1q_u64($nextp.add(2 * $i5), c1);
        vst1q_u64($nextp.add(2 * $i6), d0);
        vst1q_u64($nextp.add(2 * $i7), d1);
        vst1q_u64($nextp.add(2 * $i8), e0);
        vst1q_u64($nextp.add(2 * $i9), e1);
        vst1q_u64($nextp.add(2 * $i10), f0);
        vst1q_u64($nextp.add(2 * $i11), f1);
        vst1q_u64($nextp.add(2 * $i12), g0);
        vst1q_u64($nextp.add(2 * $i13), g1v);
        vst1q_u64($nextp.add(2 * $i14), h0);
        vst1q_u64($nextp.add(2 * $i15), h1);
    }};
}

/// Four independent [`round8`]s interleaved at `G`-step granularity.
///
/// Costs all thirty-two live vectors before any temporary, so whether it is
/// faster than [`round8x2`] is entirely a question of how much the spilling
/// costs against the extra instruction-level parallelism. Measured; see the
/// interleaving-depth table in the module docs.
macro_rules! round8x4 {
    ($tbl:ident, $ml:ident, $x32:ident,
     $a00:ident, $a01:ident, $b00:ident, $b01:ident, $c00:ident, $c01:ident, $d00:ident, $d01:ident, $a10:ident, $a11:ident, $b10:ident, $b11:ident, $c10:ident, $c11:ident, $d10:ident, $d11:ident, $a20:ident, $a21:ident, $b20:ident, $b21:ident, $c20:ident, $c21:ident, $d20:ident, $d21:ident, $a30:ident, $a31:ident, $b30:ident, $b31:ident, $c30:ident, $c31:ident, $d30:ident, $d31:ident) => {{
        g1!(
            $tbl, $ml, $x32, $a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01
        );
        g1!(
            $tbl, $ml, $x32, $a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11
        );
        g1!(
            $tbl, $ml, $x32, $a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21
        );
        g1!(
            $tbl, $ml, $x32, $a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31
        );
        g2!($tbl, $ml, $a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01);
        g2!($tbl, $ml, $a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11);
        g2!($tbl, $ml, $a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21);
        g2!($tbl, $ml, $a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31);
        diagonalize!($a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01);
        diagonalize!($a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11);
        diagonalize!($a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21);
        diagonalize!($a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31);
        g1!(
            $tbl, $ml, $x32, $a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01
        );
        g1!(
            $tbl, $ml, $x32, $a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11
        );
        g1!(
            $tbl, $ml, $x32, $a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21
        );
        g1!(
            $tbl, $ml, $x32, $a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31
        );
        g2!($tbl, $ml, $a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01);
        g2!($tbl, $ml, $a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11);
        g2!($tbl, $ml, $a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21);
        g2!($tbl, $ml, $a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31);
        undiagonalize!($a00, $b00, $c00, $d00, $a01, $b01, $c01, $d01);
        undiagonalize!($a10, $b10, $c10, $d10, $a11, $b11, $c11, $d11);
        undiagonalize!($a20, $b20, $c20, $d20, $a21, $b21, $c21, $d21);
        undiagonalize!($a30, $b30, $c30, $d30, $a31, $b31, $c31, $d31);
    }};
}

/// [`col_group`] for four column rounds at once, on top of [`round8x4`].
macro_rules! col_group4 {
    ($tbl:ident, $ml:ident, $x32:ident,
     $s:expr, $xy:expr, $refp:expr, $nextp:expr, $with_xor:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr, $i8:expr, $i9:expr, $i10:expr, $i11:expr, $i12:expr, $i13:expr, $i14:expr, $i15:expr, $i16:expr, $i17:expr, $i18:expr, $i19:expr, $i20:expr, $i21:expr, $i22:expr, $i23:expr, $i24:expr, $i25:expr, $i26:expr, $i27:expr, $i28:expr, $i29:expr, $i30:expr, $i31:expr) => {{
        let mut a00 = veorq_u64($s[$i0], vld1q_u64($refp.add(2 * $i0)));
        let mut a01 = veorq_u64($s[$i1], vld1q_u64($refp.add(2 * $i1)));
        let mut b00 = veorq_u64($s[$i2], vld1q_u64($refp.add(2 * $i2)));
        let mut b01 = veorq_u64($s[$i3], vld1q_u64($refp.add(2 * $i3)));
        let mut c00 = veorq_u64($s[$i4], vld1q_u64($refp.add(2 * $i4)));
        let mut c01 = veorq_u64($s[$i5], vld1q_u64($refp.add(2 * $i5)));
        let mut d00 = veorq_u64($s[$i6], vld1q_u64($refp.add(2 * $i6)));
        let mut d01 = veorq_u64($s[$i7], vld1q_u64($refp.add(2 * $i7)));
        let mut a10 = veorq_u64($s[$i8], vld1q_u64($refp.add(2 * $i8)));
        let mut a11 = veorq_u64($s[$i9], vld1q_u64($refp.add(2 * $i9)));
        let mut b10 = veorq_u64($s[$i10], vld1q_u64($refp.add(2 * $i10)));
        let mut b11 = veorq_u64($s[$i11], vld1q_u64($refp.add(2 * $i11)));
        let mut c10 = veorq_u64($s[$i12], vld1q_u64($refp.add(2 * $i12)));
        let mut c11 = veorq_u64($s[$i13], vld1q_u64($refp.add(2 * $i13)));
        let mut d10 = veorq_u64($s[$i14], vld1q_u64($refp.add(2 * $i14)));
        let mut d11 = veorq_u64($s[$i15], vld1q_u64($refp.add(2 * $i15)));
        let mut a20 = veorq_u64($s[$i16], vld1q_u64($refp.add(2 * $i16)));
        let mut a21 = veorq_u64($s[$i17], vld1q_u64($refp.add(2 * $i17)));
        let mut b20 = veorq_u64($s[$i18], vld1q_u64($refp.add(2 * $i18)));
        let mut b21 = veorq_u64($s[$i19], vld1q_u64($refp.add(2 * $i19)));
        let mut c20 = veorq_u64($s[$i20], vld1q_u64($refp.add(2 * $i20)));
        let mut c21 = veorq_u64($s[$i21], vld1q_u64($refp.add(2 * $i21)));
        let mut d20 = veorq_u64($s[$i22], vld1q_u64($refp.add(2 * $i22)));
        let mut d21 = veorq_u64($s[$i23], vld1q_u64($refp.add(2 * $i23)));
        let mut a30 = veorq_u64($s[$i24], vld1q_u64($refp.add(2 * $i24)));
        let mut a31 = veorq_u64($s[$i25], vld1q_u64($refp.add(2 * $i25)));
        let mut b30 = veorq_u64($s[$i26], vld1q_u64($refp.add(2 * $i26)));
        let mut b31 = veorq_u64($s[$i27], vld1q_u64($refp.add(2 * $i27)));
        let mut c30 = veorq_u64($s[$i28], vld1q_u64($refp.add(2 * $i28)));
        let mut c31 = veorq_u64($s[$i29], vld1q_u64($refp.add(2 * $i29)));
        let mut d30 = veorq_u64($s[$i30], vld1q_u64($refp.add(2 * $i30)));
        let mut d31 = veorq_u64($s[$i31], vld1q_u64($refp.add(2 * $i31)));

        if $with_xor {
            $xy[$i0] = MaybeUninit::new(veorq_u64(a00, vld1q_u64($nextp.add(2 * $i0))));
            $xy[$i1] = MaybeUninit::new(veorq_u64(a01, vld1q_u64($nextp.add(2 * $i1))));
            $xy[$i2] = MaybeUninit::new(veorq_u64(b00, vld1q_u64($nextp.add(2 * $i2))));
            $xy[$i3] = MaybeUninit::new(veorq_u64(b01, vld1q_u64($nextp.add(2 * $i3))));
            $xy[$i4] = MaybeUninit::new(veorq_u64(c00, vld1q_u64($nextp.add(2 * $i4))));
            $xy[$i5] = MaybeUninit::new(veorq_u64(c01, vld1q_u64($nextp.add(2 * $i5))));
            $xy[$i6] = MaybeUninit::new(veorq_u64(d00, vld1q_u64($nextp.add(2 * $i6))));
            $xy[$i7] = MaybeUninit::new(veorq_u64(d01, vld1q_u64($nextp.add(2 * $i7))));
            $xy[$i8] = MaybeUninit::new(veorq_u64(a10, vld1q_u64($nextp.add(2 * $i8))));
            $xy[$i9] = MaybeUninit::new(veorq_u64(a11, vld1q_u64($nextp.add(2 * $i9))));
            $xy[$i10] = MaybeUninit::new(veorq_u64(b10, vld1q_u64($nextp.add(2 * $i10))));
            $xy[$i11] = MaybeUninit::new(veorq_u64(b11, vld1q_u64($nextp.add(2 * $i11))));
            $xy[$i12] = MaybeUninit::new(veorq_u64(c10, vld1q_u64($nextp.add(2 * $i12))));
            $xy[$i13] = MaybeUninit::new(veorq_u64(c11, vld1q_u64($nextp.add(2 * $i13))));
            $xy[$i14] = MaybeUninit::new(veorq_u64(d10, vld1q_u64($nextp.add(2 * $i14))));
            $xy[$i15] = MaybeUninit::new(veorq_u64(d11, vld1q_u64($nextp.add(2 * $i15))));
            $xy[$i16] = MaybeUninit::new(veorq_u64(a20, vld1q_u64($nextp.add(2 * $i16))));
            $xy[$i17] = MaybeUninit::new(veorq_u64(a21, vld1q_u64($nextp.add(2 * $i17))));
            $xy[$i18] = MaybeUninit::new(veorq_u64(b20, vld1q_u64($nextp.add(2 * $i18))));
            $xy[$i19] = MaybeUninit::new(veorq_u64(b21, vld1q_u64($nextp.add(2 * $i19))));
            $xy[$i20] = MaybeUninit::new(veorq_u64(c20, vld1q_u64($nextp.add(2 * $i20))));
            $xy[$i21] = MaybeUninit::new(veorq_u64(c21, vld1q_u64($nextp.add(2 * $i21))));
            $xy[$i22] = MaybeUninit::new(veorq_u64(d20, vld1q_u64($nextp.add(2 * $i22))));
            $xy[$i23] = MaybeUninit::new(veorq_u64(d21, vld1q_u64($nextp.add(2 * $i23))));
            $xy[$i24] = MaybeUninit::new(veorq_u64(a30, vld1q_u64($nextp.add(2 * $i24))));
            $xy[$i25] = MaybeUninit::new(veorq_u64(a31, vld1q_u64($nextp.add(2 * $i25))));
            $xy[$i26] = MaybeUninit::new(veorq_u64(b30, vld1q_u64($nextp.add(2 * $i26))));
            $xy[$i27] = MaybeUninit::new(veorq_u64(b31, vld1q_u64($nextp.add(2 * $i27))));
            $xy[$i28] = MaybeUninit::new(veorq_u64(c30, vld1q_u64($nextp.add(2 * $i28))));
            $xy[$i29] = MaybeUninit::new(veorq_u64(c31, vld1q_u64($nextp.add(2 * $i29))));
            $xy[$i30] = MaybeUninit::new(veorq_u64(d30, vld1q_u64($nextp.add(2 * $i30))));
            $xy[$i31] = MaybeUninit::new(veorq_u64(d31, vld1q_u64($nextp.add(2 * $i31))));
        } else {
            $xy[$i0] = MaybeUninit::new(a00);
            $xy[$i1] = MaybeUninit::new(a01);
            $xy[$i2] = MaybeUninit::new(b00);
            $xy[$i3] = MaybeUninit::new(b01);
            $xy[$i4] = MaybeUninit::new(c00);
            $xy[$i5] = MaybeUninit::new(c01);
            $xy[$i6] = MaybeUninit::new(d00);
            $xy[$i7] = MaybeUninit::new(d01);
            $xy[$i8] = MaybeUninit::new(a10);
            $xy[$i9] = MaybeUninit::new(a11);
            $xy[$i10] = MaybeUninit::new(b10);
            $xy[$i11] = MaybeUninit::new(b11);
            $xy[$i12] = MaybeUninit::new(c10);
            $xy[$i13] = MaybeUninit::new(c11);
            $xy[$i14] = MaybeUninit::new(d10);
            $xy[$i15] = MaybeUninit::new(d11);
            $xy[$i16] = MaybeUninit::new(a20);
            $xy[$i17] = MaybeUninit::new(a21);
            $xy[$i18] = MaybeUninit::new(b20);
            $xy[$i19] = MaybeUninit::new(b21);
            $xy[$i20] = MaybeUninit::new(c20);
            $xy[$i21] = MaybeUninit::new(c21);
            $xy[$i22] = MaybeUninit::new(d20);
            $xy[$i23] = MaybeUninit::new(d21);
            $xy[$i24] = MaybeUninit::new(a30);
            $xy[$i25] = MaybeUninit::new(a31);
            $xy[$i26] = MaybeUninit::new(b30);
            $xy[$i27] = MaybeUninit::new(b31);
            $xy[$i28] = MaybeUninit::new(c30);
            $xy[$i29] = MaybeUninit::new(c31);
            $xy[$i30] = MaybeUninit::new(d30);
            $xy[$i31] = MaybeUninit::new(d31);
        }

        round8x4!(
            $tbl, $ml, $x32, a00, a01, b00, b01, c00, c01, d00, d01, a10, a11, b10, b11, c10, c11,
            d10, d11, a20, a21, b20, b21, c20, c21, d20, d21, a30, a31, b30, b31, c30, c31, d30,
            d31
        );

        $s[$i0] = a00;
        $s[$i1] = a01;
        $s[$i2] = b00;
        $s[$i3] = b01;
        $s[$i4] = c00;
        $s[$i5] = c01;
        $s[$i6] = d00;
        $s[$i7] = d01;
        $s[$i8] = a10;
        $s[$i9] = a11;
        $s[$i10] = b10;
        $s[$i11] = b11;
        $s[$i12] = c10;
        $s[$i13] = c11;
        $s[$i14] = d10;
        $s[$i15] = d11;
        $s[$i16] = a20;
        $s[$i17] = a21;
        $s[$i18] = b20;
        $s[$i19] = b21;
        $s[$i20] = c20;
        $s[$i21] = c21;
        $s[$i22] = d20;
        $s[$i23] = d21;
        $s[$i24] = a30;
        $s[$i25] = a31;
        $s[$i26] = b30;
        $s[$i27] = b31;
        $s[$i28] = c30;
        $s[$i29] = c31;
        $s[$i30] = d30;
        $s[$i31] = d31;
    }};
}

/// [`row_group`] for four row rounds at once, on top of [`round8x4`].
///
/// # Safety
///
/// Every slot of `$xy` must have been initialised by [`col_group4`] first.
macro_rules! row_group4 {
    ($tbl:ident, $ml:ident, $x32:ident, $s:expr, $xy:expr, $nextp:expr,
     $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr, $i8:expr, $i9:expr, $i10:expr, $i11:expr, $i12:expr, $i13:expr, $i14:expr, $i15:expr, $i16:expr, $i17:expr, $i18:expr, $i19:expr, $i20:expr, $i21:expr, $i22:expr, $i23:expr, $i24:expr, $i25:expr, $i26:expr, $i27:expr, $i28:expr, $i29:expr, $i30:expr, $i31:expr) => {{
        let mut a00 = $s[$i0];
        let mut a01 = $s[$i1];
        let mut b00 = $s[$i2];
        let mut b01 = $s[$i3];
        let mut c00 = $s[$i4];
        let mut c01 = $s[$i5];
        let mut d00 = $s[$i6];
        let mut d01 = $s[$i7];
        let mut a10 = $s[$i8];
        let mut a11 = $s[$i9];
        let mut b10 = $s[$i10];
        let mut b11 = $s[$i11];
        let mut c10 = $s[$i12];
        let mut c11 = $s[$i13];
        let mut d10 = $s[$i14];
        let mut d11 = $s[$i15];
        let mut a20 = $s[$i16];
        let mut a21 = $s[$i17];
        let mut b20 = $s[$i18];
        let mut b21 = $s[$i19];
        let mut c20 = $s[$i20];
        let mut c21 = $s[$i21];
        let mut d20 = $s[$i22];
        let mut d21 = $s[$i23];
        let mut a30 = $s[$i24];
        let mut a31 = $s[$i25];
        let mut b30 = $s[$i26];
        let mut b31 = $s[$i27];
        let mut c30 = $s[$i28];
        let mut c31 = $s[$i29];
        let mut d30 = $s[$i30];
        let mut d31 = $s[$i31];

        round8x4!(
            $tbl, $ml, $x32, a00, a01, b00, b01, c00, c01, d00, d01, a10, a11, b10, b11, c10, c11,
            d10, d11, a20, a21, b20, b21, c20, c21, d20, d21, a30, a31, b30, b31, c30, c31, d30,
            d31
        );

        a00 = veorq_u64(a00, $xy[$i0].assume_init());
        a01 = veorq_u64(a01, $xy[$i1].assume_init());
        b00 = veorq_u64(b00, $xy[$i2].assume_init());
        b01 = veorq_u64(b01, $xy[$i3].assume_init());
        c00 = veorq_u64(c00, $xy[$i4].assume_init());
        c01 = veorq_u64(c01, $xy[$i5].assume_init());
        d00 = veorq_u64(d00, $xy[$i6].assume_init());
        d01 = veorq_u64(d01, $xy[$i7].assume_init());
        a10 = veorq_u64(a10, $xy[$i8].assume_init());
        a11 = veorq_u64(a11, $xy[$i9].assume_init());
        b10 = veorq_u64(b10, $xy[$i10].assume_init());
        b11 = veorq_u64(b11, $xy[$i11].assume_init());
        c10 = veorq_u64(c10, $xy[$i12].assume_init());
        c11 = veorq_u64(c11, $xy[$i13].assume_init());
        d10 = veorq_u64(d10, $xy[$i14].assume_init());
        d11 = veorq_u64(d11, $xy[$i15].assume_init());
        a20 = veorq_u64(a20, $xy[$i16].assume_init());
        a21 = veorq_u64(a21, $xy[$i17].assume_init());
        b20 = veorq_u64(b20, $xy[$i18].assume_init());
        b21 = veorq_u64(b21, $xy[$i19].assume_init());
        c20 = veorq_u64(c20, $xy[$i20].assume_init());
        c21 = veorq_u64(c21, $xy[$i21].assume_init());
        d20 = veorq_u64(d20, $xy[$i22].assume_init());
        d21 = veorq_u64(d21, $xy[$i23].assume_init());
        a30 = veorq_u64(a30, $xy[$i24].assume_init());
        a31 = veorq_u64(a31, $xy[$i25].assume_init());
        b30 = veorq_u64(b30, $xy[$i26].assume_init());
        b31 = veorq_u64(b31, $xy[$i27].assume_init());
        c30 = veorq_u64(c30, $xy[$i28].assume_init());
        c31 = veorq_u64(c31, $xy[$i29].assume_init());
        d30 = veorq_u64(d30, $xy[$i30].assume_init());
        d31 = veorq_u64(d31, $xy[$i31].assume_init());

        $s[$i0] = a00;
        $s[$i1] = a01;
        $s[$i2] = b00;
        $s[$i3] = b01;
        $s[$i4] = c00;
        $s[$i5] = c01;
        $s[$i6] = d00;
        $s[$i7] = d01;
        $s[$i8] = a10;
        $s[$i9] = a11;
        $s[$i10] = b10;
        $s[$i11] = b11;
        $s[$i12] = c10;
        $s[$i13] = c11;
        $s[$i14] = d10;
        $s[$i15] = d11;
        $s[$i16] = a20;
        $s[$i17] = a21;
        $s[$i18] = b20;
        $s[$i19] = b21;
        $s[$i20] = c20;
        $s[$i21] = c21;
        $s[$i22] = d20;
        $s[$i23] = d21;
        $s[$i24] = a30;
        $s[$i25] = a31;
        $s[$i26] = b30;
        $s[$i27] = b31;
        $s[$i28] = c30;
        $s[$i29] = c31;
        $s[$i30] = d30;
        $s[$i31] = d31;

        vst1q_u64($nextp.add(2 * $i0), a00);
        vst1q_u64($nextp.add(2 * $i1), a01);
        vst1q_u64($nextp.add(2 * $i2), b00);
        vst1q_u64($nextp.add(2 * $i3), b01);
        vst1q_u64($nextp.add(2 * $i4), c00);
        vst1q_u64($nextp.add(2 * $i5), c01);
        vst1q_u64($nextp.add(2 * $i6), d00);
        vst1q_u64($nextp.add(2 * $i7), d01);
        vst1q_u64($nextp.add(2 * $i8), a10);
        vst1q_u64($nextp.add(2 * $i9), a11);
        vst1q_u64($nextp.add(2 * $i10), b10);
        vst1q_u64($nextp.add(2 * $i11), b11);
        vst1q_u64($nextp.add(2 * $i12), c10);
        vst1q_u64($nextp.add(2 * $i13), c11);
        vst1q_u64($nextp.add(2 * $i14), d10);
        vst1q_u64($nextp.add(2 * $i15), d11);
        vst1q_u64($nextp.add(2 * $i16), a20);
        vst1q_u64($nextp.add(2 * $i17), a21);
        vst1q_u64($nextp.add(2 * $i18), b20);
        vst1q_u64($nextp.add(2 * $i19), b21);
        vst1q_u64($nextp.add(2 * $i20), c20);
        vst1q_u64($nextp.add(2 * $i21), c21);
        vst1q_u64($nextp.add(2 * $i22), d20);
        vst1q_u64($nextp.add(2 * $i23), d21);
        vst1q_u64($nextp.add(2 * $i24), a30);
        vst1q_u64($nextp.add(2 * $i25), a31);
        vst1q_u64($nextp.add(2 * $i26), b30);
        vst1q_u64($nextp.add(2 * $i27), b31);
        vst1q_u64($nextp.add(2 * $i28), c30);
        vst1q_u64($nextp.add(2 * $i29), c31);
        vst1q_u64($nextp.add(2 * $i30), d30);
        vst1q_u64($nextp.add(2 * $i31), d31);
    }};
}

// ---------------------------------------------------------------------------
// opt.c, 128-bit path
// ---------------------------------------------------------------------------

/// The 64 x 128-bit working state, `__m128i state[ARGON2_OWORDS_IN_BLOCK]`.
///
/// `state[i]` holds block words `2i` and `2i + 1`.
type State = [uint64x2_t; OWORDS_IN_BLOCK];

/// A zeroed [`State`], `memset(zero_block, 0, sizeof(zero_block))`.
#[inline(always)]
unsafe fn zero_state() -> State {
    // SAFETY: `zero()` is safe to call on any aarch64 CPU; see its own comment.
    [unsafe { zero() }; OWORDS_IN_BLOCK]
}

/// `fill_block()` from the `#else /* SSE2 */` branch of `src/opt.c`.
///
/// ```c
/// if (with_xor) {
///     state[i]    = state[i] ^ ref_block[i];
///     block_XY[i] = state[i] ^ next_block[i];
/// } else {
///     block_XY[i] = state[i] = state[i] ^ ref_block[i];
/// }
/// 8 column rounds over state[8i + 0 .. 8i + 8]
/// 8 row    rounds over state[8j + i] for j = 0..8
/// state[i] ^= block_XY[i];  store state[i] into next_block
/// ```
///
/// `state` comes in holding the **previous** block and goes out holding the
/// block just produced, which is what lets `fill_segment` skip re-reading the
/// previous block from the arena on every iteration.
///
/// Equivalent to `src/ref.c`'s `fill_block(prev, ref, next, with_xor)`:
/// `state ^ ref` is `ref.c`'s `blockR`, `block_XY` is its `block_tmp`, and the
/// final `state ^ block_XY` is `block_tmp ^ blockR`.
///
/// # Safety
///
/// * `ref_block` must be valid for reads of 128 `u64`s;
/// * `next_block` must be valid for writes of 128 `u64`s, and for reads too when
///   `with_xor` is `true`;
/// * the two may alias (`next_addresses` relies on it): every read of
///   `ref_block` — and of `next_block`, when `with_xor` — happens in the column
///   groups, and every write to `next_block` happens in the row groups, which
///   run strictly after all of them. They must not alias `state`.
#[inline(always)]
unsafe fn fill_block<const TBL: bool, const ML: u8, const X32: bool, const V: u8>(
    state: &mut State,
    prev_block: *const u64,
    ref_block: *const u64,
    next_block: *mut u64,
    with_xor: bool,
) {
    // `V` selects between the two shapes below and nothing else is handled, so
    // an unknown value would compile to a silent no-op rather than to a wrong
    // answer. Reject it at monomorphisation time instead.
    const {
        assert!(
            V == FUSED || V == FUSED2 || V == FUSED2_PREV || V == FUSED4,
            "unknown fill_block shape"
        )
    };

    // SAFETY: the pointers are valid for a whole block by the contract above,
    // and `i < OWORDS_IN_BLOCK == 64` so `2 * i + 1 <= 127` stays inside it.
    unsafe {
        // `opt.c` declares `__m128i block_XY[64];` UNINITIALISED, and so does
        // this. Spelling it `zero_state()` costs a real 1 KiB `bl _bzero` **per
        // block**: LLVM does not eliminate it, because the two arms of
        // `if with_xor` fill the array in separate basic blocks and dead-store
        // elimination never sees a single whole-array overwrite. Measured in
        // the disassembly, not assumed — see the module docs.
        //
        // SAFETY of every `assume_init` below: all 64 slots are written before
        // any is read, on both arms and in both variants.
        let mut block_xy: [MaybeUninit<uint64x2_t>; OWORDS_IN_BLOCK] =
            [const { MaybeUninit::uninit() }; OWORDS_IN_BLOCK];

        if V == FUSED2 || V == FUSED2_PREV {
            // As `FUSED`, but two rounds at a time; see `round8x2!`.
            //
            // `carry` is a comparison of const-generic parameters, so it is a
            // compile-time constant and the arms it guards inside `col_group2!`
            // / `row_group2!` are folded away at monomorphisation. Verified in
            // the disassembly: no branch survives, and the `FUSED2_PREV` build
            // emits 64 fewer stores per block.
            let carry = V != FUSED2_PREV;
            let prevp = prev_block;
            let refp = ref_block;
            let nextp = next_block.cast_const();

            col_group2!(
                TBL, ML, X32, carry, prevp, state, block_xy, refp, nextp, with_xor, 0, 1, 2, 3, 4,
                5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
            );
            col_group2!(
                TBL, ML, X32, carry, prevp, state, block_xy, refp, nextp, with_xor, 16, 17, 18, 19,
                20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31
            );
            col_group2!(
                TBL, ML, X32, carry, prevp, state, block_xy, refp, nextp, with_xor, 32, 33, 34, 35,
                36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47
            );
            col_group2!(
                TBL, ML, X32, carry, prevp, state, block_xy, refp, nextp, with_xor, 48, 49, 50, 51,
                52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63
            );

            row_group2!(
                TBL, ML, X32, carry, state, block_xy, next_block, 0, 8, 16, 24, 32, 40, 48, 56, 1,
                9, 17, 25, 33, 41, 49, 57
            );
            row_group2!(
                TBL, ML, X32, carry, state, block_xy, next_block, 2, 10, 18, 26, 34, 42, 50, 58, 3,
                11, 19, 27, 35, 43, 51, 59
            );
            row_group2!(
                TBL, ML, X32, carry, state, block_xy, next_block, 4, 12, 20, 28, 36, 44, 52, 60, 5,
                13, 21, 29, 37, 45, 53, 61
            );
            row_group2!(
                TBL, ML, X32, carry, state, block_xy, next_block, 6, 14, 22, 30, 38, 46, 54, 62, 7,
                15, 23, 31, 39, 47, 55, 63
            );
        } else if V == FUSED4 {
            // Four rounds at a time; see `round8x4!`.
            let refp = ref_block;
            let nextp = next_block.cast_const();

            col_group4!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
                10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
                31
            );
            col_group4!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 32, 33, 34, 35, 36, 37, 38,
                39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
                60, 61, 62, 63
            );

            row_group4!(
                TBL, ML, X32, state, block_xy, next_block, 0, 8, 16, 24, 32, 40, 48, 56, 1, 9, 17,
                25, 33, 41, 49, 57, 2, 10, 18, 26, 34, 42, 50, 58, 3, 11, 19, 27, 35, 43, 51, 59
            );
            row_group4!(
                TBL, ML, X32, state, block_xy, next_block, 4, 12, 20, 28, 36, 44, 52, 60, 5, 13,
                21, 29, 37, 45, 53, 61, 6, 14, 22, 30, 38, 46, 54, 62, 7, 15, 23, 31, 39, 47, 55,
                63
            );
        } else if V == FUSED {
            // Prologue fused into the eight column rounds, epilogue fused into
            // the eight row rounds. See `col_group!` / `row_group!`.
            let refp = ref_block;
            let nextp = next_block.cast_const();

            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 0, 1, 2, 3, 4, 5, 6, 7
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 8, 9, 10, 11, 12, 13, 14, 15
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 16, 17, 18, 19, 20, 21, 22,
                23
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 24, 25, 26, 27, 28, 29, 30,
                31
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 32, 33, 34, 35, 36, 37, 38,
                39
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 40, 41, 42, 43, 44, 45, 46,
                47
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 48, 49, 50, 51, 52, 53, 54,
                55
            );
            col_group!(
                TBL, ML, X32, state, block_xy, refp, nextp, with_xor, 56, 57, 58, 59, 60, 61, 62,
                63
            );

            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 0, 8, 16, 24, 32, 40, 48, 56
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 1, 9, 17, 25, 33, 41, 49, 57
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 2, 10, 18, 26, 34, 42, 50, 58
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 3, 11, 19, 27, 35, 43, 51, 59
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 4, 12, 20, 28, 36, 44, 52, 60
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 5, 13, 21, 29, 37, 45, 53, 61
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 6, 14, 22, 30, 38, 46, 54, 62
            );
            row_group!(
                TBL, ML, X32, state, block_xy, next_block, 7, 15, 23, 31, 39, 47, 55, 63
            );
        }

        // `V` is a const generic and every instantiation is one of the two
        // shapes above, so exactly one of the two blocks survives inlining.
    }
}

/// `next_addresses()` from `src/opt.c`.
///
/// ```c
/// __m128i zero_block[64], zero2_block[64];
/// memset(zero_block, 0, ...);  memset(zero2_block, 0, ...);
/// input_block->v[6]++;
/// fill_block(zero_block,  input_block,   address_block, 0);
/// fill_block(zero2_block, address_block, address_block, 0);
/// ```
///
/// Two separate zeroed states are needed because `fill_block` leaves its result
/// in `state`, so the second call must start from zero again. The counter is
/// bumped **before** both calls.
///
/// The second call passes the same block as `ref` and `next`. That is fine —
/// see [`fill_block`]'s aliasing note — and both pointers are derived from the
/// same `&mut Block` so their provenance covers the reads and the writes.
#[inline(always)]
unsafe fn next_addresses<const TBL: bool, const ML: u8, const X32: bool, const V: u8>(
    address_block: &mut Block,
    input_block: &mut Block,
) {
    // SAFETY: both pointers below come from live `&mut Block`s, so each is valid
    // for reads and writes of a whole 128-word block.
    unsafe {
        let mut zero_block: State = zero_state();
        let mut zero2_block: State = zero_state();
        // `FUSED2_PREV` reads the previous block through a pointer rather than
        // out of `state`, so it needs the zeroes in memory. One buffer is
        // enough for both calls, unlike the two `State`s above: that shape
        // never *writes* the previous block, which is exactly why `opt.c` needs
        // a second `zero2_block` and this does not.
        let zero_mem = Block::ZERO;
        let zerop = zero_mem.as_ptr();

        // uint64_t increment: wraps in C, so wrap here rather than panic.
        input_block.0[6] = input_block.0[6].wrapping_add(1);

        let address = address_block.as_mut_ptr();
        fill_block::<TBL, ML, X32, V>(&mut zero_block, zerop, input_block.as_ptr(), address, false);
        fill_block::<TBL, ML, X32, V>(
            &mut zero2_block,
            zerop,
            address.cast_const(),
            address,
            false,
        );
    }
}

/// `fill_segment()` from `src/opt.c`, generic over the rotation strategy.
///
/// # Safety
///
/// As [`crate::fill_block::FillSegmentFn`].
#[inline(always)]
unsafe fn fill_segment_impl<const TBL: bool, const ML: u8, const X32: bool, const V: u8>(
    instance: &Instance,
    mut position: Position,
) {
    // `opt.c` opens with `if (instance == NULL) return;`. A `&Instance` is never
    // null, but the `%` operators below would divide by zero on a degenerate
    // instance and this library must not panic, so guard those instead. Same
    // guard, same place, as `scalar::fill_segment`.
    if instance.lane_length == 0 || instance.lanes == 0 {
        return;
    }

    // type == Argon2_i || (type == Argon2_id && pass == 0 && slice < SYNC_POINTS/2)
    let data_independent_addressing = instance.data_independent_addressing(&position);
    // Version 0x10 always overwrites; 0x13 XORs from pass 1 on. Constant for the
    // whole segment, so it is hoisted out of the loop exactly as in the C.
    let with_xor = instance.with_xor(position.pass);

    let mut address_block = Block::ZERO;
    let mut input_block = if data_independent_addressing {
        instance.address_input_block(&position)
    } else {
        Block::ZERO
    };

    // SAFETY: every raw-pointer use below is justified inline; the offsets are
    // all in bounds for a well-formed instance, which is the caller's contract.
    unsafe {
        let mut state: State = zero_state();

        let mut starting_index: u32 = 0;
        if position.pass == 0 && position.slice == 0 {
            // The first two blocks of every lane come from `fill_first_blocks`.
            starting_index = 2;
            if data_independent_addressing {
                // "Don't forget to generate the first block of addresses"
                next_addresses::<TBL, ML, X32, V>(&mut address_block, &mut input_block);
            }
        }

        // curr_offset = lane * lane_length + slice * segment_length + starting_index
        //
        // `wrapping_*` mirrors the C's `uint32_t` arithmetic and keeps this
        // function panic-free; for a well-formed instance nothing here wraps.
        let mut curr_offset = position
            .lane
            .wrapping_mul(instance.lane_length)
            .wrapping_add(position.slice.wrapping_mul(instance.segment_length))
            .wrapping_add(starting_index);

        // `%` rather than `is_multiple_of` so this reads exactly like the C's
        // `if (0 == curr_offset % instance->lane_length)`.
        #[allow(clippy::manual_is_multiple_of)]
        let mut prev_offset = if curr_offset % instance.lane_length == 0 {
            // Last block in this lane.
            curr_offset
                .wrapping_add(instance.lane_length)
                .wrapping_sub(1)
        } else {
            // Previous block.
            curr_offset.wrapping_sub(1)
        };

        // memcpy(state, ((instance->memory + prev_offset)->v), ARGON2_BLOCK_SIZE)
        //
        // This is the ONLY load of the previous block in the whole segment. From
        // here on `state` is carried across iterations; see the loop below.
        //
        // `FUSED2_PREV` re-reads it through `prev_offset` on every iteration
        // instead, so it does not need the copy at all.
        if V != FUSED2_PREV {
            let prev_ptr = instance.block_ptr(prev_offset).cast::<u64>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = vld1q_u64(prev_ptr.add(2 * i));
            }
        }

        let mut i = starting_index;
        while i < instance.segment_length {
            // 1.1 Rotating prev_offset if needed.
            //
            // Deliberately NO reload of `state` here, matching `opt.c`: this
            // branch is only reachable at `slice == 0, i == 1` on a pass > 0,
            // where the previous iteration wrote `curr_offset - 1` and left it
            // in `state`. `prev_offset` is only read for `pseudo_rand` below.
            if curr_offset % instance.lane_length == 1 {
                prev_offset = curr_offset.wrapping_sub(1);
            }

            // 1.2.1 Taking the pseudo-random value.
            let pseudo_rand: u64 = if data_independent_addressing {
                let slot = (i % ADDRESSES_IN_BLOCK_U32) as usize;
                if slot == 0 {
                    next_addresses::<TBL, ML, X32, V>(&mut address_block, &mut input_block);
                }
                address_block.0[slot]
            } else {
                // SAFETY: `prev_offset` is a block this lane has already
                // finalised (earlier in this segment, or the last block of the
                // lane on a wrap-around), so it is in bounds and no other lane
                // writes it. Word 0 of a `Block` is 8-byte aligned.
                instance.block_ptr(prev_offset).cast::<u64>().read()
            };

            // 1.2.2 Computing the lane of the reference block.
            let mut ref_lane = ((pseudo_rand >> 32) % u64::from(instance.lanes)) as u32;
            if position.pass == 0 && position.slice == 0 {
                // Cannot reference other lanes yet.
                ref_lane = position.lane;
            }

            // 1.2.3 Computing the reference index. `index_alpha` takes the LOW
            // 32 bits of `pseudo_rand`.
            position.index = i;
            let ref_index = crate::core::index_alpha(
                instance,
                &position,
                (pseudo_rand & 0xFFFF_FFFF) as u32,
                ref_lane == position.lane,
            );

            // ref_block = memory + lane_length * ref_lane + ref_index
            //
            // Evaluated in `u64` like the C (where `ref_lane` is a `uint64_t`);
            // for a well-formed instance the sum is < memory_blocks <= u32::MAX.
            let ref_offset_u64 =
                u64::from(instance.lane_length) * u64::from(ref_lane) + u64::from(ref_index);
            debug_assert!(ref_offset_u64 < instance.memory_len() as u64);
            let ref_offset = ref_offset_u64 as u32;

            // 2 Creating a new block.
            //
            // SAFETY: `ref_offset` and `curr_offset` are both in bounds for a
            // well-formed instance. They can never be equal — `index_alpha`'s
            // reference area always stops short of `position.index` — but even
            // if they were, `fill_block` reads `ref_block` entirely before it
            // writes `next_block`. Cross-lane safety is the caller's job: within
            // one slice, lane `l` writes only its own segment.
            let ref_ptr = instance.block_ptr(ref_offset).cast::<u64>().cast_const();
            let curr_ptr = instance.block_ptr(curr_offset).cast::<u64>();
            // `prev_offset` addresses exactly the block the carried `state`
            // holds — see the rotation comment above — so `FUSED2_PREV` reading
            // it here is the same 1 KiB by construction. Unused by the shapes
            // that carry `state`, and then not even computed.
            let prev_ptr = instance.block_ptr(prev_offset).cast::<u64>().cast_const();
            fill_block::<TBL, ML, X32, V>(&mut state, prev_ptr, ref_ptr, curr_ptr, with_xor);

            i += 1;
            curr_offset = curr_offset.wrapping_add(1);
            prev_offset = prev_offset.wrapping_add(1);
        }
    }
}

/// NEON `fill_segment()`.
///
/// # Safety
///
/// The CPU must support NEON (architecturally guaranteed on `aarch64`; still
/// routed through `Backend::is_available` so the dispatch
/// shape is uniform across backends). All the requirements of
/// [`crate::fill_block::FillSegmentFn`] apply.
#[target_feature(enable = "neon")]
pub unsafe fn fill_segment(instance: &Instance, position: Position) {
    // SAFETY: the caller upholds `FillSegmentFn`'s contract, which is exactly
    // what `fill_segment_impl` needs.
    unsafe {
        fill_segment_impl::<SHIFT_ROTATES, MUL_DEFAULT, ROR32_DEFAULT, SHAPE_DEFAULT>(
            instance, position,
        )
    }
}

/// [`fill_segment`] with the `TBL`-based `ror24`/`ror16`.
///
/// Bit-identical output; it exists so the rotation-strategy benchmark in the
/// module docs stays reproducible. Not part of the dispatch table.
///
/// # Safety
///
/// As [`fill_segment`].
#[cfg(any(test, feature = "internal-api"))]
#[doc(hidden)]
#[target_feature(enable = "neon")]
pub unsafe fn fill_segment_tbl_rotates(instance: &Instance, position: Position) {
    // SAFETY: as `fill_segment`.
    unsafe {
        fill_segment_impl::<TABLE_ROTATES, MUL_DEFAULT, ROR32_DEFAULT, SHAPE_DEFAULT>(
            instance, position,
        )
    }
}

/// **Scaffolding.** [`fill_segment`] with every tuning knob exposed, so
/// `tests::fill_block_variant_shootout` can time all the candidate shapes and
/// spellings against each other in one process. Every instantiation produces
/// bit-identical output; only the instruction sequence differs.
///
/// # Safety
///
/// As [`fill_segment`].
#[cfg(any(test, feature = "internal-api"))]
#[doc(hidden)]
#[target_feature(enable = "neon")]
pub unsafe fn fill_segment_variant<const TBL: bool, const ML: u8, const X32: bool, const V: u8>(
    instance: &Instance,
    position: Position,
) {
    // SAFETY: as `fill_segment`.
    unsafe { fill_segment_impl::<TBL, ML, X32, V>(instance, position) }
}

/// [`fill_block`] with an explicit `prev_block`, for differential testing
/// against [`crate::fill_block::scalar::fill_block`].
///
/// `fill_segment` never calls this: it keeps the previous block in `state`
/// instead of loading it. Only tests and benches want the isolated form.
///
/// # Safety
///
/// The CPU must support NEON. `ref_block` and `next_block` may be the same
/// block; `prev_block` may alias either.
#[cfg(any(test, feature = "internal-api"))]
#[doc(hidden)]
#[target_feature(enable = "neon")]
pub unsafe fn fill_block_isolated(
    prev_block: &Block,
    ref_block: &Block,
    next_block: &mut Block,
    with_xor: bool,
) {
    // SAFETY: the three `&`/`&mut Block`s are live, so all three pointers are
    // valid for a whole block; `i < 64` keeps `2 * i + 1 <= 127` in bounds.
    unsafe {
        let mut state: State = zero_state();
        let prev = prev_block.as_ptr();
        for (i, slot) in state.iter_mut().enumerate() {
            *slot = vld1q_u64(prev.add(2 * i));
        }
        fill_block::<SHIFT_ROTATES, MUL_DEFAULT, ROR32_DEFAULT, SHAPE_DEFAULT>(
            &mut state,
            prev,
            ref_block.as_ptr(),
            next_block.as_mut_ptr(),
            with_xor,
        );
    }
}

/// [`fill_block_isolated`] with the `TBL`-based rotations.
///
/// # Safety
///
/// As [`fill_block_isolated`].
#[cfg(any(test, feature = "internal-api"))]
#[doc(hidden)]
#[target_feature(enable = "neon")]
pub unsafe fn fill_block_isolated_tbl_rotates(
    prev_block: &Block,
    ref_block: &Block,
    next_block: &mut Block,
    with_xor: bool,
) {
    // SAFETY: as `fill_block_isolated`.
    unsafe {
        let mut state: State = zero_state();
        let prev = prev_block.as_ptr();
        for (i, slot) in state.iter_mut().enumerate() {
            *slot = vld1q_u64(prev.add(2 * i));
        }
        fill_block::<TABLE_ROTATES, MUL_DEFAULT, ROR32_DEFAULT, SHAPE_DEFAULT>(
            &mut state,
            prev,
            ref_block.as_ptr(),
            next_block.as_mut_ptr(),
            with_xor,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The "NEON beats scalar" premise is a microarchitecture property, not a
    /// platform one. It holds on Apple Silicon, where these margins were
    /// measured. On Neoverse N1 (GitHub's `ubuntu-24.04-arm` runners) the
    /// current NEON schedule is *slower* than scalar (measured: 467 vs 331
    /// ns/block), and the uarch-aware choice belongs to `detect()` — see the
    /// note in `fill_block::mod`.
    ///
    /// This gates what `detection_selects_neon_on_this_host` may expect of
    /// `detect()`, and nothing else. No test asserts a wall clock; on Apple the
    /// shootout is compiled out entirely, so `detect()` is a constant there and
    /// the expectation is exact rather than a measurement.
    const NEON_BEATS_SCALAR_PREMISE: bool =
        cfg!(all(target_vendor = "apple", target_arch = "aarch64"));

    use crate::core::hash_traced;
    use crate::fill_block::{Backend, detect, scalar};
    use crate::params::{Algorithm, Memory, Params, QWORDS_IN_BLOCK, TagLen, Version};

    /// splitmix64: a deterministic, reproducible stand-in for a random source.
    /// The same generator `scalar`'s tests use, so the two suites can be
    /// cross-checked by hand.
    fn sm(x: u64) -> u64 {
        let x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    // ------------------------------------------------------------------
    // Intrinsic correspondence: every row of the table in the module docs.
    // ------------------------------------------------------------------

    /// Read a `uint64x2_t` back out as two `u64`s.
    ///
    /// # Safety
    /// Callers must be on aarch64; every caller here is `#[cfg(test)]` in this
    /// aarch64-only module.
    unsafe fn lanes(v: uint64x2_t) -> [u64; 2] {
        let mut out = [0u64; 2];
        // SAFETY: `out` is two `u64`s, i.e. exactly 16 bytes.
        unsafe { vst1q_u64(out.as_mut_ptr(), v) };
        out
    }

    /// Build a `uint64x2_t` from two `u64`s.
    ///
    /// # Safety
    /// As `lanes`.
    unsafe fn pack(a: u64, b: u64) -> uint64x2_t {
        let src = [a, b];
        // SAFETY: `src` is two `u64`s, i.e. exactly 16 bytes.
        unsafe { vld1q_u64(src.as_ptr()) }
    }

    #[test]
    fn zero_is_all_zero() {
        // SAFETY: aarch64-only module.
        let z = unsafe { lanes(zero()) };
        assert_eq!(z, [0, 0]);
    }

    #[test]
    fn f_blamka_matches_the_scalar_definition() {
        for k in 0..2048u64 {
            let (x0, x1) = (sm(k), sm(k ^ 0x5555));
            let (y0, y1) = (sm(k ^ 0xDEAD_BEEF), sm(k ^ 0xF00D));
            // SAFETY: aarch64-only module.
            // SAFETY: aarch64-only module.
            let umull = unsafe { lanes(f_blamka::<MUL_UMULL>(pack(x0, x1), pack(y0, y1))) };
            // SAFETY: aarch64-only module.
            let umlal = unsafe { lanes(f_blamka::<MUL_UMLAL>(pack(x0, x1), pack(y0, y1))) };
            // SAFETY: aarch64-only module.
            let uzp = unsafe { lanes(f_blamka::<MUL_UZP>(pack(x0, x1), pack(y0, y1))) };
            for (spelling, got) in [("UMULL", umull), ("UMLAL", umlal), ("UZP", uzp)] {
                assert_eq!(got[0], scalar::f_blamka(x0, y0), "{spelling} lane 0, k={k}");
                assert_eq!(got[1], scalar::f_blamka(x1, y1), "{spelling} lane 1, k={k}");
            }
        }
    }

    #[test]
    fn rotations_match_u64_rotate_right() {
        // Include the extremes, where a wrong shift direction or an off-by-one
        // in `SRI` would show up immediately.
        let mut cases: alloc::vec::Vec<u64> = alloc::vec![
            0,
            1,
            u64::MAX,
            1 << 63,
            0x0123_4567_89AB_CDEF,
            0xFEDC_BA98_7654_3210,
            0xFFFF_FFFF_0000_0000,
            0x0000_0000_FFFF_FFFF,
        ];
        for k in 0..512u64 {
            cases.push(sm(k));
        }

        for w in cases.chunks(2) {
            let (a, b) = (w[0], *w.get(1).unwrap_or(&0));
            // SAFETY: aarch64-only module.
            unsafe {
                let v = pack(a, b);
                for got in [lanes(ror32::<ROR32_REV>(v)), lanes(ror32::<ROR32_XAR>(v))] {
                    assert_eq!(
                        got,
                        [a.rotate_right(32), b.rotate_right(32)],
                        "ror32 {a:#x}"
                    );
                }
                assert_eq!(lanes(ror63(v)), [a.rotate_right(63), b.rotate_right(63)]);
                for got in [
                    lanes(ror24::<SHIFT_ROTATES>(v)),
                    lanes(ror24::<TABLE_ROTATES>(v)),
                ] {
                    assert_eq!(
                        got,
                        [a.rotate_right(24), b.rotate_right(24)],
                        "ror24 {a:#x}"
                    );
                }
                for got in [
                    lanes(ror16::<SHIFT_ROTATES>(v)),
                    lanes(ror16::<TABLE_ROTATES>(v)),
                ] {
                    assert_eq!(
                        got,
                        [a.rotate_right(16), b.rotate_right(16)],
                        "ror16 {a:#x}"
                    );
                }
            }
        }
    }

    #[test]
    fn alignr8_takes_the_high_lane_of_lo_then_the_low_lane_of_hi() {
        // `_mm_alignr_epi8(hi, lo, 8)` == (lo.lane1, hi.lane0).
        // SAFETY: aarch64-only module.
        let got = unsafe { lanes(alignr8(pack(10, 11), pack(20, 21))) };
        assert_eq!(got, [21, 10]);
    }

    #[test]
    fn diagonalize_produces_the_blake2_diagonals() {
        // v[k] = k, so the lane contents are readable as indices.
        // SAFETY: aarch64-only module.
        unsafe {
            // A0/A1 are passed to the macros but never assigned by them — the C
            // macros take them for symmetry only — hence no `mut`.
            let a0 = pack(0, 1);
            let a1 = pack(2, 3);
            let mut b0 = pack(4, 5);
            let mut b1 = pack(6, 7);
            let mut c0 = pack(8, 9);
            let mut c1 = pack(10, 11);
            let mut d0 = pack(12, 13);
            let mut d1 = pack(14, 15);

            diagonalize!(a0, b0, c0, d0, a1, b1, c1, d1);

            // Lane 0 / lane 1 of (A0,B0,C0,D0) and (A1,B1,C1,D1) must be the
            // four diagonal G argument sets of BLAKE2_ROUND_NOMSG:
            //   G(v0,v5,v10,v15) G(v1,v6,v11,v12) G(v2,v7,v8,v13) G(v3,v4,v9,v14)
            let col = |a: uint64x2_t, b: uint64x2_t, c: uint64x2_t, d: uint64x2_t, l: usize| {
                [lanes(a)[l], lanes(b)[l], lanes(c)[l], lanes(d)[l]]
            };
            assert_eq!(col(a0, b0, c0, d0, 0), [0, 5, 10, 15]);
            assert_eq!(col(a0, b0, c0, d0, 1), [1, 6, 11, 12]);
            assert_eq!(col(a1, b1, c1, d1, 0), [2, 7, 8, 13]);
            assert_eq!(col(a1, b1, c1, d1, 1), [3, 4, 9, 14]);

            undiagonalize!(a0, b0, c0, d0, a1, b1, c1, d1);

            assert_eq!(lanes(a0), [0, 1]);
            assert_eq!(lanes(a1), [2, 3]);
            assert_eq!(lanes(b0), [4, 5]);
            assert_eq!(lanes(b1), [6, 7]);
            assert_eq!(lanes(c0), [8, 9]);
            assert_eq!(lanes(c1), [10, 11]);
            assert_eq!(lanes(d0), [12, 13]);
            assert_eq!(lanes(d1), [14, 15]);
        }
    }

    // ------------------------------------------------------------------
    // fill_block: NEON vs scalar over 2048 pseudo-random block triples.
    // ------------------------------------------------------------------

    #[test]
    fn fill_block_matches_scalar_over_random_triples() {
        const CASES: u64 = 2048;

        let mut counter = 0u64;
        let mut next = move || {
            counter = counter.wrapping_add(1);
            sm(counter)
        };

        for case in 0..CASES {
            let mut prev = Block::ZERO;
            let mut reference = Block::ZERO;
            let mut original = Block::ZERO;
            for i in 0..QWORDS_IN_BLOCK {
                prev.0[i] = next();
                reference.0[i] = next();
                original.0[i] = next();
            }

            for with_xor in [false, true] {
                let mut want = original;
                scalar::fill_block(&prev, &reference, &mut want, with_xor);

                let mut got = original;
                // SAFETY: aarch64-only module, so NEON is available.
                unsafe { fill_block_isolated(&prev, &reference, &mut got, with_xor) };

                let mut got_tbl = original;
                // SAFETY: as above.
                unsafe {
                    fill_block_isolated_tbl_rotates(&prev, &reference, &mut got_tbl, with_xor)
                };

                for i in 0..QWORDS_IN_BLOCK {
                    assert_eq!(
                        got.0[i], want.0[i],
                        "case {case} with_xor={with_xor}: word {i}"
                    );
                    assert_eq!(
                        got_tbl.0[i], want.0[i],
                        "case {case} with_xor={with_xor} (TBL): word {i}"
                    );
                }
            }
        }
    }

    #[test]
    fn fill_block_handles_the_degenerate_inputs() {
        // All-zero must stay all-zero (fBlaMka(0, 0) == 0), and all-ones must
        // agree with scalar too — that is where every `wrapping_*` matters.
        for fill in [0x00u8, 0xFFu8] {
            let mut prev = Block::ZERO;
            prev.fill(fill);
            let mut reference = Block::ZERO;
            reference.fill(fill ^ 0xFF);

            for with_xor in [false, true] {
                let mut want = Block::ZERO;
                want.fill(0x5A);
                let mut got = want;
                scalar::fill_block(&prev, &reference, &mut want, with_xor);
                // SAFETY: aarch64-only module.
                unsafe { fill_block_isolated(&prev, &reference, &mut got, with_xor) };
                assert_eq!(got, want, "fill={fill:#04x} with_xor={with_xor}");
            }
        }

        let mut zero_out = Block::ZERO;
        // SAFETY: aarch64-only module.
        unsafe { fill_block_isolated(&Block::ZERO, &Block::ZERO, &mut zero_out, false) };
        assert_eq!(zero_out, Block::ZERO);
    }

    #[test]
    fn next_addresses_matches_scalar() {
        let mut want_addr = Block::ZERO;
        let mut want_in = Block::ZERO;
        let mut got_addr = Block::ZERO;
        let mut got_in = Block::ZERO;
        // The layout `fill_segment` builds: pass=1 lane=2 slice=3
        // memory_blocks=4096 passes=3 type=2 (Argon2id).
        for b in [&mut want_in, &mut got_in] {
            b.0[0] = 1;
            b.0[1] = 2;
            b.0[2] = 3;
            b.0[3] = 4096;
            b.0[4] = 3;
            b.0[5] = 2;
        }

        // Several calls in a row, so the `v[6]` counter is exercised as well as
        // the `ref == next` aliasing in the second `fill_block`.
        for round in 0..4 {
            scalar::next_addresses(&mut want_addr, &mut want_in);
            // SAFETY: aarch64-only module.
            unsafe {
                next_addresses::<SHIFT_ROTATES, MUL_DEFAULT, ROR32_DEFAULT, SHAPE_DEFAULT>(
                    &mut got_addr,
                    &mut got_in,
                )
            };
            assert_eq!(got_in.0[6], want_in.0[6], "counter after round {round}");
            assert_eq!(got_addr, want_addr, "address block after round {round}");
        }
        assert_eq!(want_in.0[6], 4);
    }

    // ------------------------------------------------------------------
    // Runtime dispatch.
    // ------------------------------------------------------------------

    /// Detection must select NEON here — and only here.
    ///
    /// This module only compiles on `aarch64`, so the *negative* half of the
    /// claim ("and not on a host that does not support it") cannot be asserted
    /// from inside it. Its counterpart lives in the parent module's
    /// `tests::detection_respects_the_architecture`, which asserts
    /// `!have_neon()` and `detect() != Backend::Neon` whenever
    /// `cfg!(target_arch = "x86_64")`. On this machine that half really does get
    /// executed, because x86-64 runs under Rosetta:
    ///
    /// ```text
    /// cargo test --target x86_64-apple-darwin --features internal-api --lib -- fill_block::tests
    ///   test fill_block::tests::detection_respects_the_architecture ... ok
    /// ```
    #[test]
    fn detection_selects_neon_on_this_host() {
        // Reaching here means the host is aarch64, where NEON is part of the
        // architectural baseline.
        const { assert!(cfg!(target_arch = "aarch64")) };
        assert!(Backend::Neon.is_available(), "NEON must be available");
        if NEON_BEATS_SCALAR_PREMISE {
            // Measured on Apple Silicon: the shootout picks NEON.
            assert_eq!(detect(), Backend::Neon, "aarch64 must resolve to Neon");
            assert_eq!(crate::fill_block::backend(), Backend::Neon);
        } else {
            // Everywhere else the shootout decides; on Neoverse N1 it
            // correctly picks Scalar (NEON loses there by ~40%).
            assert!(
                matches!(detect(), Backend::Neon | Backend::Scalar),
                "detection must pick one of the two runnable backends"
            );
        }

        // Exactly two backends are runnable here, and detection picked the
        // preferred one of them. Spelled as a set rather than as four separate
        // asserts so that a new backend cannot be added without revisiting this.
        let available: alloc::vec::Vec<Backend> = Backend::ALL
            .iter()
            .copied()
            .filter(|b| b.is_available())
            .collect();
        assert_eq!(available, alloc::vec![Backend::Scalar, Backend::Neon]);

        // Function-pointer identity, skipped under Miri.
        //
        // `ptr::fn_addr_eq` documents that a `true` result is not guaranteed
        // even for two coercions of the same function: the address of a `fn`
        // item is not a language-level identity. Real codegen does give one
        // address per function, so these two assertions do their job under
        // `cargo test`. Miri models the weaker guarantee and hands out a fresh
        // address per coercion site, which makes *both* of them fail there —
        // including the `assert_eq` direction, so this is not a
        // false-negative-only situation and cannot be papered over by flipping
        // the comparison.
        if !cfg!(miri) {
            // The dispatch table really hands out *this* function...
            assert!(core::ptr::fn_addr_eq(
                crate::fill_block::fill_segment_fn(Backend::Neon),
                fill_segment as crate::fill_block::FillSegmentFn,
            ));
            // ...and not the scalar fallback that `fill_block/mod.rs` installs
            // for `Backend::Neon` on non-aarch64 targets. A miscopied `cfg`
            // there would silently make this backend dead code, and every
            // equivalence test in this file would still pass, because scalar
            // equals scalar.
            assert!(!core::ptr::fn_addr_eq(
                crate::fill_block::fill_segment_fn(Backend::Neon),
                crate::fill_block::fill_segment_fn(Backend::Scalar),
            ));
        }
    }

    // ------------------------------------------------------------------
    // Whole-hash equivalence with the scalar backend.
    //
    // The block-triple test above pins `fill_block`. This pins `fill_segment`
    // itself: the carried `state`, the `prev_offset` rotation at
    // `curr_offset % lane_length == 1`, `next_addresses` every 128 blocks, the
    // pass-0/slice-0 `starting_index = 2`, and multi-lane cross references.
    // ------------------------------------------------------------------

    /// `hash_traced` on an explicit backend, with the availability check the
    /// `unsafe fn` demands done once, here, so no caller can forget it.
    fn hash(
        backend: Backend,
        alg: Algorithm,
        ver: Version,
        params: &Params,
        salt: &[u8],
    ) -> [u8; 32] {
        assert!(
            backend.is_available(),
            "{backend} cannot run on this CPU; calling it would be UB"
        );
        let mut out = [0u8; 32];
        // SAFETY: `is_available()` was just asserted, which is exactly
        // `hash_traced`'s contract.
        unsafe {
            hash_traced(
                backend,
                alg,
                ver,
                params,
                b"password",
                salt,
                &[],
                &[],
                &mut out,
                None,
            )
        }
        .expect("hash");
        out
    }

    #[test]
    fn whole_hash_matches_scalar_across_the_parameter_matrix() {
        for alg in [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id] {
            for ver in [Version::V0x10, Version::V0x13] {
                for lanes in [1u32, 2, 3, 4] {
                    for t_cost in [1u32, 2, 3] {
                        // Small but > 128 blocks per segment for lanes == 1, so
                        // `next_addresses` runs more than once per segment.
                        for m_cost in [8 * lanes, 4 * 128 * lanes, 4 * 200 * lanes + 3] {
                            let params = Params::builder()
                                .memory(Memory::kib(u64::from(m_cost)))
                                .passes(t_cost)
                                .lanes(lanes)
                                .tag_len(TagLen::bytes(32))
                                .build()
                                .expect("params");
                            let want = hash(Backend::Scalar, alg, ver, &params, b"somesalt");
                            let got = hash(Backend::Neon, alg, ver, &params, b"somesalt");
                            assert_eq!(
                                got, want,
                                "{alg:?} {ver:?} lanes={lanes} t={t_cost} m={m_cost}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn every_tuning_variant_agrees_at_segment_level() {
        // Every knob in this file (`block_XY` shape, prologue/epilogue fusion,
        // round interleaving, `fBlaMka` spelling, `ror32` spelling, rotation
        // strategy) must be output-identical to the shipped `fill_segment`.
        // Driving them over identical arenas covers the whole segment, not just
        // `fill_block`: `next_addresses`, the carried `state`, the
        // `prev_offset` rotation and the pass-0 `starting_index` all included.
        //
        // This is the test that stops a *faster wrong answer* from surviving
        // the shootout.
        let params = Params::builder()
            .memory(Memory::kib(4 * 32))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        let (memory_blocks, _, _) = params.memory_layout();
        let n = memory_blocks as usize;

        let positions = [
            Position::new(0, 0, 0, 0),
            Position::new(0, 0, 1, 0),
            Position::new(0, 0, 2, 0),
            Position::new(0, 0, 3, 0),
            Position::new(1, 0, 0, 0),
            Position::new(1, 0, 1, 0),
        ];

        for alg in [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id] {
            for position in positions {
                // Same deterministic starting contents in both arenas. `Vec`
                // honours `align_of::<Block>() == 64`.
                let mut start: alloc::vec::Vec<Block> = alloc::vec![Block::ZERO; n];
                for (bi, block) in start.iter_mut().enumerate() {
                    for wi in 0..QWORDS_IN_BLOCK {
                        block.0[wi] = sm((bi * QWORDS_IN_BLOCK + wi) as u64);
                    }
                }
                let mut want = start.clone();
                let want_ptr = want.as_mut_ptr();
                // SAFETY: the `Instance` gets the pointer of a live `Vec` of
                // exactly `n == memory_blocks` `Block`s, and `position` is in
                // range for `lanes == 1`. No other reference to the buffer is
                // live for the duration of the call.
                unsafe {
                    let a = Instance::new(want_ptr, n, alg, Version::V0x13, &params);
                    fill_segment(&a, position);
                }

                type V = unsafe fn(&Instance, Position);
                let variants: [(&str, V); 18] = [
                    ("tbl rotates", fill_segment_tbl_rotates),
                    (
                        "x1/UMULL/REV",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_REV, FUSED>,
                    ),
                    (
                        "x1/UMLAL/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMLAL, ROR32_XAR, FUSED>,
                    ),
                    (
                        "x1/UZP/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP, ROR32_XAR, FUSED>,
                    ),
                    (
                        "x2/UMULL/REV",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_REV, FUSED2>,
                    ),
                    (
                        "x2/UMULL/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED2>,
                    ),
                    (
                        "x2/UMLAL/REV",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMLAL, ROR32_REV, FUSED2>,
                    ),
                    (
                        "x2/UZP/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP, ROR32_XAR, FUSED2>,
                    ),
                    (
                        "x2/TBL/UMLAL/XAR",
                        fill_segment_variant::<TABLE_ROTATES, MUL_UMLAL, ROR32_XAR, FUSED2>,
                    ),
                    // The paired narrowing (shipped), the shapes it enabled,
                    // and every combination they are reachable in.
                    (
                        "x1/UZPPAIR/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED>,
                    ),
                    (
                        "x2/UZPPAIR/REV",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_REV, FUSED2>,
                    ),
                    (
                        "x2/TBL/UZPPAIR/XAR",
                        fill_segment_variant::<TABLE_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
                    ),
                    (
                        "x2/UZPPAIR+UMLAL/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR_MLAL, ROR32_XAR, FUSED2>,
                    ),
                    (
                        "x2/UZPPAIR/XAR/prev",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2_PREV>,
                    ),
                    (
                        "x2/UMULL/XAR/prev",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED2_PREV>,
                    ),
                    (
                        "x4/UZPPAIR/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED4>,
                    ),
                    (
                        "x4/UMULL/XAR",
                        fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED4>,
                    ),
                    (
                        "x4/TBL/UZPPAIR/REV",
                        fill_segment_variant::<TABLE_ROTATES, MUL_UZP_PAIR, ROR32_REV, FUSED4>,
                    ),
                ];

                for (name, f) in variants {
                    let mut got = start.clone();
                    let got_ptr = got.as_mut_ptr();
                    // SAFETY: as above.
                    unsafe {
                        let b = Instance::new(got_ptr, n, alg, Version::V0x13, &params);
                        f(&b, position);
                    }
                    assert_eq!(got, want, "{name}: {alg:?} {position:?}");
                }
            }
        }
    }

    #[test]
    fn threads_do_not_change_the_neon_tag() {
        // Spec item (12): `threads` is a pure performance knob. Worth pinning
        // per backend, because the parallel path is where a backend that wrote
        // outside its own segment would be caught.
        for lanes in [2u32, 4] {
            for threads in 1..=lanes {
                let single = Params::builder()
                    .memory(Memory::kib(u64::from(4 * 40 * lanes)))
                    .passes(2)
                    .lanes(lanes)
                    .threads(1)
                    .tag_len(TagLen::bytes(32))
                    .build()
                    .expect("params");
                let multi = Params::builder()
                    .memory(Memory::kib(u64::from(4 * 40 * lanes)))
                    .passes(2)
                    .lanes(lanes)
                    .threads(threads)
                    .tag_len(TagLen::bytes(32))
                    .build()
                    .expect("params");
                assert_eq!(
                    hash(
                        Backend::Neon,
                        Algorithm::Argon2id,
                        Version::V0x13,
                        &single,
                        b"somesalt"
                    ),
                    hash(
                        Backend::Neon,
                        Algorithm::Argon2id,
                        Version::V0x13,
                        &multi,
                        b"somesalt"
                    ),
                    "lanes={lanes} threads={threads}"
                );
            }
        }
    }

    // ------------------------------------------------------------------
    // The official test vectors, with the NEON backend FORCED.
    //
    // Transcribed mechanically from `phc-winner-argon2/src/test.c` (the
    // `hashtest()` calls were parsed out of the file, not retyped); each test
    // carries the `test.c` line it came from. One `#[test]` per vector so they
    // run in parallel.
    // ------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn check_vector(
        alg: Algorithm,
        ver: Version,
        t_cost: u32,
        m_log2: u32,
        lanes: u32,
        pwd: &[u8],
        salt: &[u8],
        want_hex: &str,
    ) {
        let params = Params::builder()
            .memory(Memory::kib(1 << m_log2))
            .passes(t_cost)
            .lanes(lanes)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        assert!(
            Backend::Neon.is_available(),
            "NEON is baseline on aarch64; forcing it without it would be UB"
        );
        let mut out = [0u8; 32];
        // SAFETY: `Backend::Neon.is_available()` was just asserted.
        unsafe {
            hash_traced(
                Backend::Neon,
                alg,
                ver,
                &params,
                pwd,
                salt,
                &[],
                &[],
                &mut out,
                None,
            )
        }
        .expect("hash");

        let mut hex = alloc::string::String::new();
        for byte in out {
            use core::fmt::Write as _;
            write!(hex, "{byte:02x}").expect("write");
        }
        assert_eq!(hex, want_hex, "{alg:?} {ver:?} t={t_cost} m=2^{m_log2}");

        // And the scalar backend must agree, which is the actual equivalence
        // claim; the hex above only pins both to the C reference.
        let mut scalar_out = [0u8; 32];
        // SAFETY: `Backend::Scalar` needs no CPU feature at all.
        let scalar = unsafe {
            hash_traced(
                Backend::Scalar,
                alg,
                ver,
                &params,
                pwd,
                salt,
                &[],
                &[],
                &mut scalar_out,
                None,
            )
        };
        scalar.expect("hash");
        assert_eq!(out, scalar_out, "neon vs scalar");
    }

    macro_rules! official {
        ($name:ident, $line:expr,
         $alg:expr, $ver:expr, t=$t:expr, m_log2=$m:expr, lanes=$p:expr,
         $pwd:expr, $salt:expr, $hex:expr,) => {
            /// One `hashtest()` call from `phc-winner-argon2/src/test.c`.
            #[test]
            fn $name() {
                let _ = $line; // the test.c line this came from
                check_vector($alg, $ver, $t, $m, $p, $pwd, $salt, $hex);
            }
        };
    }

    /// Same as [`official`], plus `#[ignore]`: these are the two vectors the C
    /// guards with `#ifdef TEST_LARGE_RAM` (1 GiB each).
    macro_rules! official_large {
        ($name:ident, $line:expr,
         $alg:expr, $ver:expr, t=$t:expr, m_log2=$m:expr, lanes=$p:expr,
         $pwd:expr, $salt:expr, $hex:expr,) => {
            #[test]
            #[ignore = "TEST_LARGE_RAM in test.c: needs 1 GiB"]
            fn $name() {
                let _ = $line;
                check_vector($alg, $ver, $t, $m, $p, $pwd, $salt, $hex);
            }
        };
    }

    official! {
        argon2i_v0x10_t2_m16_p1_password_somesalt, 77,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "f6c4db4a54e2a370627aff3db6176b94a2a209a62c8e36152711802f7b30c694",
    }
    official_large! {
        argon2i_v0x10_t2_m20_p1_password_somesalt, 82,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=20, lanes=1,
        b"password", b"somesalt",
        "9690ec55d28d3ed32562f2e73ea62b02b018757643a2ae6e79528459de8106e9",
    }
    official! {
        argon2i_v0x10_t2_m18_p1_password_somesalt, 87,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=18, lanes=1,
        b"password", b"somesalt",
        "3e689aaa3d28a77cf2bc72a51ac53166761751182f1ee292e3f677a7da4c2467",
    }
    official! {
        argon2i_v0x10_t2_m8_p1_password_somesalt, 91,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=8, lanes=1,
        b"password", b"somesalt",
        "fd4dd83d762c49bdeaf57c47bdcd0c2f1babf863fdeb490df63ede9975fccf06",
    }
    official! {
        argon2i_v0x10_t2_m8_p2_password_somesalt, 95,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=8, lanes=2,
        b"password", b"somesalt",
        "b6c11560a6a9d61eac706b79a2f97d68b4463aa3ad87e00c07e2b01e90c564fb",
    }
    official! {
        argon2i_v0x10_t1_m16_p1_password_somesalt, 99,
        Algorithm::Argon2i, Version::V0x10, t=1, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "81630552b8f3b1f48cdb1992c4c678643d490b2b5eb4ff6c4b3438b5621724b2",
    }
    official! {
        argon2i_v0x10_t4_m16_p1_password_somesalt, 103,
        Algorithm::Argon2i, Version::V0x10, t=4, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "f212f01615e6eb5d74734dc3ef40ade2d51d052468d8c69440a3a1f2c1c2847b",
    }
    official! {
        argon2i_v0x10_t2_m16_p1_differentpassword_somesalt, 107,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=16, lanes=1,
        b"differentpassword", b"somesalt",
        "e9c902074b6754531a3a0be519e5baf404b30ce69b3f01ac3bf21229960109a3",
    }
    official! {
        argon2i_v0x10_t2_m16_p1_password_diffsalt, 111,
        Algorithm::Argon2i, Version::V0x10, t=2, m_log2=16, lanes=1,
        b"password", b"diffsalt",
        "79a103b90fe8aef8570cb31fc8b22259778916f8336b7bdac3892569d4f1c497",
    }
    official! {
        argon2i_v0x13_t2_m16_p1_password_somesalt, 156,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "c1628832147d9720c5bd1cfd61367078729f6dfb6f8fea9ff98158e0d7816ed0",
    }
    official_large! {
        argon2i_v0x13_t2_m20_p1_password_somesalt, 161,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=20, lanes=1,
        b"password", b"somesalt",
        "d1587aca0922c3b5d6a83edab31bee3c4ebaef342ed6127a55d19b2351ad1f41",
    }
    official! {
        argon2i_v0x13_t2_m18_p1_password_somesalt, 166,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=18, lanes=1,
        b"password", b"somesalt",
        "296dbae80b807cdceaad44ae741b506f14db0959267b183b118f9b24229bc7cb",
    }
    official! {
        argon2i_v0x13_t2_m8_p1_password_somesalt, 170,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=8, lanes=1,
        b"password", b"somesalt",
        "89e9029f4637b295beb027056a7336c414fadd43f6b208645281cb214a56452f",
    }
    official! {
        argon2i_v0x13_t2_m8_p2_password_somesalt, 174,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=8, lanes=2,
        b"password", b"somesalt",
        "4ff5ce2769a1d7f4c8a491df09d41a9fbe90e5eb02155a13e4c01e20cd4eab61",
    }
    official! {
        argon2i_v0x13_t1_m16_p1_password_somesalt, 178,
        Algorithm::Argon2i, Version::V0x13, t=1, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "d168075c4d985e13ebeae560cf8b94c3b5d8a16c51916b6f4ac2da3ac11bbecf",
    }
    official! {
        argon2i_v0x13_t4_m16_p1_password_somesalt, 182,
        Algorithm::Argon2i, Version::V0x13, t=4, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "aaa953d58af3706ce3df1aefd4a64a84e31d7f54175231f1285259f88174ce5b",
    }
    official! {
        argon2i_v0x13_t2_m16_p1_differentpassword_somesalt, 186,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"differentpassword", b"somesalt",
        "14ae8da01afea8700c2358dcef7c5358d9021282bd88663a4562f59fb74d22ee",
    }
    official! {
        argon2i_v0x13_t2_m16_p1_password_diffsalt, 190,
        Algorithm::Argon2i, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"password", b"diffsalt",
        "b0357cccfbef91f3860b0dba447b2348cbefecadaf990abfe9cc40726c521271",
    }
    official! {
        argon2id_v0x13_t2_m16_p1_password_somesalt, 233,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7",
    }
    official! {
        argon2id_v0x13_t2_m18_p1_password_somesalt, 237,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=18, lanes=1,
        b"password", b"somesalt",
        "78fe1ec91fb3aa5657d72e710854e4c3d9b9198c742f9616c2f085bed95b2e8c",
    }
    official! {
        argon2id_v0x13_t2_m8_p1_password_somesalt, 241,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=8, lanes=1,
        b"password", b"somesalt",
        "9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe",
    }
    official! {
        argon2id_v0x13_t2_m8_p2_password_somesalt, 245,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=8, lanes=2,
        b"password", b"somesalt",
        "6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037",
    }
    official! {
        argon2id_v0x13_t1_m16_p1_password_somesalt, 249,
        Algorithm::Argon2id, Version::V0x13, t=1, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98",
    }
    official! {
        argon2id_v0x13_t4_m16_p1_password_somesalt, 253,
        Algorithm::Argon2id, Version::V0x13, t=4, m_log2=16, lanes=1,
        b"password", b"somesalt",
        "9025d48e68ef7395cca9079da4c4ec3affb3c8911fe4f86d1a2520856f63172c",
    }
    official! {
        argon2id_v0x13_t2_m16_p1_differentpassword_somesalt, 257,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"differentpassword", b"somesalt",
        "0b84d652cf6b0c4beaef0dfe278ba6a80df6696281d7e0d2891b817d8c458fde",
    }
    official! {
        argon2id_v0x13_t2_m16_p1_password_diffsalt, 261,
        Algorithm::Argon2id, Version::V0x13, t=2, m_log2=16, lanes=1,
        b"password", b"diffsalt",
        "bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c",
    }

    // ------------------------------------------------------------------
    // Timing. Optimised builds only; a debug build measures the inliner, not
    // the code.
    //
    // NOTHING HERE ASSERTS A WALL CLOCK. These two tests measure and print, and
    // then assert an *equivalence* — that the variants they just timed compute
    // identical results. A throughput comparison is only meaningful if the
    // candidates agree, so that is the invariant worth failing on, and it is
    // the same verdict on an idle laptop and a contended CI runner.
    //
    // A ratio assertion used to live here, and it was flaky by construction: a
    // shared runner can hand one candidate a contention window that the others
    // never see. It failed on `macos-latest` reading neon/scalar x0.92 against
    // a documented x1.54 — a 40 % swing with no code change, on a commit whose
    // own PR run had passed. Interleaving narrows that window but cannot close
    // it, because the noise is another tenant's workload, not measurement
    // technique.
    //
    // Performance regressions are CodSpeed's job (`.github/workflows/
    // codspeed.yml`, `benches/codspeed.rs`), which compares against the base
    // commit on consistent hardware instead of guessing from one sample.
    //
    // The PRINTED numbers still need a quiet machine: `cargo test` runs tests
    // in parallel, so these two contend with each other unless you pass
    // `--test-threads=1`, and a contended run reads ~50 % high on every column
    // at once. Quote the numbers only from a run that had the machine to
    // itself.
    // ------------------------------------------------------------------

    /// Best-of-`reps` wall time, in seconds, of `f`.
    #[cfg(feature = "std")]
    fn best_of(reps: usize, mut f: impl FnMut()) -> f64 {
        let mut best = f64::MAX;
        for _ in 0..reps {
            let started = std::time::Instant::now();
            f();
            let elapsed = started.elapsed().as_secs_f64();
            if elapsed < best {
                best = elapsed;
            }
        }
        best
    }

    /// Best-of-`reps` for two candidates sampled **alternately**, with the order
    /// flipped every rep.
    ///
    /// Timing them in two separate blocks lets a frequency or thermal step that
    /// lands between the blocks be attributed entirely to one candidate. Here
    /// any such drift is shared, which is what makes the ratio trustworthy on a
    /// machine that is not idle — and a CI machine never is.
    #[cfg(feature = "std")]
    fn best_of_interleaved(reps: usize, mut a: impl FnMut(), mut b: impl FnMut()) -> (f64, f64) {
        let (mut best_a, mut best_b) = (f64::MAX, f64::MAX);
        let sample = |f: &mut dyn FnMut(), best: &mut f64| {
            let started = std::time::Instant::now();
            f();
            let elapsed = started.elapsed().as_secs_f64();
            if elapsed < *best {
                *best = elapsed;
            }
        };
        for rep in 0..reps {
            if rep % 2 == 0 {
                sample(&mut a, &mut best_a);
                sample(&mut b, &mut best_b);
            } else {
                sample(&mut b, &mut best_b);
                sample(&mut a, &mut best_a);
            }
        }
        (best_a, best_b)
    }

    /// Isolated compression throughput, everything resident in L1: this is the
    /// pure instruction cost of one `fill_block`, with no arena traffic.
    ///
    /// `fill_block_isolated` reloads `state` from `prev_block` on every call,
    /// which the real `fill_segment` does not (it carries `state`), so this
    /// overstates all three variants by the same ~64 loads.
    #[cfg(feature = "std")]
    #[test]
    #[cfg_attr(debug_assertions, ignore = "meaningless without optimisations")]
    fn compression_throughput_by_backend() {
        const ITERS: usize = 200_000;

        let mut prev = Block::ZERO;
        let mut reference = Block::ZERO;
        let mut next = Block::ZERO;
        for i in 0..QWORDS_IN_BLOCK {
            prev.0[i] = sm(i as u64);
            reference.0[i] = sm(1000 + i as u64);
            next.0[i] = sm(2000 + i as u64);
        }

        let report = |label: &str, seconds: f64| {
            let ns = seconds * 1e9 / ITERS as f64;
            std::eprintln!(
                "  {label:<22} {ns:>7.2} ns/block  ({:>5.2} GiB/s)",
                (ITERS as f64 * 1024.0) / seconds / (1024.0 * 1024.0 * 1024.0)
            );
            ns
        };

        // Every candidate runs exactly the same chain: `WARMUP` untimed calls
        // and then `REPS x ITERS` timed ones, all starting from `next`. Equal
        // call counts are what make the three final blocks comparable, which is
        // what this test asserts on.
        const WARMUP: usize = ITERS / 10;
        const REPS: usize = 3;
        const CHAIN: usize = WARMUP + REPS * ITERS;

        std::eprintln!("fill_block, L1-resident, best of {REPS} x {ITERS} calls:");

        let (scalar_ns, scalar_out) = {
            let mut n = next;
            for _ in 0..WARMUP {
                scalar::fill_block(&prev, &reference, &mut n, true);
            }
            let s = best_of(REPS, || {
                for _ in 0..ITERS {
                    scalar::fill_block(&prev, &reference, &mut n, true);
                }
            });
            (report("scalar", s), n)
        };

        let (neon_ns, neon_out) = {
            let mut n = next;
            // SAFETY: aarch64-only module.
            unsafe {
                for _ in 0..WARMUP {
                    fill_block_isolated(&prev, &reference, &mut n, true);
                }
            }
            // SAFETY: aarch64-only module.
            let s = best_of(REPS, || unsafe {
                for _ in 0..ITERS {
                    fill_block_isolated(&prev, &reference, &mut n, true);
                }
            });
            (report("neon (SHL+SRI)", s), n)
        };

        let (neon_tbl_ns, neon_tbl_out) = {
            let mut n = next;
            // SAFETY: aarch64-only module.
            unsafe {
                for _ in 0..WARMUP {
                    fill_block_isolated_tbl_rotates(&prev, &reference, &mut n, true);
                }
            }
            // SAFETY: aarch64-only module.
            let s = best_of(REPS, || unsafe {
                for _ in 0..ITERS {
                    fill_block_isolated_tbl_rotates(&prev, &reference, &mut n, true);
                }
            });
            (report("neon (TBL)", s), n)
        };

        std::eprintln!(
            "  -> neon/scalar x{:.2}, TBL/SHL+SRI x{:.3}  (informational; \
             regressions are CodSpeed's job)",
            scalar_ns / neon_ns,
            neon_tbl_ns / neon_ns
        );

        // The verdict, and the reason this test still earns its runtime now
        // that it asserts no wall clock: `with_xor = true` feeds each result
        // into the next call, so the blocks just compared are the tail of a
        // chain `CHAIN` calls deep. A divergence in any single call propagates
        // to the end. `fill_block_matches_scalar_over_random_triples` checks
        // the same three variants one call at a time, over random inputs; this
        // checks them composed, which is how `fill_segment` actually uses them.
        for i in 0..QWORDS_IN_BLOCK {
            assert_eq!(
                neon_out.0[i], scalar_out.0[i],
                "NEON diverged from scalar at word {i} after a {CHAIN}-call chain"
            );
            assert_eq!(
                neon_tbl_out.0[i], scalar_out.0[i],
                "NEON (TBL) diverged from scalar at word {i} after a {CHAIN}-call chain"
            );
        }
    }

    // ------------------------------------------------------------------
    // SCAFFOLDING: the `fill_block` shape shootout.
    //
    // Times the candidate shapes against each other **in one process**, over
    // the real `fill_segment` (not `fill_block_isolated`), round-robin so any
    // thermal or DVFS drift hits every candidate equally. Reports min-of-reps,
    // which is the right statistic for "how fast can this go".
    // ------------------------------------------------------------------

    /// Fill an arena with reproducible pseudo-random data, so the
    /// data-dependent reference indices are realistic and identical for every
    /// candidate. Runs outside the timed region.
    #[cfg(feature = "std")]
    fn seed_arena(arena: &mut [Block]) {
        for (bi, block) in arena.iter_mut().enumerate() {
            let base = (bi as u64) << 12;
            for wi in 0..QWORDS_IN_BLOCK {
                block.0[wi] = sm(base ^ wi as u64);
            }
        }
    }

    /// Run `f` over every `(pass, slice)` of a one-lane instance and return the
    /// wall time. Two passes, so `with_xor == false` and `with_xor == true` are
    /// both exercised, exactly as a `t_cost = 2` hash would.
    #[cfg(feature = "std")]
    fn time_full_fill(
        f: unsafe fn(&Instance, Position),
        arena: &mut [Block],
        params: &Params,
        passes: u32,
    ) -> f64 {
        let n = arena.len();
        let ptr = arena.as_mut_ptr();
        // SAFETY: `arena` is a live slice of exactly `n` `Block`s and no other
        // reference to it is live while the raw pointer is in use. `lanes == 1`,
        // so every position below is in range and nothing runs concurrently.
        let instance =
            unsafe { Instance::new(ptr, n, Algorithm::Argon2id, Version::V0x13, params) };

        let started = std::time::Instant::now();
        for pass in 0..passes {
            for slice in 0..4u32 {
                // SAFETY: aarch64-only module, so NEON is available; the
                // position is in range for this instance.
                unsafe { f(&instance, Position::new(pass, 0, slice, 0)) };
            }
        }
        started.elapsed().as_secs_f64()
    }

    /// Deep, strictly paired head-to-head between two `fill_segment` variants.
    ///
    /// The eleven-way `fill_block_variant_shootout` is for ranking; this is for
    /// *deciding*. Two candidates only, many more reps, and the pair is timed
    /// back to back within one rep with the order flipped every rep, so a
    /// frequency or thermal step lands on both sides of the comparison instead
    /// of on one of them.
    ///
    /// Reports the per-rep WIN RATE alongside the aggregate. With paired
    /// samples, "b beat a in 29 of 31 reps" is a much stronger claim than a
    /// couple of percent between two medians, and it is the statistic that
    /// survives the run-to-run drift this machine has: criterion's own
    /// before/after comparison moved the *unchanged* scalar backend by 3-8 %
    /// between two runs of this crate's bench suite.
    #[cfg(feature = "std")]
    fn paired_head_to_head(
        a: (&str, unsafe fn(&Instance, Position)),
        b: (&str, unsafe fn(&Instance, Position)),
    ) {
        const REPS: usize = 31;

        std::eprintln!(
            "\n{:>8} {:>7}  {:>20}  {:>20}  {:>8}  {:>8}",
            "m_cost",
            "passes",
            a.0,
            b.0,
            "x(min)",
            "b wins"
        );
        for (m_cost, passes) in [
            (1024u32, 2u32),
            (4096, 2),
            (16384, 2),
            (65536, 1),
            (65536, 2),
            (262144, 2),
        ] {
            let params = Params::builder()
                .memory(Memory::kib(u64::from(m_cost)))
                .passes(passes)
                .lanes(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let (memory_blocks, _, _) = params.memory_layout();
            let n = memory_blocks as usize;
            let blocks_filled = f64::from(memory_blocks) * f64::from(passes);

            let mut arena: alloc::vec::Vec<Block> = alloc::vec![Block::ZERO; n];
            let (mut sa, mut sb) = (
                alloc::vec::Vec::with_capacity(REPS),
                alloc::vec::Vec::with_capacity(REPS),
            );
            let mut b_wins = 0usize;

            for rep in 0..REPS {
                // Flip the order every rep so neither candidate is
                // systematically the one that pays for the cold arena.
                let (ta, tb) = if rep % 2 == 0 {
                    seed_arena(&mut arena);
                    let ta = time_full_fill(a.1, &mut arena, &params, passes);
                    seed_arena(&mut arena);
                    let tb = time_full_fill(b.1, &mut arena, &params, passes);
                    (ta, tb)
                } else {
                    seed_arena(&mut arena);
                    let tb = time_full_fill(b.1, &mut arena, &params, passes);
                    seed_arena(&mut arena);
                    let ta = time_full_fill(a.1, &mut arena, &params, passes);
                    (ta, tb)
                };
                if tb < ta {
                    b_wins += 1;
                }
                sa.push(ta);
                sb.push(tb);
            }

            let stat = |v: &mut alloc::vec::Vec<f64>| {
                v.sort_by(f64::total_cmp);
                (v[0], v[v.len() / 2])
            };
            let (amin, amed) = stat(&mut sa);
            let (bmin, bmed) = stat(&mut sb);
            std::eprintln!(
                "{m_cost:>8} {passes:>7}  {:>8.1} {:>8.1} ns  {:>8.1} {:>8.1} ns  {:>8.3}  {b_wins:>4}/{REPS}",
                amin * 1e9 / blocks_filled,
                amed * 1e9 / blocks_filled,
                bmin * 1e9 / blocks_filled,
                bmed * 1e9 / blocks_filled,
                amin / bmin,
            );
        }
        std::eprintln!(
            "(each pair of columns is min then median ns/block; \"b wins\" counts paired reps)"
        );
    }

    /// THE KEPT CHANGE: the paired `UZP1` + `UMULL`/`UMULL2` narrowing against
    /// the `XTN` x2 + `UMULL` spelling it replaced. Everything else identical.
    #[cfg(feature = "std")]
    #[test]
    #[ignore = "scaffolding: run explicitly, it takes ~2 min"]
    fn shipped_multiply_vs_the_spelling_it_replaced() {
        paired_head_to_head(
            (
                "XTN x2 + UMULL",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED2>,
            ),
            (
                "UZP1 + UMULL/2",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
            ),
        );
    }

    /// A REJECTED CHANGE, kept so the rejection stays reproducible: dropping the
    /// carried `state` and re-reading the previous block from the arena. Wins
    /// while the arena is cache-resident and loses once it is not; see the
    /// module docs.
    #[cfg(feature = "std")]
    #[test]
    #[ignore = "scaffolding: run explicitly, it takes ~2 min"]
    fn carried_state_vs_reread_prev() {
        paired_head_to_head(
            (
                "carry state (opt.c)",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
            ),
            (
                "re-read prev",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2_PREV>,
            ),
        );
    }

    /// A REJECTED CHANGE: four independent rounds interleaved instead of two.
    #[cfg(feature = "std")]
    #[test]
    #[ignore = "scaffolding: run explicitly, it takes ~2 min"]
    fn two_way_vs_four_way_interleaving() {
        paired_head_to_head(
            (
                "x2 (shipped)",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
            ),
            (
                "x4",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED4>,
            ),
        );
    }

    #[cfg(feature = "std")]
    #[test]
    #[ignore = "scaffolding: run explicitly, it takes ~1 min"]
    fn fill_block_variant_shootout() {
        const REPS: usize = 15;

        type V = unsafe fn(&Instance, Position);
        let candidates: [(&str, V); 15] = [
            (
                "x1, UMULL, REV64  (as ported)",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_REV, FUSED>,
            ),
            (
                "x2, UMULL, REV64",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_REV, FUSED2>,
            ),
            (
                "x2, UMULL, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED2>,
            ),
            (
                "x2, UZP1,  XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP, ROR32_XAR, FUSED2>,
            ),
            (
                "x2, UMLAL, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMLAL, ROR32_XAR, FUSED2>,
            ),
            (
                "x2, UMLAL, XAR, TBL rot",
                fill_segment_variant::<TABLE_ROTATES, MUL_UMLAL, ROR32_XAR, FUSED2>,
            ),
            // The paired narrowing, and the three knobs it interacts with.
            (
                "x2, UZPPAIR, XAR  (shipped)",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
            ),
            (
                "x1, UZPPAIR, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED>,
            ),
            (
                "x2, UZPPAIR, REV64",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_REV, FUSED2>,
            ),
            (
                "x2, UZPPAIR, XAR, TBL rot",
                fill_segment_variant::<TABLE_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2>,
            ),
            (
                "x2, UZPPAIR+UMLAL, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR_MLAL, ROR32_XAR, FUSED2>,
            ),
            (
                "x2, UZPPAIR, XAR, prev",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED2_PREV>,
            ),
            (
                "x2, UMULL, XAR, prev",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED2_PREV>,
            ),
            (
                "x4, UZPPAIR, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UZP_PAIR, ROR32_XAR, FUSED4>,
            ),
            (
                "x4, UMULL, XAR",
                fill_segment_variant::<SHIFT_ROTATES, MUL_UMULL, ROR32_XAR, FUSED4>,
            ),
        ];

        for (label, m_cost) in [
            ("m=4096 (4 MiB, cache-resident)", 4096u32),
            ("m=65536 (64 MiB, DRAM-bound)", 1 << 16),
        ] {
            let params = Params::builder()
                .memory(Memory::kib(u64::from(m_cost)))
                .passes(2)
                .lanes(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let (memory_blocks, _, _) = params.memory_layout();
            let n = memory_blocks as usize;
            let blocks_filled = f64::from(memory_blocks) * 2.0;

            let mut arena: alloc::vec::Vec<Block> = alloc::vec![Block::ZERO; n];
            let mut samples: [alloc::vec::Vec<f64>; 15] =
                core::array::from_fn(|_| alloc::vec::Vec::with_capacity(REPS));

            // Round-robin so drift is shared out evenly, and rotate the
            // starting candidate every rep so no candidate is systematically
            // first (or last) in the cache/DVFS state each rep leaves behind.
            for rep in 0..REPS {
                for offset in 0..candidates.len() {
                    let k = (rep + offset) % candidates.len();
                    seed_arena(&mut arena);
                    samples[k].push(time_full_fill(candidates[k].1, &mut arena, &params, 2));
                }
            }

            let stat = |v: &[f64]| {
                let mut v = v.to_vec();
                v.sort_by(f64::total_cmp);
                (v[0], v[v.len() / 2])
            };
            let (base_min, base_med) = stat(&samples[0]);

            std::eprintln!("\n{label}, 2 passes, {REPS} reps, rotated round-robin:");
            std::eprintln!(
                "  {:<30} {:>9} {:>9} {:>9} {:>9}",
                "variant",
                "min ms",
                "med ms",
                "ns/blk",
                "x vs base"
            );
            for (k, (name, _)) in candidates.iter().enumerate() {
                let (mn, med) = stat(&samples[k]);
                std::eprintln!(
                    "  {name:<30} {:>9.2} {:>9.2} {:>9.1} {:>8.3}x",
                    mn * 1e3,
                    med * 1e3,
                    mn * 1e9 / blocks_filled,
                    (base_min / mn + base_med / med) / 2.0,
                );
            }
        }
    }

    #[cfg(feature = "std")]
    #[test]
    #[cfg_attr(debug_assertions, ignore = "meaningless without optimisations")]
    fn neon_matches_scalar_on_large_arenas() {
        // The headline number, plus a cache-resident control that separates
        // compression cost from arena latency: at m_cost = 65536 the reference
        // block is a random 1 KiB in a 64 MiB working set, so a large slice of
        // every iteration is a DRAM round trip that no backend can avoid. At
        // m_cost = 1024 the whole arena fits in L2.
        //
        // The speedup is printed, not asserted. What is asserted is that the
        // two backends agree, and these are the only sizes where that is
        // checked: `whole_hash_matches_scalar_across_the_parameter_matrix`
        // sweeps algorithms, versions, lanes and passes but tops out near
        // 3 MiB, so nothing else exercises NEON against scalar in the regime
        // where the arena outgrows cache and `index_alpha` reaches across a
        // working set that no prefetcher can cover.
        for (label, m_cost) in [
            ("m=1024 (1 MiB, L2)", 1024u32),
            ("m=65536 (64 MiB)", 1 << 16),
        ] {
            let params = Params::builder()
                .memory(Memory::kib(u64::from(m_cost)))
                .passes(3)
                .lanes(1)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let blocks = f64::from(m_cost) * 3.0;

            let once = |backend: Backend| {
                hash(
                    backend,
                    Algorithm::Argon2id,
                    Version::V0x13,
                    &params,
                    b"somesalt",
                )
            };

            // Warms the allocator and the page cache for both — and the two
            // tags it produces are what this test asserts on.
            let scalar_tag = once(Backend::Scalar);
            let neon_tag = once(Backend::Neon);
            assert_eq!(
                neon_tag, scalar_tag,
                "{label}: NEON tag differs from scalar"
            );

            // Keep the results observable so nothing is optimised away.
            let once = |backend: Backend| {
                core::hint::black_box(once(backend));
            };

            // Interleaved, so a DVFS or thermal step cannot land on one
            // candidate only. Nothing below fails on these numbers, but a
            // printed ratio that misattributes a contention window is worse
            // than no ratio at all — someone will quote it.
            let (scalar_s, neon_s) =
                best_of_interleaved(5, || once(Backend::Scalar), || once(Backend::Neon));

            std::eprintln!(
                "argon2id t=3 p=1 {label}, best of 5 interleaved:\n  \
                 scalar {:>8.2} ms  ({:>6.1} ns/block, {:>5.2} GiB/s)\n  \
                 neon   {:>8.2} ms  ({:>6.1} ns/block, {:>5.2} GiB/s)\n  \
                 speedup x{:.2}",
                scalar_s * 1e3,
                scalar_s * 1e9 / blocks,
                blocks * 1024.0 / scalar_s / (1024.0 * 1024.0 * 1024.0),
                neon_s * 1e3,
                neon_s * 1e9 / blocks,
                blocks * 1024.0 / neon_s / (1024.0 * 1024.0 * 1024.0),
                scalar_s / neon_s,
            );
        }
    }
}
