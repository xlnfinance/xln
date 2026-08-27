//! C5 mirror-equivalence evidence (ordinary `cargo test --release`, NOT Kani).
//!
//! Chain of evidence:
//!
//! 1. `BigDelta` below is a width-parameterized BigInt transcription of
//!    `rscore/crates/engine/src/state/delta.rs` (`validate`, `apply_transfer`,
//!    `add_hold`, `release_hold`, `apply_j_settlement`, `left_perspective`,
//!    `perspective`) and of `core/account/utils.ts`
//!    (`deriveLeftPerspective`, `flipDeltaPerspective`), with the 256-bit
//!    field width / 128-bit payment width as parameters.
//! 2. `equivalence_w16_random` + boundary batteries: `BigDelta @ W=16/8`
//!    equals the bounded i128/u128 Kani mirror (`delta_mirror`) on millions
//!    of deterministic-PRNG inputs (splitmix64, fixed seed) for every handler
//!    outcome (including rejection field names), every perspective field,
//!    and multi-step random walks.
//! 3. `equivalence_w12_random` / `equivalence_w20_random`: same equality at
//!    neighboring widths, guarding against accidental hard-coding of 16-bit
//!    assumptions in either implementation.
//! 4. `engine_cross_check_w256_random`: the transcription at the PRODUCTION
//!    width (256/128) agrees with the real `xln-rscore-engine` `Delta::new`
//!    validation (acceptance and rejection field names) and
//!    `Delta::perspective` on random in-range and boundary-proximate inputs.
//!    (`apply_transfer`/hold setters are `pub(crate)` in the engine crate and
//!    are covered by the width-parameterized transcription plus the
//!    code-identity table in report.md.)
//! 5. `mutant_detection_calibrates_harness`: three deliberately broken
//!    mutants (transfer sign flip, missing hold subtraction in inCapacity,
//!    credit bound off-by-one) MUST be detected by this harness — a harness
//!    that cannot catch a seeded bug proves nothing (readme rule 4).
//! 6. `corpus_artifact_replays`: the first 4096 generated W16 inputs are
//!    committed as `corpus/delta-w16.jsonl` and re-verified on every run, so
//!    the corpus is generated from one source (the seeded PRNG), never
//!    hand-written.

use num_bigint::BigInt;
use std::fmt::Write as _;

use xln_proofs_kani::delta_mirror::{DeltaError, DeltaMirror, PerspectiveMirror, Side, MAX_PAYMENT_AMOUNT};

// ---------------------------------------------------------------------------
// Widths and shared helpers
// ---------------------------------------------------------------------------

const W16: (u64, u64) = (16, 8);
const W12: (u64, u64) = (12, 6);
const W20: (u64, u64) = (20, 10);
const W256: (u64, u64) = (256, 128);

fn two_pow(bits: u64) -> BigInt {
    BigInt::from(1) << bits as usize
}

fn uint_max_bits(bits: u64) -> BigInt {
    two_pow(bits) - 1
}

fn signed_bound_bits(bits: u64) -> BigInt {
    two_pow(bits - 1)
}

struct Ranges {
    signed_min: BigInt,
    signed_max: BigInt,
    uint_max: BigInt,
    max_payment: BigInt,
    max_credit: BigInt,
}

fn ranges(widths: (u64, u64)) -> Ranges {
    let (field_bits, payment_bits) = widths;
    let bound = signed_bound_bits(field_bits);
    let max_payment = uint_max_bits(payment_bits);
    Ranges {
        signed_min: -bound.clone(),
        signed_max: bound - 1,
        uint_max: uint_max_bits(field_bits),
        max_payment: max_payment.clone(),
        max_credit: max_payment * 1000,
    }
}

fn big_signed_ok(field: &'static str, value: &BigInt, bound: &BigInt) -> Result<(), &'static str> {
    if value < &(-bound) || value >= bound {
        return Err(field);
    }
    Ok(())
}

fn big_unsigned_ok(field: &'static str, value: &BigInt, max: &BigInt) -> Result<(), &'static str> {
    if value < &BigInt::from(0) || value > max {
        return Err(field);
    }
    Ok(())
}

fn non_negative(value: &BigInt) -> BigInt {
    if *value < BigInt::from(0) {
        BigInt::from(0)
    } else {
        value.clone()
    }
}

// ---------------------------------------------------------------------------
// BigInt transcription of the production delta math
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Debug)]
struct BigDelta {
    collateral: BigInt,
    ondelta: BigInt,
    offdelta: BigInt,
    left_credit_limit: BigInt,
    right_credit_limit: BigInt,
    left_allowance: BigInt,
    right_allowance: BigInt,
    left_hold: BigInt,
    right_hold: BigInt,
}

#[derive(Clone, PartialEq, Debug)]
struct BigPerspective {
    in_collateral: BigInt,
    out_collateral: BigInt,
    in_own_credit: BigInt,
    out_peer_credit: BigInt,
    in_allowance: BigInt,
    out_allowance: BigInt,
    own_credit_limit: BigInt,
    peer_credit_limit: BigInt,
    in_capacity: BigInt,
    out_capacity: BigInt,
    out_own_credit: BigInt,
    in_peer_credit: BigInt,
    peer_credit_used: BigInt,
    own_credit_used: BigInt,
    out_total_hold: BigInt,
    in_total_hold: BigInt,
    effective_own_credit_window: BigInt,
    effective_peer_credit_window: BigInt,
    total_capacity: BigInt,
    delta: BigInt,
    collateral: BigInt,
}

fn big_flip(p: BigPerspective) -> BigPerspective {
    BigPerspective {
        in_collateral: p.out_collateral,
        out_collateral: p.in_collateral,
        in_own_credit: p.out_peer_credit,
        out_peer_credit: p.in_own_credit,
        in_allowance: p.out_allowance,
        out_allowance: p.in_allowance,
        own_credit_limit: p.peer_credit_limit,
        peer_credit_limit: p.own_credit_limit,
        in_capacity: p.out_capacity,
        out_capacity: p.in_capacity,
        out_own_credit: p.in_peer_credit,
        in_peer_credit: p.out_own_credit,
        peer_credit_used: p.own_credit_used,
        own_credit_used: p.peer_credit_used,
        out_total_hold: p.in_total_hold,
        in_total_hold: p.out_total_hold,
        effective_own_credit_window: p.effective_own_credit_window,
        effective_peer_credit_window: p.effective_peer_credit_window,
        total_capacity: p.total_capacity,
        delta: p.delta,
        collateral: p.collateral,
    }
}

impl BigDelta {
    /// Mirrors `Delta::validate` with identical field order so multi-field
    /// violations report the same first field as production.
    fn validate(&self, r: &Ranges) -> Result<(), &'static str> {
        let bound = &(&r.signed_max + 1);
        big_unsigned_ok("collateral", &self.collateral, &r.uint_max)?;
        big_signed_ok("ondelta", &self.ondelta, bound)?;
        big_signed_ok("offdelta", &self.offdelta, bound)?;
        big_unsigned_ok("leftCreditLimit", &self.left_credit_limit, &r.max_credit)?;
        big_unsigned_ok("rightCreditLimit", &self.right_credit_limit, &r.max_credit)?;
        big_unsigned_ok("leftAllowance", &self.left_allowance, &r.uint_max)?;
        big_unsigned_ok("rightAllowance", &self.right_allowance, &r.uint_max)?;
        big_unsigned_ok("leftHold", &self.left_hold, &r.uint_max)?;
        big_unsigned_ok("rightHold", &self.right_hold, &r.uint_max)?;
        Ok(())
    }

    fn hold(&self, side: Side) -> &BigInt {
        match side {
            Side::Left => &self.left_hold,
            Side::Right => &self.right_hold,
        }
    }

    fn hold_field(side: Side) -> &'static str {
        match side {
            Side::Left => "leftHold",
            Side::Right => "rightHold",
        }
    }

    /// Mirrors `Delta::apply_transfer`. `mutant_flip_left_sign` breaks the
    /// Left branch on purpose for harness calibration.
    fn apply_transfer(
        &self,
        r: &Ranges,
        sender: Side,
        amount: &BigInt,
        mutant_flip_left_sign: bool,
    ) -> Result<BigDelta, &'static str> {
        let next = match sender {
            Side::Left => {
                if mutant_flip_left_sign {
                    &self.offdelta + amount
                } else {
                    &self.offdelta - amount
                }
            }
            Side::Right => &self.offdelta + amount,
        };
        big_signed_ok("offdelta", &next, &(&r.signed_max + 1))?;
        Ok(BigDelta {
            offdelta: next,
            ..self.clone()
        })
    }

    fn add_hold(&self, r: &Ranges, side: Side, amount: &BigInt) -> Result<BigDelta, &'static str> {
        let next = self.hold(side) + amount;
        big_unsigned_ok(Self::hold_field(side), &next, &r.uint_max)?;
        let mut out = self.clone();
        match side {
            Side::Left => out.left_hold = next,
            Side::Right => out.right_hold = next,
        }
        Ok(out)
    }

    fn release_hold(&self, r: &Ranges, side: Side, amount: &BigInt) -> Result<BigDelta, &'static str> {
        let next = self.hold(side) - amount;
        big_unsigned_ok(Self::hold_field(side), &next, &r.uint_max)?;
        let mut out = self.clone();
        match side {
            Side::Left => out.left_hold = next,
            Side::Right => out.right_hold = next,
        }
        Ok(out)
    }

    fn apply_j_settlement(
        &self,
        r: &Ranges,
        collateral: &BigInt,
        ondelta: &BigInt,
    ) -> Result<BigDelta, &'static str> {
        big_unsigned_ok("collateral", collateral, &r.uint_max)?;
        big_signed_ok("ondelta", ondelta, &(&r.signed_max + 1))?;
        Ok(BigDelta {
            collateral: collateral.clone(),
            ondelta: ondelta.clone(),
            ..self.clone()
        })
    }

    /// Mirrors `Delta::left_perspective` / TS `deriveLeftPerspective`.
    /// `mutant_drop_incoming_hold` skips the `- rightHold` term in
    /// `in_capacity` on purpose for harness calibration.
    fn left_perspective(&self, mutant_drop_incoming_hold: bool) -> BigPerspective {
        let total = &self.ondelta + &self.offdelta;
        let collateral = non_negative(&self.collateral);
        let zero = BigInt::from(0);
        let in_collateral = if total > zero {
            non_negative(&(&collateral - &total))
        } else {
            collateral.clone()
        };
        let out_collateral = if total > zero {
            total.clone().min(collateral.clone())
        } else {
            zero.clone()
        };
        let in_own_credit = non_negative(&(-&total));
        let out_peer_credit = non_negative(&(&total - &collateral));
        let out_own_credit = non_negative(&(&self.left_credit_limit - &in_own_credit));
        let in_peer_credit = non_negative(&(&self.right_credit_limit - &out_peer_credit));
        let effective_own_credit_window =
            self.left_credit_limit.clone().max(in_own_credit.clone());
        let effective_peer_credit_window =
            self.right_credit_limit.clone().max(out_peer_credit.clone());
        let in_capacity_raw =
            &in_own_credit + &in_collateral + &in_peer_credit - &self.right_allowance;
        let in_capacity = if mutant_drop_incoming_hold {
            non_negative(&in_capacity_raw)
        } else {
            non_negative(&(&in_capacity_raw - &self.right_hold))
        };
        let out_capacity = non_negative(
            &(&out_peer_credit + &out_collateral + &out_own_credit - &self.left_allowance
                - &self.left_hold),
        );
        BigPerspective {
            in_capacity,
            out_capacity,
            in_collateral,
            out_collateral,
            in_own_credit: in_own_credit.clone(),
            out_peer_credit: out_peer_credit.clone(),
            in_allowance: self.right_allowance.clone(),
            out_allowance: self.left_allowance.clone(),
            own_credit_limit: self.left_credit_limit.clone(),
            peer_credit_limit: self.right_credit_limit.clone(),
            out_own_credit,
            in_peer_credit,
            peer_credit_used: in_own_credit.clone(),
            own_credit_used: out_peer_credit.clone(),
            out_total_hold: self.left_hold.clone(),
            in_total_hold: self.right_hold.clone(),
            effective_own_credit_window: effective_own_credit_window.clone(),
            effective_peer_credit_window: effective_peer_credit_window.clone(),
            total_capacity: &collateral + &effective_own_credit_window
                + &effective_peer_credit_window,
            delta: total,
            collateral,
        }
    }

    fn perspective(&self, side: Side) -> BigPerspective {
        match side {
            Side::Left => self.left_perspective(false),
            Side::Right => big_flip(self.left_perspective(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (splitmix64) — single source of all test inputs
// ---------------------------------------------------------------------------

const SEED_MAIN: u64 = 0x00C5_C6C5_C6C5_0001;

struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        SplitMix64(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }

    fn bool(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }

    fn side(&mut self) -> Side {
        if self.bool() {
            Side::Left
        } else {
            Side::Right
        }
    }
}

/// Boundary-proximate values for a signed range.
fn signed_edges(min: i64, max: i64) -> Vec<i64> {
    vec![min, min + 1, min + 2, -2, -1, 0, 1, 2, max - 2, max - 1, max]
}

fn unsigned_edges(max: u64) -> Vec<i64> {
    let max = max as i64;
    vec![0, 1, 2, 3, max - 2, max - 1, max]
}

fn credit_edges(max: u64) -> Vec<i64> {
    let max = max as i64;
    vec![0, 1, 2, 999, 1000, 1001, max - 1, max]
}

// ---------------------------------------------------------------------------
// Input generation at small widths (mirror domain) and comparisons
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct SmallWidths {
    signed_min: i64,
    signed_max: i64,
    uint_max: u64,
    max_credit: u64,
}

fn small_ranges(widths: (u64, u64)) -> SmallWidths {
    let (field_bits, payment_bits) = widths;
    SmallWidths {
        signed_min: -(1i64 << (field_bits - 1)),
        signed_max: (1i64 << (field_bits - 1)) - 1,
        uint_max: (1u64 << field_bits) - 1,
        max_credit: ((1u64 << payment_bits) - 1) * 1000,
    }
}

fn gen_signed(rng: &mut SplitMix64, w: &SmallWidths) -> i64 {
    let span = (w.signed_max - w.signed_min + 1) as u64;
    if rng.below(4) == 0 {
        *rng.pick(&signed_edges(w.signed_min, w.signed_max))
    } else {
        (rng.next_u64() % span) as i64 + w.signed_min
    }
}

fn gen_unsigned(rng: &mut SplitMix64, w: &SmallWidths) -> u64 {
    if rng.below(4) == 0 {
        *rng.pick(&unsigned_edges(w.uint_max)) as u64
    } else {
        rng.next_u64() % (w.uint_max + 1)
    }
}

fn gen_credit(rng: &mut SplitMix64, w: &SmallWidths) -> u64 {
    if rng.below(4) == 0 {
        *rng.pick(&credit_edges(w.max_credit)) as u64
    } else {
        rng.next_u64() % (w.max_credit + 1)
    }
}

impl SplitMix64 {
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

fn gen_delta_small(rng: &mut SplitMix64, w: &SmallWidths) -> (DeltaMirror, BigDelta) {
    let collateral = gen_unsigned(rng, w);
    let ondelta = gen_signed(rng, w);
    let offdelta = gen_signed(rng, w);
    let left_credit = gen_credit(rng, w);
    let right_credit = gen_credit(rng, w);
    let left_allowance = gen_unsigned(rng, w);
    let right_allowance = gen_unsigned(rng, w);
    let left_hold = gen_unsigned(rng, w);
    let right_hold = gen_unsigned(rng, w);
    let mirror = DeltaMirror {
        collateral: collateral as i128,
        ondelta: ondelta as i128,
        offdelta: offdelta as i128,
        left_credit_limit: left_credit as i128,
        right_credit_limit: right_credit as i128,
        left_allowance: left_allowance as i128,
        right_allowance: right_allowance as i128,
        left_hold: left_hold as i128,
        right_hold: right_hold as i128,
    };
    let big = BigDelta {
        collateral: BigInt::from(collateral),
        ondelta: BigInt::from(ondelta),
        offdelta: BigInt::from(offdelta),
        left_credit_limit: BigInt::from(left_credit),
        right_credit_limit: BigInt::from(right_credit),
        left_allowance: BigInt::from(left_allowance),
        right_allowance: BigInt::from(right_allowance),
        left_hold: BigInt::from(left_hold),
        right_hold: BigInt::from(right_hold),
    };
    (mirror, big)
}

fn delta_at_w16(
    collateral: i64,
    ondelta: i64,
    offdelta: i64,
    left_credit: u64,
    right_credit: u64,
    left_allowance: u64,
    right_allowance: u64,
    left_hold: u64,
    right_hold: u64,
) -> (DeltaMirror, BigDelta) {
    let mirror = DeltaMirror {
        collateral: collateral as i128,
        ondelta: ondelta as i128,
        offdelta: offdelta as i128,
        left_credit_limit: left_credit as i128,
        right_credit_limit: right_credit as i128,
        left_allowance: left_allowance as i128,
        right_allowance: right_allowance as i128,
        left_hold: left_hold as i128,
        right_hold: right_hold as i128,
    };
    let to_big = |v: i64| BigInt::from(v);
    let big = BigDelta {
        collateral: to_big(collateral),
        ondelta: to_big(ondelta),
        offdelta: to_big(offdelta),
        left_credit_limit: to_big(left_credit as i64),
        right_credit_limit: to_big(right_credit as i64),
        left_allowance: to_big(left_allowance as i64),
        right_allowance: to_big(right_allowance as i64),
        left_hold: to_big(left_hold as i64),
        right_hold: to_big(right_hold as i64),
    };
    (mirror, big)
}

fn field_name(result: &Result<(), DeltaError>) -> Option<&'static str> {
    match result {
        Ok(()) => None,
        Err(DeltaError::FieldOutOfRange(field)) => Some(field),
    }
}

fn assert_delta_eq(mirror: &DeltaMirror, big: &BigDelta, context: &str) {
    let pairs = [
        (mirror.collateral, &big.collateral, "collateral"),
        (mirror.ondelta, &big.ondelta, "ondelta"),
        (mirror.offdelta, &big.offdelta, "offdelta"),
        (
            mirror.left_credit_limit,
            &big.left_credit_limit,
            "leftCreditLimit",
        ),
        (
            mirror.right_credit_limit,
            &big.right_credit_limit,
            "rightCreditLimit",
        ),
        (mirror.left_allowance, &big.left_allowance, "leftAllowance"),
        (
            mirror.right_allowance,
            &big.right_allowance,
            "rightAllowance",
        ),
        (mirror.left_hold, &big.left_hold, "leftHold"),
        (mirror.right_hold, &big.right_hold, "rightHold"),
    ];
    for (m, b, name) in pairs {
        assert_eq!(m.to_string(), b.to_string(), "{context}: field {name}");
    }
}

fn assert_perspective_eq(m: &PerspectiveMirror, b: &BigPerspective, context: &str) {
    let pairs: [(i128, &BigInt, &str); 21] = [
        (m.in_collateral, &b.in_collateral, "inCollateral"),
        (m.out_collateral, &b.out_collateral, "outCollateral"),
        (m.in_own_credit, &b.in_own_credit, "inOwnCredit"),
        (m.out_peer_credit, &b.out_peer_credit, "outPeerCredit"),
        (m.in_allowance, &b.in_allowance, "inAllowance"),
        (m.out_allowance, &b.out_allowance, "outAllowance"),
        (m.own_credit_limit, &b.own_credit_limit, "ownCreditLimit"),
        (m.peer_credit_limit, &b.peer_credit_limit, "peerCreditLimit"),
        (m.in_capacity, &b.in_capacity, "inCapacity"),
        (m.out_capacity, &b.out_capacity, "outCapacity"),
        (m.out_own_credit, &b.out_own_credit, "outOwnCredit"),
        (m.in_peer_credit, &b.in_peer_credit, "inPeerCredit"),
        (m.peer_credit_used, &b.peer_credit_used, "peerCreditUsed"),
        (m.own_credit_used, &b.own_credit_used, "ownCreditUsed"),
        (m.out_total_hold, &b.out_total_hold, "outTotalHold"),
        (m.in_total_hold, &b.in_total_hold, "inTotalHold"),
        (
            m.effective_own_credit_window,
            &b.effective_own_credit_window,
            "effectiveOwnCreditWindow",
        ),
        (
            m.effective_peer_credit_window,
            &b.effective_peer_credit_window,
            "effectivePeerCreditWindow",
        ),
        (m.total_capacity, &b.total_capacity, "totalCapacity"),
        (m.delta, &b.delta, "delta"),
        (m.collateral, &b.collateral, "collateral"),
    ];
    for (m, b, name) in pairs {
        assert_eq!(m.to_string(), b.to_string(), "{context}: field {name}");
    }
}

/// Full comparison battery for one (mirror, big) pair at width `w`.
/// Returns nothing; asserts on any divergence.
fn compare_full_state(
    mirror: &DeltaMirror,
    big: &BigDelta,
    r: &Ranges,
    w: &SmallWidths,
    rng: &mut SplitMix64,
    index: u64,
) {
    let context = format!("iteration {index}");
    assert_delta_eq(mirror, big, &context);

    // 1. validate
    assert_eq!(
        field_name(&mirror.validate()),
        big.validate(r).err(),
        "{context}: validate"
    );

    // 2. perspectives (both sides) — all 21 fields
    assert_perspective_eq(&mirror.left_perspective(), &big.left_perspective(false), &context);
    let side = rng.side();
    assert_perspective_eq(
        &mirror.perspective(side),
        &big.perspective(side),
        &format!("{context}: perspective {side:?}"),
    );

    // 3. flip involution on the big side (TS flipDeltaPerspective)
    let left_big = big.left_perspective(false);
    assert_eq!(big_flip(big_flip(left_big.clone())), left_big, "{context}: big flip");

    // 4. handlers with in-domain and oversized amounts
    let side = rng.side();
    for amount in [
        rng.below(MAX_PAYMENT_AMOUNT as u64 + 1) as i128,
        rng.below(w.uint_max + 1) as i128,
    ] {
        let m_res = mirror.apply_transfer(side, amount);
        let b_res = big.apply_transfer(r, side, &BigInt::from(amount), false);
        match (&m_res, &b_res) {
            (Ok(m_next), Ok(b_next)) => {
                assert_delta_eq(m_next, b_next, &format!("{context}: transfer {amount}"));
            }
            (Err(DeltaError::FieldOutOfRange(mf)), Err(bf)) => assert_eq!(
                *mf, *bf,
                "{context}: transfer rejection field {amount}"
            ),
            (m, b) => panic!("{context}: transfer outcome mismatch {amount}: {m:?} vs {b:?}"),
        }

        for (op_name, m_res, b_res) in [
            (
                "add_hold",
                mirror.add_hold(side, amount),
                big.add_hold(r, side, &BigInt::from(amount)),
            ),
            (
                "release_hold",
                mirror.release_hold(side, amount),
                big.release_hold(r, side, &BigInt::from(amount)),
            ),
        ] {
            match (&m_res, &b_res) {
                (Ok(m_next), Ok(b_next)) => {
                    assert_delta_eq(m_next, b_next, &format!("{context}: {op_name} {amount}"));
                }
                (Err(DeltaError::FieldOutOfRange(mf)), Err(bf)) => assert_eq!(
                    *mf, *bf,
                    "{context}: {op_name} rejection field {amount}"
                ),
                (m, b) => panic!("{context}: {op_name} mismatch {amount}: {m:?} vs {b:?}"),
            }
        }
    }

    // 5. j settlement with fresh field-range operands
    let collateral = rng.below(w.uint_max + 1) as i128;
    let ondelta = gen_signed(rng, w) as i128;
    let m_res = mirror.apply_j_settlement(collateral, ondelta);
    let b_res = big.apply_j_settlement(r, &BigInt::from(collateral), &BigInt::from(ondelta));
    match (&m_res, &b_res) {
        (Ok(m_next), Ok(b_next)) => {
            assert_delta_eq(m_next, b_next, &format!("{context}: j settlement"));
        }
        (Err(DeltaError::FieldOutOfRange(mf)), Err(bf)) => {
            assert_eq!(*mf, *bf, "{context}: j settlement rejection")
        }
        (m, b) => panic!("{context}: j settlement mismatch: {m:?} vs {b:?}"),
    }
}

/// Multi-step random walk: apply a random chain of handlers on both sides,
/// keeping the last accepted state, and compare after every step.
fn compare_random_walk(
    mirror: &DeltaMirror,
    big: &BigDelta,
    r: &Ranges,
    w: &SmallWidths,
    rng: &mut SplitMix64,
    index: u64,
) {
    let mut m = *mirror;
    let mut b = big.clone();
    for step in 0..6 {
        let side = rng.side();
        let amount = rng.below(w.uint_max + 1) as i128;
        let (m_next, b_next) = match rng.below(4) {
            0 => (m.apply_transfer(side, amount), b.apply_transfer(r, side, &BigInt::from(amount), false)),
            1 => (m.add_hold(side, amount), b.add_hold(r, side, &BigInt::from(amount))),
            2 => (
                m.release_hold(side, amount),
                b.release_hold(r, side, &BigInt::from(amount)),
            ),
            _ => {
                let collateral = rng.below(w.uint_max + 1) as i128;
                let ondelta = gen_signed(rng, w) as i128;
                (
                    m.apply_j_settlement(collateral, ondelta),
                    b.apply_j_settlement(r, &BigInt::from(collateral), &BigInt::from(ondelta)),
                )
            }
        };
        match (&m_next, &b_next) {
            (Ok(m_ok), Ok(b_ok)) => {
                m = *m_ok;
                b = b_ok.clone();
            }
            (Err(_), Err(_)) => {}
            (x, y) => panic!(
                "walk {index} step {step}: outcome mismatch: {x:?} vs {y:?}"
            ),
        }
        assert_delta_eq(&m, &b, &format!("walk {index} step {step}"));
        // A state valid for one side is valid for the other, with identical
        // rejection identity on the edge.
        assert_eq!(field_name(&m.validate()), b.validate(&r.clone()).err());
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const W16_RANDOM_ITERATIONS: u64 = 2_000_000;
const W16_WALK_ITERATIONS: u64 = 500_000;
const OTHER_WIDTH_ITERATIONS: u64 = 200_000;

#[test]
fn equivalence_w16_random() {
    let w = small_ranges(W16);
    let r = ranges(W16);
    let mut rng = SplitMix64::new(SEED_MAIN);
    let start = std::time::Instant::now();
    for index in 0..W16_RANDOM_ITERATIONS {
        let (mirror, big) = gen_delta_small(&mut rng, &w);
        compare_full_state(&mirror, &big, &r, &w, &mut rng, index);
    }
    eprintln!(
        "equivalence_w16_random: {W16_RANDOM_ITERATIONS} states compared in {:?}",
        start.elapsed()
    );
}

#[test]
fn equivalence_w16_random_walks() {
    let w = small_ranges(W16);
    let r = ranges(W16);
    let mut rng = SplitMix64::new(SEED_MAIN ^ 0x0BAD_C0DE);
    let start = std::time::Instant::now();
    for index in 0..W16_WALK_ITERATIONS {
        let (mirror, big) = gen_delta_small(&mut rng, &w);
        compare_random_walk(&mirror, &big, &r, &w, &mut rng, index);
    }
    eprintln!(
        "equivalence_w16_random_walks: {W16_WALK_ITERATIONS} walks (6 ops each) in {:?}",
        start.elapsed()
    );
}

/// Width parametricity of the BigInt transcription at W=12/6 and W=20/10.
/// The bounded mirror is fixed at 16/8 BY DESIGN (it is the Kani-verified
/// artifact), so a cross-width handler comparison is meaningless — a
/// 12-bit-range implementation must reject transfers a 16-bit
/// implementation accepts. These runs therefore check the transcription
/// against itself: flip involution, the closed-form capacity identity, hold
/// add/release round-trip, and validate's exact boundary rejections.
fn transcription_self_consistency(widths: (u64, u64), seed: u64) {
    let w = small_ranges(widths);
    let r = ranges(widths);
    let mut rng = SplitMix64::new(seed);
    for _ in 0..OTHER_WIDTH_ITERATIONS {
        let (_, big) = gen_delta_small(&mut rng, &w);
        assert!(big.validate(&r).is_ok());

        // Flip involution.
        let left = big.left_perspective(false);
        assert_eq!(big_flip(big_flip(left.clone())), left);

        // Closed-form capacity identity at this width.
        let t = &big.ondelta + &big.offdelta;
        let a = &big.collateral + &big.right_credit_limit - &big.right_allowance
            - &big.right_hold;
        let b = &big.left_credit_limit - &big.left_allowance - &big.left_hold;
        let expect_in = (&a - &t).max(BigInt::from(0));
        let expect_out = (&b + &t).max(BigInt::from(0));
        assert_eq!(left.in_capacity, expect_in);
        assert_eq!(left.out_capacity, expect_out);

        // Hold add/release round-trip with in-domain amounts.
        let side = rng.side();
        let amount = rng.below(w.uint_max + 1);
        if let Ok(held) = big.add_hold(&r, side, &BigInt::from(amount)) {
            assert_eq!(
                held.release_hold(&r, side, &BigInt::from(amount)),
                Ok(big.clone())
            );
        }
    }

    // Exact boundary rejections at this width's own scale.
    let zero = BigDelta {
        collateral: BigInt::from(0),
        ondelta: BigInt::from(0),
        offdelta: BigInt::from(0),
        left_credit_limit: BigInt::from(0),
        right_credit_limit: BigInt::from(0),
        left_allowance: BigInt::from(0),
        right_allowance: BigInt::from(0),
        left_hold: BigInt::from(0),
        right_hold: BigInt::from(0),
    };
    let (field_bits, payment_bits) = widths;
    let boundary = two_pow(field_bits - 1);
    let over_signed = zero
        .clone()
        .apply_transfer(&r, Side::Right, &boundary, false)
        .unwrap_err();
    assert_eq!(over_signed, "offdelta");
    let max_credit: BigInt = uint_max_bits(payment_bits) * 1000;
    let mut over_credit = zero.clone();
    over_credit.left_credit_limit = max_credit.clone();
    assert!(over_credit.validate(&r).is_ok());
    over_credit.left_credit_limit = max_credit + 1;
    assert_eq!(over_credit.validate(&r).unwrap_err(), "leftCreditLimit");
}

#[test]
fn transcription_self_consistency_w12() {
    transcription_self_consistency(W12, SEED_MAIN ^ 0x1111);
}

#[test]
fn transcription_self_consistency_w20() {
    transcription_self_consistency(W20, SEED_MAIN ^ 0x2222);
}

/// Structured boundary battery: for every ordered pair of fields, cross their
/// boundary-proximate values while the remaining fields sit at 0 / their own
/// extremes, comparing validate + perspective + a boundary transfer.
#[test]
fn equivalence_w16_boundary_battery() {
    let w = small_ranges(W16);
    let r = ranges(W16);
    let signed_edge = signed_edges(w.signed_min, w.signed_max);
    let unsigned_edge = unsigned_edges(w.uint_max);
    let credit_edge = credit_edges(w.max_credit);
    let mut rng = SplitMix64::new(SEED_MAIN ^ 0xBEEF);
    let mut cases = 0u64;

    let mut run_case = |vals: [i64; 10], rng: &mut SplitMix64| {
        let (mirror, big) = delta_at_w16(
            vals[0],
            vals[1],
            vals[2],
            vals[3].max(0) as u64,
            vals[4].max(0) as u64,
            vals[5].max(0) as u64,
            vals[6].max(0) as u64,
            vals[7].max(0) as u64,
            vals[8].max(0) as u64,
        );
        compare_full_state(&mirror, &big, &r, &w, rng, cases);
        cases += 1;
    };

    // [collateral, ondelta, offdelta, leftCredit, rightCredit,
    //  leftAllowance, rightAllowance, leftHold, rightHold, spare]
    let field_edges: [&[i64]; 9] = [
        &unsigned_edge, &signed_edge, &signed_edge, &credit_edge, &credit_edge,
        &unsigned_edge, &unsigned_edge, &unsigned_edge, &unsigned_edge,
    ];
    let backgrounds: [[i64; 9]; 3] = [
        [0; 9],
        [
            w.uint_max as i64,
            w.signed_min,
            w.signed_max,
            w.max_credit as i64,
            w.max_credit as i64,
            w.uint_max as i64,
            w.uint_max as i64,
            w.uint_max as i64,
            w.uint_max as i64,
        ],
        [
            w.uint_max as i64 / 2,
            -1,
            1,
            1000,
            999,
            1,
            0,
            0,
            1,
        ],
    ];
    for (field_a, edges_a) in field_edges.iter().enumerate() {
        for (field_b, edges_b) in field_edges.iter().enumerate() {
            for value_a in edges_a.iter() {
                for value_b in edges_b.iter() {
                    for background in backgrounds.iter() {
                        let mut vals = [0i64; 10];
                        vals[..9].copy_from_slice(background);
                        vals[field_a] = *value_a;
                        vals[field_b] = *value_b;
                        run_case(vals, &mut rng);
                    }
                }
            }
        }
    }
    eprintln!("equivalence_w16_boundary_battery: {cases} boundary cases compared");
}

/// Calibration (readme rule 4): seeded mutants MUST be caught. A harness
/// that cannot detect a deliberately broken implementation is uncalibrated.
#[test]
fn mutant_detection_calibrates_harness() {
    let w = small_ranges(W16);
    let r = ranges(W16);
    let mut rng = SplitMix64::new(SEED_MAIN);

    let mut transfer_mutant_divergences = 0u64;
    let mut hold_mutant_divergences = 0u64;
    let mut credit_bound_edge_reached = false;
    for _ in 0..100_000u64 {
        let (_, big) = gen_delta_small(&mut rng, &w);
        let side = rng.side();
        let amount = rng.below(w.uint_max + 1) as i128;

        // Mutant 1: Left transfer adds instead of subtracts. Detection = the
        // mutant's outcome differs from the honest outcome (different state
        // or different acceptance), which the main equivalence loop would
        // flag against the mirror.
        if side == Side::Left {
            let honest = big.apply_transfer(&r, side, &BigInt::from(amount), false);
            let mutant = big.apply_transfer(&r, side, &BigInt::from(amount), true);
            if honest != mutant {
                transfer_mutant_divergences += 1;
            }
        }

        // Mutant 2: inCapacity without the incoming hold subtraction.
        let honest_p = big.left_perspective(false);
        let mutant_p = big.left_perspective(true);
        if honest_p.in_capacity != mutant_p.in_capacity {
            hold_mutant_divergences += 1;
        }

        // Mutant 3 sensor: confirm the generator actually reaches the
        // max-credit boundary neighborhood (where an off-by-1000 bound check
        // would flip acceptance).
        if big.right_credit_limit >= r.max_credit.clone() - 2 {
            credit_bound_edge_reached = true;
        }
    }
    assert!(
        transfer_mutant_divergences > 0,
        "transfer sign mutant was not detected — harness lacks sensitivity"
    );
    assert!(
        hold_mutant_divergences > 0,
        "hold-subtraction mutant was not detected — harness lacks sensitivity"
    );
    assert!(
        credit_bound_edge_reached,
        "generator never reached the credit bound — boundary battery blind spot"
    );
    eprintln!(
        "mutant calibration: transfer divergences observed {transfer_mutant_divergences}, \
         hold divergences observed {hold_mutant_divergences}, credit-bound edge reached \
         {credit_bound_edge_reached}"
    );
}

/// Committed corpus: the first 4096 W16 inputs, generated from the seeded
/// PRNG (never hand-written). The file is written on first run and re-verified
/// byte-for-byte afterwards.
#[test]
fn corpus_artifact_replays() {
    let w = small_ranges(W16);
    let r = ranges(W16);
    let corpus_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("corpus")
        .join("delta-w16.jsonl");
    let mut rng = SplitMix64::new(SEED_MAIN);
    let mut expected_lines = Vec::new();
    let mut states = Vec::new();
    for _ in 0..4096 {
        let (mirror, big) = gen_delta_small(&mut rng, &w);
        let mut line = String::from("{");
        let _ = write!(
            line,
            "\"collateral\":\"{}\",\"ondelta\":\"{}\",\"offdelta\":\"{}\",\
             \"leftCreditLimit\":\"{}\",\"rightCreditLimit\":\"{}\",\
             \"leftAllowance\":\"{}\",\"rightAllowance\":\"{}\",\
             \"leftHold\":\"{}\",\"rightHold\":\"{}\"",
            big.collateral,
            big.ondelta,
            big.offdelta,
            big.left_credit_limit,
            big.right_credit_limit,
            big.left_allowance,
            big.right_allowance,
            big.left_hold,
            big.right_hold,
        );
        line.push('}');
        expected_lines.push(line);
        states.push((mirror, big));
    }
    let serialized = expected_lines.join("\n") + "\n";
    if corpus_path.exists() {
        let committed = std::fs::read_to_string(&corpus_path).expect("read corpus");
        assert_eq!(
            committed, serialized,
            "committed corpus does not match seeded regeneration"
        );
    } else {
        std::fs::create_dir_all(corpus_path.parent().unwrap()).expect("corpus dir");
        std::fs::write(&corpus_path, &serialized).expect("write corpus");
    }
    // Re-verify every corpus state through the full battery.
    let mut rng = SplitMix64::new(SEED_MAIN ^ 0xC0DE);
    for (index, (mirror, big)) in states.iter().enumerate() {
        compare_full_state(mirror, big, &r, &w, &mut rng, index as u64);
    }
}

// ---------------------------------------------------------------------------
// Engine cross-check at production width 256/128
// ---------------------------------------------------------------------------

fn gen_big_in_range(rng: &mut SplitMix64, max_inclusive: &BigInt) -> BigInt {
    // 3 x 64-bit limbs cover up to 192 bits; credit max needs ~138 bits.
    // Rejection-free modulo keeps values uniform over [0, max].
    let raw = (BigInt::from(rng.next_u64()) << 128)
        | (BigInt::from(rng.next_u64()) << 64)
        | BigInt::from(rng.next_u64());
    raw % (max_inclusive + 1)
}

fn gen_big_signed(rng: &mut SplitMix64, bound: &BigInt) -> BigInt {
    let raw = (BigInt::from(rng.next_u64()) << 192)
        | (BigInt::from(rng.next_u64()) << 128)
        | (BigInt::from(rng.next_u64()) << 64)
        | BigInt::from(rng.next_u64());
    raw % (bound.clone() * 2) - bound
}

fn big_boundary_biased(rng: &mut SplitMix64, max: &BigInt, is_credit: bool) -> BigInt {
    if rng.below(4) != 0 {
        return if is_credit {
            gen_big_in_range(rng, max)
        } else {
            gen_big_in_range(rng, max)
        };
    }
    let candidates = if is_credit {
        vec![
            BigInt::from(0),
            BigInt::from(1),
            max - 1,
            max.clone(),
            max - 1000,
            max - 1001,
        ]
    } else {
        vec![
            BigInt::from(0),
            BigInt::from(1),
            BigInt::from(2),
            max - 2,
            max - 1,
            max.clone(),
        ]
    };
    candidates[rng.below(candidates.len() as u64) as usize].clone()
}

#[test]
fn engine_cross_check_w256_random() {
    use xln_rscore_engine::{Delta, Side as EngineSide, StateError, TokenId};

    let r = ranges(W256);
    let bound = r.signed_max.clone() + 1;
    let mut rng = SplitMix64::new(SEED_MAIN ^ 0x256);
    let token = TokenId::new(1).expect("token");
    let iterations = 200_000u64;
    let start = std::time::Instant::now();

    for index in 0..iterations {
        let collateral = big_boundary_biased(&mut rng, &r.uint_max, false);
        let ondelta = gen_big_signed(&mut rng, &bound);
        let offdelta = gen_big_signed(&mut rng, &bound);
        let left_credit = big_boundary_biased(&mut rng, &r.max_credit, true);
        let right_credit = big_boundary_biased(&mut rng, &r.max_credit, true);
        let left_allowance = big_boundary_biased(&mut rng, &r.uint_max, false);
        let right_allowance = big_boundary_biased(&mut rng, &r.uint_max, false);
        let left_hold = big_boundary_biased(&mut rng, &r.uint_max, false);
        let right_hold = big_boundary_biased(&mut rng, &r.uint_max, false);

        let transcription = BigDelta {
            collateral: collateral.clone(),
            ondelta: ondelta.clone(),
            offdelta: offdelta.clone(),
            left_credit_limit: left_credit.clone(),
            right_credit_limit: right_credit.clone(),
            left_allowance: left_allowance.clone(),
            right_allowance: right_allowance.clone(),
            left_hold: left_hold.clone(),
            right_hold: right_hold.clone(),
        };

        let engine_result = Delta::new(
            token,
            collateral,
            ondelta,
            offdelta,
            left_credit,
            right_credit,
            left_allowance,
            right_allowance,
            left_hold,
            right_hold,
        );
        let transcription_result = transcription.validate(&r);

        match (&engine_result, &transcription_result) {
            (Ok(engine_delta), Ok(())) => {
                // Perspective agreement on both sides (the four fields of the
                // production DeltaPerspective).
                for (engine_side, our_side) in
                    [(EngineSide::Left, Side::Left), (EngineSide::Right, Side::Right)]
                {
                    let engine_view = engine_delta.perspective(engine_side);
                    let our_view = transcription.perspective(our_side);
                    assert_eq!(
                        engine_view.in_capacity.to_string(),
                        our_view.in_capacity.to_string(),
                        "{index}: inCapacity {engine_side:?}"
                    );
                    assert_eq!(
                        engine_view.out_capacity.to_string(),
                        our_view.out_capacity.to_string(),
                        "{index}: outCapacity {engine_side:?}"
                    );
                    assert_eq!(
                        engine_view.own_credit_limit.to_string(),
                        our_view.own_credit_limit.to_string(),
                        "{index}: ownCreditLimit {engine_side:?}"
                    );
                    assert_eq!(
                        engine_view.peer_credit_limit.to_string(),
                        our_view.peer_credit_limit.to_string(),
                        "{index}: peerCreditLimit {engine_side:?}"
                    );
                }
            }
            (
                Err(StateError::DeltaFieldOutOfRange { field: engine_field, .. }),
                Err(our_field),
            ) => {
                assert_eq!(engine_field, our_field, "{index}: rejection field");
            }
            (engine, ours) => panic!(
                "{index}: acceptance mismatch: engine={engine:?} transcription={ours:?}"
            ),
        }
    }
    eprintln!(
        "engine_cross_check_w256_random: {iterations} states compared in {:?}",
        start.elapsed()
    );
}
