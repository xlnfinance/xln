use super::*;

// Same inclusive deadline and signed claimed-ratio floor as DeltaTransformer
// and TS resolveFinalizedPullFillRatio. Dispute start never bounds publication.
fn settled_ratio(
    pull: &SignedProofPull,
    record: Option<&CanonicalValue>,
) -> Result<u16, EntityKernelError> {
    let Some(record) = record else {
        return Ok(pull.claimed_ratio);
    };
    let time = unsigned(record, "revealedAt")
        .ok_or_else(|| invalid(EntityTxKind::DisputeFinalize, "REGISTRY_TIME"))?;
    let ratio = unsigned(record, "fillRatio")
        .filter(|ratio| *ratio <= u64::from(u16::MAX))
        .ok_or_else(|| invalid(EntityTxKind::DisputeFinalize, "REGISTRY_RATIO"))?
        as u16;
    Ok(if time > 0 && time <= pull.deadline {
        ratio.max(pull.claimed_ratio)
    } else {
        pull.claimed_ratio
    })
}

fn matching_role(
    route: &CanonicalValue,
    local: &str,
    peer: &str,
    stack: Option<&str>,
) -> Result<Option<bool>, EntityKernelError> {
    let mut matches = Vec::new();
    for (leg_name, target) in [("source", false), ("target", true)] {
        let leg = field(route, leg_name)
            .ok_or_else(|| invalid(EntityTxKind::DisputeFinalize, "FINALITY_LEG"))?;
        let entity = normalized(text(leg, "entityId").unwrap_or(""));
        let counterparty = normalized(text(leg, "counterpartyEntityId").unwrap_or(""));
        if (entity == local && counterparty == peer) || (entity == peer && counterparty == local) {
            matches.push((target, text(leg, "jurisdiction").unwrap_or("")));
        }
    }
    if matches.is_empty() {
        return Ok(None);
    }
    let stack = stack.ok_or_else(|| {
        invalid(
            EntityTxKind::DisputeFinalize,
            "FINALITY_JURISDICTION_MISSING",
        )
    })?;
    let exact: Vec<_> = matches
        .into_iter()
        .filter(|(_, jurisdiction)| normalized(jurisdiction) == stack)
        .collect();
    if exact.len() != 1 {
        return Err(invalid(
            EntityTxKind::DisputeFinalize,
            "FINALITY_LEG_MISSING_OR_AMBIGUOUS",
        ));
    }
    Ok(Some(exact[0].0))
}

pub(crate) fn terminalize_finalized_routes(
    state: &mut EntityStateSlice,
    peer: &str,
    authority: Option<&EntityFrameAuthority>,
    body: &crate::j_batch::ProofBody,
    view: &xln_rscore_batch::ResidentAccountDisputeView,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let Some(routes) = state.cross_jurisdiction_swaps.as_ref() else {
        return Ok(());
    };
    let rows = routes.text_entries()?;
    if rows.is_empty() {
        return Ok(());
    }
    let kind = EntityTxKind::DisputeFinalize;
    let stack = authority
        .and_then(|value| value.config.jurisdiction.as_ref())
        .map(|jurisdiction| {
            let chain =
                unsigned(jurisdiction, "chainId").ok_or_else(|| invalid(kind, "FINALITY_CHAIN"))?;
            let depository = text(jurisdiction, "depositoryAddress")
                .ok_or_else(|| invalid(kind, "FINALITY_DEPOSITORY"))?;
            Ok::<_, EntityKernelError>(format!("stack:{chain}:{}", normalized(depository)))
        })
        .transpose()?;
    let local = normalized(&state.entity_id);
    let peer = normalized(peer);
    for (id, mut route) in rows {
        if terminal_route(&route) {
            continue;
        }
        let Some(target) = matching_role(&route, &local, &peer, stack.as_deref())? else {
            continue;
        };
        let expected = field(&route, if target { "targetPull" } else { "sourcePull" });
        let raw_intent = text(&route, "status") == Some("intent")
            && expected.is_none()
            && field(&route, "sourcePull").is_none()
            && field(&route, "targetPull").is_none();
        let ratio = if raw_intent {
            0
        } else {
            let expected = expected.ok_or_else(|| invalid(kind, "FINALITY_PULL_MISSING"))?;
            let transformer = view
                .delta_transformer
                .ok_or_else(|| invalid(kind, "FINAL_DELTA_TRANSFORMER_MISSING"))?;
            if !body
                .transformers
                .iter()
                .any(|clause| clause.transformer_address == transformer)
            {
                return Err(invalid(kind, "FINAL_DELTA_TRANSFORMER_MISSING"));
            }
            let pulls = decode_signed_proof_pulls(body, transformer, kind)?;
            match exact_signed_pull(&pulls, expected, target, kind)? {
                None => 0,
                Some(pull) => {
                    let active = view
                        .active_dispute
                        .as_ref()
                        .ok_or_else(|| invalid(kind, "FINAL_START"))?;
                    let start = unsigned(active, "disputeStartTimestamp")
                        .ok_or_else(|| invalid(kind, "FINAL_START"))?;
                    if unsigned(active, "disputeTimeout")
                        != Some(
                            start
                                + u64::from(body.left_response_seconds)
                                + u64::from(body.right_response_seconds),
                        )
                    {
                        return Err(invalid(kind, "FINAL_CLOCK_MISMATCH"));
                    }
                    settled_ratio(
                        &pull,
                        field(
                            &route,
                            if target {
                                "targetRegistryRecord"
                            } else {
                                "sourceRegistryRecord"
                            },
                        ),
                    )?
                }
            }
        };
        remove(&mut route, "pendingSourceRegistryReveal")?;
        remove(&mut route, "pendingTargetRegistryReveal")?;
        let terminal = if raw_intent {
            "cancelled"
        } else if ratio > 0 {
            "settled"
        } else if route_runtime_expired(&route, state.timestamp) {
            "expired"
        } else {
            "cancelled"
        };
        set(&mut route, "status", string(terminal))?;
        set(
            &mut route,
            "updatedAt",
            number(state.timestamp, kind, "TIMESTAMP")?,
        )?;
        if terminal == "settled" {
            set(
                &mut route,
                "settledAt",
                number(state.timestamp, kind, "TIMESTAMP")?,
            )?;
        }
        collection(&mut state.cross_jurisdiction_swaps).insert(id.clone(), route)?;
        events.push(EntityFrameEvent::Status {
            message: if raw_intent {
                format!("🌉 Cross-j route {id} cancelled before Pull lock on Account finality")
            } else {
                format!("🌉 Cross-j route {id} terminal after dispute finality: {terminal}")
            },
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absolute_deadline_boundaries_and_asymmetric_starts_match_typescript() {
        let kind = EntityTxKind::DisputeFinalize;
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/cross-j-absolute-deadline.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let body = crate::j_batch::ProofBody {
                watch_seed: [0; 32],
                left_response_seconds: 10,
                right_response_seconds: 20,
                offdeltas: Vec::new(),
                token_ids: Vec::new(),
                transformers: vec![crate::j_batch::TransformerClause {
                    transformer_address: [0x44; 20],
                    encoded_batch: ::hex::decode(
                        vector["encodedBatch"]
                            .as_str()
                            .unwrap()
                            .trim_start_matches("0x"),
                    )
                    .unwrap(),
                    allowances: Vec::new(),
                }],
            };
            let pulls = decode_signed_proof_pulls(&body, [0x44; 20], kind).unwrap();
            let record = CanonicalValue::Object(vec![
                (
                    "fillRatio".into(),
                    number(vector["ratio"].as_u64().unwrap(), kind, "RATIO").unwrap(),
                ),
                (
                    "revealedAt".into(),
                    number(vector["revealedAt"].as_u64().unwrap(), kind, "TIME").unwrap(),
                ),
            ]);
            assert_eq!(
                u64::from(settled_ratio(&pulls[0], Some(&record)).unwrap()),
                vector["expected"].as_u64().unwrap()
            );
            assert_eq!(pulls[0].deadline, vector["deadline"].as_u64().unwrap());
        }
    }
}
