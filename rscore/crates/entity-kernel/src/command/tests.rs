use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::*;
use crate::{ConsensusMode, EntityConsensusConfig, EntityFrameAuthority, EntityLeaderState};

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("number"))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn command_fixture() -> CanonicalValue {
    let signer = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
    let inner = object(vec![
        ("type", CanonicalValue::String("directPayment".into())),
        (
            "data",
            object(vec![
                (
                    "targetEntityId",
                    CanonicalValue::String(format!("0x{}", "22".repeat(32))),
                ),
                ("tokenId", number(1)),
                ("amount", CanonicalValue::BigInt(7.into())),
                (
                    "route",
                    CanonicalValue::Array(vec![
                        CanonicalValue::String(format!("0x{}", "33".repeat(32))),
                        CanonicalValue::String(format!("0x{}", "44".repeat(32))),
                    ]),
                ),
                ("deliveryMode", CanonicalValue::String("direct".into())),
            ]),
        ),
    ]);
    let proposal = object(vec![
        ("type", CanonicalValue::String("propose".into())),
        ("data", object(vec![
            ("proposer", CanonicalValue::String(signer.into())),
            ("action", object(vec![
                ("type", CanonicalValue::String("entity_transaction".into())),
                ("data", object(vec![
                    ("version", number(1)),
                    ("actionHash", CanonicalValue::String("0x7ca0ea9185fd57834be814ca4298d0f823d38d679ce431c4e24ff2aa85aca82c".into())),
                    ("txs", CanonicalValue::Array(vec![inner])),
                ])),
            ])),
        ])),
    ]);
    object(vec![
        ("version", number(1)),
        ("entityId", CanonicalValue::String("0xc2a0d9cd6291049ac6e77327a00d94638bface4c078a7db5c9fd68ef57d19a64".into())),
        ("stackKey", CanonicalValue::String(UNREGISTERED_ENTITY_COMMAND_STACK_KEY.into())),
        ("boardHash", CanonicalValue::String("0xc2a0d9cd6291049ac6e77327a00d94638bface4c078a7db5c9fd68ef57d19a64".into())),
        ("boardEpoch", number(0)),
        ("authorSignerId", CanonicalValue::String(signer.into())),
        ("authorSigner", CanonicalValue::String(signer.into())),
        ("nonce", CanonicalValue::BigInt(1.into())),
        ("txsHash", CanonicalValue::String("0xc72efd1014a417642268a02845a60326d1ed9fe49933e544e1c919f96acc730d".into())),
        ("txs", CanonicalValue::Array(vec![proposal])),
        ("signature", CanonicalValue::String("0xa7ad68af0d76f62efc300c8b58c54e95b23730a3d84dd63196c51360fa261d6d55d704eeadda557ea2359c4eb249956160f3b9783d118a0625b6c89b3a5815c400".into())),
    ])
}

fn authority() -> EntityFrameAuthority {
    let signer = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a".to_string();
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer.clone()],
            shares: BTreeMap::from([(signer.clone(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer,
            view: 0,
            changed_at_height: 0,
        },
    }
}

#[test]
fn matches_typescript_signed_command_vector_and_nonce_rules() {
    let command = decode_signed_entity_command(&command_fixture()).expect("command");
    assert_eq!(
        command.command_hash,
        "0x82dfb7f3999b4b734105311ff1f71a5f26f87923062dede8087791eb2e66850b"
    );
    assert_eq!(command.native_txs.len(), 1);
    assert_eq!(
        current_entity_command_board_hash(&authority(), &command.author_signer).expect("board"),
        command.board_hash
    );
    let (board, disposition) = assert_signed_entity_command(
        &command.entity_id,
        &authority(),
        &command.author_signer,
        0,
        UNREGISTERED_ENTITY_COMMAND_STACK_KEY,
        None,
        &command,
    )
    .expect("verified");
    assert_eq!(disposition, EntityCommandDisposition::Next);
    let mut state = None;
    advance_entity_command_nonce(&mut state, &board, &command).expect("advance");
    assert_eq!(
        get_entity_command_disposition(state.as_ref(), &command).expect("retry"),
        EntityCommandDisposition::Retry
    );
}

#[test]
fn cancellation_gap_and_signature_encoding_are_strict() {
    let command = decode_signed_entity_command(&command_fixture()).expect("command");
    let state = EntityCommandNonceState {
        version: 1,
        board_hash: command.board_hash.clone(),
        board_epoch: 0,
        by_signer: BTreeMap::from([(
            command.author_signer_id.clone(),
            EntityCommandNonceRecord {
                nonce: 1.into(),
                command_hash: format!("0x{}", "11".repeat(32)),
            },
        )]),
    };
    assert_eq!(
        get_entity_command_disposition(Some(&state), &command).expect("cancel"),
        EntityCommandDisposition::Cancel
    );
    let mut gap = command.clone();
    gap.nonce = BigInt::from(3_u8);
    assert!(
        get_entity_command_disposition(Some(&state), &gap)
            .expect_err("gap")
            .to_string()
            .contains("ENTITY_COMMAND_NONCE_MISMATCH:3:2")
    );
    let mut invalid_v = command_fixture();
    let CanonicalValue::Object(fields) = &mut invalid_v else {
        unreachable!()
    };
    let signature = fields
        .iter_mut()
        .find(|(key, _)| key == "signature")
        .expect("signature");
    let CanonicalValue::String(value) = &mut signature.1 else {
        unreachable!()
    };
    value.replace_range(value.len() - 2.., "1b");
    assert!(
        decode_signed_entity_command(&invalid_v)
            .expect_err("v=27")
            .to_string()
            .contains("SIGNATURE_INVALID")
    );
}
