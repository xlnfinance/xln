//! Permanent path-keyed rows owned by the native Runtime store.

use super::NativeStorageError;

pub(super) const KEY_FRAME: u8 = 0x10;
pub(super) const KEY_RUNTIME_OUTPUT_ROW: u8 = 0x13;
pub(super) const KEY_RUNTIME_MACHINE_LEAF: u8 = 0x16;
pub(super) const KEY_HEAD: &[u8] = &[0x20];
pub(super) const KEY_NATIVE_CHECKPOINT: &[u8] = &[0x39];
pub(super) const KEY_RUNTIME_WATCHER_CURSOR: u8 = 0x3a;

const PATH_KEY_TAGS: &[u8] = &[
    0x17, // Rust Account checkpoint meta: owner.
    0x18, // Rust Account sidecar: owner + Account.
    0x19, // Rust Account Patricia: owner + Account + namespace + path.
    0x21, // live Entity.
    0x22, // live Account.
    0x23, // live book.
    0x24, // live Account field.
    0x26, // live replica metadata.
    0x2a, // certified-board logical binary path.
    0x2c, // Account J-claim logical binary path.
    0x2d, // live book branch.
    0x2e, // live book leaf.
    0x2f, // live Account branch.
    0x30, // live Account leaf.
    0x36, // live Entity field.
    0x37, // live Entity branch.
    0x38, // live Entity leaf.
];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PathNodeKey(Vec<u8>);

impl PathNodeKey {
    /// Accept only permanent owner/path namespaces. Hash-addressed history
    /// tags are intentionally absent: a new value replaces the old path and
    /// deletion prunes it without tracing a content DAG.
    pub fn new(bytes: Vec<u8>) -> Result<Self, NativeStorageError> {
        if !valid_path_key(&bytes) {
            return Err(NativeStorageError::PathKey(bytes));
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

pub(super) fn is_path_node_key(key: &[u8]) -> bool {
    valid_path_key(key)
}

pub(crate) fn valid_path_key(key: &[u8]) -> bool {
    let Some(tag) = key.first() else {
        return false;
    };
    if !PATH_KEY_TAGS.contains(tag) {
        return false;
    }
    match *tag {
        0x17 | 0x21 => key.len() == 33,
        0x18 | 0x22 => key.len() == 65,
        0x19 if key.len() >= 68 => {
            let namespace = key[65];
            let kind = key[66];
            let payload = &key[67..];
            match (namespace, kind) {
                (1..=5, 0) => canonical_radix16_path(payload),
                (1..=5, 1) => !payload.is_empty(),
                (6, 0) => {
                    payload.first().is_some_and(|side| *side <= 1)
                        && canonical_binary_path(&[vec![0], payload[1..].to_vec()].concat())
                }
                (6, 1) => payload.len() == 33 && payload[0] <= 1,
                _ => false,
            }
        }
        0x23 => canonical_text(&key[33..]).is_some_and(|end| 33 + end == key.len()),
        0x24 => matches!(key.len(), 66 | 70) && key.get(65).is_some_and(|field| *field != 0),
        0x26 => key.len() == 65 && key[33..45].iter().all(|byte| *byte == 0),
        0x2a | 0x2b => key.len() > 33 && canonical_binary_path(&key[33..]),
        0x2c => key.len() > 66 && key[65] <= 1 && canonical_binary_path(&key[66..]),
        0x2d | 0x2e => canonical_text(&key[33..]).is_some_and(|end| {
            let side = 33 + end;
            key.get(side).is_some_and(|value| *value <= 1)
                && match *tag {
                    0x2d => canonical_radix16_path(&key[side + 1..]),
                    _ => !key[side + 1..].is_empty(),
                }
        }),
        0x2f | 0x30 if key.len() > 66 && key[65] != 0 => match *tag {
            0x2f => canonical_radix16_path(&key[66..]),
            _ => !key[66..].is_empty(),
        },
        0x36 => matches!(key.len(), 34 | 38) && key.get(33).is_some_and(|field| *field != 0),
        0x37 | 0x38 if key.len() > 34 && key[33] != 0 => match *tag {
            0x37 => canonical_radix16_path(&key[34..]),
            _ => !key[34..].is_empty(),
        },
        _ => false,
    }
}

fn canonical_radix16_path(bytes: &[u8]) -> bool {
    crate::checkpoint_node_key::unpack_radix16_path(bytes).is_ok()
}

fn canonical_binary_path(bytes: &[u8]) -> bool {
    match bytes {
        [1, key @ ..] => key.len() == 32,
        [0, high, low, prefix @ ..] if prefix.len() == 32 => {
            let bit = usize::from(u16::from_be_bytes([*high, *low]));
            if bit > 255 {
                return false;
            }
            let whole = bit / 8;
            let remainder = bit % 8;
            if remainder == 0 {
                prefix[whole..].iter().all(|byte| *byte == 0)
            } else {
                let mask = (1_u8 << (8 - remainder)) - 1;
                prefix[whole] & mask == 0 && prefix[whole + 1..].iter().all(|byte| *byte == 0)
            }
        }
        _ => false,
    }
}

fn canonical_text(bytes: &[u8]) -> Option<usize> {
    let length = bytes
        .get(..2)
        .and_then(|value| <[u8; 2]>::try_from(value).ok())
        .map(u16::from_be_bytes)
        .map(usize::from)?;
    if length == 0
        || bytes.len() < length + 2
        || std::str::from_utf8(&bytes[2..length + 2]).is_err()
    {
        return None;
    }
    Some(length + 2)
}

pub(super) fn frame_key(height: u64) -> [u8; 9] {
    let mut key = [0_u8; 9];
    key[0] = KEY_FRAME;
    key[1..].copy_from_slice(&height.to_be_bytes());
    key
}

pub(super) fn output_key(height: u64, index: usize) -> Result<[u8; 13], NativeStorageError> {
    let index = u32::try_from(index).map_err(|_| NativeStorageError::OutputCount(index))?;
    let mut key = [0_u8; 13];
    key[0] = KEY_RUNTIME_OUTPUT_ROW;
    key[1..9].copy_from_slice(&height.to_be_bytes());
    key[9..].copy_from_slice(&index.to_be_bytes());
    Ok(key)
}

pub(super) fn runtime_machine_leaf_prefix(height: u64) -> [u8; 9] {
    let mut prefix = [0_u8; 9];
    prefix[0] = KEY_RUNTIME_MACHINE_LEAF;
    prefix[1..].copy_from_slice(&height.to_be_bytes());
    prefix
}

pub(super) fn runtime_machine_leaf_key(
    height: u64,
    path_bytes: &[u8],
) -> Result<Vec<u8>, NativeStorageError> {
    if path_bytes.is_empty() {
        return Err(NativeStorageError::RuntimeMachinePath);
    }
    let prefix = runtime_machine_leaf_prefix(height);
    let mut key = Vec::with_capacity(prefix.len().saturating_add(path_bytes.len()));
    key.extend_from_slice(&prefix);
    key.extend_from_slice(path_bytes);
    Ok(key)
}

pub(super) fn runtime_watcher_cursor_key(
    entity_id: &[u8; 32],
    chain_id: u64,
    depository_address: &[u8; 20],
) -> [u8; 61] {
    let mut key = [0_u8; 61];
    key[0] = KEY_RUNTIME_WATCHER_CURSOR;
    key[1..33].copy_from_slice(entity_id);
    key[33..41].copy_from_slice(&chain_id.to_be_bytes());
    key[41..].copy_from_slice(depository_address);
    key
}
