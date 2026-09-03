# Params API redesign: typed units and a const builder

Date: 2026-08-10
Status: approved, not implemented
Affects: `argon2-rust` 0.0.3 (breaking)

## Problem

`Params` is built from a run of unlabelled numbers:

```rust
let params = Params::new(65536, 3, 4, 32)?;          // m=64 MiB, t=3, p=4, out=32 B
let ceiling = Params::new(1 << 16, 8, 4, 32)?;
```

Both lines are from this crate's own README, and both need a trailing comment to
be legible. Three defects follow.

1. **Nothing at the call site says which number is which.** Swapping `m_cost` and
   `t_cost` produces a working hash with the wrong cost, and it compiles.
2. **The units live in comments.** `m_cost` is KiB and `output_len` is bytes, but
   both are plain integers, so `65536` could be bytes, KiB, MiB, or blocks.
3. **One constructor per optional argument.** `new` and `new_with_threads` differ
   by a single value. A third option would mean a third constructor, or a fifth
   positional argument on both.

## Evidence: what the ecosystem does

| Crate | Recent downloads | Construction |
| --- | --- | --- |
| `argon2` (RustCrypto) | 17.5 M | `Params::new(m_cost, t_cost, p_cost, Option<usize>)`, `const`, positional; plus `ParamsBuilder` and `Params::DEFAULT` |
| `rust-argon2` | 2.9 M | `Config` with 9 public fields, struct literal, plus `original()`, `owasp1()`–`owasp5()`, `rfc9106()`, `rfc9106_low_mem()` |
| `argon2rs` | 70 K | unmaintained |

Three conclusions shaped this design.

- The positional constructor is **not** the outlier. The dominant crate has the
  same shape. What it adds is a builder beside it, and a `DEFAULT`.
- Both live crates ship named presets. This crate has a `Default` impl and
  nothing else.
- RustCrypto's builder **cannot** build in a `const` context. Its setters take
  `&mut self`, so they are not `const fn`, which makes its `const fn build()`
  unreachable from const code. This crate's `Params::new` is `const fn` today, so
  the redesign must not lose that.

## Decisions

| Decision | Choice |
| --- | --- |
| Shape | Chainable builder with by-value `const fn` setters |
| Typed units | `Memory` and `TagLen` only |
| Vocabulary | `memory`, `passes`, `lanes`, `threads`, `tag_len` |
| `Params::new`, `new_with_threads` | Deleted, no deprecation cycle |
| `TagLen::bits()` | Cut; `bytes()` is the only constructor |
| Const escape hatch | `build_or_panic()` |
| New `Error` variants | None |

The crate is at 0.0.2, published two days before this spec, so a clean break
costs less than a deprecation cycle. Keeping the positional form would leave the
unreadable spelling as the shortest one to type.

## The new surface

### `Memory`

A memory cost. Holds `u64` kibibytes and validates nothing, so no constructor
can panic or fail.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Memory(u64);

impl Memory {
    pub const fn kib(kib: u64) -> Memory;
    pub const fn mib(mib: u64) -> Memory;
    pub const fn gib(gib: u64) -> Memory;
    pub const fn as_kib(self) -> u64;
}
```

`mib` and `gib` multiply by 1024 and 1024 * 1024 with `saturating_mul`, not `*`.
A plain multiplication would panic in a debug build on `Memory::gib(u64::MAX)`,
which would break the no-panic rule these constructors are meant to hold. A
saturated value is astronomically above `MAX_MEMORY`, so it becomes
`Error::MemoryTooMuch` at `build()` — the same outcome, reached without a panic.

`Ord` is derived on purpose: it makes the bounded-verify ceiling a typed
comparison, `params.memory() <= ceiling.memory()`.

### `TagLen`

An output length in bytes. Same rule: holds `u64`, validates nothing.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TagLen(u64);

impl TagLen {
    pub const fn bytes(bytes: u64) -> TagLen;
    pub const fn as_bytes(self) -> u64;
}
```

There is no `bits()`. `TagLen::bytes(32)` already puts the unit at the call site,
which is the entire benefit. A `bits()` constructor would add one failure mode —
a bit count that is not a whole number of bytes — for a spelling callers do not
write. RFC 9106's "256-bit tag" is written `TagLen::bytes(32)`.

### `ParamsBuilder`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParamsBuilder { /* private */ }

impl ParamsBuilder {
    pub const fn memory(self, memory: Memory) -> ParamsBuilder;
    pub const fn passes(self, passes: u32) -> ParamsBuilder;
    pub const fn lanes(self, lanes: u32) -> ParamsBuilder;
    pub const fn threads(self, threads: u32) -> ParamsBuilder;
    pub const fn tag_len(self, tag_len: TagLen) -> ParamsBuilder;

    pub const fn build(self) -> Result<Params, Error>;
    pub const fn build_or_panic(self) -> Params;
}

impl Default for ParamsBuilder;   // == Params::DEFAULT's fields
```

Every setter is `const fn(self) -> Self`, which is what makes a const `Params`
expressible. The builder starts from `Params::DEFAULT`, so every setter is
optional.

`threads` defaults to tracking `lanes`, matching `argon2_hash()`, which sets both
from its single `parallelism` argument. Setting `lanes` after `threads` must not
silently overwrite an explicit `threads`, so the builder stores `threads` as an
`Option<u32>` internally and resolves it to `lanes` at `build()` only when unset.

### `Params`

```rust
impl Params {
    pub const DEFAULT: Params;                 // OWASP: 19 MiB, t=2, p=1, 32 B
    pub const OWASP: Params;                   // == DEFAULT
    pub const RFC9106_HIGH_MEMORY: Params;     // 2 GiB, t=1, p=4, 32 B
    pub const RFC9106_LOW_MEMORY: Params;      // 64 MiB, t=3, p=4, 32 B

    pub const fn builder() -> ParamsBuilder;
    pub const fn to_builder(self) -> ParamsBuilder;

    pub const fn memory(&self) -> Memory;
    pub const fn memory_kib(&self) -> u32;     // validated to fit u32
    pub const fn passes(&self) -> u32;
    pub const fn lanes(&self) -> u32;          // unchanged
    pub const fn threads(&self) -> u32;        // unchanged
    pub const fn tag_len(&self) -> TagLen;
    pub const fn tag_len_bytes(&self) -> usize;
}
```

`Params` keeps its private fields, its `Copy`, its `Default` impl, and its
"a `Params` value is always valid" guarantee. `validate_for`, `memory_layout`,
`memory_blocks`, `segment_length`, `lane_length` and `effective_threads` are
untouched.

Each renamed accessor has a typed form and a raw form. Internal code needs the
number; callers want the unit. `memory_kib()` and `tag_len_bytes()` are the only
places that document why narrowing from `u64` is lossless, namely that `build()`
already rejected anything wider.

The four `DEFAULT_M_COST`, `DEFAULT_T_COST`, `DEFAULT_LANES` and
`DEFAULT_OUTPUT_LEN` constants are removed. `Params::DEFAULT` replaces all four
and is what the builder and the `Default` impl both start from.

### Usage

```rust
// the common case
let params = Params::builder()
    .memory(Memory::mib(64))
    .passes(3)
    .lanes(4)
    .build()?;

// a const, which RustCrypto's builder cannot express
const LOGIN: Params = Params::builder()
    .memory(Memory::mib(64))
    .passes(3)
    .build_or_panic();

// a preset is already valid, so no `?`
let p = Params::OWASP;

// a preset, adjusted
let q = Params::RFC9106_LOW_MEMORY.to_builder().lanes(1).build()?;
```

## Validation and errors

No new `Error` variant — not because one is forbidden, but because none is
needed. `Error` is `#[non_exhaustive]` and already carries a crate-specific
variant, `OsRandom`, so adding one is available and is not a breaking change for
a downstream `match`. The redesign simply introduces no condition that an
existing variant does not already describe, which is also why `TagLen::bits()`
is cut: it would have been the one new failure mode in the design.

| Input | Result |
| --- | --- |
| `Memory::gib(9999)` | `Error::MemoryTooMuch` (-15) |
| `Memory::kib(4)` | `Error::MemoryTooLittle` (-14) |
| `TagLen::bytes(3)` | `Error::OutputTooShort` (-2) |
| `TagLen::bytes(1 << 40)` | `Error::OutputTooLong` (-3) |
| `.passes(0)` | `Error::TimeTooSmall` (-12) |
| `.lanes(0)` | `Error::LanesTooFew` (-16) |
| `.threads(0)` | `Error::ThreadsTooFew` (-28) |

`build()` must compare both `u64` values against their limits **before** narrowing
either one. `Memory` and `TagLen` hold `u64`, while `validate_inputs` takes a
`u32` memory cost and a `usize` output length. On a 32-bit target
`TagLen::bytes(1 << 40) as usize` truncates to 0, which would turn a
`OutputTooLong` into a spurious `OutputTooShort` — or worse, into a value that
passes. So `build()` runs two range checks of its own first:

```text
memory.as_kib()   > MAX_MEMORY as u64  → Error::MemoryTooMuch
tag_len.as_bytes() > MAX_OUTLEN as u64 → Error::OutputTooLong
```

and only then narrows and calls `validate_inputs`. Both checks duplicate a limit
that `validate_inputs` also enforces, which is intended: they are the guard that
makes the narrowing lossless, and they return the same variant the C would.

Past those two checks, `build()` calls the existing `validate_inputs` with the
same placeholder lengths `new_with_threads` used, so the *relative* order of the
checks that apply stays exactly the C's. The "known divergence from the C
reference" note on `Params` therefore remains accurate, and `validate_for` still
reproduces the C ordering for a concrete call.

`build_or_panic()` is the one entry point that can panic. It is a `const fn`, so
in a `const` item a bad parameter is a compile error, not a runtime abort. The
crate's rule that no *fallible* public path panics is unaffected, because
`build()` remains the normal way in.

## Internal impact

The rename reaches 78 accessor call sites in `src/`.

| Accessor | Sites |
| --- | --- |
| `m_cost()` → `memory_kib()` | 12 |
| `t_cost()` → `passes()` | 12 |
| `output_len()` → `tag_len_bytes()` | 23 |
| `lanes()`, `threads()` | 31, names unchanged |

The PHC decoder is rewritten to build through the builder, so the crate has one
construction path:

```text
"$argon2id$v=19$m=65536,t=3,p=4$…"
   └─ Params::builder()
        .memory(Memory::kib(m as u64))
        .passes(t).lanes(p)
        .tag_len(TagLen::bytes(len))
        .build()?          // attacker-chosen values, same validation
```

`verify_encoded_bounded` compares against the ceiling using `memory_kib()` and
`threads()`, so the allocation bound the README documents keeps working
unchanged. The typed `memory()` accessor with its derived `Ord` is available for
callers who would rather compare `Memory` values directly.

## Testing

The existing suite is the safety net: 350 tests, including 24 official vectors
from `phc-winner-argon2`'s `src/test.c` and the live differential test against
the C. The redesign is correct only if every one still passes with byte-identical
tags. No vector, KAT or differential expectation changes.

Three groups are added.

1. **Unit conversions and saturation.** `Memory::kib(65536) == Memory::mib(64)`,
   and `Memory::mib(1024) == Memory::gib(1)`. `TagLen::bytes(32).as_bytes() == 32`.
   Plus the no-panic cases: `Memory::gib(u64::MAX)` and `Memory::mib(u64::MAX)`
   must return a saturated `Memory` rather than panic, and must then produce
   `Error::MemoryTooMuch` at `build()`. These run in a debug build, where a plain
   `*` would panic and `saturating_mul` does not.
2. **Constness.** A real `const` item, `const P: Params = Params::builder()
   .memory(Memory::mib(64)).passes(3).build_or_panic();`, which fails to compile
   if constness regresses. A `const` built through `build()` and `match` too.
3. **Each error row.** The seven rows in the table above, asserting the exact
   variant, plus one test that a preset equals its documented numbers and that
   `Params::OWASP == Params::DEFAULT == Params::default()`.

   The `TagLen::bytes(1 << 40)` row is the one that matters most on a 32-bit
   target, where a narrowing bug turns it into the wrong variant. CI has one
   32-bit leg, `i686-pc-windows-msvc`, which cross-compiles and runs the i686
   binary, so this test runs there without new CI work. `Memory::kib(1 << 33)`
   covers the same hazard on the memory side, where a 32-bit target's `MAX_MEMORY`
   is 2 GiB rather than 4 TiB.

Call sites: 184 across `src/` (108), `tests/` (73) and `benches/` (3), all found
by the compiler. The README quick start and all 31 doctests move to the new
spelling; `tests/readme.rs` already enforces that the README's Rust blocks
compile and match its transcription, so it will catch a missed one.

## Out of scope

- `Algorithm`, `Version`, `Argon2`, `Hasher` and the encoding API are unchanged.
- No change to hashing, to any backend, or to any tag this crate produces.
- No `bits()` on `TagLen`, and no newtype for `passes`, `lanes` or `threads`.
  These are dimensionless counts; a newtype would add ceremony and prevent
  nothing.
- No preset beyond the three listed. `rust-argon2` ships eight; five of them are
  OWASP time/memory trade-offs that a caller can express with one `to_builder()`
  call.
