//! Canonical Account checkpoint wire values shared by persistence and process ABI.
//!
//! `AccountCheckpointRows` is authored by this crate, so its positional value
//! encoder lives here as well. Persistence and process transport must never
//! grow independent copies: a byte difference would make a checkpoint that
//! one native path can write but another cannot restore.

mod account_tx;
mod canonical;
mod nodes;
mod rows;
mod state_value;

use thiserror::Error;

pub use account_tx::{encode_account_tx, encode_bigint, encode_delta, encode_j_claim_node};
pub use canonical::encode_account_envelope;
pub use nodes::{
    AccountCheckpointNamespace, EncodedAccountCheckpointNodeAddress,
    EncodedAccountCheckpointNodeMutation, EncodedAccountCheckpointNodes,
    EncodedAccountCheckpointTreeChanges, EncodedAccountJClaimChanges, EncodedAccountJClaimNodePut,
    encode_account_checkpoint_nodes,
};
pub use rows::encode_account_checkpoint_rows;

#[derive(Debug, Error)]
pub enum AccountWireEncodeError {
    #[error("RSCORE_ACCOUNT_WIRE_EXPECTED:{0}")]
    Expected(&'static str),
    #[error("RSCORE_ACCOUNT_WIRE_UNSUPPORTED:{0}")]
    Unsupported(String),
    #[error("RSCORE_ACCOUNT_WIRE_STATE:{0}")]
    State(#[from] xln_rscore_engine::StateError),
}

pub(super) fn tuple(fields: Vec<xln_rscore_abi::AbiValue>) -> xln_rscore_abi::AbiValue {
    xln_rscore_abi::AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields))
}

pub(super) fn integer(value: impl TryInto<i128>) -> xln_rscore_abi::AbiValue {
    // All callers supply protocol integers no wider than u64. This conversion
    // is therefore infallible on every supported target; keeping it here
    // prevents scattered numeric casts from becoming a wire-format choice.
    let Ok(value) = value.try_into() else {
        unreachable!("protocol wire integer exceeds i128")
    };
    xln_rscore_abi::AbiValue::Integer(value)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use xln_rscore_abi::AbiValue;
    use xln_rscore_engine::{AccountTx, DeliveryMode, TokenId};

    use super::{encode_account_tx, tuple};

    #[test]
    fn canonical_account_tx_encoder_is_owned_below_process() {
        let tx = AccountTx::DirectPayment {
            token_id: TokenId::new(7).expect("token"),
            amount: BigInt::from(11),
            route: vec!["a".to_owned(), "b".to_owned()],
            description: None,
            from_entity_id: "left".to_owned(),
            to_entity_id: "right".to_owned(),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        };
        assert_eq!(
            encode_account_tx(&tx).expect("encode"),
            tuple(vec![
                AbiValue::Integer(0),
                AbiValue::Integer(7),
                AbiValue::Text("11".to_owned()),
                tuple(vec![
                    AbiValue::Text("a".to_owned()),
                    AbiValue::Text("b".to_owned()),
                ]),
                AbiValue::Nil,
                AbiValue::Text("left".to_owned()),
                AbiValue::Text("right".to_owned()),
                AbiValue::Integer(0),
                AbiValue::Nil,
            ]),
        );
    }
}
