//! Exact inverse of `core/storage/schema/rscore/checkpoint.ts`.
//!
//! The durable Runtime WAL stores one checkpoint header per Entity, one
//! bounded Account shell row, and six namespaces of Account-owned leaves.
//! Recovery rebuilds the exact `RestoreExact` wire rows; it never imports the
//! TypeScript Account objects kept in an old Runtime snapshot.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Number, Value};

use super::{RuntimeLevelDbError, RuntimeWalReader, decode_storage_payload};
use crate::checkpoint_node_key::{
    JClaimAccumulatorRef, JClaimPhysicalRow, RadixPhysicalRow, j_claim_accumulators,
    restore_j_claim_rows, restore_radix_leaf_rows, unpack_radix16_path,
};

const KEY_RSCORE_CHECKPOINT: u8 = 0x17;
const KEY_RSCORE_ACCOUNT: u8 = 0x18;
const KEY_RSCORE_ACCOUNT_NODE: u8 = 0x19;
const TREE_NAMESPACES: std::ops::RangeInclusive<u8> = 1..=5;
const J_CLAIM_NAMESPACE: u8 = 6;

#[derive(Clone, Debug)]
pub struct StoredRscoreCheckpoint {
    pub owner_entity_id: [u8; 32],
    pub protocol_fingerprint: [u8; 32],
    pub base_revision: u64,
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub signer_digest: [u8; 32],
    pub account_count: usize,
    /// Exact ten-field rows accepted by process `RestoreExact`.
    pub accounts: Vec<Value>,
}

fn invalid(detail: impl Into<String>) -> RuntimeLevelDbError {
    RuntimeLevelDbError::Output(format!("RSCORE_CHECKPOINT:{}", detail.into()))
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, RuntimeLevelDbError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), RuntimeLevelDbError> {
    let mut actual = value.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn array<'a>(
    value: &'a Value,
    length: usize,
    path: &str,
) -> Result<&'a [Value], RuntimeLevelDbError> {
    value
        .as_array()
        .filter(|values| values.len() == length)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("ARRAY:{path}:{length}")))
}

fn text<'a>(value: &'a Value, path: &str) -> Result<&'a str, RuntimeLevelDbError> {
    value
        .as_str()
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn stored_u64(value: &Value, path: &str) -> Result<u64, RuntimeLevelDbError> {
    let value = text(value, path)?;
    if value != "0" && (value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(invalid(format!("DECIMAL:{path}")));
    }
    value.parse().map_err(|_| invalid(format!("U64:{path}")))
}

fn hex32(value: &Value, path: &str) -> Result<[u8; 32], RuntimeLevelDbError> {
    let value = text(value, path)?;
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| invalid(format!("HEX32:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("HEX32:{path}")))?;
    }
    Ok(output)
}

fn typed_bytes(value: &Value, path: &str) -> Result<Vec<u8>, RuntimeLevelDbError> {
    let value = object(value, path)?;
    if value.get("__xlnType").and_then(Value::as_str) != Some("TypedArray")
        || value.get("kind").and_then(Value::as_str) != Some("Uint8Array")
        || value.len() != 3
    {
        return Err(invalid(format!("BYTES:{path}")));
    }
    BASE64
        .decode(
            value
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(format!("BYTES:{path}")))?,
        )
        .map_err(|_| invalid(format!("BYTES:{path}")))
}

fn tagged_bytes(bytes: &[u8]) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("TypedArray".into())),
        ("kind".into(), Value::String("Uint8Array".into())),
        ("value".into(), Value::String(BASE64.encode(bytes))),
    ]))
}

fn prefixed(base: &[u8], suffix: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(base.len() + suffix.len());
    output.extend_from_slice(base);
    output.extend_from_slice(suffix);
    output
}

fn tree_value(namespace: u8, row: &[Value], path: &str) -> Result<Value, RuntimeLevelDbError> {
    if row.first().and_then(Value::as_u64) != Some(1) {
        return Err(invalid(format!("LEAF_TAG:{path}")));
    }
    let key = typed_bytes(&row[2], &format!("{path}.key"))?;
    match namespace {
        3 => {
            let length = key
                .get(..2)
                .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
                .map(u16::from_be_bytes)
                .map(usize::from)
                .ok_or_else(|| invalid(format!("LENDING_KEY:{path}")))?;
            if key.len() != length + 2 {
                return Err(invalid(format!("LENDING_KEY:{path}")));
            }
            let key = std::str::from_utf8(&key[2..])
                .map_err(|_| invalid(format!("LENDING_KEY_UTF8:{path}")))?;
            Ok(Value::Array(vec![
                Value::String(key.to_string()),
                row[3].clone(),
            ]))
        }
        5 => {
            if key.len() != 32 || key[..30].iter().any(|byte| *byte != 0) {
                return Err(invalid(format!("POLICY_KEY:{path}")));
            }
            Ok(Value::Array(vec![
                Value::Number(Number::from(u16::from_be_bytes([key[30], key[31]]))),
                row[3].clone(),
            ]))
        }
        _ => Ok(row[3].clone()),
    }
}

impl RuntimeWalReader {
    fn rscore_tree_values(
        &mut self,
        owner: &[u8; 32],
        account: &[u8; 32],
        namespace: u8,
        j_claim_roots: Option<&[JClaimAccumulatorRef; 2]>,
    ) -> Result<Vec<Value>, RuntimeLevelDbError> {
        let mut prefix = Vec::with_capacity(66);
        prefix.push(KEY_RSCORE_ACCOUNT_NODE);
        prefix.extend_from_slice(owner);
        prefix.extend_from_slice(account);
        prefix.push(namespace);
        let keys = self
            .prefixed_rows(&prefix)?
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        let mut values = Vec::with_capacity(keys.len());
        let mut j_claim_rows = Vec::new();
        let mut radix_rows = Vec::new();
        for key in keys {
            let decoded = self.required_bounded(&key)?;
            let path = format!("namespace={namespace}:key={}", super::hex(&key));
            let suffix = key
                .get(prefix.len()..)
                .filter(|suffix| !suffix.is_empty())
                .ok_or_else(|| invalid(format!("NODE_KEY:{path}")))?;
            let kind = suffix[0];
            if namespace == J_CLAIM_NAMESPACE {
                let side = *suffix
                    .get(1)
                    .ok_or_else(|| invalid(format!("J_CLAIM_SIDE:{path}")))?;
                let logical_path = suffix
                    .get(2..)
                    .filter(|payload| !payload.is_empty())
                    .ok_or_else(|| invalid(format!("J_CLAIM_PATH:{path}")))?;
                j_claim_rows.push(JClaimPhysicalRow {
                    kind,
                    side,
                    path: logical_path.to_vec(),
                    value: decoded,
                });
            } else {
                let physical_path = suffix
                    .get(1..)
                    .ok_or_else(|| invalid(format!("NODE_PATH:{path}")))?;
                let logical_path = if kind == 0 {
                    unpack_radix16_path(physical_path).map_err(invalid)?
                } else {
                    physical_path.to_vec()
                };
                radix_rows.push(RadixPhysicalRow {
                    kind,
                    path: logical_path,
                    value: decoded,
                });
            }
        }
        if namespace == J_CLAIM_NAMESPACE {
            let roots = j_claim_roots.ok_or_else(|| invalid("J_CLAIM_ROOTS_MISSING"))?;
            values = restore_j_claim_rows(j_claim_rows, roots).map_err(invalid)?;
        } else {
            for decoded in restore_radix_leaf_rows(radix_rows).map_err(invalid)? {
                let row = array(&decoded, 4, "radixLeaf")?;
                values.push(tree_value(namespace, row, "radixLeaf")?);
            }
        }
        Ok(values)
    }

    pub fn rscore_checkpoint(
        &mut self,
        owner: [u8; 32],
    ) -> Result<Option<StoredRscoreCheckpoint>, RuntimeLevelDbError> {
        let meta_key = prefixed(&[KEY_RSCORE_CHECKPOINT], &owner);
        let Some(raw_meta) = self.database.get(&meta_key).map(|value| value.to_vec()) else {
            return Ok(None);
        };
        let meta = decode_storage_payload(&raw_meta)?;
        let meta = object(&meta, "meta")?;
        exact_fields(
            meta,
            &[
                "version",
                "ownerEntityId",
                "protocolFingerprint",
                "baseRevision",
                "revision",
                "accountsRoot",
                "signerDigest",
                "accountCount",
            ],
            "meta",
        )?;
        if meta.get("version").and_then(Value::as_u64) != Some(1)
            || hex32(
                &Value::String(text(&meta["ownerEntityId"], "owner")?.into()),
                "owner",
            )? != owner
        {
            return Err(invalid("META_ID"));
        }
        let base_revision = stored_u64(&meta["baseRevision"], "baseRevision")?;
        let revision = stored_u64(&meta["revision"], "revision")?;
        if base_revision != revision {
            return Err(invalid("META_BASE_REVISION"));
        }
        let account_count = meta["accountCount"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value <= 65_536)
            .ok_or_else(|| invalid("META_ACCOUNT_COUNT"))?;

        let account_prefix = prefixed(&[KEY_RSCORE_ACCOUNT], &owner);
        let account_keys = self
            .prefixed_rows(&account_prefix)?
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        let mut accounts = Vec::with_capacity(account_keys.len());
        let mut seen_accounts = std::collections::BTreeSet::new();
        for key in account_keys {
            let account: [u8; 32] = key
                .get(account_prefix.len()..)
                .and_then(|value| value.try_into().ok())
                .ok_or_else(|| invalid("ACCOUNT_KEY"))?;
            if !seen_accounts.insert(account) {
                return Err(invalid("ACCOUNT_DUPLICATE"));
            }
            let meta = self.required_bounded(&key)?;
            let meta = array(&meta, 3, "accountMeta")?;
            let leaf = typed_bytes(&meta[0], "accountMeta.leaf")?;
            if leaf.len() != 32 {
                return Err(invalid("ACCOUNT_LEAF"));
            }
            let mut row = Vec::with_capacity(10);
            row.push(tagged_bytes(&account));
            row.push(meta[0].clone());
            row.push(meta[1].clone());
            let j_claim_roots = j_claim_accumulators(&meta[1]).map_err(invalid)?;
            for namespace in TREE_NAMESPACES {
                row.push(Value::Array(
                    self.rscore_tree_values(&owner, &account, namespace, None)?,
                ));
            }
            row.push(Value::Array(self.rscore_tree_values(
                &owner,
                &account,
                J_CLAIM_NAMESPACE,
                Some(&j_claim_roots),
            )?));
            row.push(meta[2].clone());
            accounts.push(Value::Array(row));
        }
        let node_prefix = prefixed(&[KEY_RSCORE_ACCOUNT_NODE], &owner);
        for (key, _) in self.prefixed_rows(&node_prefix)? {
            let account = key
                .get(node_prefix.len()..node_prefix.len() + 32)
                .and_then(|value| <[u8; 32]>::try_from(value).ok())
                .ok_or_else(|| invalid("ACCOUNT_NODE_KEY"))?;
            if !seen_accounts.contains(&account) {
                return Err(invalid("ACCOUNT_NODE_ORPHAN"));
            }
        }
        if accounts.len() != account_count {
            return Err(invalid(format!(
                "ACCOUNT_COUNT:expected={account_count}:actual={}",
                accounts.len()
            )));
        }
        Ok(Some(StoredRscoreCheckpoint {
            owner_entity_id: owner,
            protocol_fingerprint: hex32(&meta["protocolFingerprint"], "fingerprint")?,
            base_revision,
            revision,
            accounts_root: hex32(&meta["accountsRoot"], "accountsRoot")?,
            signer_digest: hex32(&meta["signerDigest"], "signerDigest")?,
            account_count,
            accounts,
        }))
    }
}
