//! Exact inbound HTLC context materialization for the live Runtime path.

use std::collections::BTreeMap;
use std::time::Instant;

use num_bigint::BigInt;
use xln_rscore_batch::{AccountId, AccountInputKind};
use xln_rscore_engine::{
    AccountTx, HTLC_OPAQUE_CIPHERTEXT_VERSION, IncomingFrame, OpaqueHtlcCiphertext, TokenId,
};
use xln_rscore_entity_kernel::{
    DecodedOnionLayer, DecryptedHtlcLayer, HtlcMaterializeEnvironment, HtlcMaterializeInput,
    HtlcPreparedBinding, HtlcPreparedOutcome, PreparedAccountView, PreparedContextError,
    PreparedHtlcEntry, decrypt_htlc_materialize_inputs, materialize_decrypted_htlc_entries,
    required_htlc_account_tokens,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::{EntityInfraMaterializeRequest, FreshEntityContextError, InboundHtlcInfrastructure};

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::from("0x"), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn account_id(value: &str) -> Result<AccountId, FreshEntityContextError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| FreshEntityContextError::HtlcInfrastructureInvalid("ACCOUNT_ID".into()))?;
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| FreshEntityContextError::HtlcInfrastructureInvalid("ACCOUNT_ID".into()))?;
    }
    Ok(AccountId::from_bytes(bytes))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    let mut entries = entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    CanonicalValue::Object(entries)
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(value: u64) -> Result<CanonicalValue, FreshEntityContextError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| FreshEntityContextError::HtlcInfrastructureInvalid("NUMBER".into()))
}

fn bigint(value: &BigInt) -> CanonicalValue {
    CanonicalValue::BigInt(value.clone())
}

fn collect_frame(
    row: &xln_rscore_batch::AccountInputRow,
    frame: &IncomingFrame,
    output: &mut Vec<HtlcMaterializeInput>,
) {
    for tx in &frame.frame.txs {
        let AccountTx::HtlcLock(lock) = tx else {
            continue;
        };
        let Some(envelope) = lock.envelope.clone() else {
            continue;
        };
        output.push(HtlcMaterializeInput {
            binding: HtlcPreparedBinding {
                from_entity_id: hex(&row.input.envelope.from_entity_id),
                to_entity_id: hex(&row.input.envelope.to_entity_id),
                domain: row.input.envelope.domain.clone(),
                account_frame_hash: hex(&frame.state_hash),
                account_height: frame.frame.height,
                envelope_hash: hex(&envelope.integrity_hash()),
                hashlock: lock.hashlock.to_string(),
                token_id: lock.token_id.get(),
                amount: lock.amount.clone(),
                timelock: lock.timelock.clone(),
                reveal_before_height: lock.reveal_before_height,
            },
            envelope,
        });
    }
}

pub(super) fn collect_inputs(
    request: &EntityInfraMaterializeRequest<'_>,
) -> Vec<HtlcMaterializeInput> {
    let mut output = Vec::new();
    for row in request.account_inputs {
        match &row.input.kind {
            AccountInputKind::AckFrame { frame, .. } => collect_frame(row, frame, &mut output),
            AccountInputKind::Ack(_)
            | AccountInputKind::Dispute(_)
            | AccountInputKind::BoardHankoRefresh(_) => {}
        }
    }
    output
}

fn envelope(value: &OpaqueHtlcCiphertext) -> Result<CanonicalValue, FreshEntityContextError> {
    Ok(object(vec![
        ("version", text(HTLC_OPAQUE_CIPHERTEXT_VERSION)),
        ("ciphertext", text(value.ciphertext())),
    ]))
}

fn binding(value: &HtlcPreparedBinding) -> Result<CanonicalValue, FreshEntityContextError> {
    Ok(object(vec![
        ("fromEntityId", text(value.from_entity_id.clone())),
        ("toEntityId", text(value.to_entity_id.clone())),
        (
            "domain",
            object(vec![
                ("chainId", number(value.domain.chain_id())?),
                (
                    "depositoryAddress",
                    text(value.domain.depository_address().as_hex()),
                ),
            ]),
        ),
        ("accountFrameHash", text(value.account_frame_hash.clone())),
        ("accountHeight", number(value.account_height)?),
        ("envelopeHash", text(value.envelope_hash.clone())),
        ("hashlock", text(value.hashlock.clone())),
        ("tokenId", number(u64::from(value.token_id))?),
        ("amount", bigint(&value.amount)),
        ("timelock", bigint(&value.timelock)),
        ("revealBeforeHeight", number(value.reveal_before_height)?),
    ]))
}

fn outcome(value: &HtlcPreparedOutcome) -> Result<CanonicalValue, FreshEntityContextError> {
    match value {
        HtlcPreparedOutcome::Reject { reason } => Ok(object(vec![
            ("kind", text("reject")),
            ("reason", text(reason.clone())),
        ])),
        HtlcPreparedOutcome::Forward {
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
        } => Ok(object(vec![
            ("kind", text("forward")),
            ("nextHopEntityId", text(next_hop_entity_id.clone())),
            ("forwardAmount", bigint(forward_amount)),
            ("innerEnvelope", envelope(inner_envelope)?),
        ])),
        HtlcPreparedOutcome::Final {
            secret,
            description,
            started_at_ms,
        } => {
            let mut row = vec![("kind", text("final")), ("secret", text(secret.clone()))];
            if let Some(description) = description {
                row.push(("description", text(description.clone())));
            }
            if let Some(started_at_ms) = started_at_ms {
                row.push(("startedAtMs", number(*started_at_ms)?));
            }
            Ok(object(row))
        }
    }
}

fn entry(value: &PreparedHtlcEntry) -> Result<CanonicalValue, FreshEntityContextError> {
    Ok(object(vec![
        ("binding", binding(&value.binding)?),
        ("outcome", outcome(&value.outcome)?),
    ]))
}

type PreparedInboundHtlcContext = (
    Vec<PreparedHtlcEntry>,
    Vec<CanonicalValue>,
    BTreeMap<(String, String), String>,
);

pub(super) fn materialize_inbound_htlc_context(
    infrastructure: &InboundHtlcInfrastructure,
    reachability: &(
        crate::processor::EntityRouteTable,
        crate::transport::InboundSessionTable,
    ),
    request: &mut EntityInfraMaterializeRequest<'_>,
    inputs: Vec<HtlcMaterializeInput>,
) -> Result<PreparedInboundHtlcContext, FreshEntityContextError> {
    let total_started = Instant::now();
    let input_count = inputs.len();
    debug_assert!(!inputs.is_empty());
    let worker_count = request.replica.accounts.worker_count();
    let chunk_size = inputs.len().div_ceil(worker_count);
    let mut inputs = inputs.into_iter();
    let chunks = (0..worker_count)
        .map(|_| inputs.by_ref().take(chunk_size).collect::<Vec<_>>())
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>();
    let public_key = infrastructure.entity_encryption_public_key;
    let private_key = infrastructure.entity_encryption_private_key;
    let decrypted = request
        .replica
        .accounts
        .map_stateless_ordered(chunks, move |chunk| {
            decrypt_htlc_materialize_inputs(chunk, &public_key, &private_key)
        })
        .map_err(|error| FreshEntityContextError::HtlcAccountRead(error.to_string()))?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let decrypt_done = total_started.elapsed();
    let mut observed_peer_by_prepared = BTreeMap::new();
    for input in &decrypted {
        let DecryptedHtlcLayer::Decoded(DecodedOnionLayer::Forward { next_hop, .. }) = &input.layer
        else {
            continue;
        };
        let key = (
            input.binding.account_frame_hash.clone(),
            input.binding.hashlock.clone(),
        );
        if let Some(previous) = observed_peer_by_prepared.insert(key.clone(), next_hop.clone())
            && previous != *next_hop
        {
            return Err(FreshEntityContextError::Htlc(
                PreparedContextError::BindingConflict {
                    key: format!("{}:{}", key.0, key.1),
                },
            ));
        }
    }
    let requested = required_htlc_account_tokens(&decrypted);
    let requested_account_count = requested.len();
    let account_requests = requested
        .iter()
        .map(|(entity_id, tokens)| {
            let tokens = tokens
                .iter()
                .map(|token| {
                    TokenId::new(u32::from(*token)).map_err(|error| {
                        FreshEntityContextError::HtlcInfrastructureInvalid(error.to_string())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((
                account_id(entity_id)?,
                xln_rscore_batch::ResidentAccountFinancialViewRequest {
                    token_ids: tokens,
                    htlc_lock_ids: Vec::new(),
                    pull_ids: Vec::new(),
                    swap_offer_ids: Vec::new(),
                    dispute: false,
                },
            ))
        })
        .collect::<Result<Vec<_>, FreshEntityContextError>>()?;
    let plan_done = total_started.elapsed();
    let views = request
        .replica
        .accounts
        .local_financial_views(account_requests)
        .map_err(|error| FreshEntityContextError::HtlcAccountRead(error.to_string()))?;
    let view_count = views.len();
    let views = views.into_iter().collect::<BTreeMap<_, _>>();
    let views_done = total_started.elapsed();
    let mut accounts = BTreeMap::new();
    let mut assertions = BTreeMap::<String, bool>::new();
    for (entity_id, tokens) in requested {
        let Some(view) = views.get(&account_id(&entity_id)?) else {
            continue;
        };
        let online = reachability
            .0
            .is_paybook_peer_online(&entity_id, &reachability.1)
            .map_err(|error| {
                FreshEntityContextError::HtlcInfrastructureInvalid(error.to_string())
            })?;
        assertions.insert(entity_id.clone(), online);
        for token_id in tokens {
            let token = TokenId::new(u32::from(token_id)).map_err(|error| {
                FreshEntityContextError::HtlcInfrastructureInvalid(error.to_string())
            })?;
            accounts.insert(
                (entity_id.clone(), token_id),
                PreparedAccountView {
                    online,
                    out_capacity: view
                        .owner_out_capacity
                        .get(&token)
                        .cloned()
                        .unwrap_or_else(|| BigInt::from(0)),
                    in_capacity: view
                        .owner_in_capacity
                        .get(&token)
                        .cloned()
                        .unwrap_or_else(|| BigInt::from(0)),
                },
            );
        }
    }
    let materialized = materialize_decrypted_htlc_entries(
        decrypted,
        &HtlcMaterializeEnvironment {
            entity_encryption_public_key: infrastructure.entity_encryption_public_key,
            entity_encryption_private_key: infrastructure.entity_encryption_private_key,
            entity_timestamp: request.timestamp,
            last_finalized_j_height: request.finalized_j_height,
            routing_fee_ppm: infrastructure.routing_fee_ppm,
            routing_base_fee: infrastructure.routing_base_fee.clone(),
            accounts,
        },
    )?;
    let materialize_done = total_started.elapsed();
    if super::profile_entity_context() {
        eprintln!(
            "RSCORE_HTLC_CONTEXT_PHASE decrypt={} plan={} views={} materialize={} total={} inputs={} requestedAccounts={} viewsRead={}",
            decrypt_done.as_micros(),
            plan_done.saturating_sub(decrypt_done).as_micros(),
            views_done.saturating_sub(plan_done).as_micros(),
            materialize_done.saturating_sub(views_done).as_micros(),
            materialize_done.as_micros(),
            input_count,
            requested_account_count,
            view_count,
        );
    }
    Ok((
        materialized,
        assertions
            .into_iter()
            .map(|(entity_id, online)| {
                object(vec![
                    ("entityId", text(entity_id)),
                    ("online", CanonicalValue::Bool(online)),
                ])
            })
            .collect(),
        observed_peer_by_prepared,
    ))
}

pub(super) fn canonical_entry(
    value: &PreparedHtlcEntry,
) -> Result<CanonicalValue, FreshEntityContextError> {
    entry(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_value_from_tagged_json;
    use serde_json::json;
    use xln_rscore_batch::{AccountInput, AccountInputBoardAuthority};
    use xln_rscore_engine::{
        AccountDisputeConfig, AccountDomain, AccountFrame, AccountInputEnvelope, DepositoryAddress,
        HtlcHashlock, HtlcLockTx, WatchSeed,
    };

    fn golden_row() -> xln_rscore_batch::AccountInputRow {
        let from_entity_id = [0x11; 32];
        let to_entity_id = [0x22; 32];
        let envelope = OpaqueHtlcCiphertext::parse(
            HTLC_OPAQUE_CIPHERTEXT_VERSION,
            "EyxEK+AQ+9V+cmAzKKp25x/MwVA6riGTJ9FNnJmT9HICUR2hh3m4QkbXs2jc1x2BebzxGNFx/fyl2TH6CABq/GdmvSQCiNm7Yv2wZ2m6s434RXwI687JlOPA7YbyXPh0v/B8QlM1OKEdSpTNKviT",
        )
        .expect("TypeScript golden envelope");
        let frame = IncomingFrame {
            frame: AccountFrame {
                height: 1,
                timestamp: 1,
                j_height: 1,
                txs: vec![AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: format!("0x{}", "55".repeat(32)),
                    hashlock: HtlcHashlock::parse(&format!("0x{}", "55".repeat(32)))
                        .expect("hashlock"),
                    timelock: BigInt::from(987_654_321_u64),
                    reveal_before_height: 1_234,
                    amount: BigInt::from(123_456_789_u64),
                    token_id: TokenId::new(7).expect("token"),
                    delivery_mode: None,
                    envelope: Some(envelope),
                })],
                prev_frame_hash: "genesis".into(),
                account_state_root: [0x66; 32],
            },
            state_hash: [0x77; 32],
            frame_hanko: None,
            dispute: None,
        };
        xln_rscore_batch::AccountInputRow {
            operation_index: 0,
            account_id: AccountId::from_bytes(from_entity_id),
            genesis_policy: None,
            certified_board_authority: AccountInputBoardAuthority::Lazy,
            local_certified_board_authority: AccountInputBoardAuthority::Lazy,
            input: AccountInput {
                envelope: AccountInputEnvelope {
                    from_entity_id,
                    to_entity_id,
                    domain: AccountDomain::new(
                        31_337,
                        DepositoryAddress::parse(&format!("0x{}", "33".repeat(20)))
                            .expect("depository"),
                    )
                    .expect("domain"),
                    dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute"),
                    watch_seed: Some(
                        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                    ),
                },
                kind: AccountInputKind::AckFrame {
                    ack: None,
                    frame: Box::new(frame),
                },
            },
        }
    }

    #[test]
    fn production_extraction_matches_the_typescript_inbound_final_golden() {
        let row = golden_row();
        let mut inputs = Vec::new();
        let AccountInputKind::AckFrame { ack: None, frame } = &row.input.kind else {
            panic!("fixture frame")
        };
        collect_frame(&row, frame, &mut inputs);
        assert_eq!(inputs.len(), 1);

        let private_key =
            hex::decode("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
                .expect("private key")
                .try_into()
                .expect("private key width");
        let public_key =
            hex::decode("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c")
                .expect("public key")
                .try_into()
                .expect("public key width");
        let decrypted = decrypt_htlc_materialize_inputs(inputs, &public_key, &private_key)
            .expect("decrypt TypeScript golden");
        let entries = materialize_decrypted_htlc_entries(
            decrypted,
            &HtlcMaterializeEnvironment {
                entity_encryption_public_key: public_key,
                entity_encryption_private_key: private_key,
                entity_timestamp: 1,
                last_finalized_j_height: 1,
                routing_fee_ppm: 1,
                routing_base_fee: BigInt::from(0),
                accounts: BTreeMap::new(),
            },
        )
        .expect("materialize TypeScript golden");

        assert_eq!(
            entry(&entries[0]).expect("direct canonical entry"),
            canonical_value_from_tagged_json(&json!({
                "binding": {
                    "fromEntityId": format!("0x{}", "11".repeat(32)),
                    "toEntityId": format!("0x{}", "22".repeat(32)),
                    "domain": {
                        "chainId": 31_337,
                        "depositoryAddress": format!("0x{}", "33".repeat(20)),
                    },
                    "accountFrameHash": format!("0x{}", "77".repeat(32)),
                    "accountHeight": 1,
                    "envelopeHash": "0x1b5fc4d2d3579f354e8fef129658b96b5e275d0dd623428a9357441811e787c1",
                    "hashlock": format!("0x{}", "55".repeat(32)),
                    "tokenId": 7,
                    "amount": { "__xlnType": "BigInt", "value": "123456789" },
                    "timelock": { "__xlnType": "BigInt", "value": "987654321" },
                    "revealBeforeHeight": 1_234,
                },
                "outcome": {
                    "kind": "final",
                    "secret": format!("0x{}", "66".repeat(32)),
                    "description": "rust-ts-golden",
                    "startedAtMs": 777,
                },
            }))
            .expect("tagged canonical fixture"),
        );
    }
}
