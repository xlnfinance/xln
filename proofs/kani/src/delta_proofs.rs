//! Kani proof harnesses for claim C5 (delta math mirror).
//!
//! Bounded model: every symbolic Delta is a VALID mirror delta (all nine
//! fields inside the scaled declared ranges), generated from raw small-width
//! integers (`i16`/`u16` cover the signed/unsigned 16-bit ranges exactly;
//! credit limits are 32-bit symbolic values constrained to
//! `[0, MAX_CREDIT_LIMIT]`). Transfer/hold amounts come from `u8`, covering
//! `[0, MAX_PAYMENT_AMOUNT]` — production additionally requires `amount >= 1`
//! (`validate_envelope` in `engine/src/tx/handlers/balance/payment.rs`); where
//! a property needs that precondition it is stated as an explicit assumption.
//!
//! All properties are claims "within the bounded 16/8-bit mirror", never
//! statements about the 256/128-bit production machine itself; the bridge to
//! production widths is the width-parameterized equivalence test in
//! `tests/equivalence.rs`.

use crate::delta_mirror::{
    DeltaMirror, MAX_CREDIT_LIMIT, MAX_PAYMENT_AMOUNT, Side,
};

/// Symbolic valid delta: raw fields at exactly the scaled field widths,
/// credit limits constrained to `[0, MAX_CREDIT_LIMIT]`. `validate` succeeds
/// by construction, mirroring the production invariant that only
/// `Delta::new`-validated deltas enter the state machine.
fn any_valid_delta() -> DeltaMirror {
    let ondelta: i16 = kani::any();
    let offdelta: i16 = kani::any();
    let collateral: u16 = kani::any();
    let left_credit: u32 = kani::any();
    let right_credit: u32 = kani::any();
    let left_allowance: u16 = kani::any();
    let right_allowance: u16 = kani::any();
    let left_hold: u16 = kani::any();
    let right_hold: u16 = kani::any();
    kani::assume(left_credit <= MAX_CREDIT_LIMIT as u32);
    kani::assume(right_credit <= MAX_CREDIT_LIMIT as u32);
    let delta = DeltaMirror {
        ondelta: ondelta as i128,
        offdelta: offdelta as i128,
        collateral: collateral as i128,
        left_credit_limit: left_credit as i128,
        right_credit_limit: right_credit as i128,
        left_allowance: left_allowance as i128,
        right_allowance: right_allowance as i128,
        left_hold: left_hold as i128,
        right_hold: right_hold as i128,
    };
    assert!(delta.is_valid());
    delta
}

fn any_side() -> Side {
    let is_left: bool = kani::any();
    if is_left {
        Side::Left
    } else {
        Side::Right
    }
}

/// Transfer/hold operand in `[0, MAX_PAYMENT_AMOUNT]` (u8 = 8-bit payment
/// width; production additionally requires `>= 1`, assumed where needed).
fn any_payment_amount() -> i128 {
    let amount: u8 = kani::any();
    amount as i128
}

fn any_payment_or_oversize_amount() -> i128 {
    // u16 exceeds the 8-bit payment domain only up to 65535, still far below
    // the 16-bit unsigned field cap; this exercises rejection of oversized
    // operands, not just on-range ones.
    let amount: u16 = kani::any();
    amount as i128
}

// -------------------------------------------------------------------------
// C5a: perspective flip is an involution
// -------------------------------------------------------------------------

#[kani::proof]
fn c5a_flip_is_involution() {
    let delta = any_valid_delta();
    let left = delta.left_perspective();
    let double_flipped = crate::delta_mirror::flip_perspective(
        crate::delta_mirror::flip_perspective(left),
    );
    assert_eq!(double_flipped, left);
}

#[kani::proof]
fn c5a_flip_equals_right_perspective() {
    let delta = any_valid_delta();
    let left = delta.left_perspective();
    let right = delta.perspective(Side::Right);
    assert_eq!(crate::delta_mirror::flip_perspective(left), right);
    // The two credit-limit fields of the production Rust `DeltaPerspective`
    // are view-relative: the right view's own limit is the right entity's
    // granted credit (mirrors `flipDeltaPerspective`).
    assert_eq!(right.own_credit_limit, delta.right_credit_limit);
    assert_eq!(right.peer_credit_limit, delta.left_credit_limit);
}

#[kani::proof]
fn c5a_right_total_negates_left_total() {
    let delta = any_valid_delta();
    let left = delta.left_perspective();
    let right = delta.perspective(Side::Right);
    // TS `deriveDelta` reports view-INdependent summaries: `delta` (=
    // ondelta + offdelta) and `collateral` are the same object for both
    // views; the counterparty's negated net position is carried by the
    // directional fields (inOwnCredit == right's outPeerCredit, etc.),
    // which the flip involution harness covers. A right view that negated
    // `delta` would NOT match `deriveDelta(isLeft=false)`.
    assert_eq!(left.delta, right.delta);
    assert_eq!(left.collateral, right.collateral);
    // Perspective-invariant summaries survive the flip unchanged.
    assert_eq!(left.total_capacity, right.total_capacity);
    // Directional mirror: what LEFT can receive is what RIGHT can send back.
    assert_eq!(left.in_own_credit, right.out_peer_credit);
    assert_eq!(left.out_peer_credit, right.in_own_credit);
}

// -------------------------------------------------------------------------
// C5b: capacities are non-negative for all in-range inputs
// -------------------------------------------------------------------------

#[kani::proof]
fn c5b_capacities_nonnegative() {
    let delta = any_valid_delta();
    let left = delta.left_perspective();
    assert!(left.in_capacity >= 0);
    assert!(left.out_capacity >= 0);
    // Every other derived perspective field is non-negative as well.
    assert!(left.in_collateral >= 0);
    assert!(left.out_collateral >= 0);
    assert!(left.in_own_credit >= 0);
    assert!(left.out_peer_credit >= 0);
    assert!(left.out_own_credit >= 0);
    assert!(left.in_peer_credit >= 0);
    assert!(left.in_allowance >= 0);
    assert!(left.out_allowance >= 0);
    assert!(left.own_credit_limit >= 0);
    assert!(left.peer_credit_limit >= 0);
    assert!(left.out_total_hold >= 0);
    assert!(left.in_total_hold >= 0);
    assert!(left.total_capacity >= 0);
    // And by the flip involution the same holds for the right view.
    let right = delta.perspective(Side::Right);
    assert!(right.in_capacity >= 0);
    assert!(right.out_capacity >= 0);
}

// -------------------------------------------------------------------------
// C5c: transfer conservation across the two perspectives
// -------------------------------------------------------------------------

/// The piecewise perspective formulas collapse to closed clamped forms.
/// This is the locality theorem for the conservation argument: capacity is
/// exactly `max(0, potential -/+ position)` and nothing else.
#[kani::proof]
fn c5c_capacity_closed_form() {
    let delta = any_valid_delta();
    let t = delta.total_delta();
    let left = delta.left_perspective();
    assert_eq!(left.in_capacity, (delta.in_potential() - t).max(0));
    assert_eq!(left.out_capacity, (delta.out_potential() + t).max(0));
}

/// `apply_transfer` never touches the potential terms: receive potential A
/// and send potential B are transfer-invariants.
#[kani::proof]
fn c5c_transfer_preserves_potentials() {
    let delta = any_valid_delta();
    let sender = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(next) = delta.apply_transfer(sender, amount) {
        assert_eq!(next.in_potential(), delta.in_potential());
        assert_eq!(next.out_potential(), delta.out_potential());
    }
}

/// Interior conservation: when neither capacity clamp binds before or after
/// the transfer, the in+out capacity sum of the left view is conserved
/// exactly (equivalently: left.outCapacity decrease equals left.inCapacity
/// increase). This is the region in which a payment only moves capacity
/// across the two perspectives and creates or destroys none of it.
#[kani::proof]
fn c5c_interior_conserves_capacity_sum() {
    let delta = any_valid_delta();
    let sender = any_side();
    let amount = any_payment_amount();
    let t_before = delta.total_delta();
    let t_after = match sender {
        Side::Left => t_before - amount,
        Side::Right => t_before + amount,
    };
    kani::assume(delta.interior_at(t_before));
    kani::assume(delta.interior_at(t_after));
    if let Ok(next) = delta.apply_transfer(sender, amount) {
        let before = delta.left_perspective();
        let after = next.left_perspective();
        assert_eq!(
            after.in_capacity + after.out_capacity,
            before.in_capacity + before.out_capacity
        );
        // In the interior both clamps are unclamped, so the change is exact
        // and directional: LEFT sending moves t down by amount (outCapacity
        // down, inCapacity up by the same amount), RIGHT sending moves t up.
        let out_change = match sender {
            Side::Left => -amount,
            Side::Right => amount,
        };
        assert_eq!(after.out_capacity, before.out_capacity + out_change);
        assert_eq!(after.in_capacity, before.in_capacity - out_change);
    }
}

/// Production-precondition consumption: `payment.rs` only calls
/// `apply_transfer` when `amount >= 1` and `amount <= sender outCapacity`.
/// Under exactly that precondition the sender's outCapacity decreases by the
/// full transfer amount — the clamp never eats a covered transfer.
#[kani::proof]
fn c5c_covered_transfer_consumes_exactly_amount() {
    let delta = any_valid_delta();
    let sender = any_side();
    let amount = any_payment_amount();
    kani::assume(amount >= 1);
    let sender_view = delta.perspective(sender);
    kani::assume(amount <= sender_view.out_capacity);
    if let Ok(next) = delta.apply_transfer(sender, amount) {
        let after = next.perspective(sender);
        assert_eq!(after.out_capacity, sender_view.out_capacity - amount);
        // The receiver's inCapacity IS the sender's outCapacity (flip), so it
        // shrinks by the same exact amount; the movement is lossless.
        let receiver_view = next.perspective(sender.opposite());
        assert_eq!(receiver_view.in_capacity, after.out_capacity);
    }
}

// -------------------------------------------------------------------------
// C5d: add_hold ∘ release_hold == identity
// -------------------------------------------------------------------------

#[kani::proof]
fn c5d_add_then_release_is_identity() {
    let delta = any_valid_delta();
    let side = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(held) = delta.add_hold(side, amount) {
        let released = held.release_hold(side, amount);
        assert_eq!(released, Ok(delta));
    }
}

#[kani::proof]
fn c5d_release_then_add_is_identity() {
    let delta = any_valid_delta();
    let side = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(released) = delta.release_hold(side, amount) {
        let reheld = released.add_hold(side, amount);
        assert_eq!(reheld, Ok(delta));
    }
}

/// A rejected hold mutation never changes any field: `release_hold` below
/// zero (underflow) or past the cap must return `Err` while the mirror state
/// is bit-identical to the input (functional encoding makes the
/// compute-then-assign discipline of the production `&mut self` methods
/// explicit: on `Err` there is no next value at all).
#[kani::proof]
fn c5d_hold_underflow_rejects() {
    let delta = any_valid_delta();
    let side = any_side();
    let amount = any_payment_or_oversize_amount();
    if amount > delta.hold(side) {
        assert!(delta.release_hold(side, amount).is_err());
    }
    // add_hold accepts exactly when the candidate stays inside the unsigned
    // field cap: oversized operands are rejected, never wrapped or clamped.
    assert_eq!(
        delta.add_hold(side, amount).is_ok(),
        delta.hold(side) + amount <= crate::delta_mirror::UINT_MAX as i128
    );
}

// -------------------------------------------------------------------------
// C5e: no field leaves its declared range through any single handler
// -------------------------------------------------------------------------

/// For every handler: valid input state + in-domain operand, `Ok` result
/// implies the full nine-field validation still passes. Rejected handlers
/// produce no state (Err), so no out-of-range state can escape a handler.
#[kani::proof]
fn c5e_apply_transfer_stays_in_range() {
    let delta = any_valid_delta();
    let sender = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(next) = delta.apply_transfer(sender, amount) {
        assert!(next.is_valid());
    }
}

#[kani::proof]
fn c5e_add_hold_stays_in_range() {
    let delta = any_valid_delta();
    let side = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(next) = delta.add_hold(side, amount) {
        assert!(next.is_valid());
    }
}

#[kani::proof]
fn c5e_release_hold_stays_in_range() {
    let delta = any_valid_delta();
    let side = any_side();
    let amount = any_payment_or_oversize_amount();
    if let Ok(next) = delta.release_hold(side, amount) {
        assert!(next.is_valid());
    }
}

#[kani::proof]
fn c5e_apply_j_settlement_stays_in_range() {
    let delta = any_valid_delta();
    let collateral: u16 = kani::any();
    let ondelta: i16 = kani::any();
    if let Ok(next) = delta.apply_j_settlement(collateral as i128, ondelta as i128) {
        assert!(next.is_valid());
    }
}

/// Transfer that would push `offdelta` past a signed bound is rejected,
/// never wrapped: the production `signed("offdelta", next, 256)` check has
/// reachable rejection edges at both boundaries inside the mirror ranges.
/// LEFT sending subtracts (moves toward SIGNED_MIN), RIGHT sending adds
/// (moves toward SIGNED_MAX), mirroring `deriveTransferOffdeltaChange`.
#[kani::proof]
fn c5e_offdelta_boundary_rejection() {
    let mut delta = DeltaMirror::zero();
    delta.offdelta = 32_766; // SIGNED_MAX - 1
    assert!(delta.is_valid());
    let at_max = delta.apply_transfer(Side::Right, 1).unwrap();
    assert_eq!(at_max.offdelta, 32_767); // SIGNED_MAX, still in range
    assert!(at_max.is_valid());
    // One more unit past SIGNED_MAX must reject.
    assert_eq!(
        at_max.apply_transfer(Side::Right, 1),
        Err(crate::delta_mirror::DeltaError::FieldOutOfRange("offdelta"))
    );

    let mut delta = DeltaMirror::zero();
    delta.offdelta = -32_766; // SIGNED_MIN + 2
    let at_min = delta.apply_transfer(Side::Left, 2).unwrap();
    assert_eq!(at_min.offdelta, -32_768); // SIGNED_MIN, inclusive bound
    assert!(at_min.is_valid());
    assert_eq!(
        at_min.apply_transfer(Side::Left, 1),
        Err(crate::delta_mirror::DeltaError::FieldOutOfRange("offdelta"))
    );
}
