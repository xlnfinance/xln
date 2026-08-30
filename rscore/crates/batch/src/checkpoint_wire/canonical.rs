use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{AccountEnvelope, CanonicalValue};

use super::tuple;

pub fn encode_account_envelope(value: &AccountEnvelope) -> AbiValue {
    let fields = CanonicalValue::Object(value.fields().to_vec());
    tuple(vec![
        encode_canonical_value(&fields),
        tuple(value.mempool().iter().map(encode_canonical_value).collect()),
        tuple(
            value
                .rebalance_shadow_policy_rows()
                .into_iter()
                .map(|(token_id, policy)| {
                    tuple(vec![
                        AbiValue::Integer(i128::from(token_id)),
                        encode_canonical_value(&policy),
                    ])
                })
                .collect(),
        ),
        tuple(
            value
                .rebalance_shadow_submitted_rows()
                .into_iter()
                .map(|(token_id, timestamp)| {
                    tuple(vec![
                        AbiValue::Integer(i128::from(token_id)),
                        AbiValue::Integer(i128::from(timestamp)),
                    ])
                })
                .collect(),
        ),
    ])
}

pub fn encode_canonical_value(value: &CanonicalValue) -> AbiValue {
    match value {
        CanonicalValue::Null => tuple(vec![AbiValue::Integer(0)]),
        CanonicalValue::Bool(flag) => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Integer(i128::from(*flag)),
        ]),
        CanonicalValue::Number(number) => tuple(vec![
            AbiValue::Integer(2),
            AbiValue::Text(number.as_str().to_owned()),
        ]),
        CanonicalValue::BigInt(number) => tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Text(number.to_string()),
        ]),
        CanonicalValue::String(text) => {
            tuple(vec![AbiValue::Integer(4), AbiValue::Text(text.clone())])
        }
        CanonicalValue::Array(values) => tuple(vec![
            AbiValue::Integer(5),
            tuple(values.iter().map(encode_canonical_value).collect()),
        ]),
        CanonicalValue::Map(entries) => tuple(vec![
            AbiValue::Integer(6),
            tuple(
                entries
                    .iter()
                    .map(|(key, value)| {
                        tuple(vec![
                            encode_canonical_value(key),
                            encode_canonical_value(value),
                        ])
                    })
                    .collect(),
            ),
        ]),
        CanonicalValue::Set(values) => tuple(vec![
            AbiValue::Integer(7),
            tuple(values.iter().map(encode_canonical_value).collect()),
        ]),
        CanonicalValue::Object(entries) => tuple(vec![
            AbiValue::Integer(8),
            tuple(
                entries
                    .iter()
                    .map(|(key, value)| {
                        tuple(vec![
                            AbiValue::Text(key.clone()),
                            encode_canonical_value(value),
                        ])
                    })
                    .collect(),
            ),
        ]),
    }
}
