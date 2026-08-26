use sha3::{Digest as _, Keccak256};

use crate::{AccountIdentity, StateError};

const ACCOUNT_DOMAIN: &[u8] = b"xln.account-j-claim.account.v1";
const KEY_DOMAIN: &[u8] = b"xln.account-j-claim.key.v1";
const RECORD_DOMAIN: &[u8] = b"xln.account-j-claim.record.v1";
const LEAF_DOMAIN: &[u8] = b"xln.account-j-claim.leaf.v1";
const BRANCH_DOMAIN: &[u8] = b"xln.account-j-claim.branch.v1";

pub const EMPTY_J_CLAIM_ROOT: [u8; 32] = [
    0x28, 0xd6, 0x27, 0x0b, 0x93, 0xb6, 0x46, 0xf6, 0x3b, 0x2e, 0xce, 0xc1, 0xcc, 0x81, 0x1a, 0x6a,
    0x27, 0xb0, 0x91, 0x69, 0x54, 0xb6, 0x21, 0x1a, 0x21, 0x43, 0x79, 0xf8, 0xcc, 0x25, 0xc5, 0xc2,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum JClaimSide {
    Left,
    Right,
}

impl JClaimSide {
    pub const fn index(self) -> u8 {
        match self {
            Self::Left => 0,
            Self::Right => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JClaimRecord {
    pub account_key: [u8; 32],
    pub side: JClaimSide,
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
    pub events_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JClaimNode {
    Leaf {
        key: [u8; 32],
        record: JClaimRecord,
    },
    Branch {
        bit: u16,
        left: [u8; 32],
        right: [u8; 32],
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JClaimProof {
    pub nodes: Vec<JClaimNode>,
}

impl JClaimProof {
    pub const fn empty() -> Self {
        Self { nodes: Vec::new() }
    }
}

pub fn account_key(identity: &AccountIdentity) -> [u8; 32] {
    keccak_words(&[
        domain_word(ACCOUNT_DOMAIN),
        uint_word(identity.domain().chain_id()),
        address_word(identity.domain().depository_address().as_bytes()),
        *identity.left().as_bytes(),
        *identity.right().as_bytes(),
    ])
}

pub fn claim_key(record: &JClaimRecord) -> Result<[u8; 32], StateError> {
    validate_record(record)?;
    Ok(keccak_words(&[
        domain_word(KEY_DOMAIN),
        record.account_key,
        uint_word(u64::from(record.side.index())),
        uint_word(record.j_height),
    ]))
}

pub fn hash_node(node: &JClaimNode) -> Result<[u8; 32], StateError> {
    match node {
        JClaimNode::Leaf { key, record } => {
            let expected = claim_key(record)?;
            if key != &expected {
                return Err(j_error(format!(
                    "ACCOUNT_J_CLAIM_LEAF_KEY_MISMATCH:{}:{}",
                    hex(key),
                    hex(&expected)
                )));
            }
            Ok(keccak_words(&[
                domain_word(LEAF_DOMAIN),
                uint_word(1),
                *key,
                hash_record(record)?,
            ]))
        }
        JClaimNode::Branch { bit, left, right } => {
            if *bit > 255 {
                return Err(j_error(format!("ACCOUNT_J_CLAIM_BRANCH_BIT_INVALID:{bit}")));
            }
            if left == right {
                return Err(j_error(format!(
                    "ACCOUNT_J_CLAIM_BRANCH_UNARY:{}",
                    hex(left)
                )));
            }
            Ok(keccak_words(&[
                domain_word(BRANCH_DOMAIN),
                uint_word(1),
                uint_word(u64::from(*bit)),
                *left,
                *right,
            ]))
        }
    }
}

pub(crate) fn key_bit(key: &[u8; 32], bit: u16) -> u8 {
    let byte = key[usize::from(bit / 8)];
    (byte >> (7 - (bit % 8))) & 1
}

pub(crate) fn first_different_bit(left: &[u8; 32], right: &[u8; 32]) -> Option<u16> {
    (0..256).find(|bit| key_bit(left, *bit) != key_bit(right, *bit))
}

pub(crate) fn same_record(left: &JClaimRecord, right: &JClaimRecord) -> bool {
    left == right
}

pub(crate) fn validate_record(record: &JClaimRecord) -> Result<(), StateError> {
    if record.j_height == 0 {
        return Err(j_error("ACCOUNT_J_CLAIM_HEIGHT_INVALID:0"));
    }
    Ok(())
}

pub(crate) fn j_error(message: impl Into<String>) -> StateError {
    StateError::JClaim(message.into())
}

fn hash_record(record: &JClaimRecord) -> Result<[u8; 32], StateError> {
    validate_record(record)?;
    Ok(keccak_words(&[
        domain_word(RECORD_DOMAIN),
        record.account_key,
        uint_word(u64::from(record.side.index())),
        uint_word(record.j_height),
        record.j_block_hash,
        record.events_hash,
    ]))
}

fn domain_word(label: &[u8]) -> [u8; 32] {
    Keccak256::digest(label).into()
}

fn uint_word(value: u64) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn address_word(value: &[u8; 20]) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(value);
    word
}

fn keccak_words(words: &[[u8; 32]]) -> [u8; 32] {
    let mut digest = Keccak256::new();
    for word in words {
        digest.update(word);
    }
    digest.finalize().into()
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}

#[cfg(test)]
mod tests {
    use sha3::{Digest as _, Keccak256};

    use super::*;

    #[test]
    fn empty_root_constant_is_the_typescript_domain_hash() {
        let actual: [u8; 32] = Keccak256::digest(b"xln.account-j-claim.empty.v1").into();
        assert_eq!(EMPTY_J_CLAIM_ROOT, actual);
    }
}
