//! Reply and Account transition encoder for the process ABI.

use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_batch::{BatchResponse, BatchVerdict, IndexedOutput, IndexedResult, PreparedBatch};
use xln_rscore_engine::{AccountOutput, DeliveryMode};

pub fn hello(
    worker_count: usize,
    swap_market_digest: [u8; 32],
    // The identity an authoritative session derived from the seed it was
    // given: the signer address and the lazy entity that address alone
    // defines. The runtime holds the account seeds, so it must be able to
    // check that the engine derived the entity it is about to be handed
    // accounts for, before any frame is signed.
    authority_identity: Option<([u8; 20], [u8; 32])>,
) -> BodyTuple {
    body(vec![
        integer(crate::PROCESS_ABI_VERSION),
        AbiValue::Text(crate::PROCESS_PROFILE.into()),
        integer(worker_count),
        // The caller compares this against the digest of the tables it sent,
        // so a registry that moved under the engine is loud, not silent.
        AbiValue::Bytes(swap_market_digest.to_vec()),
        authority_identity.map_or(AbiValue::Nil, |(address, _)| {
            AbiValue::Bytes(address.to_vec())
        }),
        authority_identity.map_or(AbiValue::Nil, |(_, entity_id)| {
            AbiValue::Bytes(entity_id.to_vec())
        }),
    ])
}

pub fn loaded(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

pub fn prepared(
    candidate: &PreparedBatch,
    engine_micros: u64,
    candidate_token: &[u8; 32],
) -> Result<BodyTuple, crate::ProcessError> {
    let roots = candidate.payment_profile_roots()?;
    Ok(body(vec![
        integer(candidate.base_revision()),
        integer(candidate.next_revision()),
        tuple(candidate.results().iter().map(result).collect()),
        tuple(candidate.outputs().iter().map(output).collect()),
        tuple(
            roots
                .into_iter()
                .map(|root| {
                    tuple(vec![
                        AbiValue::Bytes(root.account_id.as_bytes().to_vec()),
                        AbiValue::Bytes(root.payment_profile_root.to_vec()),
                    ])
                })
                .collect(),
        ),
        integer(engine_micros),
        // Ephemeral process capability. It is outside every financial digest
        // and is stripped by the client before exposing the prepared result.
        AbiValue::Bytes(candidate_token.to_vec()),
    ]))
}

pub fn committed(response: &BatchResponse) -> BodyTuple {
    body(vec![
        integer(response.committed_revision),
        AbiValue::Bytes(response.accounts_root.to_vec()),
    ])
}

pub fn upserted(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

pub fn aborted(revision: u64) -> BodyTuple {
    body(vec![integer(revision)])
}

pub fn shutdown() -> BodyTuple {
    body(Vec::new())
}

pub fn capacity_rows(
    revision: u64,
    rows: &[Option<xln_rscore_engine::DeltaPerspective>],
) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            rows.iter()
                .map(|row| match row {
                    None => AbiValue::Nil,
                    Some(view) => tuple(vec![
                        AbiValue::Text(view.in_capacity.to_string()),
                        AbiValue::Text(view.out_capacity.to_string()),
                        AbiValue::Text(view.own_credit_limit.to_string()),
                        AbiValue::Text(view.peer_credit_limit.to_string()),
                    ]),
                })
                .collect(),
        ),
    ])
}

/// Exact committed replica fields used by the TypeScript shadow diagnostic.
/// Tag 18 has owned this reply shape since wire=13. Preserve it so enabling
/// diagnostics cannot change the process transcript or persisted fingerprint.
pub fn account_envelope(revision: u64, envelope: &xln_rscore_engine::AccountEnvelope) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            envelope
                .fields()
                .iter()
                .map(|(name, value)| {
                    tuple(vec![
                        AbiValue::Text(name.clone()),
                        xln_rscore_batch::encode_canonical_value(value),
                    ])
                })
                .collect(),
        ),
    ])
}

pub fn summary_page(
    revision: u64,
    rows: &[xln_rscore_batch::AccountSummaryRow],
    next_cursor: Option<xln_rscore_batch::AccountId>,
    totals: &xln_rscore_batch::EngineTotals,
) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            rows.iter()
                .map(|row| {
                    tuple(vec![
                        AbiValue::Bytes(row.account_id.as_bytes().to_vec()),
                        AbiValue::Integer(match row.owner_side {
                            xln_rscore_engine::Side::Left => 0,
                            xln_rscore_engine::Side::Right => 1,
                        }),
                        integer(row.delta_rows),
                        integer(row.htlc_locks),
                        AbiValue::Bytes(row.deltas_root.to_vec()),
                        AbiValue::Bytes(row.htlc_locks_root.to_vec()),
                        AbiValue::Bytes(row.account_state_root.to_vec()),
                        AbiValue::Bytes(row.swap_offers_root.to_vec()),
                        AbiValue::Bytes(row.rebalance_fee_policies_root.to_vec()),
                        AbiValue::Bytes(row.entity_account_leaf.to_vec()),
                        AbiValue::Bytes(row.mempool_root.to_vec()),
                        integer(row.mempool_len),
                    ])
                })
                .collect(),
        ),
        match next_cursor {
            None => AbiValue::Nil,
            Some(cursor) => AbiValue::Bytes(cursor.as_bytes().to_vec()),
        },
        tuple(vec![
            integer(totals.accounts),
            integer(totals.htlc_locks),
            tuple(
                totals
                    .tokens
                    .iter()
                    .map(|token| {
                        tuple(vec![
                            AbiValue::Integer(i128::from(token.token_id.get())),
                            integer(token.rows),
                            AbiValue::Text(token.collateral.to_string()),
                            AbiValue::Text(token.owner_in_capacity.to_string()),
                            AbiValue::Text(token.owner_out_capacity.to_string()),
                        ])
                    })
                    .collect(),
            ),
        ]),
    ])
}

pub fn error(error: &crate::ProcessError) -> BodyTuple {
    body(vec![
        AbiValue::Text(error.code().into()),
        AbiValue::Text(error.to_string()),
    ])
}

fn result(value: &IndexedResult) -> AbiValue {
    let verdict = match &value.verdict {
        BatchVerdict::Applied => tuple(vec![AbiValue::Integer(0)]),
        BatchVerdict::Rejected(rejection) => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Text(rejection.code().into()),
            AbiValue::Text(rejection.message()),
        ]),
    };
    tuple(vec![
        AbiValue::Integer(i128::from(value.input_index)),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        verdict,
        tuple(value.events.iter().cloned().map(AbiValue::Text).collect()),
    ])
}

fn output(value: &IndexedOutput) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(i128::from(value.input_index)),
        AbiValue::Integer(i128::from(value.output_index)),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        account_output(&value.output),
    ])
}

fn account_output(value: &AccountOutput) -> AbiValue {
    match value {
        AccountOutput::AccountSettledFinalized {
            token_id,
            j_height,
            collateral,
            ondelta,
        } => tuple(vec![
            AbiValue::Integer(6),
            integer(token_id.get()),
            integer(*j_height),
            big(collateral),
            big(ondelta),
        ]),
        AccountOutput::DirectPaymentForward {
            token_id,
            amount,
            route,
            description,
            delivery_mode,
            trusted_gateway_entity_id,
        } => tuple(vec![
            AbiValue::Integer(0),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            tuple(route.iter().cloned().map(AbiValue::Text).collect()),
            optional_text(description),
            AbiValue::Integer(match delivery_mode {
                DeliveryMode::Direct => 0,
                DeliveryMode::Trusted => 1,
            }),
            AbiValue::Text(trusted_gateway_entity_id.clone()),
        ]),
        AccountOutput::HtlcSecret {
            lock_id,
            hashlock,
            secret,
            token_id,
            amount,
        } => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Text(secret.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
        ]),
        AccountOutput::SwapOfferUpsert { offer } => tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Text(offer.offer_id.clone()),
            AbiValue::Text(offer.left_entity.clone()),
            AbiValue::Text(offer.right_entity.clone()),
            integer(offer.give_token_id),
            integer(offer.give_token_decimals),
            AbiValue::Text(offer.give_amount.to_string()),
            integer(offer.want_token_id),
            integer(offer.want_token_decimals),
            AbiValue::Text(offer.want_amount.to_string()),
            AbiValue::Text(offer.max_fee.to_string()),
            AbiValue::Text(offer.min_net_receive.to_string()),
            AbiValue::Text(offer.price_ticks.to_string()),
            offer.time_in_force.map_or(AbiValue::Nil, integer),
            AbiValue::Integer(i128::from(!offer.maker_is_left)),
            integer(offer.created_height),
            AbiValue::Text(offer.quantized_give.to_string()),
            AbiValue::Text(offer.quantized_want.to_string()),
        ]),
        AccountOutput::SwapOfferRemove {
            offer_id,
            maker_is_left,
        } => tuple(vec![
            AbiValue::Integer(4),
            AbiValue::Text(offer_id.clone()),
            AbiValue::Integer(i128::from(!maker_is_left)),
        ]),
        AccountOutput::SwapCancelRequest { offer_id } => {
            tuple(vec![AbiValue::Integer(5), AbiValue::Text(offer_id.clone())])
        }
        AccountOutput::HtlcError {
            lock_id,
            hashlock,
            token_id,
            amount,
            reason,
        } => tuple(vec![
            AbiValue::Integer(2),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            optional_text(reason),
        ]),
    }
}

pub(crate) fn body(fields: Vec<AbiValue>) -> BodyTuple {
    BodyTuple::from_array([tuple(fields)])
}

pub(crate) fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

fn optional_text(value: &Option<String>) -> AbiValue {
    value.clone().map_or(AbiValue::Nil, AbiValue::Text)
}

pub(crate) fn integer(value: impl TryInto<i128>) -> AbiValue {
    AbiValue::Integer(value.try_into().ok().expect("wire integer fits i128"))
}

// ---------------------------------------------------------- authority wave

/// One Entity round in the same canonical shape a wave reply has, so the
/// caller decodes both with one decoder.
pub fn round(
    result: &xln_rscore_batch::EntityRoundResult,
    engine_micros: u64,
) -> Result<BodyTuple, crate::ProcessError> {
    Ok(body(round_fields(RoundFields {
        revision: result.revision,
        accounts_root: result.accounts_root,
        applied: &result.applied,
        admissions: &result.admissions,
        proposals: &result.proposals,
        touched: &result.touched,
        post_accounts: &result.post_accounts,
        created_accounts: &result.created_accounts,
        checkpoint: result.checkpoint.as_ref(),
        engine_micros,
    })?))
}

/// Whether a reply echoes the Account envelope back to its owner.
///
/// The engine stores envelope fields and hands them back untouched; it never
/// authors one. A caller that trusts the engine's leaf has no use for the
/// echo, and it was 39% of every reply. A caller that re-derives the leaf
/// itself needs the exact fields the leaf was sealed over, and asks for them
/// by setting this on the process it spawns.
fn carry_envelope() -> bool {
    static CARRY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CARRY.get_or_init(|| std::env::var("XLN_RSCORE_CARRY_ENVELOPE").as_deref() == Ok("1"))
}

struct RoundFields<'a> {
    revision: u64,
    accounts_root: [u8; 32],
    applied: &'a [xln_rscore_batch::AccountInputResult],
    admissions: &'a [xln_rscore_batch::AccountAdmissionResult],
    proposals: &'a [xln_rscore_batch::ProposalRow],
    touched: &'a [(xln_rscore_batch::AccountId, [u8; 32])],
    post_accounts: &'a [xln_rscore_batch::AccountCheckpointRows],
    created_accounts: &'a [xln_rscore_batch::AccountCheckpointRows],
    checkpoint: Option<&'a xln_rscore_batch::AccountsCheckpoint>,
    engine_micros: u64,
}

fn round_fields(fields: RoundFields<'_>) -> Result<Vec<AbiValue>, crate::ProcessError> {
    let mut proposals = Vec::with_capacity(fields.proposals.len());
    for row in fields.proposals {
        proposals.push(proposal(row)?);
    }
    let applied = tuple(
        fields
            .applied
            .iter()
            .map(input_result)
            .collect::<Result<Vec<_>, _>>()?,
    );
    let admissions = tuple(fields.admissions.iter().map(admission_result).collect());
    let touched = tuple(
        fields
            .touched
            .iter()
            .map(|(account_id, leaf)| {
                tuple(vec![
                    AbiValue::Bytes(account_id.as_bytes().to_vec()),
                    AbiValue::Bytes(leaf.to_vec()),
                ])
            })
            .collect(),
    );
    let proposals = tuple(proposals);
    let post_accounts = tuple(
        fields
            .post_accounts
            .iter()
            .map(|row| crate::checkpoint_wire::account_rows(row, carry_envelope()))
            .collect::<Result<_, _>>()?,
    );
    let created_accounts = tuple(
        fields
            .created_accounts
            .iter()
            // A newly authenticated Account has no prior Entity read model.
            // Its H=1 row must therefore carry the envelope even when normal
            // cutover verification is disabled.
            .map(|row| crate::checkpoint_wire::account_rows(row, true))
            .collect::<Result<_, _>>()?,
    );
    let checkpoint = crate::checkpoint_wire::changes(fields.checkpoint)?;
    let created_leaves = tuple(
        fields
            .created_accounts
            .iter()
            .map(|row| {
                tuple(vec![
                    AbiValue::Bytes(row.account_id.as_bytes().to_vec()),
                    AbiValue::Bytes(row.account_leaf.to_vec()),
                ])
            })
            .collect(),
    );
    let digest = parity_digest(
        fields.accounts_root,
        &touched,
        &applied,
        &admissions,
        &proposals,
        &created_leaves,
    )?;
    Ok(vec![
        integer(fields.revision),
        AbiValue::Bytes(fields.accounts_root.to_vec()),
        applied,
        admissions,
        proposals,
        touched,
        post_accounts,
        created_accounts,
        checkpoint,
        AbiValue::Bytes(digest.to_vec()),
        // Wall time inside the engine, so a caller can tell the cost of the
        // work from the cost of reaching it. Excluded from the parity digest:
        // it is a measurement of this run, not part of what the two engines
        // must agree on.
        integer(fields.engine_micros),
    ])
}

/// The whole wave in one hash: the accounts root, the leaves it moved, the
/// verdicts in order — effects included — and every proposal attempt with its
/// dropped rows. A driver compares this and nothing else until it differs.
///
/// Effects are in it deliberately: no state root covers them, so an engine
/// that lost a forward or a revealed secret would otherwise agree on every
/// root it publishes.
///
/// Signatures are not: a Hanko is checked against the frame it signs and the
/// entity that must have produced it, which is a stronger statement than two
/// engines producing identical bytes.
///
/// The digest is taken over this ABI's own canonical encoding rather than any
/// Rust-side formatting, so TypeScript reproduces it with the encoder it
/// already speaks.
fn parity_digest(
    accounts_root: [u8; 32],
    touched: &AbiValue,
    applied: &AbiValue,
    admissions: &AbiValue,
    proposals: &AbiValue,
    created_leaves: &AbiValue,
) -> Result<[u8; 32], crate::ProcessError> {
    use sha2::{Digest, Sha256};
    // The transcript is the six values themselves, not a body: a reply wraps
    // its fields in one more tuple, and hashing that wrapper would make the
    // digest describe the envelope rather than the wave.
    let transcript = xln_rscore_abi::BodyTuple::from_array([
        AbiValue::Bytes(accounts_root.to_vec()),
        touched.clone(),
        applied.clone(),
        admissions.clone(),
        proposals.clone(),
        created_leaves.clone(),
    ]);
    let encoded = xln_rscore_abi::encode_tuple(&transcript)?;
    let mut digest = Sha256::new();
    digest.update(WAVE_PARITY_DOMAIN.as_bytes());
    digest.update(&encoded);
    Ok(digest.finalize().into())
}

const WAVE_PARITY_DOMAIN: &str = "xln.rscore.wave-parity.v2";

/// One attempt to propose: the account, the frame it produced if any, and the
/// transactions it could not include. An attempt that produced no frame is
/// still reported — it moved the mempool, and therefore the leaf.
fn proposal(row: &xln_rscore_batch::ProposalRow) -> Result<AbiValue, crate::ProcessError> {
    let proposed = match row.proposed.as_ref() {
        None => AbiValue::Nil,
        Some(proposed) => {
            let mut fields = frame_fields(&proposed.frame, proposed.state_hash)?;
            fields.push(AbiValue::Bytes(proposed.hanko.clone()));
            tuple(fields)
        }
    };
    Ok(tuple(vec![
        AbiValue::Bytes(row.account_id.as_bytes().to_vec()),
        proposed,
        tuple(row.dropped.iter().map(dropped).collect()),
        dispute_draft(row.proposed.as_ref().and_then(|row| row.dispute.as_ref())),
        match row
            .proposed
            .as_ref()
            .and_then(|row| row.bundled_ack.as_ref())
        {
            None => AbiValue::Nil,
            Some(ack) => tuple(vec![
                integer(ack.height),
                AbiValue::Bytes(ack.frame_hash.to_vec()),
                dispute_draft(ack.dispute.as_ref()),
            ]),
        },
        tuple(match row.proposed.as_ref() {
            None => Vec::new(),
            Some(proposed) => proposed
                .events
                .iter()
                .cloned()
                .map(AbiValue::Text)
                .collect(),
        }),
        tuple(match row.proposed.as_ref() {
            None => Vec::new(),
            Some(proposed) => proposed.outputs.iter().map(account_output).collect(),
        }),
        tuple(
            row.failed_htlc_locks
                .iter()
                .map(|failed| {
                    tuple(vec![
                        AbiValue::Bytes(failed.hashlock.to_vec()),
                        AbiValue::Text(failed.lock_id.clone()),
                        AbiValue::Text(failed.reason.clone()),
                        match &failed.upstream_resolution {
                            None => AbiValue::Nil,
                            Some(resolution) => tuple(vec![
                                AbiValue::Bytes(resolution.account_id.as_bytes().to_vec()),
                                AbiValue::Text(resolution.lock_id.clone()),
                                AbiValue::Text(resolution.reason.clone()),
                            ]),
                        },
                    ])
                })
                .collect(),
        ),
    ]))
}

/// The canonical Account frame body plus its derived state hash. Rust keeps
/// the hash beside `AccountFrame`; TypeScript keeps it on the frame object.
/// The process boundary carries the complete TypeScript shape so Entity can
/// consume committed transactions without reconstructing consensus evidence.
fn frame_fields(
    frame: &xln_rscore_engine::AccountFrame,
    state_hash: [u8; 32],
) -> Result<Vec<AbiValue>, crate::ProcessError> {
    let mut txs = Vec::with_capacity(frame.txs.len());
    for value in &frame.txs {
        txs.push(tx(value)?);
    }
    Ok(vec![
        integer(frame.height),
        integer(frame.timestamp),
        integer(frame.j_height),
        tuple(txs),
        AbiValue::Text(frame.prev_frame_hash.clone()),
        AbiValue::Bytes(frame.account_state_root.to_vec()),
        AbiValue::Bytes(state_hash.to_vec()),
    ])
}

fn committed_frame(
    evidence: &xln_rscore_engine::CommittedFrameEvidence,
    state_hash: [u8; 32],
) -> Result<AbiValue, crate::ProcessError> {
    Ok(tuple(vec![
        tuple(frame_fields(&evidence.frame, state_hash)?),
        AbiValue::Bool(evidence.committed_via_new_frame),
    ]))
}

/// A transaction the proposer did not put in the frame, and why. A count
/// would say that the engines disagree; this says which transaction and
/// whether it is coming back.
fn dropped(value: &xln_rscore_batch::DroppedRow) -> AbiValue {
    use xln_rscore_engine::Disposition;
    tuple(vec![
        integer(value.index),
        AbiValue::Bytes(value.tx_digest.to_vec()),
        AbiValue::Text(value.code.to_string()),
        AbiValue::Text(value.message.clone()),
        AbiValue::Integer(match value.disposition {
            Disposition::Deferred => 0,
            Disposition::Removed => 1,
        }),
    ])
}

pub(crate) fn input_result(
    value: &xln_rscore_batch::AccountInputResult,
) -> Result<AbiValue, crate::ProcessError> {
    Ok(tuple(vec![
        integer(value.operation_index),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        verdict(&value.verdict)?,
    ]))
}

fn admission_result(value: &xln_rscore_batch::AccountAdmissionResult) -> AbiValue {
    use xln_rscore_batch::AccountAdmissionVerdict;
    let verdict = match &value.verdict {
        AccountAdmissionVerdict::Admitted { count } => tuple(vec![integer(0), integer(*count)]),
        AccountAdmissionVerdict::Rejected { code, message } => tuple(vec![
            integer(1),
            AbiValue::Text(code.clone()),
            AbiValue::Text(message.clone()),
        ]),
    };
    tuple(vec![
        integer(value.operation_index),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        verdict,
    ])
}

/// What the committed transactions said they did, in transaction order. The
/// Entity frame hashes these strings, so they cross the wire verbatim.
fn frame_events(events: &[String]) -> AbiValue {
    tuple(
        events
            .iter()
            .map(|event| AbiValue::Text(event.clone()))
            .collect(),
    )
}

/// The recovery proof an acknowledgement or proposal travels with, or `Nil`.
///
/// The publisher sends this; it must not have to read the account back to
/// learn what it just signed.
fn dispute_draft(value: Option<&xln_rscore_engine::DisputeDraft>) -> AbiValue {
    match value {
        None => AbiValue::Nil,
        Some(draft) => tuple(vec![
            AbiValue::Bytes(draft.hash.to_vec()),
            AbiValue::Bytes(draft.proof_body_hash.to_vec()),
            integer(draft.nonce),
            AbiValue::Bool(draft.proposer_is_left),
        ]),
    }
}

/// Tagged so the runtime can tell a commit from an ignored collision without
/// parsing text. The tags are the wire's, not the engine's: a new outcome adds
/// a tag rather than changing an old one.
fn verdict(value: &xln_rscore_batch::AccountInputVerdict) -> Result<AbiValue, crate::ProcessError> {
    use xln_rscore_batch::AccountInputVerdict;
    Ok(match value {
        AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_hanko,
            outputs,
            events,
            rolled_back,
            committed_frame: evidence,
            ack_dispute,
        } => tuple(vec![
            integer(0),
            integer(*height),
            AbiValue::Bytes(state_hash.to_vec()),
            AbiValue::Bytes(ack_hanko.clone()),
            tuple(outputs.iter().map(account_output).collect()),
            match rolled_back {
                None => AbiValue::Nil,
                Some(rolled_back) => tuple(vec![
                    integer(rolled_back.height),
                    integer(rolled_back.restored),
                    integer(rolled_back.proposed),
                ]),
            },
            committed_frame(evidence, *state_hash)?,
            frame_events(events),
            dispute_draft(ack_dispute.as_ref()),
        ]),
        AccountInputVerdict::FrameCollisionIgnored { height, queued } => {
            tuple(vec![integer(1), integer(*height), integer(*queued)])
        }
        AccountInputVerdict::FrameDuplicate {
            height,
            state_hash,
            ack_hanko,
            ack_dispute,
        } => tuple(vec![
            integer(2),
            integer(*height),
            AbiValue::Bytes(state_hash.to_vec()),
            AbiValue::Bytes(ack_hanko.clone()),
            dispute_draft(ack_dispute.as_ref()),
        ]),
        AccountInputVerdict::FrameStale {
            height,
            current_height,
        } => tuple(vec![integer(3), integer(*height), integer(*current_height)]),
        AccountInputVerdict::FrameDisputeRequired {
            reason,
            evidence_secrets,
            signed_frame,
        } => {
            let mut signed = frame_fields(&signed_frame.frame, signed_frame.state_hash)?;
            signed.push(AbiValue::Bytes(signed_frame.frame_hanko.clone()));
            tuple(vec![
                integer(11),
                AbiValue::Text(reason.clone()),
                tuple(
                    evidence_secrets
                        .iter()
                        .map(|evidence| {
                            tuple(vec![
                                AbiValue::Text(evidence.hashlock.clone()),
                                AbiValue::Text(evidence.secret.clone()),
                            ])
                        })
                        .collect(),
                ),
                tuple(signed),
            ])
        }
        AccountInputVerdict::FrameRejected { reason } => {
            tuple(vec![integer(4), AbiValue::Text(reason.clone())])
        }
        AccountInputVerdict::AckCommitted {
            height,
            state_hash,
            outputs,
            events,
            committed_frame: evidence,
        } => tuple(vec![
            integer(5),
            integer(*height),
            AbiValue::Bytes(state_hash.to_vec()),
            tuple(outputs.iter().map(account_output).collect()),
            committed_frame(evidence, *state_hash)?,
            frame_events(events),
        ]),
        AccountInputVerdict::AckStale { height } => tuple(vec![integer(6), integer(*height)]),
        AccountInputVerdict::AckRejected { reason } => {
            tuple(vec![integer(7), AbiValue::Text(reason.clone())])
        }
        AccountInputVerdict::Failed(message) => {
            tuple(vec![integer(8), AbiValue::Text(message.clone())])
        }
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            if !is_ack_verdict(ack) {
                return Err(crate::ProcessError::Expected("frameAckAckVerdict"));
            }
            if !is_frame_verdict(frame) {
                return Err(crate::ProcessError::Expected("frameAckFrameVerdict"));
            }
            tuple(vec![integer(9), verdict(ack)?, verdict(frame)?])
        }
        AccountInputVerdict::FrameAckRejected { phase, reason } => tuple(vec![
            integer(10),
            integer(match phase {
                xln_rscore_engine::FrameAckPhase::Ack => 0,
                xln_rscore_engine::FrameAckPhase::Frame => 1,
            }),
            AbiValue::Text(reason.clone()),
        ]),
        AccountInputVerdict::DisputeApplied => tuple(vec![integer(12)]),
        AccountInputVerdict::DisputeRejected { reason } => {
            tuple(vec![integer(13), AbiValue::Text(reason.clone())])
        }
        AccountInputVerdict::BoardHankoRefreshApplied { events } => {
            tuple(vec![integer(14), frame_events(events)])
        }
        AccountInputVerdict::BoardHankoRefreshRejected { reason } => {
            tuple(vec![integer(15), AbiValue::Text(reason.clone())])
        }
    })
}

fn is_ack_verdict(value: &xln_rscore_batch::AccountInputVerdict) -> bool {
    matches!(
        value,
        xln_rscore_batch::AccountInputVerdict::AckCommitted { .. }
            | xln_rscore_batch::AccountInputVerdict::AckStale { .. }
            | xln_rscore_batch::AccountInputVerdict::AckRejected { .. }
    )
}

fn is_frame_verdict(value: &xln_rscore_batch::AccountInputVerdict) -> bool {
    matches!(
        value,
        xln_rscore_batch::AccountInputVerdict::FrameCommitted { .. }
            | xln_rscore_batch::AccountInputVerdict::FrameCollisionIgnored { .. }
            | xln_rscore_batch::AccountInputVerdict::FrameDuplicate { .. }
            | xln_rscore_batch::AccountInputVerdict::FrameStale { .. }
            | xln_rscore_batch::AccountInputVerdict::FrameDisputeRequired { .. }
            | xln_rscore_batch::AccountInputVerdict::FrameRejected { .. }
    )
}

/// The exact inverse of `decode_tx` (wire_decode.rs): same tags, same field
/// order, so a frame this engine proposes decodes back into the same
/// transactions on the other side.
pub(crate) fn tx(value: &xln_rscore_engine::AccountTx) -> Result<AbiValue, crate::ProcessError> {
    xln_rscore_batch::encode_account_tx(value).map_err(Into::into)
}

pub(crate) fn big(value: &num_bigint::BigInt) -> AbiValue {
    xln_rscore_batch::encode_bigint(value)
}
