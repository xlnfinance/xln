use rlp::{Rlp, RlpStream};
use serde_json::Value;
use sha3::{Digest, Keccak256};

use super::{bytes, number};

fn rlp_data(node: &Rlp<'_>, index: usize) -> Result<Vec<u8>, String> {
    node.at(index)
        .and_then(|item| item.data())
        .map(Vec::from)
        .map_err(|_| "J_AUTHORITY_RECEIPT_RLP".into())
}

/// Verify the Ethereum receipt MPT path using its RLP transaction index.
/// Inline nodes bind to their exact parent bytes; hashed nodes bind to Keccak.
/// A witness never substitutes for this proof on an Ethereum jurisdiction.
fn verify_path(root: &[u8], index: u64, receipt: &[u8], proof: &[Vec<u8>]) -> Result<(), String> {
    let mut stream = RlpStream::new();
    stream.append(&index);
    let key: Vec<u8> = stream
        .out()
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 15])
        .collect();
    let mut offset = 0;
    let mut reference = root.to_vec();
    for _ in 0..=128 {
        let encoded = if reference.len() == 32 {
            proof
                .iter()
                .find(|node| Keccak256::digest(node).as_slice() == reference)
                .ok_or("J_AUTHORITY_RECEIPT_PROOF_NODE_MISSING")?
                .clone()
        } else if reference.len() < 32 && !reference.is_empty() {
            reference.clone()
        } else {
            return Err("J_AUTHORITY_RECEIPT_REFERENCE".into());
        };
        let node = Rlp::new(&encoded);
        let count = node.item_count().map_err(|_| "J_AUTHORITY_RECEIPT_NODE")?;
        let child = match count {
            17 => {
                if offset == key.len() {
                    return (rlp_data(&node, 16)? == receipt)
                        .then_some(())
                        .ok_or("J_AUTHORITY_RECEIPT_VALUE".into());
                }
                let child = node
                    .at(usize::from(key[offset]))
                    .map_err(|_| "J_AUTHORITY_RECEIPT_BRANCH")?;
                offset += 1;
                child
            }
            2 => {
                let compact = rlp_data(&node, 0)?;
                let first = *compact.first().ok_or("J_AUTHORITY_RECEIPT_PATH")?;
                let flag = first >> 4;
                if flag > 3 || (flag & 1 == 0 && first & 15 != 0) {
                    return Err("J_AUTHORITY_RECEIPT_PATH".into());
                }
                let mut path = Vec::new();
                if flag & 1 != 0 {
                    path.push(first & 15);
                }
                path.extend(compact[1..].iter().flat_map(|byte| [byte >> 4, byte & 15]));
                if !key[offset..].starts_with(&path) {
                    return Err("J_AUTHORITY_RECEIPT_PATH_MISMATCH".into());
                }
                offset += path.len();
                if flag & 2 != 0 {
                    return (offset == key.len() && rlp_data(&node, 1)? == receipt)
                        .then_some(())
                        .ok_or("J_AUTHORITY_RECEIPT_VALUE".into());
                }
                if path.is_empty() {
                    return Err("J_AUTHORITY_RECEIPT_EMPTY_EXTENSION".into());
                }
                node.at(1).map_err(|_| "J_AUTHORITY_RECEIPT_EXTENSION")?
            }
            _ => return Err("J_AUTHORITY_RECEIPT_NODE_SHAPE".into()),
        };
        reference = if child.is_list() {
            child.as_raw().to_vec()
        } else {
            child
                .data()
                .map_err(|_| "J_AUTHORITY_RECEIPT_CHILD")?
                .to_vec()
        };
    }
    Err("J_AUTHORITY_RECEIPT_PROOF_DEPTH".into())
}

pub(super) fn verify(value: &Value) -> Result<(), String> {
    let root = bytes(value, "receiptsRoot", 32, 32)?;
    if root.iter().all(|byte| *byte == 0) {
        return Err("J_AUTHORITY_UNCOMMITTED_RECEIPT".into());
    }
    let encoded = bytes(value, "encodedReceipt", 0, 1_048_576)?;
    let nodes = value["receiptProofNodes"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 128)
        .ok_or("J_AUTHORITY_PROOF_NODE_COUNT")?;
    let proof = nodes
        .iter()
        .map(|node| bytes(&serde_json::json!({"node":node}), "node", 0, 1_048_576))
        .collect::<Result<Vec<_>, _>>()?;
    if proof.iter().map(Vec::len).sum::<usize>() > 2_097_152 {
        return Err("J_AUTHORITY_PROOF_OVERSIZED".into());
    }
    verify_path(&root, number(value, "transactionIndex")?, &encoded, &proof)?;
    let payload = if encoded.first().is_some_and(|byte| *byte <= 0x7f) {
        &encoded[1..]
    } else {
        &encoded
    };
    let receipt = Rlp::new(payload);
    if receipt
        .item_count()
        .map_err(|_| "J_AUTHORITY_RECEIPT_SHAPE")?
        != 4
    {
        return Err("J_AUTHORITY_RECEIPT_SHAPE".into());
    }
    let logs = receipt.at(3).map_err(|_| "J_AUTHORITY_RECEIPT_LOGS")?;
    let index = usize::try_from(number(value, "receiptLogIndex")?)
        .map_err(|_| "J_AUTHORITY_RECEIPT_LOG_INDEX")?;
    let log = logs
        .at(index)
        .map_err(|_| "J_AUTHORITY_RECEIPT_LOG_MISSING")?;
    if log.item_count().map_err(|_| "J_AUTHORITY_RECEIPT_LOG")? != 3 {
        return Err("J_AUTHORITY_RECEIPT_LOG".into());
    }
    let topics = log.at(1).map_err(|_| "J_AUTHORITY_RECEIPT_TOPICS")?;
    let expected = value["topics"].as_array().ok_or("J_AUTHORITY_TOPICS")?;
    if rlp_data(&log, 0)? != bytes(value, "emitter", 20, 20)?
        || rlp_data(&log, 2)? != bytes(value, "data", 0, 65_536)?
        || topics
            .item_count()
            .map_err(|_| "J_AUTHORITY_RECEIPT_TOPICS")?
            != expected.len()
    {
        return Err("J_AUTHORITY_RECEIPT_LOG_MISMATCH".into());
    }
    for (index, topic) in expected.iter().enumerate() {
        if rlp_data(&topics, index)? != bytes(&serde_json::json!({"topic":topic}), "topic", 32, 32)?
        {
            return Err("J_AUTHORITY_RECEIPT_TOPIC_MISMATCH".into());
        }
    }
    Ok(())
}
