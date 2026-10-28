//! Account-owned signed lending clocks. Mirrors protocol/dispute/lending-covenant.ts.
use crate::{LendingTermId, StateError};
use num_bigint::BigInt;
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};
pub const YEAR_MS: u64 = 31_536_000_000;
pub const MAX_CLOCK: u64 = 9_007_199_254_740_991;
pub fn term_ms(term: LendingTermId) -> u64 {
    match term {
        LendingTermId::OneHour => 3_600_000,
        LendingTermId::OneDay => 86_400_000,
        LendingTermId::OneMonth => 2_592_000_000,
        LendingTermId::Demand => YEAR_MS,
    }
}
pub fn interest(principal: &BigInt, rate: i64) -> BigInt {
    if principal <= &0.into() || rate <= 0 {
        0.into()
    } else {
        principal * rate / 10_000
    }
}
pub fn bigint_json(value: &BigInt) -> serde_json::Value {
    serde_json::json!({"__xlnType":"BigInt","value":value.to_string()})
}
pub fn hash_json(value: &serde_json::Value) -> String {
    format!(
        "0x{}",
        hex::encode(Keccak256::digest(value.to_string().as_bytes()))
    )
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingCovenant {
    pub kind: String,
    pub token_id: u32,
    pub creditor_is_left: bool,
    pub principal: BigInt,
    pub interest_bps: u64,
    pub opened_at: u64,
    pub accrued_at: u64,
    pub accrued_interest: BigInt,
    pub interest_remainder: BigInt,
    pub term_ms: u64,
    pub late_ms: u64,
}
impl LendingCovenant {
    pub fn validate_clock(&self) -> Result<(), StateError> {
        let fail = |s: &str| StateError::AccountStateRoot(s.into());
        if !matches!(self.kind.as_str(), "savings" | "demand" | "loan") {
            return Err(fail("LENDING_COVENANT_ROLE"));
        }
        if self.token_id == 0 {
            return Err(fail("LENDING_COVENANT_TOKEN"));
        }
        if self.term_ms == 0
            || self
                .opened_at
                .checked_add(self.term_ms)
                .and_then(|v| v.checked_add(self.late_ms))
                .is_none_or(|v| v > MAX_CLOCK)
        {
            return Err(fail("LENDING_COVENANT_MATURITY"));
        }
        if self.accrued_at < self.opened_at
            || self.accrued_at > self.end()
            || self.interest_bps > 10000
        {
            return Err(fail("LENDING_COVENANT_CLOCK"));
        }
        if self.principal < 0.into()
            || self.accrued_interest < 0.into()
            || self.interest_remainder < 0.into()
            || self.interest_remainder >= BigInt::from(10000) * self.term_ms
            || self.maximum() > (BigInt::from(1) << 256) - 1
        {
            return Err(fail("LENDING_COVENANT_AMOUNT"));
        }
        if self.kind != "loan" && self.late_ms != 0 {
            return Err(fail("LENDING_SAVINGS_LATE_INTEREST"));
        }
        if self.kind == "demand" && self.term_ms != YEAR_MS {
            return Err(fail("LENDING_DEMAND_RATE_PERIOD"));
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), StateError> {
        self.validate_clock()?;
        if self.principal == 0.into() {
            return Err(StateError::AccountStateRoot(
                "LENDING_COVENANT_EMPTY".into(),
            ));
        }
        Ok(())
    }
    pub fn end(&self) -> u64 {
        self.opened_at + self.term_ms + self.late_ms
    }
    pub fn accrued(&self, time: u64) -> Self {
        let mut c = self.clone();
        c.accrued_at = self.accrued_at.max(time.min(self.end()));
        let numerator = &self.principal * self.interest_bps * (c.accrued_at - self.accrued_at)
            + &self.interest_remainder;
        let denominator = BigInt::from(10000) * self.term_ms;
        c.accrued_interest += &numerator / &denominator;
        c.interest_remainder = numerator % denominator;
        c
    }
    pub fn exit(&self, time: u64) -> BigInt {
        &self.principal + self.accrued(time).accrued_interest
    }
    pub fn maximum(&self) -> BigInt {
        self.exit(self.end())
    }
    pub fn settle(&self, maximum: &BigInt, time: u64) -> (BigInt, Self) {
        let mut c = self.accrued(time);
        let amount = maximum.clone().min(&c.principal + &c.accrued_interest);
        let paid_interest = amount.clone().min(c.accrued_interest.clone());
        c.principal -= &amount - &paid_interest;
        c.accrued_interest -= paid_interest;
        if c.principal == 0.into() {
            c.interest_remainder = 0.into();
        }
        (amount, c)
    }
    pub fn renew(&self, rate: u64, time: u64) -> Result<Self, &'static str> {
        if self.kind != "demand"
            || time.checked_add(YEAR_MS).is_none_or(|v| v > MAX_CLOCK)
            || time <= self.accrued_at
            || rate > 10000
        {
            return Err("LENDING_RATE_CLOCK_OR_PRODUCT");
        }
        let mut c = self.accrued(time);
        c.opened_at = time;
        c.accrued_at = time;
        c.interest_bps = rate;
        if c.maximum() > (BigInt::from(1) << 256) - 1 {
            return Err("LENDING_RATE_AMOUNT_OVERFLOW");
        }
        Ok(c)
    }
    pub fn hash(&self) -> String {
        hash_json(&serde_json::json!([
            self.kind,
            self.token_id,
            self.creditor_is_left,
            bigint_json(&self.principal),
            self.interest_bps,
            self.opened_at,
            self.accrued_at,
            bigint_json(&self.accrued_interest),
            bigint_json(&self.interest_remainder),
            self.term_ms,
            self.late_ms
        ]))
    }
    pub fn canonical(&self) -> CanonicalValue {
        let n =
            |v: u64| CanonicalValue::Number(CanonicalNumber::try_from_u64(v).expect("safe clock"));
        CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String(self.kind.clone())),
            ("tokenId".into(), n(self.token_id.into())),
            (
                "creditorIsLeft".into(),
                CanonicalValue::Bool(self.creditor_is_left),
            ),
            (
                "principal".into(),
                CanonicalValue::BigInt(self.principal.clone()),
            ),
            ("interestBps".into(), n(self.interest_bps)),
            ("openedAt".into(), n(self.opened_at)),
            ("accruedAt".into(), n(self.accrued_at)),
            (
                "accruedInterest".into(),
                CanonicalValue::BigInt(self.accrued_interest.clone()),
            ),
            (
                "interestRemainder".into(),
                CanonicalValue::BigInt(self.interest_remainder.clone()),
            ),
            ("termMs".into(), n(self.term_ms)),
            ("lateMs".into(), n(self.late_ms)),
        ])
    }
    pub fn decode(value: &CanonicalValue) -> Result<Self, StateError> {
        let fail = || StateError::AccountStateRoot("LENDING_COVENANT_FIELDS".into());
        let CanonicalValue::Object(rows) = value else {
            return Err(fail());
        };
        if rows.len() != 11 {
            return Err(fail());
        }
        let get = |key: &str| {
            rows.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .ok_or_else(fail)
        };
        let num = |key: &str| -> Result<u64, StateError> {
            let CanonicalValue::Number(n) = get(key)? else {
                return Err(fail());
            };
            let n = n.as_str().parse::<f64>().map_err(|_| fail())?;
            if n < 0.0 || n.fract() != 0.0 || n > MAX_CLOCK as f64 {
                return Err(fail());
            }
            Ok(n as u64)
        };
        let big = |key: &str| -> Result<BigInt, StateError> {
            let CanonicalValue::BigInt(n) = get(key)? else {
                return Err(fail());
            };
            Ok(n.clone())
        };
        let CanonicalValue::String(kind) = get("kind")? else {
            return Err(fail());
        };
        let CanonicalValue::Bool(side) = get("creditorIsLeft")? else {
            return Err(fail());
        };
        let c = Self {
            kind: kind.clone(),
            token_id: u32::try_from(num("tokenId")?).map_err(|_| fail())?,
            creditor_is_left: *side,
            principal: big("principal")?,
            interest_bps: num("interestBps")?,
            opened_at: num("openedAt")?,
            accrued_at: num("accruedAt")?,
            accrued_interest: big("accruedInterest")?,
            interest_remainder: big("interestRemainder")?,
            term_ms: num("termMs")?,
            late_ms: num("lateMs")?,
        };
        c.validate()?;
        Ok(c)
    }
}

mod view;
pub use view::{LendingAccountView, decode_lending_account_projection, project_lending_account};
