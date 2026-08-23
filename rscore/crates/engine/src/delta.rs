use std::fmt;

use num_bigint::BigInt;

use crate::{Side, StateError};

pub const MAX_TOKEN_ID: u32 = 65_535;
pub const MAX_ACCOUNT_TOKEN_ROWS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TokenId(u16);

impl TokenId {
    pub fn new(value: u32) -> Result<Self, StateError> {
        if value > MAX_TOKEN_ID {
            return Err(StateError::DeltaFieldOutOfRange {
                field: "tokenId",
                value: BigInt::from(value),
            });
        }
        Ok(Self(value as u16))
    }

    pub const fn get(self) -> u16 {
        self.0
    }

    pub fn radix_key(self) -> Vec<u8> {
        let mut output = vec![0_u8; 32];
        output[30..].copy_from_slice(&self.0.to_be_bytes());
        output
    }
}

impl fmt::Display for TokenId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delta {
    token_id: TokenId,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeltaPerspective {
    pub in_capacity: BigInt,
    pub out_capacity: BigInt,
    pub own_credit_limit: BigInt,
    pub peer_credit_limit: BigInt,
}

impl Delta {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        token_id: TokenId,
        collateral: BigInt,
        ondelta: BigInt,
        offdelta: BigInt,
        left_credit_limit: BigInt,
        right_credit_limit: BigInt,
        left_allowance: BigInt,
        right_allowance: BigInt,
        left_hold: BigInt,
        right_hold: BigInt,
    ) -> Result<Self, StateError> {
        let value = Self {
            token_id,
            collateral,
            ondelta,
            offdelta,
            left_credit_limit,
            right_credit_limit,
            left_allowance,
            right_allowance,
            left_hold,
            right_hold,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn zero(token_id: TokenId) -> Self {
        Self {
            token_id,
            collateral: 0.into(),
            ondelta: 0.into(),
            offdelta: 0.into(),
            left_credit_limit: 0.into(),
            right_credit_limit: 0.into(),
            left_allowance: 0.into(),
            right_allowance: 0.into(),
            left_hold: 0.into(),
            right_hold: 0.into(),
        }
    }

    pub const fn token_id(&self) -> TokenId {
        self.token_id
    }

    pub const fn collateral(&self) -> &BigInt {
        &self.collateral
    }

    pub const fn ondelta(&self) -> &BigInt {
        &self.ondelta
    }

    pub const fn offdelta(&self) -> &BigInt {
        &self.offdelta
    }

    pub const fn left_credit_limit(&self) -> &BigInt {
        &self.left_credit_limit
    }

    pub const fn right_credit_limit(&self) -> &BigInt {
        &self.right_credit_limit
    }

    pub(crate) fn set_credit_limit(&mut self, proposer: Side, amount: BigInt) {
        match proposer {
            Side::Left => self.right_credit_limit = amount,
            Side::Right => self.left_credit_limit = amount,
        }
    }

    pub(crate) fn apply_transfer(
        &mut self,
        sender: Side,
        amount: &BigInt,
    ) -> Result<(), StateError> {
        let next = match sender {
            Side::Left => &self.offdelta - amount,
            Side::Right => &self.offdelta + amount,
        };
        signed("offdelta", &next, 256)?;
        self.offdelta = next;
        Ok(())
    }

    pub fn perspective(&self, side: Side) -> DeltaPerspective {
        let left = self.left_perspective();
        if side == Side::Left {
            left
        } else {
            DeltaPerspective {
                in_capacity: left.out_capacity,
                out_capacity: left.in_capacity,
                own_credit_limit: left.peer_credit_limit,
                peer_credit_limit: left.own_credit_limit,
            }
        }
    }

    fn left_perspective(&self) -> DeltaPerspective {
        let total = &self.ondelta + &self.offdelta;
        let zero = BigInt::from(0);
        let in_collateral = if total > zero {
            non_negative(&self.collateral - &total)
        } else {
            self.collateral.clone()
        };
        let out_collateral = if total > zero {
            total.clone().min(self.collateral.clone())
        } else {
            zero.clone()
        };
        let in_own_credit = non_negative(-&total);
        let out_peer_credit = non_negative(&total - &self.collateral);
        let out_own_credit = non_negative(&self.left_credit_limit - &in_own_credit);
        let in_peer_credit = non_negative(&self.right_credit_limit - &out_peer_credit);
        DeltaPerspective {
            in_capacity: non_negative(
                in_own_credit + in_collateral + in_peer_credit
                    - &self.right_allowance
                    - &self.right_hold,
            ),
            out_capacity: non_negative(
                out_peer_credit + out_collateral + out_own_credit
                    - &self.left_allowance
                    - &self.left_hold,
            ),
            own_credit_limit: self.left_credit_limit.clone(),
            peer_credit_limit: self.right_credit_limit.clone(),
        }
    }

    pub(crate) fn commitment_fields(&self) -> [(&'static str, BigInt); 9] {
        [
            ("collateral", self.collateral.clone()),
            ("ondelta", self.ondelta.clone()),
            ("offdelta", self.offdelta.clone()),
            ("leftCreditLimit", self.left_credit_limit.clone()),
            ("rightCreditLimit", self.right_credit_limit.clone()),
            ("leftAllowance", self.left_allowance.clone()),
            ("rightAllowance", self.right_allowance.clone()),
            ("leftHold", self.left_hold.clone()),
            ("rightHold", self.right_hold.clone()),
        ]
    }

    fn validate(&self) -> Result<(), StateError> {
        unsigned("collateral", &self.collateral, &uint_max(256))?;
        signed("ondelta", &self.ondelta, 256)?;
        signed("offdelta", &self.offdelta, 256)?;
        unsigned(
            "leftCreditLimit",
            &self.left_credit_limit,
            &max_credit_limit(),
        )?;
        unsigned(
            "rightCreditLimit",
            &self.right_credit_limit,
            &max_credit_limit(),
        )?;
        unsigned("leftAllowance", &self.left_allowance, &uint_max(256))?;
        unsigned("rightAllowance", &self.right_allowance, &uint_max(256))?;
        unsigned("leftHold", &self.left_hold, &uint_max(256))?;
        unsigned("rightHold", &self.right_hold, &uint_max(256))
    }
}

pub(crate) fn max_payment_amount() -> BigInt {
    uint_max(128)
}

pub(crate) fn max_credit_limit() -> BigInt {
    max_payment_amount() * 1_000_u16
}

fn uint_max(bits: usize) -> BigInt {
    (BigInt::from(1_u8) << bits) - 1_u8
}

fn signed(field: &'static str, value: &BigInt, bits: usize) -> Result<(), StateError> {
    let boundary = BigInt::from(1_u8) << (bits - 1);
    if value < &(-&boundary) || value >= &boundary {
        return Err(StateError::DeltaFieldOutOfRange {
            field,
            value: value.clone(),
        });
    }
    Ok(())
}

fn unsigned(field: &'static str, value: &BigInt, maximum: &BigInt) -> Result<(), StateError> {
    if value < &BigInt::from(0) || value > maximum {
        return Err(StateError::DeltaFieldOutOfRange {
            field,
            value: value.clone(),
        });
    }
    Ok(())
}

fn non_negative(value: BigInt) -> BigInt {
    value.max(BigInt::from(0))
}
