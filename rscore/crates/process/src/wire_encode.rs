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

/// One account's committed leaf projection: the field names and their
/// canonical values, in the order the engine holds them.
pub fn account_envelope(
    revision: u64,
    fields: &[(String, xln_rscore_engine::CanonicalValue)],
) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            fields
                .iter()
                .map(|(name, value)| {
                    tuple(vec![
                        AbiValue::Text(name.clone()),
                        crate::canonical::canonical_wire(value),
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
        AccountOutput::SwapOfferRemove { offer_id } => {
            tuple(vec![AbiValue::Integer(4), AbiValue::Text(offer_id.clone())])
        }
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

/// What one wave produced, against a candidate the runtime has not committed.
pub fn wave(
    result: &xln_rscore_batch::WaveResult,
    engine_micros: u64,
) -> Result<BodyTuple, crate::ProcessError> {
    Ok(body(wave_fields(result, engine_micros)?))
}

/// The first staged reply also carries the opaque capability that names this
/// candidate. Later replies remain the canonical nine-field Wave value.
pub fn prepared_wave(
    result: &xln_rscore_batch::WaveResult,
    engine_micros: u64,
    candidate_token: &[u8; 32],
) -> Result<BodyTuple, crate::ProcessError> {
    let mut fields = wave_fields(result, engine_micros)?;
    fields.push(AbiValue::Bytes(candidate_token.to_vec()));
    Ok(body(fields))
}

/// One Entity round in the same canonical shape a wave reply has, so the
/// caller decodes both with one decoder.
pub fn round(
    result: &xln_rscore_batch::EntityRoundResult,
    engine_micros: u64,
) -> Result<BodyTuple, crate::ProcessError> {
    Ok(body(round_fields(
        result.revision,
        result.accounts_root,
        &result.applied,
        &result.admissions,
        &result.proposals,
        &result.touched,
        &result.post_accounts,
        engine_micros,
    )?))
}

fn wave_fields(
    result: &xln_rscore_batch::WaveResult,
    engine_micros: u64,
) -> Result<Vec<AbiValue>, crate::ProcessError> {
    round_fields(
        result.revision,
        result.accounts_root,
        &result.applied,
        &result.admissions,
        &result.proposals,
        &result.touched,
        &result.post_accounts,
        engine_micros,
    )
}

#[allow(clippy::too_many_arguments)]
fn round_fields(
    revision: u64,
    accounts_root: [u8; 32],
    applied_rows: &[xln_rscore_batch::AccountInputResult],
    admission_rows: &[xln_rscore_batch::AccountAdmissionResult],
    proposal_rows: &[xln_rscore_batch::ProposalRow],
    touched_rows: &[(xln_rscore_batch::AccountId, [u8; 32])],
    post_account_rows: &[xln_rscore_batch::AccountCheckpointRows],
    engine_micros: u64,
) -> Result<Vec<AbiValue>, crate::ProcessError> {
    let mut proposals = Vec::with_capacity(proposal_rows.len());
    for row in proposal_rows {
        proposals.push(proposal(row)?);
    }
    let applied = tuple(
        applied_rows
            .iter()
            .map(input_result)
            .collect::<Result<Vec<_>, _>>()?,
    );
    let admissions = tuple(admission_rows.iter().map(admission_result).collect());
    let touched = tuple(
        touched_rows
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
        post_account_rows
            .iter()
            .map(|row| crate::checkpoint_wire::account_rows(row, false))
            .collect::<Result<_, _>>()?,
    );
    let digest = parity_digest(accounts_root, &touched, &applied, &admissions, &proposals)?;
    Ok(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
        applied,
        admissions,
        proposals,
        touched,
        post_accounts,
        AbiValue::Bytes(digest.to_vec()),
        // Wall time inside the engine, so a caller can tell the cost of the
        // work from the cost of reaching it. Excluded from the parity digest:
        // it is a measurement of this run, not part of what the two engines
        // must agree on.
        integer(engine_micros),
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
) -> Result<[u8; 32], crate::ProcessError> {
    use sha2::{Digest, Sha256};
    // The transcript is the four values themselves, not a body: a reply wraps
    // its fields in one more tuple, and hashing that wrapper would make the
    // digest describe the envelope rather than the wave.
    let transcript = xln_rscore_abi::BodyTuple::from_array([
        AbiValue::Bytes(accounts_root.to_vec()),
        touched.clone(),
        applied.clone(),
        admissions.clone(),
        proposals.clone(),
    ]);
    let encoded = xln_rscore_abi::encode_tuple(&transcript)?;
    let mut digest = Sha256::new();
    digest.update(WAVE_PARITY_DOMAIN.as_bytes());
    digest.update(&encoded);
    Ok(digest.finalize().into())
}

const WAVE_PARITY_DOMAIN: &str = "xln.rscore.wave-parity.v1";

/// Where the accounts stand after marking, keeping or undoing a savepoint.
pub fn savepoint(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

pub fn wave_committed(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

pub fn wave_aborted(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

/// Exact acknowledgement of one parent Entity-input savepoint operation.
///
/// This intentionally carries the candidate revision and forest root beside
/// the idempotency receipt. The runtime can therefore prove that an accepted
/// stage retained its Account mutations and a discarded stage restored the
/// exact pre-input candidate before it decides what enters the Runtime WAL.
pub fn entity_stage(
    receipt: &xln_rscore_batch::EntityStageReceipt,
    revision: u64,
    accounts_root: [u8; 32],
) -> Result<BodyTuple, crate::ProcessError> {
    use xln_rscore_batch::EntityStageStatus;

    let status = match receipt.status {
        EntityStageStatus::Open => 0,
        EntityStageStatus::Accepted => 1,
        EntityStageStatus::RolledBack => 2,
    };
    Ok(body(vec![
        AbiValue::Bytes(receipt.key.as_bytes().to_vec()),
        integer(status),
        integer(receipt.accepted_stage_ordinal),
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ]))
}

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
        match row.proposed.as_ref().and_then(|row| row.bundled_ack.as_ref()) {
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
        AbiValue::Bool(frame.by_left),
        tuple(frame.deltas.iter().map(delta).collect()),
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

/// One delta as the frame commits it. Same field order as `decode_delta`
/// (wire_decode.rs), which is the order the frame hash reads them in.
pub(crate) fn delta(value: &xln_rscore_engine::Delta) -> AbiValue {
    use xln_rscore_engine::Side;
    tuple(vec![
        integer(value.token_id().get()),
        big(value.collateral()),
        big(value.ondelta()),
        big(value.offdelta()),
        big(value.left_credit_limit()),
        big(value.right_credit_limit()),
        big(value.allowance(Side::Left)),
        big(value.allowance(Side::Right)),
        big(value.hold(Side::Left)),
        big(value.hold(Side::Right)),
    ])
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
            | xln_rscore_batch::AccountInputVerdict::FrameRejected { .. }
    )
}

/// The exact inverse of `decode_tx` (wire_decode.rs): same tags, same field
/// order, so a frame this engine proposes decodes back into the same
/// transactions on the other side.
pub(crate) fn tx(value: &xln_rscore_engine::AccountTx) -> Result<AbiValue, crate::ProcessError> {
    use xln_rscore_engine::{AccountTx, HtlcDeliveryMode, HtlcResolveOutcome};
    let fields = match value {
        AccountTx::DirectPayment {
            token_id,
            amount,
            route,
            description,
            from_entity_id,
            to_entity_id,
            delivery_mode,
            trusted_gateway_entity_id,
        } => vec![
            integer(0),
            integer(token_id.get()),
            big(amount),
            tuple(
                route
                    .iter()
                    .map(|hop| AbiValue::Text(hop.clone()))
                    .collect(),
            ),
            optional_text(description),
            AbiValue::Text(from_entity_id.clone()),
            AbiValue::Text(to_entity_id.clone()),
            integer(match delivery_mode {
                DeliveryMode::Direct => 0,
                DeliveryMode::Trusted => 1,
            }),
            optional_text(trusted_gateway_entity_id),
        ],
        AccountTx::HtlcLock(lock) => vec![
            integer(1),
            AbiValue::Text(lock.lock_id.clone()),
            hex_bytes(lock.hashlock.as_str(), 32),
            big(&lock.timelock),
            integer(lock.reveal_before_height),
            big(&lock.amount),
            integer(lock.token_id.get()),
            match lock.delivery_mode {
                None => AbiValue::Nil,
                Some(HtlcDeliveryMode::Instant) => integer(0),
                Some(HtlcDeliveryMode::Async) => integer(1),
            },
            match &lock.envelope {
                None => AbiValue::Nil,
                Some(envelope) => AbiValue::Bytes(envelope.packed().to_vec()),
            },
        ],
        AccountTx::HtlcResolve(resolve) => {
            let (outcome, payload) = match &resolve.outcome {
                HtlcResolveOutcome::Secret { secret } => (integer(0), hex_bytes(secret, 32)),
                HtlcResolveOutcome::Error { reason } => (integer(1), optional_text(reason)),
            };
            vec![
                integer(2),
                AbiValue::Text(resolve.lock_id.clone()),
                outcome,
                payload,
            ]
        }
        AccountTx::AddDelta { token_id } => vec![integer(3), integer(token_id.get())],
        AccountTx::SetCreditLimit { token_id, amount } => {
            vec![integer(4), integer(token_id.get()), big(amount)]
        }
        AccountTx::RebalancePolicy {
            token_id,
            policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
        } => vec![
            integer(5),
            integer(*token_id),
            integer(*policy_version),
            big(base_fee),
            big(liquidity_fee_bps),
            big(gas_fee),
        ],
        AccountTx::SwapOffer {
            offer_id,
            give_token_id,
            give_token_decimals,
            give_amount,
            want_token_id,
            want_token_decimals,
            want_amount,
            max_fee,
            min_net_receive,
            time_in_force,
            price_ticks,
        } => vec![
            integer(6),
            AbiValue::Text(offer_id.clone()),
            integer(*give_token_id),
            integer(*give_token_decimals),
            big(give_amount),
            integer(*want_token_id),
            integer(*want_token_decimals),
            big(want_amount),
            big(max_fee),
            big(min_net_receive),
            time_in_force.map_or(AbiValue::Nil, integer),
            optional_big(price_ticks),
        ],
        AccountTx::SwapCancelRequest { offer_id } => {
            vec![integer(7), AbiValue::Text(offer_id.clone())]
        }
        AccountTx::SwapResolve {
            offer_id,
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            comment,
            fee_token_id,
            fee_amount,
            execution_give_amount,
            execution_want_amount,
            resting_give_token_id,
            resting_want_token_id,
            resting_price_ticks,
            resting_give_amount,
            resting_want_amount,
            resting_quantized_give,
            resting_quantized_want,
        } => vec![
            integer(8),
            AbiValue::Text(offer_id.clone()),
            integer(*fill_ratio),
            optional_big(fill_numerator),
            optional_big(fill_denominator),
            // 0/1, not a boolean: the decoder reads an integer here and so
            // does TypeScript's encoder. A boolean produced a swap_resolve
            // this ABI could not read back.
            integer(u8::from(*cancel_remainder)),
            comment
                .as_ref()
                .map_or(AbiValue::Nil, |value| AbiValue::Text(value.clone())),
            resting_give_token_id.map_or(AbiValue::Nil, integer),
            resting_want_token_id.map_or(AbiValue::Nil, integer),
            fee_token_id.map_or(AbiValue::Nil, integer),
            optional_big(fee_amount),
            optional_big(execution_give_amount),
            optional_big(execution_want_amount),
            optional_big(resting_price_ticks),
            optional_big(resting_give_amount),
            optional_big(resting_want_amount),
            optional_big(resting_quantized_give),
            optional_big(resting_quantized_want),
        ],
        // Every kind the frame hash cannot express is refused at admission, so
        // one cannot reach a proposal.
        other => {
            return Err(crate::ProcessError::Unsupported(
                xln_rscore_engine::StateError::UnsupportedFrameTx(
                    xln_rscore_engine::unsupported_frame_tx_kind(other),
                )
                .to_string(),
            ));
        }
    };
    Ok(tuple(fields))
}

/// A `0x`-prefixed hex string as the bytes the decoder expects. The wire is
/// binary for fixed-width identifiers: encoding one as text here would produce
/// a frame this ABI cannot read back.
fn hex_bytes(value: &str, length: usize) -> AbiValue {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    let mut bytes = Vec::with_capacity(length);
    for pair in hex.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair).unwrap_or("");
        bytes.push(u8::from_str_radix(text, 16).unwrap_or(0));
    }
    AbiValue::Bytes(bytes)
}

pub(crate) fn big(value: &num_bigint::BigInt) -> AbiValue {
    AbiValue::Text(value.to_string())
}

fn optional_big(value: &Option<num_bigint::BigInt>) -> AbiValue {
    value.as_ref().map_or(AbiValue::Nil, big)
}
