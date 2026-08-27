//! Bounded i128/u128 mirror of the bilateral account delta math.
//!
//! Production sources mirrored field-for-field and branch-for-branch:
//! - `rscore/crates/engine/src/state/delta.rs` (`Delta::validate`,
//!   `apply_transfer`, `add_hold`, `release_hold`, `apply_j_settlement`,
//!   `left_perspective`, `perspective`)
//! - `core/account/utils.ts` (`deriveLeftPerspective`, `flipDeltaPerspective`,
//!   `deriveDelta`) for the full perspective field set
//! - `core/account/tx/hold-utils.ts` and
//!   `core/account/tx/handlers/balance/payment.rs` for the caller-side
//!   preconditions (`amount >= 1`, `amount <= sender outCapacity`).
//!
//! Scale mapping (production -> mirror, factor 16):
//! - field width 256 bits -> `FIELD_BITS = 16` (signed and unsigned fields)
//! - payment width 128 bits -> `PAYMENT_BITS = 8`
//! - `max_credit_limit = uint_max(128) * 1000` -> `uint_max(8) * 1000 = 255_000`
//!
//! The mirror is pure: every handler is a total function
//! `(DeltaMirror, operands) -> Result<DeltaMirror, DeltaError>` that computes
//! the next value first and only then decides, exactly like the production
//! `&mut self` methods which assign exclusively after the range check passes.
//! A rejected handler therefore cannot mutate state by construction.
//!
//! All arithmetic runs in i128 while logical values are bounded by
//! `MAX_CREDIT_LIMIT * 4 < 2^20`, so no intermediate can overflow the host
//! type; Kani's arithmetic-overflow checks are left enabled and would fail
//! loudly if this reasoning ever breaks.

pub const FIELD_BITS: usize = 16;
pub const PAYMENT_BITS: usize = 8;

/// Half-open signed range bound, mirroring `signed(field, value, 256)`:
/// production accepts `[-2^255, 2^255)`, mirror accepts `[-2^15, 2^15)`.
pub const SIGNED_BOUND: i128 = 1 << (FIELD_BITS - 1);
pub const SIGNED_MIN: i128 = -SIGNED_BOUND;
pub const SIGNED_MAX: i128 = SIGNED_BOUND - 1;

/// Mirrors `uint_max(256) = 2^256 - 1` as `2^16 - 1`.
pub const UINT_MAX: u128 = (1_u128 << FIELD_BITS) - 1;

/// Mirrors `max_payment_amount() = uint_max(128)` as `2^8 - 1`.
pub const MAX_PAYMENT_AMOUNT: u128 = (1_u128 << PAYMENT_BITS) - 1;

/// Mirrors `max_credit_limit() = max_payment_amount() * 1000`.
pub const MAX_CREDIT_LIMIT: u128 = MAX_PAYMENT_AMOUNT * 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeltaError {
    /// Field name matches the production `StateError::DeltaFieldOutOfRange`
    /// strings byte-for-byte so equivalence can compare rejection identity.
    FieldOutOfRange(&'static str),
}

/// Mirrors the nine BigInt financial fields of the production `Delta`.
/// Signed fields live in `[SIGNED_MIN, SIGNED_MAX]`; unsigned fields are
/// stored as i128 but constrained to `[0, UINT_MAX]` (or `[0,
/// MAX_CREDIT_LIMIT]` for credit limits) by `validate`, mirroring the split
/// between `signed(...)` and `unsigned(...)` in production.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DeltaMirror {
    pub collateral: i128,
    pub ondelta: i128,
    pub offdelta: i128,
    pub left_credit_limit: i128,
    pub right_credit_limit: i128,
    pub left_allowance: i128,
    pub right_allowance: i128,
    pub left_hold: i128,
    pub right_hold: i128,
}

impl DeltaMirror {
    /// Mirrors `Delta::zero`.
    pub fn zero() -> DeltaMirror {
        DeltaMirror {
            collateral: 0,
            ondelta: 0,
            offdelta: 0,
            left_credit_limit: 0,
            right_credit_limit: 0,
            left_allowance: 0,
            right_allowance: 0,
            left_hold: 0,
            right_hold: 0,
        }
    }

    /// Mirrors `Delta::validate` with identical field names and identical
    /// bound types (signed 256 -> signed 16, uint_max(256) -> uint_max(16),
    /// max_credit_limit scaled).
    pub fn validate(&self) -> Result<(), DeltaError> {
        unsigned("collateral", self.collateral, UINT_MAX as i128)?;
        signed("ondelta", self.ondelta)?;
        signed("offdelta", self.offdelta)?;
        unsigned(
            "leftCreditLimit",
            self.left_credit_limit,
            MAX_CREDIT_LIMIT as i128,
        )?;
        unsigned(
            "rightCreditLimit",
            self.right_credit_limit,
            MAX_CREDIT_LIMIT as i128,
        )?;
        unsigned("leftAllowance", self.left_allowance, UINT_MAX as i128)?;
        unsigned("rightAllowance", self.right_allowance, UINT_MAX as i128)?;
        unsigned("leftHold", self.left_hold, UINT_MAX as i128)?;
        unsigned("rightHold", self.right_hold, UINT_MAX as i128)?;
        Ok(())
    }

    pub fn is_valid(&self) -> bool {
        self.validate().is_ok()
    }

    /// Mirrors `Delta::hold(side)`.
    pub fn hold(&self, side: Side) -> i128 {
        match side {
            Side::Left => self.left_hold,
            Side::Right => self.right_hold,
        }
    }

    fn hold_field(side: Side) -> &'static str {
        match side {
            Side::Left => "leftHold",
            Side::Right => "rightHold",
        }
    }

    /// Mirrors `Delta::apply_transfer` exactly: Left sender subtracts from
    /// `offdelta` (positive offdelta favors LEFT), Right sender adds; the
    /// signed range check runs on the candidate BEFORE any assignment.
    /// TS counterpart: `deriveTransferOffdeltaChange` (`senderIsLeft ->
    /// -amount`) applied as `delta.offdelta += change`.
    pub fn apply_transfer(
        &self,
        sender: Side,
        amount: i128,
    ) -> Result<DeltaMirror, DeltaError> {
        let next = match sender {
            Side::Left => self.offdelta - amount,
            Side::Right => self.offdelta + amount,
        };
        signed("offdelta", next)?;
        Ok(DeltaMirror {
            offdelta: next,
            ..*self
        })
    }

    /// Mirrors `Delta::add_hold`: unsigned range check on the candidate.
    pub fn add_hold(&self, side: Side, amount: i128) -> Result<DeltaMirror, DeltaError> {
        let next = self.hold(side) + amount;
        unsigned(Self::hold_field(side), next, UINT_MAX as i128)?;
        Ok(self.with_hold(side, next))
    }

    /// Mirrors `Delta::release_hold`: unsigned range check on the candidate,
    /// which rejects both underflow (below zero) and any overflow.
    pub fn release_hold(&self, side: Side, amount: i128) -> Result<DeltaMirror, DeltaError> {
        let next = self.hold(side) - amount;
        unsigned(Self::hold_field(side), next, UINT_MAX as i128)?;
        Ok(self.with_hold(side, next))
    }

    /// Mirrors `Delta::apply_j_settlement`.
    pub fn apply_j_settlement(
        &self,
        collateral: i128,
        ondelta: i128,
    ) -> Result<DeltaMirror, DeltaError> {
        unsigned("collateral", collateral, UINT_MAX as i128)?;
        signed("ondelta", ondelta)?;
        Ok(DeltaMirror {
            collateral,
            ondelta,
            ..*self
        })
    }

    fn with_hold(&self, side: Side, value: i128) -> DeltaMirror {
        let mut next = *self;
        match side {
            Side::Left => next.left_hold = value,
            Side::Right => next.right_hold = value,
        }
        next
    }

    /// Mirrors `Delta::left_perspective` / `deriveLeftPerspective` with the
    /// full TS `DerivedDelta` field set (the Rust `DeltaPerspective` is the
    /// four-field subset `{in_capacity, out_capacity, own_credit_limit,
    /// peer_credit_limit}` and is cross-checked in tests/equivalence.rs).
    pub fn left_perspective(&self) -> PerspectiveMirror {
        let total = self.ondelta + self.offdelta;
        // TS `deriveDelta` clamps collateral at non-negative before deriving;
        // production `Delta::new` rejects negative collateral outright. On the
        // validated domain both coincide; the mirror follows the TS clamp so
        // equivalence covers the TS path exactly.
        let collateral = non_negative(self.collateral);
        let in_collateral = if total > 0 {
            non_negative(collateral - total)
        } else {
            collateral
        };
        let out_collateral = if total > 0 {
            total.min(collateral)
        } else {
            0
        };
        let in_own_credit = non_negative(-total);
        let out_peer_credit = non_negative(total - collateral);
        let out_own_credit = non_negative(self.left_credit_limit - in_own_credit);
        let in_peer_credit = non_negative(self.right_credit_limit - out_peer_credit);
        let left_hold = self.left_hold;
        let right_hold = self.right_hold;
        let effective_own_credit_window = self.left_credit_limit.max(in_own_credit);
        let effective_peer_credit_window = self.right_credit_limit.max(out_peer_credit);
        PerspectiveMirror {
            in_collateral,
            out_collateral,
            in_own_credit,
            out_peer_credit,
            in_allowance: self.right_allowance,
            out_allowance: self.left_allowance,
            own_credit_limit: self.left_credit_limit,
            peer_credit_limit: self.right_credit_limit,
            in_capacity: non_negative(
                in_own_credit + in_collateral + in_peer_credit
                    - self.right_allowance
                    - right_hold,
            ),
            out_capacity: non_negative(
                out_peer_credit + out_collateral + out_own_credit
                    - self.left_allowance
                    - left_hold,
            ),
            out_own_credit,
            in_peer_credit,
            peer_credit_used: in_own_credit,
            own_credit_used: out_peer_credit,
            out_total_hold: left_hold,
            in_total_hold: right_hold,
            effective_own_credit_window,
            effective_peer_credit_window,
            total_capacity: collateral + effective_own_credit_window + effective_peer_credit_window,
            delta: total,
            collateral,
        }
    }

    /// Mirrors `Delta::perspective(side)`: left view directly, right view by
    /// flipping the left view (`deriveDelta(isLeft=false)` in TS).
    pub fn perspective(&self, side: Side) -> PerspectiveMirror {
        match side {
            Side::Left => self.left_perspective(),
            Side::Right => flip_perspective(self.left_perspective()),
        }
    }
}

/// Mirrors `deriveLeftPerspective`/`left_perspective` outputs plus the TS-only
/// derived windows (`effective_own_credit_window`, `effective_peer_credit_window`,
/// `total_capacity`) and `deriveDelta`'s `delta`/`collateral` summary fields.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PerspectiveMirror {
    pub in_collateral: i128,
    pub out_collateral: i128,
    pub in_own_credit: i128,
    pub out_peer_credit: i128,
    pub in_allowance: i128,
    pub out_allowance: i128,
    pub own_credit_limit: i128,
    pub peer_credit_limit: i128,
    pub in_capacity: i128,
    pub out_capacity: i128,
    pub out_own_credit: i128,
    pub in_peer_credit: i128,
    pub peer_credit_used: i128,
    pub own_credit_used: i128,
    pub out_total_hold: i128,
    pub in_total_hold: i128,
    pub effective_own_credit_window: i128,
    pub effective_peer_credit_window: i128,
    pub total_capacity: i128,
    pub delta: i128,
    pub collateral: i128,
}

/// Mirrors `flipDeltaPerspective` exactly: the sixteen directional fields
/// swap in/out, the two window summaries are perspective-invariant in the TS
/// type system (`DeltaPerspective` omits `totalCapacity`/`ascii`), so the
/// mirror keeps them fixed under the flip, as the TS object spread does.
pub fn flip_perspective(p: PerspectiveMirror) -> PerspectiveMirror {
    PerspectiveMirror {
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

fn signed(field: &'static str, value: i128) -> Result<(), DeltaError> {
    if value < SIGNED_MIN || value >= SIGNED_BOUND {
        return Err(DeltaError::FieldOutOfRange(field));
    }
    Ok(())
}

fn unsigned(field: &'static str, value: i128, maximum: i128) -> Result<(), DeltaError> {
    if value < 0 || value > maximum {
        return Err(DeltaError::FieldOutOfRange(field));
    }
    Ok(())
}

fn non_negative(value: i128) -> i128 {
    value.max(0)
}

// ---------------------------------------------------------------------------
// Closed-form potentials used by the conservation properties (C5c).
//
// For t = ondelta + offdelta the piecewise perspective formulas collapse to
//
//     in_capacity  = max(0, A - t)   with A = collateral + rightCreditLimit
//                                     - rightAllowance - rightHold
//     out_capacity = max(0, B + t)   with B = leftCreditLimit
//                                     - leftAllowance - leftHold
//
// A is the left-view receive potential, B the left-view send potential; both
// are functions of fields that `apply_transfer` never touches, so a transfer
// moves capacity between the two sides of the same formula without creating
// or destroying it. The full derivation is proven as a Kani property
// (`c5c_capacity_closed_form`), not assumed here.
// ---------------------------------------------------------------------------

impl DeltaMirror {
    /// Receive potential `A` of the left view.
    pub fn in_potential(&self) -> i128 {
        self.collateral + self.right_credit_limit - self.right_allowance - self.right_hold
    }

    /// Send potential `B` of the left view.
    pub fn out_potential(&self) -> i128 {
        self.left_credit_limit - self.left_allowance - self.left_hold
    }

    /// Total `t = ondelta + offdelta`, the signed net position of LEFT.
    pub fn total_delta(&self) -> i128 {
        self.ondelta + self.offdelta
    }

    /// Neither capacity clamp binds at position `t`: the interior region in
    /// which transfers conserve the in+out capacity sum exactly. `t` may be a
    /// hypothetical next position (transfer candidate), not a field.
    pub fn interior_at(&self, t: i128) -> bool {
        let a = self.in_potential();
        let b = self.out_potential();
        t <= a && t >= -b
    }
}
