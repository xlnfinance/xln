//! Time coordinates retain primitive wire values, but conversions are explicit.
//! A timestamp is never a duration or a chain height.
//!
//! ```compile_fail
//! use xln_rscore_protocol::{UnixMs, UnixS};
//! let seconds: UnixS = UnixMs::new(1000).unwrap();
//! ```

use crate::JS_MAX_SAFE_INTEGER;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("PROTOCOL_{unit}_INVALID:{value}")]
pub struct TimeUnitError {
    unit: &'static str,
    value: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnixMs(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnixS(u64);

impl UnixMs {
    pub fn new(value: u64) -> Result<Self, TimeUnitError> {
        coordinate(value, "UNIX_MS").map(Self)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
    pub const fn floor_seconds(self) -> UnixS {
        // Division preserves the validated safe-integer range.
        UnixS(self.0 / 1000)
    }
}

impl UnixS {
    pub fn new(value: u64) -> Result<Self, TimeUnitError> {
        coordinate(value, "UNIX_S").map(Self)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
    pub fn to_millis(self) -> Result<UnixMs, TimeUnitError> {
        self.0
            .checked_mul(1000)
            .filter(|value| *value <= JS_MAX_SAFE_INTEGER)
            .map(UnixMs)
            .ok_or(TimeUnitError {
                unit: "UNIX_MS",
                value: self.0,
            })
    }
    pub fn checked_add_seconds(self, duration: u64) -> Result<Self, TimeUnitError> {
        self.0
            .checked_add(duration)
            .filter(|value| *value <= JS_MAX_SAFE_INTEGER)
            .map(Self)
            .ok_or(TimeUnitError {
                unit: "UNIX_S",
                value: self.0,
            })
    }
}

fn coordinate(value: u64, unit: &'static str) -> Result<u64, TimeUnitError> {
    if value > JS_MAX_SAFE_INTEGER {
        Err(TimeUnitError { unit, value })
    } else {
        Ok(value)
    }
}
