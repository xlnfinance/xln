//! Exact inbound HTLC context materialization for the live Runtime path.

use std::collections::BTreeMap;

use num_bigint::BigInt;
use serde_json::{Map, Number, Value, json};
use xln_rscore_batch::{AccountId, AccountInputKind};
use xln_rscore_engine::{
    AccountTx, HTLC_OPAQUE_CIPHERTEXT_VERSION, IncomingFrame, OpaqueHtlcCiphertext, TokenId,
};
use xln_rscore_entity_kernel::{
    HtlcMaterializeEnvironment, HtlcMaterializeInput, HtlcPreparedBinding, HtlcPreparedOutcome,
    PreparedAccountView, PreparedHtlcEntry, decrypt_htlc_materialize_inputs,
    materialize_decrypted_htlc_entries, required_htlc_account_tokens,
};

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

fn bigint(value: &BigInt) -> Value {
    json!({ "__xlnType": "BigInt", "value": value.to_string() })
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
                lock_id: lock.lock_id.clone(),
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

fn collect_inputs(request: &EntityInfraMaterializeRequest<'_>) -> Vec<HtlcMaterializeInput> {
    let mut output = Vec::new();
    for row in request.account_inputs {
        match &row.input.kind {
            AccountInputKind::Frame(frame) => collect_frame(row, frame, &mut output),
            AccountInputKind::FrameAck { frame, .. } => collect_frame(row, frame, &mut output),
            AccountInputKind::Ack(_)
            | AccountInputKind::Dispute(_)
            | AccountInputKind::BoardHankoRefresh(_) => {}
        }
    }
    output
}

fn envelope(value: &OpaqueHtlcCiphertext) -> Value {
    json!({
        "version": HTLC_OPAQUE_CIPHERTEXT_VERSION,
        "ciphertext": value.ciphertext(),
    })
}

fn binding(value: &HtlcPreparedBinding) -> Value {
    json!({
        "fromEntityId": value.from_entity_id,
        "toEntityId": value.to_entity_id,
        "domain": {
            "chainId": value.domain.chain_id(),
            "depositoryAddress": value.domain.depository_address().as_hex(),
        },
        "accountFrameHash": value.account_frame_hash,
        "accountHeight": value.account_height,
        "lockId": value.lock_id,
        "envelopeHash": value.envelope_hash,
        "hashlock": value.hashlock,
        "tokenId": value.token_id,
        "amount": bigint(&value.amount),
        "timelock": bigint(&value.timelock),
        "revealBeforeHeight": value.reveal_before_height,
    })
}

fn outcome(value: &HtlcPreparedOutcome) -> Value {
    match value {
        HtlcPreparedOutcome::Reject { reason } => json!({
            "kind": "reject",
            "reason": reason,
        }),
        HtlcPreparedOutcome::Forward {
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
        } => json!({
            "kind": "forward",
            "nextHopEntityId": next_hop_entity_id,
            "forwardAmount": bigint(forward_amount),
            "innerEnvelope": envelope(inner_envelope),
        }),
        HtlcPreparedOutcome::Final {
            secret,
            description,
            started_at_ms,
        } => {
            let mut row = Map::from_iter([
                ("kind".into(), Value::String("final".into())),
                ("secret".into(), Value::String(secret.clone())),
            ]);
            if let Some(description) = description {
                row.insert("description".into(), Value::String(description.clone()));
            }
            if let Some(started_at_ms) = started_at_ms {
                row.insert(
                    "startedAtMs".into(),
                    Value::Number(Number::from(*started_at_ms)),
                );
            }
            Value::Object(row)
        }
    }
}

fn entry(value: &PreparedHtlcEntry) -> Value {
    json!({
        "binding": binding(&value.binding),
        "outcome": outcome(&value.outcome),
    })
}

pub(super) fn materialize_inbound_htlc_context(
    infrastructure: &InboundHtlcInfrastructure,
    request: &mut EntityInfraMaterializeRequest<'_>,
) -> Result<(Vec<Value>, Vec<Value>), FreshEntityContextError> {
    let inputs = collect_inputs(request);
    if inputs.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let decrypted = decrypt_htlc_materialize_inputs(
        inputs,
        &infrastructure.entity_encryption_public_key,
        &infrastructure.entity_encryption_private_key,
    )?;
    let requested = required_htlc_account_tokens(&decrypted);
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
            Ok((account_id(entity_id)?, tokens))
        })
        .collect::<Result<Vec<_>, FreshEntityContextError>>()?;
    let views = request
        .replica
        .accounts
        .local_financial_views(account_requests)
        .map_err(|error| FreshEntityContextError::HtlcAccountRead(error.to_string()))?;
    let views = views.into_iter().collect::<BTreeMap<_, _>>();
    let mut accounts = BTreeMap::new();
    let mut assertions = BTreeMap::<String, bool>::new();
    for (entity_id, tokens) in requested {
        let Some(view) = views.get(&account_id(&entity_id)?) else {
            continue;
        };
        let known = infrastructure.known_profile_entity_ids.contains(&entity_id);
        let online = known && infrastructure.online_entity_ids.contains(&entity_id);
        if known {
            assertions.insert(entity_id.clone(), online);
        }
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
    Ok((
        materialized.iter().map(entry).collect(),
        assertions
            .into_iter()
            .map(|(entity_id, online)| json!({ "entityId": entity_id, "online": online }))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_batch::{AccountPeerInput, PeerBoardAuthority};
    use xln_rscore_engine::{
        AccountDisputeConfig, AccountDomain, AccountFrame, AccountPeerEnvelope, DepositoryAddress,
        HtlcHashlock, HtlcLockTx, WatchSeed,
    };

    fn golden_row() -> xln_rscore_batch::AccountInputRow {
        let from_entity_id = [0x11; 32];
        let to_entity_id = [0x22; 32];
        let envelope = OpaqueHtlcCiphertext::parse(
            HTLC_OPAQUE_CIPHERTEXT_VERSION,
            "ZLEBsdC+WocEvQePmJUAH8A+jp+VIvGI3RKNmEbUhGanXH41W7vcvi12F50b84riPUmDmGE7/CrmiJ/vubHZI9sKBN3d4dOWkWmpAHNtixC9R3cYLkr/2auDN17fXzydAauQ3khq4kn+cRqOgvKv",
        )
        .expect("TypeScript golden envelope");
        let frame = IncomingFrame {
            frame: AccountFrame {
                height: 1,
                timestamp: 1,
                j_height: 1,
                txs: vec![AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: format!("0x{}", "44".repeat(32)),
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
            certified_board_authority: PeerBoardAuthority::Lazy,
            local_certified_board_authority: PeerBoardAuthority::Lazy,
            input: AccountPeerInput {
                envelope: AccountPeerEnvelope {
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
                kind: AccountInputKind::Frame(Box::new(frame)),
            },
        }
    }

    #[test]
    fn production_extraction_matches_the_typescript_inbound_final_golden() {
        let row = golden_row();
        let mut inputs = Vec::new();
        let AccountInputKind::Frame(frame) = &row.input.kind else {
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
            entry(&entries[0]),
            json!({
                "binding": {
                    "fromEntityId": format!("0x{}", "11".repeat(32)),
                    "toEntityId": format!("0x{}", "22".repeat(32)),
                    "domain": {
                        "chainId": 31_337,
                        "depositoryAddress": format!("0x{}", "33".repeat(20)),
                    },
                    "accountFrameHash": format!("0x{}", "77".repeat(32)),
                    "accountHeight": 1,
                    "lockId": format!("0x{}", "44".repeat(32)),
                    "envelopeHash": "0x1e48740c3da2cc697f19ee3c72ec0ae2a4e1bfb57ab0dead24ad6c5534f5b2b8",
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
            }),
        );
    }
}
