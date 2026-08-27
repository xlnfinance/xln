//! Exact flat Runtime outbox rows keyed by height and output index.

use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::{KEY_RUNTIME_OUTPUT_ROW, RuntimeLevelDbError, RuntimeWalReader, hex, parse_digest};

const OUTBOX_DIGEST_DOMAIN: &[u8] = b"xln.runtime.outbox.v1";
const MAX_RUNTIME_OUTPUT_ROWS: usize = 10_000;

fn row_key(height: u64, index: usize) -> Result<[u8; 13], RuntimeLevelDbError> {
    let index = u32::try_from(index)
        .map_err(|_| RuntimeLevelDbError::Output(format!("OUTPUT_INDEX:{index}")))?;
    let mut key = [0_u8; 13];
    key[0] = KEY_RUNTIME_OUTPUT_ROW;
    key[1..9].copy_from_slice(&height.to_be_bytes());
    key[9..13].copy_from_slice(&index.to_be_bytes());
    Ok(key)
}

fn verify_output_digest(actual: [u8; 32], expected_text: &str) -> Result<(), RuntimeLevelDbError> {
    let expected = parse_digest(expected_text)?;
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeLevelDbError::Digest {
            expected: format!("0x{}", hex(&expected)),
            actual: format!("0x{}", hex(&actual)),
        })
    }
}

fn account_inputs_in_tx(value: &Value, depth: usize) -> Result<u64, RuntimeLevelDbError> {
    if depth > 16 {
        return Err(RuntimeLevelDbError::Output(
            "OUTPUT_TX_NESTING_LIMIT".into(),
        ));
    }
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_TX_OBJECT".into()))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_TX_TYPE".into()))?;
    let own = u64::from(kind == "accountInput");
    let Some(data) = object.get("data").and_then(Value::as_object) else {
        return Ok(own);
    };
    let children = match kind {
        "entityCommand" => data.get("txs"),
        "runtimeOutput" => data.get("entityTxs"),
        "propose" => data
            .get("action")
            .and_then(Value::as_object)
            .filter(|action| {
                action.get("type").and_then(Value::as_str) == Some("entity_transaction")
            })
            .and_then(|action| action.get("data"))
            .and_then(Value::as_object)
            .and_then(|action| action.get("txs")),
        _ => None,
    };
    let Some(children) = children else {
        return Ok(own);
    };
    children
        .as_array()
        .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_TX_CHILDREN".into()))?
        .iter()
        .try_fold(own, |count, child| {
            count
                .checked_add(account_inputs_in_tx(child, depth + 1)?)
                .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_INPUT_COUNT_OVERFLOW".into()))
        })
}

pub fn account_input_count(outputs: &[Value]) -> Result<u64, RuntimeLevelDbError> {
    outputs.iter().try_fold(0_u64, |count, output| {
        let txs = output
            .as_object()
            .and_then(|value| value.get("entityTxs"))
            .map(|value| {
                value
                    .as_array()
                    .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_ENTITY_TXS".into()))
            })
            .transpose()?
            .map(Vec::as_slice)
            .unwrap_or_default();
        txs.iter().try_fold(count, |nested, tx| {
            nested
                .checked_add(account_inputs_in_tx(tx, 0)?)
                .ok_or_else(|| RuntimeLevelDbError::Output("OUTPUT_INPUT_COUNT_OVERFLOW".into()))
        })
    })
}

impl RuntimeWalReader {
    pub fn runtime_output_account_inputs(
        &mut self,
        height: u64,
        count: usize,
        expected_digest: &str,
    ) -> Result<u64, RuntimeLevelDbError> {
        account_input_count(&self.runtime_outputs(height, count, expected_digest)?)
    }

    pub fn runtime_outputs(
        &mut self,
        height: u64,
        count: usize,
        expected_digest: &str,
    ) -> Result<Vec<Value>, RuntimeLevelDbError> {
        self.runtime_output_bytes(height, count, expected_digest)?
            .into_iter()
            .map(|bytes| crate::decode_storage_payload(&bytes).map_err(Into::into))
            .collect()
    }

    pub(crate) fn runtime_output_bytes(
        &mut self,
        height: u64,
        count: usize,
        expected_digest: &str,
    ) -> Result<Vec<Vec<u8>>, RuntimeLevelDbError> {
        if count > MAX_RUNTIME_OUTPUT_ROWS {
            return Err(RuntimeLevelDbError::Output(format!(
                "OUTPUT_COUNT_MAX:{count}"
            )));
        }
        let mut digest = Sha256::new();
        digest.update(OUTBOX_DIGEST_DOMAIN);
        digest.update(
            u32::try_from(count)
                .map_err(|_| RuntimeLevelDbError::Output(format!("OUTPUT_COUNT:{count}")))?
                .to_be_bytes(),
        );
        let mut outputs = Vec::with_capacity(count);
        for index in 0..count {
            let bytes = self.required_bounded_bytes(&row_key(height, index)?)?;
            let length = u32::try_from(bytes.len()).map_err(|_| {
                RuntimeLevelDbError::Output(format!("OUTPUT_BYTES_MAX:{}", bytes.len()))
            })?;
            digest.update(length.to_be_bytes());
            digest.update(&bytes);
            crate::decode_storage_payload(&bytes)?;
            outputs.push(bytes);
        }
        verify_output_digest(digest.finalize().into(), expected_digest)?;
        Ok(outputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_input_counter_walks_only_canonical_nested_entity_transactions() {
        let output = serde_json::json!({
            "entityTxs": [{
                "type": "runtimeOutput",
                "data": { "entityTxs": [{ "type": "accountInput", "data": {} }] }
            }]
        });
        assert_eq!(account_input_count(&[output]).expect("count"), 1);
    }

    #[test]
    fn canonical_prefixed_runtime_output_digest_compares_as_raw_bytes() {
        let actual = [0xab_u8; 32];
        let expected = format!("0x{}", hex(&actual));
        verify_output_digest(actual, &expected).expect("canonical digest");
        assert!(matches!(
            verify_output_digest(actual, &expected[2..]),
            Err(RuntimeLevelDbError::Output(detail)) if detail == "DIGEST"
        ));
    }
}
