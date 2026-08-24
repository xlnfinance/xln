use std::fmt;

use crate::StateError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub const fn opposite(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntityId([u8; 32]);

impl EntityId {
    pub fn parse(value: &str) -> Result<Self, StateError> {
        if value != value.trim().to_ascii_lowercase() {
            return Err(StateError::InvalidEntityId(value.into()));
        }
        let normalized = value.to_ascii_lowercase();
        let payload = normalized
            .strip_prefix("0x")
            .ok_or_else(|| StateError::InvalidEntityId(value.into()))?;
        if payload.len() != 64 || !payload.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StateError::InvalidEntityId(value.into()));
        }
        let mut bytes = [0_u8; 32];
        hex_decode(payload.as_bytes(), &mut bytes)
            .ok_or_else(|| StateError::InvalidEntityId(value.into()))?;
        Ok(Self(bytes))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn as_hex(&self) -> String {
        render_hex(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositoryAddress([u8; 20]);

impl DepositoryAddress {
    pub fn parse(value: &str) -> Result<Self, StateError> {
        if value != value.to_ascii_lowercase() {
            return Err(StateError::InvalidDepositoryAddress(value.into()));
        }
        parse_fixed_hex(value)
            .map(Self)
            .ok_or_else(|| StateError::InvalidDepositoryAddress(value.into()))
    }

    pub fn as_hex(&self) -> String {
        render_hex(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchSeed([u8; 32]);

impl WatchSeed {
    pub fn parse(value: &str) -> Result<Self, StateError> {
        if value != value.to_ascii_lowercase() {
            return Err(StateError::InvalidWatchSeed(value.into()));
        }
        parse_fixed_hex(value)
            .map(Self)
            .ok_or_else(|| StateError::InvalidWatchSeed(value.into()))
    }

    pub fn as_hex(&self) -> String {
        render_hex(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDomain {
    chain_id: u64,
    depository_address: DepositoryAddress,
}

impl AccountDomain {
    pub fn new(chain_id: u64, depository_address: DepositoryAddress) -> Result<Self, StateError> {
        if chain_id == 0 || chain_id > 9_007_199_254_740_991 {
            return Err(StateError::InvalidChainId(chain_id));
        }
        Ok(Self {
            chain_id,
            depository_address,
        })
    }

    pub const fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub const fn depository_address(&self) -> &DepositoryAddress {
        &self.depository_address
    }
}

impl fmt::Debug for EntityId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_hex())
    }
}

impl fmt::Display for EntityId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_hex())
    }
}

fn hex_decode<const N: usize>(input: &[u8], output: &mut [u8; N]) -> Option<()> {
    for (index, pair) in input.chunks_exact(2).enumerate() {
        output[index] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(())
}

fn parse_fixed_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    let payload = value.strip_prefix("0x")?;
    if payload.len() != N * 2 || !payload.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0_u8; N];
    hex_decode(payload.as_bytes(), &mut bytes)?;
    Some(bytes)
}

/// The first `limit` UTF-16 code units of `value`, the way `String.prototype
/// .slice(0, limit)` cuts an offer id for a human-readable event line.
///
/// Byte-indexing a `String` panics whenever the cut lands inside a multi-byte
/// character, and offer ids are caller-supplied text: TypeScript accepts any
/// id without a colon, `€€€` included. A cut that would split a surrogate pair
/// yields the replacement character here where JavaScript yields a lone
/// surrogate — the two disagree only on astral offer ids, and only inside a
/// diagnostic string.
pub(crate) fn js_prefix(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        // ASCII-or-shorter fast path: byte length bounds UTF-16 length.
        return value.to_owned();
    }
    let units: Vec<u16> = value.encode_utf16().take(limit).collect();
    String::from_utf16_lossy(&units)
}

/// Table-driven `0x…` rendering.
///
/// The commitment path renders roughly fifteen 32-byte roots per account state
/// root; going through `core::fmt` for each byte was the single largest cost in
/// the engine profile (formatting outweighed SHA-256).
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

pub(crate) fn render_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        output.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

const fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentity {
    domain: AccountDomain,
    left: EntityId,
    right: EntityId,
    watch_seed: WatchSeed,
}

impl AccountIdentity {
    pub fn new(
        domain: AccountDomain,
        left: EntityId,
        right: EntityId,
        watch_seed: WatchSeed,
    ) -> Result<Self, StateError> {
        if left >= right {
            return Err(StateError::NonCanonicalAccountParties {
                left: left.to_string(),
                right: right.to_string(),
            });
        }
        Ok(Self {
            domain,
            left,
            right,
            watch_seed,
        })
    }

    pub const fn domain(&self) -> &AccountDomain {
        &self.domain
    }

    pub const fn left(&self) -> &EntityId {
        &self.left
    }

    pub const fn right(&self) -> &EntityId {
        &self.right
    }

    pub const fn watch_seed(&self) -> &WatchSeed {
        &self.watch_seed
    }

    pub const fn entity(&self, side: Side) -> &EntityId {
        match side {
            Side::Left => &self.left,
            Side::Right => &self.right,
        }
    }

    pub fn side_of(&self, entity: &EntityId) -> Option<Side> {
        if entity == &self.left {
            Some(Side::Left)
        } else if entity == &self.right {
            Some(Side::Right)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod js_prefix_tests {
    use super::js_prefix;

    /// Offer ids are caller-supplied text — TypeScript accepts any id without
    /// a colon — and the event line cuts them at 8. Byte-indexing panicked on
    /// every multi-byte id whose cut landed inside a character.
    #[test]
    fn cuts_by_utf16_code_units_like_string_slice() {
        assert_eq!(js_prefix("offer-1234-5678", 8), "offer-12");
        assert_eq!(js_prefix("short", 8), "short");
        assert_eq!(js_prefix("€€€€€€€€€€", 8), "€€€€€€€€");
        assert_eq!(js_prefix("абвгдеёжзи", 8), "абвгдеёж");
        // One astral character is two UTF-16 units, so eight units is four.
        assert_eq!(js_prefix("😀😀😀😀😀", 8), "😀😀😀😀");
    }
}
