//! Raw Account-output publication.
//!
//! AccountInput is authorized by bilateral Account Hankos and is emitted raw
//! after Runtime WAL fsync. Generic mutating cross-Entity outputs are outside
//! the native Runtime feature set and must fail before reaching this module.

use std::collections::BTreeMap;

use thiserror::Error;
use xln_rscore_batch::{AccountInputKind, AccountPeerInput};

use super::frame::HashType;

/// Exact Entity-local output before Runtime binds validator/runtime routing.
/// This is the Rust equivalent of TS `EntityOutput`: target Entity plus one
/// or more typed Entity transactions, with no transport fields mixed in.
#[derive(Clone, Debug)]
pub struct LocalEntityOutput {
    pub entity_id: String,
    pub entity_txs: Vec<LocalEntityOutputTx>,
}

#[derive(Clone, Debug)]
pub enum LocalEntityOutputTx {
    AccountInput(AccountPeerInput),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityHankoWitness {
    pub kind: HashType,
    pub hanko: Vec<u8>,
}

pub type EntityHankoWitnessMap = BTreeMap<String, EntityHankoWitness>;

fn bytes32_text(bytes: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

impl LocalEntityOutput {
    pub fn non_mutating_wake(entity_id: String) -> Self {
        Self {
            entity_id,
            entity_txs: Vec::new(),
        }
    }

    pub fn account_input(
        mut input: AccountPeerInput,
        witnesses: &EntityHankoWitnessMap,
    ) -> Result<Self, EntityOutputError> {
        attach_account_input_hankos(&mut input, witnesses)?;
        Ok(Self {
            entity_id: bytes32_text(&input.envelope.to_entity_id),
            entity_txs: vec![LocalEntityOutputTx::AccountInput(input)],
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityOutputError {
    #[error("ACCOUNT_OUTPUT_HANKO_WITNESS_MISSING:{kind}:{hash}")]
    AccountHankoMissing { kind: &'static str, hash: String },
    #[error("ACCOUNT_OUTPUT_HANKO_WITNESS_TYPE:{hash}:expected={expected}:actual={actual:?}")]
    AccountHankoType {
        hash: String,
        expected: &'static str,
        actual: HashType,
    },
    #[error("ACCOUNT_OUTPUT_HANKO_WITNESS_MISMATCH:{kind}:{hash}")]
    AccountHankoMismatch { kind: &'static str, hash: String },
}

fn require_account_hanko<'a>(
    witnesses: &'a EntityHankoWitnessMap,
    digest: &[u8; 32],
    expected: HashType,
    label: &'static str,
) -> Result<&'a [u8], EntityOutputError> {
    let hash = bytes32_text(digest);
    let witness = witnesses
        .get(&hash)
        .ok_or_else(|| EntityOutputError::AccountHankoMissing {
            kind: label,
            hash: hash.clone(),
        })?;
    if witness.kind != expected {
        return Err(EntityOutputError::AccountHankoType {
            hash,
            expected: label,
            actual: witness.kind.clone(),
        });
    }
    Ok(&witness.hanko)
}

fn attach_or_assert_hanko(
    current: &mut Option<Vec<u8>>,
    witness: &[u8],
    digest: &[u8; 32],
    label: &'static str,
) -> Result<(), EntityOutputError> {
    match current {
        Some(existing) if existing.as_slice() != witness => {
            Err(EntityOutputError::AccountHankoMismatch {
                kind: label,
                hash: bytes32_text(digest),
            })
        }
        Some(_) => Ok(()),
        None => {
            *current = Some(witness.to_vec());
            Ok(())
        }
    }
}

fn attach_frame_hankos(
    frame: &mut xln_rscore_engine::IncomingFrame,
    witnesses: &EntityHankoWitnessMap,
) -> Result<(), EntityOutputError> {
    let frame_hanko = require_account_hanko(
        witnesses,
        &frame.state_hash,
        HashType::AccountFrame,
        "accountFrame",
    )?;
    attach_or_assert_hanko(
        &mut frame.frame_hanko,
        frame_hanko,
        &frame.state_hash,
        "accountFrame",
    )?;
    if let Some(dispute) = &mut frame.dispute {
        let dispute_hanko =
            require_account_hanko(witnesses, &dispute.hash, HashType::Dispute, "dispute")?;
        attach_or_assert_hanko(&mut dispute.hanko, dispute_hanko, &dispute.hash, "dispute")?;
    }
    Ok(())
}

fn attach_ack_hankos(
    ack: &mut xln_rscore_engine::IncomingAck,
    witnesses: &EntityHankoWitnessMap,
) -> Result<(), EntityOutputError> {
    let frame_hash = bytes32_text(&ack.frame_hash);
    if let Some(witness) = witnesses.get(&frame_hash) {
        if witness.kind != HashType::AccountFrame {
            return Err(EntityOutputError::AccountHankoType {
                hash: frame_hash,
                expected: "accountFrame",
                actual: witness.kind.clone(),
            });
        }
        attach_or_assert_hanko(
            &mut ack.frame_hanko,
            &witness.hanko,
            &ack.frame_hash,
            "accountFrame",
        )?;
    } else if ack.frame_hanko.as_ref().is_none_or(Vec::is_empty) {
        return Err(EntityOutputError::AccountHankoMissing {
            kind: "accountFrame",
            hash: frame_hash,
        });
    }

    if let Some(dispute) = &mut ack.dispute {
        attach_dispute_hanko(dispute, witnesses)?;
    }
    Ok(())
}

fn attach_dispute_hanko(
    dispute: &mut xln_rscore_engine::CounterpartyDispute,
    witnesses: &EntityHankoWitnessMap,
) -> Result<(), EntityOutputError> {
    let dispute_hash = bytes32_text(&dispute.hash);
    if let Some(witness) = witnesses.get(&dispute_hash) {
        if witness.kind != HashType::Dispute {
            return Err(EntityOutputError::AccountHankoType {
                hash: dispute_hash,
                expected: "dispute",
                actual: witness.kind.clone(),
            });
        }
        attach_or_assert_hanko(&mut dispute.hanko, &witness.hanko, &dispute.hash, "dispute")?;
    } else if dispute.hanko.as_ref().is_none_or(Vec::is_empty) {
        return Err(EntityOutputError::AccountHankoMissing {
            kind: "dispute",
            hash: dispute_hash,
        });
    }
    Ok(())
}

fn attach_account_input_hankos(
    input: &mut AccountPeerInput,
    witnesses: &EntityHankoWitnessMap,
) -> Result<(), EntityOutputError> {
    match &mut input.kind {
        AccountInputKind::Frame(frame) => attach_frame_hankos(frame, witnesses),
        AccountInputKind::FrameAck { ack, frame } => {
            attach_ack_hankos(ack, witnesses)?;
            attach_frame_hankos(frame, witnesses)
        }
        AccountInputKind::Ack(ack) => attach_ack_hankos(ack, witnesses),
        AccountInputKind::Dispute(dispute) => attach_dispute_hanko(dispute, witnesses),
        AccountInputKind::BoardHankoRefresh(refresh) => {
            let frame_hash = bytes32_text(&refresh.frame_hash);
            if let Some(witness) = witnesses.get(&frame_hash) {
                if witness.kind != HashType::AccountFrame {
                    return Err(EntityOutputError::AccountHankoType {
                        hash: frame_hash,
                        expected: "accountFrame",
                        actual: witness.kind.clone(),
                    });
                }
                attach_or_assert_hanko(
                    &mut refresh.frame_hanko,
                    &witness.hanko,
                    &refresh.frame_hash,
                    "accountFrame",
                )?;
            } else if refresh.frame_hanko.as_ref().is_none_or(Vec::is_empty) {
                return Err(EntityOutputError::AccountHankoMissing {
                    kind: "accountFrame",
                    hash: frame_hash,
                });
            }
            if let Some(dispute) = &mut refresh.dispute {
                attach_dispute_hanko(dispute, witnesses)?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use xln_rscore_batch::AccountInputKind;
    use xln_rscore_engine::{
        AccountDisputeConfig, AccountDomain, AccountFrame, AccountPeerEnvelope,
        CounterpartyDispute, DepositoryAddress, IncomingFrame, WatchSeed,
    };

    use super::*;

    #[test]
    fn account_output_receives_the_current_frame_and_dispute_hankos() {
        let frame_hash = [0x11_u8; 32];
        let dispute_hash = [0x22_u8; 32];
        let frame_hanko = vec![0x31, 0x32];
        let dispute_hanko = vec![0x41, 0x42];
        let input = AccountPeerInput {
            envelope: AccountPeerEnvelope {
                from_entity_id: [0xaa; 32],
                to_entity_id: [0xbb; 32],
                domain: AccountDomain::new(
                    1,
                    DepositoryAddress::parse(&format!("0x{}", "cc".repeat(20)))
                        .expect("depository"),
                )
                .expect("domain"),
                dispute_config: AccountDisputeConfig::new(10, 20).expect("dispute config"),
                watch_seed: Some(
                    WatchSeed::parse(&format!("0x{}", "dd".repeat(32))).expect("watch seed"),
                ),
            },
            kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                frame: AccountFrame {
                    height: 1,
                    timestamp: 2,
                    j_height: 3,
                    txs: Vec::new(),
                    prev_frame_hash: "genesis".into(),
                    account_state_root: [0xee; 32],
                },
                state_hash: frame_hash,
                frame_hanko: Some(frame_hanko.clone()),
                dispute: Some(CounterpartyDispute {
                    hanko: None,
                    hash: dispute_hash,
                    proof_body_hash: [0x23; 32],
                    nonce: 4,
                    proposer_is_left: true,
                }),
            })),
        };
        let witnesses = EntityHankoWitnessMap::from([
            (
                bytes32_text(&frame_hash),
                EntityHankoWitness {
                    kind: HashType::AccountFrame,
                    hanko: frame_hanko,
                },
            ),
            (
                bytes32_text(&dispute_hash),
                EntityHankoWitness {
                    kind: HashType::Dispute,
                    hanko: dispute_hanko.clone(),
                },
            ),
        ]);
        let output = LocalEntityOutput::account_input(input, &witnesses).expect("certified output");
        let LocalEntityOutputTx::AccountInput(input) = &output.entity_txs[0];
        let AccountInputKind::Frame(frame) = &input.kind else {
            panic!("frame output");
        };
        assert_eq!(frame.frame_hanko.as_ref(), Some(&vec![0x31, 0x32]));
        assert_eq!(
            frame
                .dispute
                .as_ref()
                .and_then(|proof| proof.hanko.as_ref()),
            Some(&dispute_hanko),
        );
    }
}
