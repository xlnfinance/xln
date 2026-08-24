//! The signed account frame: what a proposer commits and what its peer acks.
//!
//! Parity target: `computeCanonicalAccountFrameHash`
//! (core/account/consensus/frame/hash.ts). Four entries under the
//! `account.frame` namespace — the transition header, the canonical
//! transactions, the frame's deltas, and the account state root — combined by
//! the same flat integrity root the account state itself uses.

use xln_rscore_protocol::{CanonicalValue, compute_flat_integrity_root};

use crate::{Delta, StateError};

const ACCOUNT_FRAME_NAMESPACE: &str = "account.frame";
/// The first frame of an account chains to this literal, not to a hash.
pub const GENESIS_PREV_FRAME_HASH: &str = "genesis";

/// A frame as it is hashed and signed. `state_hash` is the result of hashing
/// the other fields, so it is never part of its own preimage.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountFrame {
    pub height: u64,
    pub timestamp: u64,
    pub j_height: u64,
    /// Canonical `{type, data}` form of each transaction, in frame order.
    pub txs: Vec<CanonicalValue>,
    pub prev_frame_hash: String,
    pub account_state_root: [u8; 32],
    pub by_left: bool,
    pub deltas: Vec<Delta>,
}

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(value as f64)
}

fn delta_value(delta: &Delta) -> CanonicalValue {
    let mut fields = vec![(
        "tokenId".to_string(),
        CanonicalValue::Number(f64::from(delta.token_id().get())),
    )];
    fields.extend(
        delta
            .commitment_fields()
            .map(|(name, value)| (name.to_string(), CanonicalValue::BigInt(value))),
    );
    CanonicalValue::Object(fields)
}

impl AccountFrame {
    /// The frame's `stateHash`: what the proposer signs and the peer verifies.
    pub fn hash(&self) -> Result<[u8; 32], StateError> {
        let transition = CanonicalValue::Object(vec![
            ("height".into(), number(self.height)),
            ("timestamp".into(), number(self.timestamp)),
            ("jHeight".into(), number(self.j_height)),
            (
                "prevFrameHash".into(),
                CanonicalValue::String(self.prev_frame_hash.clone()),
            ),
            ("byLeft".into(), CanonicalValue::Bool(self.by_left)),
        ]);
        let entries = vec![
            ("transition".to_string(), transition),
            (
                "transactions".to_string(),
                CanonicalValue::Array(self.txs.clone()),
            ),
            (
                "deltas".to_string(),
                CanonicalValue::Array(self.deltas.iter().map(delta_value).collect()),
            ),
            (
                "accountStateRoot".to_string(),
                CanonicalValue::String(crate::state::identity::render_hex(
                    &self.account_state_root,
                )),
            ),
        ];
        compute_flat_integrity_root(ACCOUNT_FRAME_NAMESPACE, &entries)
            .map_err(|error| StateError::AccountStateRoot(error.to_string()))
    }
}

/// Canonical `{type, data}` of one transaction, the form the frame hash and
/// the mempool root both commit.
///
/// Parity target: `canonicalAccountTxForFrameHash` in the same TypeScript
/// file. Optional fields are omitted, never encoded as null: TypeScript drops
/// `undefined` object entries before hashing.
pub fn canonical_tx_value(tx: &crate::AccountTx) -> CanonicalValue {
    use crate::AccountTx;
    let (kind, data) = match tx {
        AccountTx::DirectPayment {
            token_id,
            amount,
            route,
            description,
            from_entity_id,
            to_entity_id,
            delivery_mode,
            trusted_gateway_entity_id,
        } => {
            let mut fields = vec![
                (
                    "tokenId".to_string(),
                    CanonicalValue::Number(f64::from(token_id.get())),
                ),
                ("amount".to_string(), CanonicalValue::BigInt(amount.clone())),
                (
                    "route".to_string(),
                    CanonicalValue::Array(
                        route
                            .iter()
                            .map(|hop| CanonicalValue::String(hop.clone()))
                            .collect(),
                    ),
                ),
            ];
            if let Some(description) = description {
                fields.push((
                    "description".to_string(),
                    CanonicalValue::String(description.clone()),
                ));
            }
            fields.push((
                "fromEntityId".to_string(),
                CanonicalValue::String(from_entity_id.clone()),
            ));
            fields.push((
                "toEntityId".to_string(),
                CanonicalValue::String(to_entity_id.clone()),
            ));
            fields.push((
                "deliveryMode".to_string(),
                CanonicalValue::String(
                    match delivery_mode {
                        crate::DeliveryMode::Direct => "direct",
                        crate::DeliveryMode::Trusted => "trusted",
                    }
                    .to_string(),
                ),
            ));
            if let Some(gateway) = trusted_gateway_entity_id {
                fields.push((
                    "trustedGatewayEntityId".to_string(),
                    CanonicalValue::String(gateway.clone()),
                ));
            }
            ("direct_payment", fields)
        }
        _ => return CanonicalValue::Null,
    };
    CanonicalValue::Object(vec![
        ("type".to_string(), CanonicalValue::String(kind.to_string())),
        ("data".to_string(), CanonicalValue::Object(data)),
    ])
}

/// Big-endian helper for callers that hold a hex account state root.
pub fn parse_root_hex(value: &str) -> Option<[u8; 32]> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.len() != 64 {
        return None;
    }
    let mut out = [0_u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;

    use super::*;
    use crate::{AccountTx, DeliveryMode, TokenId};

    /// Vector produced by `computeFrameHash`
    /// (core/account/consensus/frame/hash.ts) over the same frame.
    #[test]
    fn matches_typescript_frame_hash_vector() {
        let token = TokenId::new(1).expect("token");
        let delta = Delta::new(
            token,
            BigInt::from(1_000_000),
            BigInt::from(0),
            BigInt::from(-5),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
        )
        .expect("delta");
        let tx = AccountTx::DirectPayment {
            token_id: token,
            amount: BigInt::from(5),
            route: vec![format!("0x{}", "aa".repeat(32))],
            description: Some("frame-vector".into()),
            from_entity_id: format!("0x{}", "bb".repeat(32)),
            to_entity_id: format!("0x{}", "aa".repeat(32)),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        };
        let frame = AccountFrame {
            height: 1,
            timestamp: 1_700_000_000_000,
            j_height: 7,
            txs: vec![canonical_tx_value(&tx)],
            prev_frame_hash: GENESIS_PREV_FRAME_HASH.into(),
            account_state_root: parse_root_hex(&format!("0x{}", "cd".repeat(32)))
                .expect("state root"),
            by_left: false,
            deltas: vec![delta],
        };
        assert_eq!(
            hex::encode(frame.hash().expect("frame hash")),
            "924ebfa860055183b8a45e1555308cf206bf8fa9962d9cbd431c796ec8791210",
        );
    }
}
