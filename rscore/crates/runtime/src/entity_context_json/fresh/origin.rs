//! Proposer-only entropy. Only encrypted preimages and verified public evidence
//! enter the existing Entity infrastructure context; replay never calls this.
use super::origin_route::{bytes, domain, hop_domain, invalid, profile, required_inbound};
use super::{EntityInfraMaterializeRequest, FreshEntityContextError, InboundHtlcInfrastructure};
use crate::signed_profile::{ProfileTransportIdentity, signed_entity_profile};
use crate::{canonical_value_from_tagged_json, tagged_json_from_canonical_value};
use num_bigint::BigInt;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use std::collections::{BTreeMap, BTreeSet};
use xln_rscore_batch::AccountId;
use xln_rscore_engine::{HTLC_OPAQUE_CIPHERTEXT_VERSION, OpaqueHtlcCiphertext};
use xln_rscore_entity_kernel::{
    DecodedOnionLayer, HtlcPaymentEntityTx, HtlcPreparedBinding, LocalEntityFinancialTx,
    OriginatedHtlcDeliveryMode, PreparedOriginatedHtlcPayment, compute_htlc_envelope_context_hash,
    encode_onion_layer, encrypt_opaque_htlc_layer,
};
use xln_rscore_protocol::CanonicalValue;

fn tagged(value: &BigInt) -> Value {
    json!({"__xlnType":"BigInt","value":value.to_string()})
}
pub(super) fn canonical(
    payment: &PreparedOriginatedHtlcPayment,
) -> Result<CanonicalValue, FreshEntityContextError> {
    canonical_value_from_tagged_json(&json!({
        "txHash":payment.tx_hash,"targetEntityId":payment.target_entity_id,"tokenId":payment.token_id,
        "recipientAmount":tagged(&payment.recipient_amount),"route":payment.route,"description":payment.description,
        "deliveryMode":match payment.delivery_mode { OriginatedHtlcDeliveryMode::Instant=>"instant",OriginatedHtlcDeliveryMode::Async=>"async" },
        "startedAtMs":payment.started_at_ms,"hashlock":payment.hashlock,"senderLockAmount":tagged(&payment.sender_lock_amount),
        "maxSenderDebit":tagged(&payment.max_sender_debit),"totalFee":tagged(&payment.total_fee),"timelock":tagged(&payment.timelock),
        "revealBeforeHeight":payment.reveal_before_height,"nextHopEntityId":payment.next_hop_entity_id,
        "envelope":{"version":HTLC_OPAQUE_CIPHERTEXT_VERSION,"ciphertext":payment.envelope.ciphertext()}
    })).map_err(invalid)
}
pub(super) struct Origins {
    pub payments: BTreeMap<String, PreparedOriginatedHtlcPayment>,
    pub profiles: Vec<CanonicalValue>,
    pub assertions: BTreeMap<String, bool>,
}
fn prepare(
    tx: &HtlcPaymentEntityTx,
    request: &mut EntityInfraMaterializeRequest<'_>,
    profiles: &[Value],
) -> Result<PreparedOriginatedHtlcPayment, FreshEntityContextError> {
    fn random_word() -> Result<[u8; 32], FreshEntityContextError> {
        let mut value = [0; 32];
        getrandom::fill(&mut value).map_err(|e| invalid(format!("ENTROPY:{e}")))?;
        Ok(value)
    }
    super::origin_route::validate(tx, &request.state.entity.entity_id, request.timestamp)?;
    let secret = random_word()?;
    let hashlock = format!("0x{}", hex::encode(Keccak256::digest(secret)));
    if tx
        .hashlock
        .as_ref()
        .is_some_and(|expected| expected != &hashlock)
    {
        return Err(FreshEntityContextError::OriginRejected("HASHLOCK_MISMATCH"));
    }
    let hops = tx.route.len() - 1;
    let mut amounts = vec![tx.amount.clone(); hops];
    for index in (1..hops).rev() {
        amounts[index - 1] = required_inbound(
            profiles,
            &tx.route[index],
            &tx.route[index + 1],
            tx.token_id.get(),
            &amounts[index],
        )?;
    }
    if amounts[0] > tx.max_sender_debit {
        return Err(FreshEntityContextError::OriginRejected(
            "MAX_SENDER_DEBIT_EXCEEDED",
        ));
    }
    let domains = tx
        .route
        .windows(2)
        .map(|pair| hop_domain(profiles, &pair[0], &pair[1]))
        .collect::<Result<Vec<_>, _>>()?;
    let local_domains = request
        .replica
        .accounts
        .read_account_views(
            vec![AccountId::from_bytes(bytes(&tx.route[1])?)],
            |account| {
                let domain = account.replica().state().identity().domain();
                Ok(CanonicalValue::Object(vec![
                    (
                        "chainId".into(),
                        CanonicalValue::Number(
                            xln_rscore_protocol::CanonicalNumber::try_from_u64(domain.chain_id())
                                .map_err(|_| {
                                xln_rscore_engine::StateError::InvalidChainId(domain.chain_id())
                            })?,
                        ),
                    ),
                    (
                        "depositoryAddress".into(),
                        CanonicalValue::String(domain.depository_address().as_hex()),
                    ),
                ]))
            },
        )
        .map_err(invalid)?;
    let local_domain = tagged_json_from_canonical_value(
        &local_domains
            .first()
            .ok_or_else(|| invalid("SOURCE_ACCOUNT_MISSING"))?
            .1,
    )
    .map_err(invalid)?;
    if domain(&local_domain)? != domains[0] {
        return Err(invalid("SOURCE_ACCOUNT_DOMAIN_MISMATCH"));
    }
    let (expiry_ms, expiry_blocks) = match tx.delivery_mode {
        OriginatedHtlcDeliveryMode::Instant => (120_000u64, 50u64),
        OriginatedHtlcDeliveryMode::Async => (86_400_000, 17_280),
    };
    let timelock = BigInt::from(
        request
            .timestamp
            .checked_add(expiry_ms.max(hops as u64 * 10_000 + 20_000))
            .ok_or_else(|| invalid("TIMELOCK_OVERFLOW"))?,
    );
    let reveal = request
        .originated_j_heights
        .get(&tx.tx_hash)
        .copied()
        .ok_or_else(|| invalid("J_HEIGHT_MISSING"))?
        .checked_add(expiry_blocks)
        .and_then(|height| height.checked_add(hops as u64 * 3))
        .filter(|height| *height <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("REVEAL_OVERFLOW"))?;
    let mut envelope: Option<OpaqueHtlcCiphertext> = None;
    for index in (1..=hops).rev() {
        let layer = match envelope {
            None => DecodedOnionLayer::Final {
                secret: format!("0x{}", hex::encode(secret)),
                description: tx.description.clone().filter(|text| !text.is_empty()),
                started_at_ms: Some(request.timestamp),
            },
            Some(inner) => DecodedOnionLayer::Forward {
                next_hop: tx.route[index + 1].clone(),
                inner_envelope: inner,
                forward_amount: amounts[index].clone(),
            },
        };
        let binding = HtlcPreparedBinding {
            from_entity_id: tx.route[index - 1].clone(),
            to_entity_id: tx.route[index].clone(),
            domain: domains[index - 1].clone(),
            account_frame_hash: String::new(),
            account_height: 0,
            envelope_hash: String::new(),
            hashlock: hashlock.clone(),
            token_id: tx.token_id.get(),
            amount: amounts[index - 1].clone(),
            timelock: &timelock - BigInt::from((index - 1) * 10_000),
            reveal_before_height: reveal - (index - 1) as u64 * 3,
        };
        let key = bytes(
            profile(profiles, &tx.route[index])?["entityEncryptionPublicKey"]
                .as_str()
                .ok_or_else(|| invalid("ENTITY_PUBLIC_KEY"))?,
        )?;
        envelope = Some(encrypt_opaque_htlc_layer(
            &encode_onion_layer(&layer)?,
            &key,
            &compute_htlc_envelope_context_hash(&binding)?,
            &random_word()?,
        )?);
    }
    Ok(PreparedOriginatedHtlcPayment {
        tx_hash: tx.tx_hash.clone(),
        target_entity_id: tx.target_entity_id.clone(),
        token_id: tx.token_id.get(),
        recipient_amount: tx.amount.clone(),
        route: tx.route.clone(),
        description: tx.description.clone().unwrap_or_default(),
        delivery_mode: tx.delivery_mode,
        started_at_ms: request.timestamp,
        hashlock,
        sender_lock_amount: amounts[0].clone(),
        max_sender_debit: tx.max_sender_debit.clone(),
        total_fee: &amounts[0] - &tx.amount,
        timelock,
        reveal_before_height: reveal,
        next_hop_entity_id: tx.route[1].clone(),
        envelope: envelope.ok_or_else(|| invalid("ENVELOPE"))?,
    })
}
pub(super) fn materialize(
    request: &mut EntityInfraMaterializeRequest<'_>,
    infrastructure: Option<&InboundHtlcInfrastructure>,
    routes: &crate::processor::EntityRouteTable,
    sessions: &crate::transport::InboundSessionTable,
    identity: &ProfileTransportIdentity,
) -> Result<Origins, FreshEntityContextError> {
    let txs = request
        .local_financial_txs
        .iter()
        .filter_map(|tx| {
            if let LocalEntityFinancialTx::HtlcPayment(tx) = tx {
                Some(tx.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let mut profiles = routes.authenticated_profiles();
    let source = &request.state.entity.entity_id;
    let (ppm, base) = if request.state.entity.profile.is_hub {
        let infra = infrastructure.ok_or_else(|| invalid("LOCAL_FEE_POLICY"))?;
        (infra.routing_fee_ppm, infra.routing_base_fee.clone())
    } else {
        (1, BigInt::from(0))
    };
    let account_rows = request
        .replica
        .accounts
        .read_account_views(
            crate::signed_profile_accounts::account_ids(request.state).map_err(invalid)?,
            crate::signed_profile_accounts::project_account,
        )
        .map_err(invalid)?;
    let local = signed_entity_profile(
        request.state,
        request.replica,
        request.timestamp,
        identity,
        ppm,
        &base,
        account_rows,
    )
    .map_err(invalid)?;
    profiles.retain(|profile| profile["entityId"].as_str() != Some(source));
    profiles.push(local);
    let mut payments = BTreeMap::new();
    let mut assertions = BTreeMap::new();
    let mut selected = BTreeSet::new();
    for mut tx in txs {
        let prepared = super::origin_route::resolve_empty_route(&mut tx, source, &profiles)
            .and_then(|()| prepare(&tx, request, &profiles));
        let payment = match prepared {
            Ok(payment) => payment,
            // Only sender-invalid preparation omits its entry. The canonical
            // kernel then rejects this exact command without consuming nonce;
            // replay uses the same missing-entry reject, never fresh entropy.
            Err(FreshEntityContextError::OriginRejected(_)) => continue,
            Err(error) => return Err(error),
        };
        selected.extend(payment.route.iter().cloned());
        assertions.insert(
            payment.next_hop_entity_id.clone(),
            routes
                .is_paybook_peer_online(&payment.next_hop_entity_id, sessions)
                .map_err(invalid)?,
        );
        if payments.insert(payment.tx_hash.clone(), payment).is_some() {
            return Err(invalid("TX_DUPLICATE"));
        }
    }
    let profiles = selected
        .iter()
        .map(|id| canonical_value_from_tagged_json(profile(&profiles, id)?).map_err(invalid))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Origins {
        payments,
        profiles,
        assertions,
    })
}

#[cfg(test)]
#[path = "origin_fee_tests.rs"]
mod fee_tests;
