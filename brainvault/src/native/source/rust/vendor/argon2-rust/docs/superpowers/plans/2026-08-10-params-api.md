# Params API Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Params`' two positional constructors with typed units and a chainable `const` builder, so a call site names and dimensions every cost parameter.

**Architecture:** Two newtypes, `Memory` (kibibytes) and `TagLen` (bytes), hold a `u64` and validate nothing. `ParamsBuilder` carries them plus three `u32` counts and takes `self` by value in every `const fn` setter, which is what lets a `const Params` exist. `build()` performs the two range checks that make narrowing to `u32`/`usize` lossless, then delegates to the existing `validate_inputs` so the C's check order is preserved. `Params` itself is unchanged internally: same private `u32` fields, same "always valid" guarantee.

**Tech Stack:** Rust 2024 edition, `#![no_std]` + `extern crate alloc`, zero mandatory dependencies, MSRV 1.89.

## Global Constraints

Every task's requirements implicitly include this section.

- MSRV is **1.89**. Do not use a feature stabilized later. `saturating_mul`, `const panic!`, and mutable locals in `const fn` are all older than this and are fine.
- **Zero mandatory dependencies.** Do not add one.
- The crate is `#![no_std]` with `extern crate alloc`. `std` is a feature. Nothing in `src/params.rs` may need `std`.
- **No public fallible path may panic.** `ParamsBuilder::build_or_panic` is the single, documented exception.
- **Do not add an `Error` variant.** None is needed. Every condition maps to a variant that already exists.
- **Check order must match the C.** `validate_inputs` checks `out_len` before `m_cost` (`src/params.rs:381` vs `:413`). Therefore `build()` checks `tag_len` before `memory`.
- **No hashing behavior change.** All 24 official vectors in `tests/vectors.rs`, the KAT traces, and the live differential test against the C must produce byte-identical tags. No expectation in `tests/` changes except the spelling of `Params` construction.
- Vocabulary is fixed: `memory`, `passes`, `lanes`, `threads`, `tag_len`. Not `m_cost`, `t_cost`, `p_cost`, `output_len`.
- Public accessors are exactly: `memory()`, `memory_kib()`, `passes()`, `lanes()`, `threads()`, `tag_len()`, `tag_len_bytes()`.
- Exactly three presets: `Params::OWASP` (equals `Params::DEFAULT`), `Params::RFC9106_HIGH_MEMORY`, `Params::RFC9106_LOW_MEMORY`.
- `TagLen` has one constructor, `bytes()`. There is no `bits()`.
- Every new public item needs a doc comment. `#![deny(missing_docs)]`-grade prose is the house style; match the density of the surrounding file.
- **The docs build is a CI gate.** `ci.yml:96-108` runs `cargo doc --no-deps` and `cargo doc --no-deps --all-features`, both with `RUSTDOCFLAGS: -D warnings`. An intra-doc link to an item that does not exist yet is therefore a build failure, not a warning. Never write `[`Item`]` for something a later task introduces — use a plain code span and convert it to a link in the task that adds the item.
- Full spec: `docs/superpowers/specs/2026-08-10-params-api-design.md`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/params.rs` | Limits, `validate_inputs`, `Algorithm`, `Version`, `Params` | Add `Memory`, `TagLen`, `ParamsBuilder`, presets, new accessors; delete `new`, `new_with_threads`, the four `DEFAULT_*` consts, and the old accessors |
| `src/core.rs` | `Argon2`, `Hasher`, hashing entry points | Accessor renames only |
| `src/encoding.rs` | PHC encode/decode | Accessor renames; the decoder at `:949` builds through `ParamsBuilder`; three doc comments reference `Params::new`'s argument order and must be rewritten |
| `src/block.rs`, `src/fill_block/sse2.rs` | Block arena, SSE2 backend | Accessor renames only |
| `tests/*.rs` (7 files) | Vectors, KAT, differential, reuse, readme, allocation audit, RSS | Construction and accessor spelling only |
| `benches/*.rs` (6 files) | Criterion and bespoke harnesses | Construction and accessor spelling only |
| `README.md` | Quick start, verify-bounded section | Construction spelling; the `Params::new` vs `new_with_threads` paragraph is rewritten |

Unit tests for the new types go in the existing `#[cfg(test)] mod tests` at `src/params.rs:720`, matching the crate's pattern.

Call-site inventory, for scale: 126 `Params::new(`, 58 `Params::new_with_threads(`, and accessor uses of `m_cost()`/`t_cost()`/`output_len()` numbering 47 in `src/`, 7 in `tests/`, 18 in `benches/`. The compiler enumerates every one of them; you do not need to find them by hand.

---

## Task 1: Memory and TagLen newtypes

Purely additive. Nothing else in the crate references these yet, so the crate compiles and the whole suite passes at the end of this task.

**Files:**
- Modify: `src/params.rs` — add the two types after the limit constants and before `validate_inputs` (i.e. after `src/params.rs:80`, the `MAX_SECRET` const)
- Test: `src/params.rs` — the existing `mod tests` at `:720`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub struct Memory(u64)` with `const fn kib(u64) -> Memory`, `const fn mib(u64) -> Memory`, `const fn gib(u64) -> Memory`, `const fn as_kib(self) -> u64`
  - `pub struct TagLen(u64)` with `const fn bytes(u64) -> TagLen`, `const fn as_bytes(self) -> u64`
  - Both derive `Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src/params.rs`:

```rust
#[test]
fn memory_units_convert() {
    assert_eq!(Memory::kib(65536), Memory::mib(64));
    assert_eq!(Memory::mib(1024), Memory::gib(1));
    assert_eq!(Memory::gib(2).as_kib(), 2 * 1024 * 1024);
    assert_eq!(Memory::kib(19456).as_kib(), 19456);
}

/// A plain `*` would panic here in a debug build. These constructors promise
/// not to, so an absurd request saturates and is rejected later, by `build()`.
#[test]
fn memory_saturates_instead_of_overflowing() {
    assert_eq!(Memory::mib(u64::MAX).as_kib(), u64::MAX);
    assert_eq!(Memory::gib(u64::MAX).as_kib(), u64::MAX);
    assert_eq!(Memory::gib(u64::MAX / 1024).as_kib(), u64::MAX);
}

#[test]
fn memory_orders_by_size() {
    assert!(Memory::mib(64) > Memory::kib(19456));
    assert!(Memory::gib(1) > Memory::mib(64));
}

#[test]
fn tag_len_carries_bytes() {
    assert_eq!(TagLen::bytes(32).as_bytes(), 32);
    assert!(TagLen::bytes(64) > TagLen::bytes(32));
}

/// Both types must be usable in a `const` item, or the builder cannot be.
#[test]
fn units_are_const() {
    const M: Memory = Memory::mib(64);
    const T: TagLen = TagLen::bytes(32);
    assert_eq!(M.as_kib(), 65536);
    assert_eq!(T.as_bytes(), 32);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib params::tests::memory_units_convert`
Expected: FAIL to compile, `cannot find type Memory in this scope`.

- [ ] **Step 3: Implement the two types**

Insert into `src/params.rs` after the `MAX_SECRET` const:

```rust
// ---------------------------------------------------------------------------
// Typed units
// ---------------------------------------------------------------------------

/// A memory cost, carried in kibibytes.
///
/// The unit is the point of this type. Argon2's `m_cost` is a count of 1 KiB
/// blocks, so a bare `65536` at a call site could be read as bytes, KiB, MiB or
/// blocks; `Memory::mib(64)` cannot.
///
/// No constructor validates or panics. The value is held as a `u64` and checked
/// once, by [`ParamsBuilder::build`], which is the only place that knows the
/// target's `MAX_MEMORY`.
///
/// ```
/// use argon2_rust::params::Memory;
///
/// assert_eq!(Memory::mib(64), Memory::kib(65536));
/// assert_eq!(Memory::gib(1), Memory::mib(1024));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Memory(u64);

impl Memory {
    /// A cost in kibibytes, the unit Argon2's `m_cost` uses.
    #[inline]
    #[must_use]
    pub const fn kib(kib: u64) -> Memory {
        Memory(kib)
    }

    /// A cost in mebibytes.
    ///
    /// Saturating, not wrapping: `mib(u64::MAX)` yields `u64::MAX` KiB rather
    /// than panicking in a debug build. Any saturated value is far above
    /// [`MAX_MEMORY`] and becomes [`Error::MemoryTooMuch`] at `build()`.
    #[inline]
    #[must_use]
    pub const fn mib(mib: u64) -> Memory {
        Memory(mib.saturating_mul(1024))
    }

    /// A cost in gibibytes. Saturating, for the reason given on [`Memory::mib`].
    #[inline]
    #[must_use]
    pub const fn gib(gib: u64) -> Memory {
        Memory(gib.saturating_mul(1024 * 1024))
    }

    /// The cost in kibibytes.
    #[inline]
    #[must_use]
    pub const fn as_kib(self) -> u64 {
        self.0
    }
}

/// A tag length, carried in bytes.
///
/// There is deliberately no `bits()` constructor: a bit count that is not a
/// whole number of bytes would be the only new failure mode in this API, and
/// `TagLen::bytes(32)` already names the unit at the call site. RFC 9106's
/// "256-bit tag" is written `TagLen::bytes(32)`.
///
/// Like [`Memory`], this validates nothing; [`ParamsBuilder::build`] does.
///
/// ```
/// use argon2_rust::params::TagLen;
///
/// assert_eq!(TagLen::bytes(32).as_bytes(), 32);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TagLen(u64);

impl TagLen {
    /// A tag length in bytes.
    #[inline]
    #[must_use]
    pub const fn bytes(bytes: u64) -> TagLen {
        TagLen(bytes)
    }

    /// The length in bytes.
    #[inline]
    #[must_use]
    pub const fn as_bytes(self) -> u64 {
        self.0
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib params::tests`
Expected: PASS, including the five new tests.

- [ ] **Step 5: Verify the doc examples compile**

Run: `cargo test --doc params`
Expected: PASS. The examples use the `argon2_rust::params::` path, which is public.

- [ ] **Step 6: Commit**

```bash
git add src/params.rs
git commit -m "feat(params): add Memory and TagLen typed units"
```

---

## Task 2: ParamsBuilder, presets, and the new accessors

Still additive. `Params::new`, `Params::new_with_threads`, the `DEFAULT_*` consts and the old accessors all remain, so the crate and the whole suite still work. Task 4 deletes them.

**Files:**
- Modify: `src/params.rs` — add `ParamsBuilder` after the `Params` struct definition; add the consts, `builder()`, `to_builder()` and the new accessors to `impl Params`; rewrite `impl Default for Params`
- Test: `src/params.rs` — the existing `mod tests`

**Interfaces:**
- Consumes: `Memory`, `TagLen` from Task 1; the existing `validate_inputs`, `MAX_MEMORY`, `MAX_OUTLEN`, `MIN_SALT_LENGTH`, and the private `Params` fields `m_cost`, `t_cost`, `lanes`, `threads`, `output_len`
- Produces:
  - `pub struct ParamsBuilder` with `pub const DEFAULT: ParamsBuilder`
  - Setters, each `pub const fn(self, …) -> ParamsBuilder`: `memory(Memory)`, `passes(u32)`, `lanes(u32)`, `threads(u32)`, `tag_len(TagLen)`
  - `pub const fn build(self) -> Result<Params, Error>`, `pub const fn build_or_panic(self) -> Params`
  - `impl Default for ParamsBuilder`
  - `Params::DEFAULT`, `Params::OWASP`, `Params::RFC9106_HIGH_MEMORY`, `Params::RFC9106_LOW_MEMORY`, all `pub const Params`
  - `pub const fn Params::builder() -> ParamsBuilder`, `pub const fn Params::to_builder(self) -> ParamsBuilder`
  - `pub const fn Params::memory(&self) -> Memory`, `memory_kib(&self) -> u32`, `passes(&self) -> u32`, `tag_len(&self) -> TagLen`, `tag_len_bytes(&self) -> usize`

**Ordering constraint you must not get wrong:** `ParamsBuilder::DEFAULT` holds literal values (`19456`, `2`, `1`, `None`, `32`) and `Params::DEFAULT` is built *from it*. Defining it the other way round — a builder that starts from `Params::DEFAULT` while `Params::DEFAULT` is built by the builder — is a cyclic `const` dependency and will not compile.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src/params.rs`:

```rust
/// A `const` item, not a `let`. This is the whole reason the setters take
/// `self` by value; if constness regresses, this stops compiling.
const CONST_BUILT: Params = Params::builder()
    .memory(Memory::mib(64))
    .passes(3)
    .lanes(4)
    .build_or_panic();

#[test]
fn builder_builds_in_a_const_item() {
    assert_eq!(CONST_BUILT.memory_kib(), 65536);
    assert_eq!(CONST_BUILT.passes(), 3);
    assert_eq!(CONST_BUILT.lanes(), 4);
    assert_eq!(CONST_BUILT.threads(), 4);
    assert_eq!(CONST_BUILT.tag_len_bytes(), 32);
}

#[test]
fn threads_defaults_to_lanes_but_an_explicit_value_survives() {
    let implicit = Params::builder().lanes(4).build().unwrap();
    assert_eq!((implicit.lanes(), implicit.threads()), (4, 4));

    // Order must not matter: setting lanes after threads may not clobber it.
    let explicit = Params::builder().threads(2).lanes(4).build().unwrap();
    assert_eq!((explicit.lanes(), explicit.threads()), (4, 2));
    assert_eq!(explicit.effective_threads(), 2);
}

#[test]
fn typed_and_raw_accessors_agree() {
    let p = Params::builder()
        .memory(Memory::mib(64))
        .tag_len(TagLen::bytes(64))
        .build()
        .unwrap();
    assert_eq!(p.memory(), Memory::mib(64));
    assert_eq!(p.memory().as_kib(), u64::from(p.memory_kib()));
    assert_eq!(p.tag_len(), TagLen::bytes(64));
    assert_eq!(p.tag_len().as_bytes() as usize, p.tag_len_bytes());
}

#[test]
fn presets_hold_their_documented_numbers() {
    assert_eq!(Params::OWASP, Params::DEFAULT);
    assert_eq!(Params::DEFAULT, Params::default());

    assert_eq!(Params::OWASP.memory_kib(), 19456);
    assert_eq!((Params::OWASP.passes(), Params::OWASP.lanes()), (2, 1));
    assert_eq!(Params::OWASP.tag_len_bytes(), 32);

    assert_eq!(Params::RFC9106_HIGH_MEMORY.memory(), Memory::gib(2));
    assert_eq!(
        (
            Params::RFC9106_HIGH_MEMORY.passes(),
            Params::RFC9106_HIGH_MEMORY.lanes()
        ),
        (1, 4)
    );

    assert_eq!(Params::RFC9106_LOW_MEMORY.memory(), Memory::mib(64));
    assert_eq!(
        (
            Params::RFC9106_LOW_MEMORY.passes(),
            Params::RFC9106_LOW_MEMORY.lanes()
        ),
        (3, 4)
    );
}

#[test]
fn to_builder_round_trips_every_preset() {
    for preset in [
        Params::OWASP,
        Params::RFC9106_HIGH_MEMORY,
        Params::RFC9106_LOW_MEMORY,
    ] {
        assert_eq!(preset.to_builder().build(), Ok(preset));
    }
}

#[test]
fn a_preset_can_be_adjusted() {
    let narrow = Params::RFC9106_LOW_MEMORY
        .to_builder()
        .lanes(1)
        .build()
        .unwrap();
    assert_eq!(narrow.memory(), Memory::mib(64));
    assert_eq!(narrow.passes(), 3);
    assert_eq!(narrow.lanes(), 1);
}

#[test]
fn build_rejects_every_out_of_range_value() {
    let b = Params::builder();
    assert_eq!(b.memory(Memory::gib(9999)).build(), Err(Error::MemoryTooMuch));
    assert_eq!(b.memory(Memory::kib(4)).build(), Err(Error::MemoryTooLittle));
    assert_eq!(b.tag_len(TagLen::bytes(3)).build(), Err(Error::OutputTooShort));
    assert_eq!(
        b.tag_len(TagLen::bytes(1 << 40)).build(),
        Err(Error::OutputTooLong)
    );
    assert_eq!(b.passes(0).build(), Err(Error::TimeTooSmall));
    assert_eq!(b.lanes(0).build(), Err(Error::LanesTooFew));
    assert_eq!(b.threads(0).build(), Err(Error::ThreadsTooFew));
}

/// `validate_inputs` checks BOTH `out_len` bounds before `m_cost`
/// (params.rs:381-386 vs :413). `build()`'s own pre-narrowing checks must keep
/// that order, so a caller who gets both wrong sees the error the C would have
/// reported. Both directions are pinned: checking only the upper bound first is
/// the bug this test exists to catch.
#[test]
fn tag_len_is_checked_before_memory_like_the_c() {
    let too_long = Params::builder()
        .memory(Memory::gib(9999))
        .tag_len(TagLen::bytes(1 << 40))
        .build();
    assert_eq!(too_long, Err(Error::OutputTooLong));

    // The case that a two-check implementation gets wrong: the tag is too
    // SHORT, so only `validate_inputs` would catch it — but the memory
    // pre-check would already have returned MemoryTooMuch. Reachable from a
    // crafted PHC string with a 3-byte tag and a large `m=`.
    let too_short = Params::builder()
        .memory(Memory::kib(MAX_MEMORY as u64 + 1))
        .tag_len(TagLen::bytes(3))
        .build();
    assert_eq!(too_short, Err(Error::OutputTooShort));
}

/// A saturated `Memory` must be rejected, not truncated into a legal `u32`.
#[test]
fn a_saturated_memory_is_rejected() {
    assert_eq!(
        Params::builder().memory(Memory::gib(u64::MAX)).build(),
        Err(Error::MemoryTooMuch)
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib params::tests::builder_builds_in_a_const_item`
Expected: FAIL to compile, `no function or associated item named builder found for struct Params`.

- [ ] **Step 3: Implement ParamsBuilder**

Insert into `src/params.rs` immediately after the `Params` struct definition (after its closing brace, before `impl Params`):

```rust
/// Builder for [`Params`].
///
/// Every setter is a `const fn` taking `self` by value, so a `Params` can be
/// built in a `const` item — see [`ParamsBuilder::build_or_panic`]. The builder
/// starts from [`ParamsBuilder::DEFAULT`], so each setter is optional.
///
/// ```
/// use argon2_rust::{Params, params::{Memory, TagLen}};
///
/// let params = Params::builder()
///     .memory(Memory::mib(64))
///     .passes(3)
///     .lanes(4)
///     .tag_len(TagLen::bytes(32))
///     .build()?;
/// assert_eq!(params.memory(), Memory::mib(64));
/// # Ok::<(), argon2_rust::Error>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParamsBuilder {
    memory: Memory,
    passes: u32,
    lanes: u32,
    /// `None` means "track `lanes`", which is what `argon2_hash()` does: it
    /// sets both `context.lanes` and `context.threads` from one argument.
    /// Storing the choice rather than eagerly copying `lanes` is what makes
    /// `.threads(2).lanes(4)` and `.lanes(4).threads(2)` agree.
    threads: Option<u32>,
    tag_len: TagLen,
}

impl ParamsBuilder {
    /// The starting point: OWASP's Argon2id profile, 19 MiB, two passes, one
    /// lane, a 32-byte tag.
    ///
    /// These are literals rather than a copy of [`Params::DEFAULT`]'s fields
    /// on purpose. `Params::DEFAULT` is built *by* this builder, so reading it
    /// here would be a cyclic `const`.
    pub const DEFAULT: ParamsBuilder = ParamsBuilder {
        memory: Memory::kib(19456),
        passes: 2,
        lanes: 1,
        threads: None,
        tag_len: TagLen::bytes(32),
    };

    /// Set the memory cost.
    #[inline]
    #[must_use]
    pub const fn memory(mut self, memory: Memory) -> ParamsBuilder {
        self.memory = memory;
        self
    }

    /// Set the number of passes (`t_cost` in the C, `t=` in a PHC string).
    #[inline]
    #[must_use]
    pub const fn passes(mut self, passes: u32) -> ParamsBuilder {
        self.passes = passes;
        self
    }

    /// Set the degree of parallelism (`p=` in a PHC string).
    ///
    /// This one feeds the tag. Changing it changes the hash.
    #[inline]
    #[must_use]
    pub const fn lanes(mut self, lanes: u32) -> ParamsBuilder {
        self.lanes = lanes;
        self
    }

    /// Set the worker-thread budget.
    ///
    /// A pure performance knob: it does not affect the tag. Left unset, it
    /// tracks `lanes`. See [`Params::effective_threads`].
    #[inline]
    #[must_use]
    pub const fn threads(mut self, threads: u32) -> ParamsBuilder {
        self.threads = Some(threads);
        self
    }

    /// Set the tag length.
    #[inline]
    #[must_use]
    pub const fn tag_len(mut self, tag_len: TagLen) -> ParamsBuilder {
        self.tag_len = tag_len;
        self
    }

    /// Validate and produce [`Params`].
    ///
    /// # Errors
    ///
    /// Any of the cost-parameter errors from [`validate_inputs`], plus
    /// [`Error::OutputTooLong`] and [`Error::MemoryTooMuch`] for values too
    /// large for this target at all.
    pub const fn build(self) -> Result<Params, Error> {
        // `Memory` and `TagLen` hold `u64`; `validate_inputs` takes a `u32`
        // memory cost and a `usize` output length. Range-check BEFORE
        // narrowing: on a 32-bit target `(1u64 << 40) as usize` is 0, which
        // would turn OutputTooLong into OutputTooShort.
        //
        // The order here is the C's. `validate_inputs` checks BOTH `out_len`
        // bounds before it looks at `m_cost`, so both are checked here too —
        // pre-checking only the upper bound would report MemoryTooMuch for a
        // 3-byte tag combined with an over-large memory cost, where the C
        // reports OutputTooShort. That combination is reachable from a crafted
        // PHC string, whose tag length and `m=` are both attacker-chosen.
        let bytes = self.tag_len.as_bytes();
        if bytes > MAX_OUTLEN as u64 {
            return Err(Error::OutputTooLong);
        }
        if bytes < MIN_OUTLEN as u64 {
            return Err(Error::OutputTooShort);
        }
        let kib = self.memory.as_kib();
        if kib > MAX_MEMORY as u64 {
            return Err(Error::MemoryTooMuch);
        }

        let threads = match self.threads {
            Some(threads) => threads,
            None => self.lanes,
        };

        // Placeholder lengths that always pass their own checks, so the
        // *relative* order of the checks that do apply is exactly the C's.
        match validate_inputs(
            bytes as usize,
            0,
            MIN_SALT_LENGTH as usize,
            0,
            0,
            kib as u32,
            self.passes,
            self.lanes,
            threads,
        ) {
            Ok(()) => {}
            Err(e) => return Err(e),
        }

        Ok(Params {
            m_cost: kib as u32,
            t_cost: self.passes,
            lanes: self.lanes,
            threads,
            output_len: bytes as u32,
        })
    }

    /// Validate and produce [`Params`], panicking on invalid parameters.
    ///
    /// This exists for `const` items, where a panic is a compile error:
    ///
    /// ```
    /// use argon2_rust::{Params, params::Memory};
    ///
    /// const LOGIN: Params = Params::builder()
    ///     .memory(Memory::mib(64))
    ///     .passes(3)
    ///     .build_or_panic();
    /// assert_eq!(LOGIN.passes(), 3);
    /// ```
    ///
    /// # Panics
    ///
    /// If the parameters are invalid. Use [`ParamsBuilder::build`] anywhere a
    /// runtime error is the right answer — it is the normal way in, and it is
    /// why no fallible path in this crate panics.
    #[must_use]
    pub const fn build_or_panic(self) -> Params {
        match self.build() {
            Ok(params) => params,
            Err(_) => panic!("invalid Argon2 parameters"),
        }
    }
}

impl Default for ParamsBuilder {
    fn default() -> ParamsBuilder {
        ParamsBuilder::DEFAULT
    }
}
```

Note on `mut self`: mutating a local in a `const fn` is long-stable and works on 1.89. If it somehow does not compile, replace each setter body with an explicit `ParamsBuilder { field: value, ..self }` construction rather than dropping `const`.

- [ ] **Step 4: Add the presets, entry points and new accessors**

Add to `impl Params` in `src/params.rs`, replacing the four `DEFAULT_M_COST` / `DEFAULT_T_COST` / `DEFAULT_LANES` / `DEFAULT_OUTPUT_LEN` constants *in Task 4*, not now — for this task, add alongside them:

```rust
    /// The recommended default: OWASP's Argon2id profile.
    ///
    /// 19 MiB, two passes, one lane, a 32-byte tag. Equal to [`Params::OWASP`]
    /// and to `Params::default()`.
    pub const DEFAULT: Params = ParamsBuilder::DEFAULT.build_or_panic();

    /// OWASP's Argon2id profile: 19 MiB, `t=2`, `p=1`, 32-byte tag.
    ///
    /// The same value as [`Params::DEFAULT`], under the name that says where
    /// the numbers come from.
    pub const OWASP: Params = Params::DEFAULT;

    /// RFC 9106 §4's first recommendation: 2 GiB, `t=1`, `p=4`, 32-byte tag.
    ///
    /// On a 32-bit target 2 GiB is exactly [`MAX_MEMORY`], so this constant
    /// still compiles there — but the arena will fail to allocate inside a
    /// 4 GiB address space. Prefer [`Params::RFC9106_LOW_MEMORY`] there.
    pub const RFC9106_HIGH_MEMORY: Params = ParamsBuilder::DEFAULT
        .memory(Memory::gib(2))
        .passes(1)
        .lanes(4)
        .build_or_panic();

    /// RFC 9106 §4's second recommendation, for memory-constrained systems:
    /// 64 MiB, `t=3`, `p=4`, 32-byte tag.
    pub const RFC9106_LOW_MEMORY: Params = ParamsBuilder::DEFAULT
        .memory(Memory::mib(64))
        .passes(3)
        .lanes(4)
        .build_or_panic();

    /// Start building, from [`ParamsBuilder::DEFAULT`].
    #[inline]
    #[must_use]
    pub const fn builder() -> ParamsBuilder {
        ParamsBuilder::DEFAULT
    }

    /// Reopen these parameters for adjustment.
    ///
    /// ```
    /// use argon2_rust::Params;
    ///
    /// let narrow = Params::RFC9106_LOW_MEMORY.to_builder().lanes(1).build()?;
    /// assert_eq!(narrow.lanes(), 1);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    #[inline]
    #[must_use]
    pub const fn to_builder(self) -> ParamsBuilder {
        ParamsBuilder {
            memory: Memory::kib(self.m_cost as u64),
            passes: self.t_cost,
            lanes: self.lanes,
            // `Some`, not `None`: a round trip must preserve an explicit
            // thread budget that differs from `lanes`.
            threads: Some(self.threads),
            tag_len: TagLen::bytes(self.output_len as u64),
        }
    }

    /// The memory cost.
    #[inline]
    #[must_use]
    pub const fn memory(&self) -> Memory {
        Memory::kib(self.m_cost as u64)
    }

    /// The memory cost in kibibytes (`context.m_cost`, `m=` in a PHC string).
    ///
    /// A `u32`, losslessly: `build()` rejected anything wider.
    #[inline]
    #[must_use]
    pub const fn memory_kib(&self) -> u32 {
        self.m_cost
    }

    /// Number of passes (`context.t_cost`, `instance.passes`, `t=`).
    #[inline]
    #[must_use]
    pub const fn passes(&self) -> u32 {
        self.t_cost
    }

    /// The tag length.
    #[inline]
    #[must_use]
    pub const fn tag_len(&self) -> TagLen {
        TagLen::bytes(self.output_len as u64)
    }

    /// The tag length in bytes (`context.outlen`).
    ///
    /// A `usize`, losslessly: `build()` rejected anything wider.
    #[inline]
    #[must_use]
    pub const fn tag_len_bytes(&self) -> usize {
        self.output_len as usize
    }
```

Then replace `impl Default for Params` at `src/params.rs:706` with:

```rust
impl Default for Params {
    /// [`Params::DEFAULT`]: OWASP's profile, 19 MiB, `t=2`, `p=1`, 32-byte tag.
    fn default() -> Params {
        Params::DEFAULT
    }
}
```

- [ ] **Step 5: Convert the two deferred doc links, then run the new tests**

Task 1 wrote `` `ParamsBuilder::build` `` as a plain code span in two places in
`src/params.rs` — the `Memory` type doc and the `TagLen` type doc — because the
item did not exist yet and an unresolvable intra-doc link fails the CI docs job.
`ParamsBuilder` exists now, so convert both to real links: `` [`ParamsBuilder::build`] ``.

Run: `cargo test --lib params::tests`
Expected: PASS, including all ten new tests.

- [ ] **Step 6: Run the whole suite and the docs gate**

Run:
```bash
cargo test --release --locked
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features
```
Expected: all PASS. The suite is 357 tests at this point — the 350 baseline plus
Task 1's five unit tests and two doctests. The old constructors and accessors are
still present and untouched, so every existing test still compiles. The two doc
commands are the `ci.yml:96-108` gate; they must be clean now that the links from
Step 5 resolve.

- [ ] **Step 7: Commit**

```bash
git add src/params.rs
git commit -m "feat(params): add a const ParamsBuilder, presets and typed accessors"
```

---

## Task 3: Migrate the crate's internals and the PHC decoder

**Files:**
- Modify: `src/params.rs` — delete the old accessors `m_cost()`, `t_cost()`, `output_len()`
- Modify: `src/core.rs`, `src/encoding.rs`, `src/block.rs`, `src/fill_block/sse2.rs`, `src/params.rs` — accessor renames
- Modify: `tests/vectors.rs`, `tests/reuse.rs`, `benches/argon2.rs`, `benches/micro.rs` — accessor renames. These call the accessors this task deletes, so they must move in this task, not Task 4. Otherwise Step 5 cannot compile the test and bench targets.
- Modify: `src/encoding.rs:949` — the PHC decoder builds through `ParamsBuilder`
- Modify: `src/encoding.rs` around `:246-:293` — three doc comments describe `Params::new`'s argument order

This task renames accessor *calls* everywhere. It does not touch `Params::new`
or `Params::new_with_threads`, which still exist and still compile — Task 4
deletes those and migrates their call sites.

**Interfaces:**
- Consumes: everything Task 2 produced
- Produces: `Params` with only the new accessors. `lanes()`, `threads()`, `effective_threads()`, `memory_layout()`, `memory_blocks()`, `segment_length()`, `lane_length()` and `validate_for()` are unchanged and keep their names.

- [ ] **Step 1: Rename the accessor calls everywhere**

The mapping is exact and total:

| Old | New |
| --- | --- |
| `.m_cost()` | `.memory_kib()` |
| `.t_cost()` | `.passes()` |
| `.output_len()` | `.tag_len_bytes()` |

Apply it to all nine files that call them:

```bash
sed -i '' 's/\.m_cost()/.memory_kib()/g; s/\.t_cost()/.passes()/g; s/\.output_len()/.tag_len_bytes()/g' \
  src/core.rs src/encoding.rs src/block.rs src/fill_block/sse2.rs src/params.rs \
  tests/vectors.rs tests/reuse.rs benches/argon2.rs benches/micro.rs
```

`src/params.rs` is in that list for exactly one line: the doc example at
`src/params.rs:357` asserts `params.output_len() == 32`. A doctest is a caller
like any other, and `cargo test --doc` catches it if you miss it.

The four files under `tests/` and `benches/` are in the list because Step 2
deletes the accessors they call. Leaving them for Task 4 would make this task's
own `cargo test` step fail to compile.

The struct's private **fields** keep their names — `m_cost`, `t_cost`,
`output_len` — because they mirror `argon2_context`. Only method *calls* change,
so `self.m_cost` inside `Params`' own methods stays as it is. The sed above only
matches call syntax, `.m_cost()`, so it cannot touch a field access.

- [ ] **Step 2a: Repoint the doc links that name the accessors you are about to delete**

Deleting a public item turns every `[`Item`]` link to it into an unresolvable
link, which fails the `RUSTDOCFLAGS="-D warnings"` docs gate. The sed in Step 1
only matches call syntax, `.output_len()`, so it does not touch these. There are
eight, all naming `output_len`, and none naming `m_cost` or `t_cost`:

| Location | Current text | Becomes |
| --- | --- | --- |
| `src/core.rs:1192` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |
| `src/core.rs:1210` | `Params::output_len` (plain span, inside a doc example comment) | `Params::tag_len_bytes` |
| `src/core.rs:1266` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |
| `src/core.rs:1481` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |
| `src/core.rs:2203` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |
| `src/error.rs:91` | ``[`crate::Params::output_len`]`` | ``[`crate::Params::tag_len_bytes`]`` |
| `src/encoding.rs:700` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |
| `src/params.rs:406` | ``[`Params::output_len`]`` | ``[`Params::tag_len_bytes`]`` |

Line numbers are from the state at the start of this task and will drift as you
edit. Re-derive the list if needed with
`grep -rn 'Params::output_len' src` — it must return nothing when you are done.

- [ ] **Step 2: Delete the three old accessors**

Remove `pub const fn m_cost`, `pub const fn t_cost` and `pub const fn output_len` from `impl Params` in `src/params.rs`. Leave `lanes`, `threads`, `effective_threads` and everything below them alone.

- [ ] **Step 3: Rewrite the PHC decoder's construction**

`src/encoding.rs:949` currently reads:

```rust
    let params = Params::new_with_threads(m_cost, t_cost, lanes, threads, hash.len())?;
```

Replace it with:

```rust
    // Attacker-chosen values from the string, through the same validation any
    // caller's parameters get.
    let params = Params::builder()
        .memory(Memory::kib(u64::from(m_cost)))
        .passes(t_cost)
        .lanes(lanes)
        .threads(threads)
        .tag_len(TagLen::bytes(hash.len() as u64))
        .build()?;
```

Add `Memory` and `TagLen` to the file's `use crate::params::{…}` import list.

- [ ] **Step 4: Rewrite the three doc comments that describe the old argument order**

`src/encoding.rs` explains, around lines 246-251, 267-268 and 293, that the PHC string's field order is the reverse of `Params::new`'s arguments. That warning exists because the old signature was positional. Rewrite each so it describes the builder: the point to preserve is that a PHC string carries `m`, then `t`, then `p`, and that the decoder must not transpose them. Delete the "reversed against `Params::new`" framing — with named setters there is no argument order to reverse — and update the two runnable examples at `:268` and `:293` to the builder spelling.

- [ ] **Step 5: Build and run the whole suite, including benches**

Run:
```bash
cargo test --release --locked
cargo build --release --benches
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features
```
Expected: all PASS, 369 tests. The two doc commands are the `ci.yml:96-108` gate.
Step 2a below is what keeps them clean.

`--benches` matters here: `benches/argon2.rs` and
`benches/micro.rs` call the renamed accessors, and a plain `cargo test` does not
compile bench targets. Any missed call site is a compile error naming the file
and line.

- [ ] **Step 6: Confirm no accessor call survives**

Run: `grep -rn '\.m_cost()\|\.t_cost()\|\.output_len()' src tests benches README.md`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src tests benches
git commit -m "refactor(params): move every caller onto the typed accessors"
```

---

## Task 4: Delete the positional constructors and migrate every caller

**Files:**
- Modify: `src/params.rs` — delete `new`, `new_with_threads`, `DEFAULT_M_COST`, `DEFAULT_T_COST`, `DEFAULT_LANES`, `DEFAULT_OUTPUT_LEN`
- Modify: all of `src/` — 31 doctests and any remaining internal construction
- Modify: `tests/` (7 files), `benches/` (6 files)
- Modify: `README.md`

This task is about **construction** only. Task 3 already renamed every accessor
call, so nothing here touches `.memory_kib()`, `.passes()` or `.tag_len_bytes()`.
What remains is every `Params::new(` and `Params::new_with_threads(` call site.

**Interfaces:**
- Consumes: everything Tasks 1-3 produced
- Produces: a crate whose only way to build `Params` is `Params::builder()`, `Params::to_builder()`, a preset, or `Params::default()`

- [ ] **Step 1: Delete the old constructors and constants**

Remove from `impl Params` in `src/params.rs`: `pub const fn new`, `pub const fn new_with_threads`, and the four `DEFAULT_*` constants. `Params::DEFAULT` replaces all four.

**Before you start, one CI trap found during Task 3.** The two docs commands are
not equivalent, and only one of them catches a whole class of error. An intra-doc
link to an item that is public *only* behind a feature — for example
`decode_string`, which is `#[doc(hidden)]` behind `internal-api` — makes
`cargo doc --no-deps` fail with `rustdoc::private_intra_doc_links` while
`cargo doc --no-deps --all-features` **passes**. This task repoints
`Params::new` links across the crate, so it is exposed to exactly that asymmetry.
Run the default-features leg too, and never treat the `--all-features` leg alone
as proof.

- [ ] **Step 2: Let the compiler enumerate the breakage**

Run: `cargo build --all-targets 2>&1 | grep -c '^error'`
Expected: a large number. Each error names a file and line.

- [ ] **Step 3: Migrate every call site**

The translation is mechanical. `Params::new(m, t, p, out)` becomes:

```rust
Params::builder()
    .memory(Memory::kib(m))
    .passes(t)
    .lanes(p)
    .tag_len(TagLen::bytes(out))
    .build()?
```

and `Params::new_with_threads(m, t, p, threads, out)` adds `.threads(threads)`.

Three rules keep the diff honest:

1. **Drop a setter only when the value equals the default** — `passes(2)`, `lanes(1)`, `tag_len(TagLen::bytes(32))`. Test vectors must keep their explicit values even when they coincide with a default, because the vector is asserting that number.
2. **Use the clearest unit.** `Memory::kib(65536)` and `Memory::mib(64)` are the same value; in `tests/vectors.rs` the vectors are defined as `1 << m_cost_log2` KiB, so `Memory::kib(…)` is correct there. In prose examples and the README, `Memory::mib(64)` reads better.
3. **A test asserting an error keeps asserting the same error.** The variants did not change.

- [ ] **Step 4: Update the README**

`README.md:283` and `:302` construct `Params`. Rewrite both to the builder. Then rewrite the paragraph at `:313-:316`, which currently says "`Params::new` sets `threads == lanes` and so caps both together; reach for `Params::new_with_threads` to accept wide strings without spawning wide." The behavior is unchanged — an unset `.threads()` still tracks `lanes` — so the replacement says that in the builder's terms: leaving `.threads()` unset caps both together, and setting it accepts a wide string without spawning wide.

- [ ] **Step 5: Run the suite, including the README test**

Run: `cargo test --release --locked`
Expected: PASS, 369 tests — measure the count on the commit you start from rather than trusting this number, since earlier tasks moved it from 350 to 357 to 369. `tests/readme.rs` re-extracts every ```rust block from `README.md` and asserts each line appears in its transcription, so a README block you changed without changing that file fails here.

- [ ] **Step 6: Run the doctests**

Run: `cargo test --doc`
Expected: PASS, all 31 migrated examples.

- [ ] **Step 7: Verify no old spelling survives anywhere**

Run: `grep -rn 'Params::new\|DEFAULT_M_COST\|DEFAULT_T_COST\|DEFAULT_LANES\|DEFAULT_OUTPUT_LEN' src tests benches README.md`
Expected: no output.

- [ ] **Step 7a: Sweep stale line-number citations**

This branch grows `src/params.rs` by roughly 550 lines and renames items across
five files, so every `params.rs:NNN`-style citation written earlier in the branch
has drifted. Two are known: the comment inside `build()` and the doc comment on
`tag_len_is_checked_before_memory_like_the_c`, both citing `validate_inputs`'
`out_len` and `m_cost` checks.

Find them all with `grep -rn 'params\.rs:[0-9]' src`, then for each one either
repoint it at the correct current line or, preferably, replace the number with the
thing it identifies — `validate_inputs`' "Validate output length" and "Validate
memory cost" comments are stable where line numbers are not. A citation that
points at unrelated code is worse than no citation in a module whose whole claim
is a checkable correspondence with the C.

- [ ] **Step 8: Check the feature matrix and a 32-bit target**

Run:
```bash
cargo test --release --locked --no-default-features
cargo test --release --locked --all-features
cargo build --release --target wasm32-wasip1
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features
```
Expected: all PASS. `Params::new` appears in doc links and doc examples across the
crate; deleting it fails the docs gate until every one is repointed, exactly as in
Task 3's Step 2a. `grep -rn 'Params::new' src` must return nothing. The 32-bit narrowing tests run in CI's `i686-pc-windows-msvc` leg; locally, `cargo build --target i686-unknown-linux-gnu` at minimum type-checks the `MAX_MEMORY = 2 GiB` path if that target is installed.

- [ ] **Step 9: Commit**

```bash
git add src tests benches README.md
git commit -m "feat(params)!: replace the positional constructors with the builder"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: `Memory`/`TagLen` → Task 1; `ParamsBuilder`, presets, `Params::DEFAULT`, the accessor pairs → Task 2; validation order, the PHC decoder, the internal rename → Task 3; the deletions, the 184 call sites, the README and doctests → Task 4. The spec's three test groups appear as real code in Tasks 1 and 2, plus the suite runs in Tasks 3 and 4.

**One refinement of the spec, recorded here.** The spec says the builder "starts from `Params::DEFAULT`". Implemented literally that is a cyclic `const`, because `Params::DEFAULT` is built by the builder. Task 2 inverts the direction — `ParamsBuilder::DEFAULT` holds the literals and `Params::DEFAULT` is built from it — which produces identical values and is called out in Task 2's ordering constraint.

**Type consistency.** `memory_kib()` returns `u32` and `tag_len_bytes()` returns `usize` in every task that uses them. `Memory::as_kib()` and `TagLen::as_bytes()` return `u64` throughout. `threads` is `Option<u32>` in the builder and `u32` in `Params`, resolved only in `build()`.

**Ordering risk, flagged for the implementer.** `build()` checks *both* `tag_len` bounds before `memory`. Task 2's `tag_len_is_checked_before_memory_like_the_c` test pins both directions; do not reorder those blocks to read more naturally, and do not drop the lower-bound pre-check.

**Corrected after Task 2's review.** The first version of this plan pre-checked only the upper tag bound before memory, and its test covered only the too-long case. Codex caught that `TagLen::bytes(3)` with an over-large memory cost then returns `MemoryTooMuch` where the C returns `OutputTooShort` — reachable from a crafted PHC string, since a decoded tag length and `m=` are both attacker-chosen. Verified empirically before the plan was changed, not argued from the code alone.
