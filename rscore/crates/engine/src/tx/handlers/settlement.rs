use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_account_state_value};

use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountExecutionContext, AccountRejection, AccountReplica, Side, TokenId, TransitionError,
    ValidationRejection,
};

const WORKSPACE_DOMAIN: &str = "xln:settlement-workspace:v1";
const MERKLE_LEAF_DOMAIN: &str = "xln.storage.merkle.leaf.v1";
const MAX_SETTLEMENT_ROWS: usize = 32;

#[derive(Clone)]
struct OpDiff {
    token_id: TokenId,
    left: BigInt,
    right: BigInt,
    collateral: BigInt,
    ondelta: BigInt,
}

struct CompiledOps {
    diffs: Vec<OpDiff>,
    forgive: Vec<TokenId>,
}

struct WorkspaceView<'a> {
    fields: &'a [(String, CanonicalValue)],
    revision: u64,
    workspace_hash: &'a str,
    ops: &'a [CanonicalValue],
    last_modified_by_left: bool,
    executor_is_left: bool,
    status: &'a str,
    memo: Option<&'a str>,
}

pub(crate) fn apply(
    account: &mut AccountReplica,
    data: &CanonicalValue,
    proposer: Side,
    context: &AccountExecutionContext,
) -> Result<MutationDecision, TransitionError> {
    let fields = match object(data, "SETTLEMENT_TRANSITION_DATA_OBJECT") {
        Ok(fields) => fields,
        Err(message) => return Ok(rejected(message)),
    };
    let kind = match required(fields, "kind")
        .and_then(|value| string(value, "SETTLEMENT_TRANSITION_KIND"))
    {
        Ok(kind) => kind,
        Err(message) => return Ok(rejected(message)),
    };
    let result = match kind {
        "upsert" => apply_upsert(account, fields, proposer, context.committed_timestamp),
        "hanko" => apply_hanko(account, fields, proposer, context),
        "submit" => apply_submit(account, fields, proposer, context.committed_timestamp),
        "clear" => apply_clear(account, fields),
        _ => Err(format!("SETTLEMENT_TRANSITION_KIND_INVALID:{kind}")),
    };
    Ok(match result {
        Ok(event) => MutationDecision::applied(vec![event]),
        Err(message) => rejected(message),
    })
}

/// Consume one finalized Depository settlement against the exact signed
/// workspace already committed by Account consensus.  The returned effect is
/// replica-envelope work (proof/Hanko authority), not another stored state:
/// the AccountConsensus caller consumes it before it publishes the candidate.
pub(crate) fn apply_finalized_account_settlement(
    account: &mut AccountReplica,
    finalized_nonce: u64,
) -> Result<Option<crate::tx::apply_types::AccountConsensusEffect>, String> {
    let Some(stored) = account.state().settlement_workspace().cloned() else {
        return Ok(None);
    };
    let workspace = workspace_view(&stored)?;
    let signed = optional_nonempty_string(workspace.fields, "settlementHash").is_some()
        || optional_nonempty_string(workspace.fields, "leftHanko").is_some()
        || optional_nonempty_string(workspace.fields, "rightHanko").is_some()
        || field(workspace.fields, "postSettlementDisputeProof").is_some();
    if !signed {
        clear_finalized_workspace(account, &workspace)?;
        return Ok(None);
    }
    let signed_nonce = positive_safe_number(
        required(workspace.fields, "nonceAtSign")?,
        "SETTLEMENT_SIGNED_NONCE_MISSING",
    )?;
    if finalized_nonce < signed_nonce {
        return Ok(None);
    }
    if finalized_nonce > signed_nonce {
        clear_finalized_workspace(account, &workspace)?;
        return Ok(None);
    }
    let proof = object(
        required(workspace.fields, "postSettlementDisputeProof")?,
        "POST_SETTLEMENT_PROOF_MISSING",
    )?;
    let proof_nonce = positive_safe_number(
        required(proof, "nonce")?,
        "POST_SETTLEMENT_PROOF_NONCE_MISMATCH",
    )?;
    if proof_nonce != signed_nonce.saturating_add(1) {
        return Err(format!(
            "POST_SETTLEMENT_PROOF_NONCE_MISMATCH:{proof_nonce}:{}",
            signed_nonce.saturating_add(1)
        ));
    }
    let left_hanko = decode_hex_bytes(exact_hanko_text(
        proof,
        "leftHanko",
        "POST_SETTLEMENT_PROOF_HANKO_MISSING",
    )?)?;
    let right_hanko = decode_hex_bytes(exact_hanko_text(
        proof,
        "rightHanko",
        "POST_SETTLEMENT_PROOF_HANKO_MISSING",
    )?)?;
    let dispute_hash = decode_hash(
        optional_nonempty_string(proof, "disputeHash")
            .ok_or("POST_SETTLEMENT_DISPUTE_HASH_MISSING")?,
    )?;
    let proof_body_hash = decode_hash(
        optional_nonempty_string(proof, "proofBodyHash")
            .ok_or("POST_SETTLEMENT_PROOF_BODY_HASH_MISSING")?,
    )?;
    let proposer_is_left = boolean(
        required(proof, "proposerIsLeft")?,
        "POST_SETTLEMENT_PROPOSER_INVALID",
    )?;
    let transformer = account
        .delta_transformer()
        .ok_or("SETTLEMENT_DELTA_TRANSFORMER_MISSING")?;
    let finalized_body =
        crate::proof_body_hash(account, transformer).map_err(|error| error.to_string())?;
    if finalized_body != proof_body_hash {
        return Err(format!(
            "POST_SETTLEMENT_FINALIZED_PROOF_BODY_MISMATCH:{}:{}",
            hex_hash(proof_body_hash),
            hex_hash(finalized_body)
        ));
    }
    let (local_hanko, counterparty_hanko) = if account.owner_side() == Side::Left {
        (left_hanko, right_hanko)
    } else {
        (right_hanko, left_hanko)
    };
    let local = crate::DisputeDraft {
        hanko: Some(local_hanko),
        hash: dispute_hash,
        proof_body_hash,
        nonce: proof_nonce,
        proposer_is_left,
    };
    let counterparty = crate::CounterpartyDispute {
        hanko: Some(counterparty_hanko),
        hash: dispute_hash,
        proof_body_hash,
        nonce: proof_nonce,
        proposer_is_left,
    };
    clear_finalized_workspace(account, &workspace)?;
    Ok(Some(
        crate::tx::apply_types::AccountConsensusEffect::ActivatePostSettlementProof {
            local,
            counterparty,
            next_proof_nonce: proof_nonce
                .saturating_add(1)
                .max(finalized_nonce.saturating_add(1)),
        },
    ))
}

fn clear_finalized_workspace(
    account: &mut AccountReplica,
    workspace: &WorkspaceView<'_>,
) -> Result<(), String> {
    let mut planned = BTreeMap::new();
    if workspace.status != "submitted" {
        plan_hold_release(account, workspace, &mut planned)?;
    }
    publish_deltas(account, planned)?;
    account.state_mut().clear_settlement_workspace();
    Ok(())
}

fn apply_upsert(
    account: &mut AccountReplica,
    fields: &[(String, CanonicalValue)],
    proposer: Side,
    timestamp: u64,
) -> Result<String, String> {
    let revision = positive_safe_number(
        required(fields, "revision")?,
        "SETTLEMENT_WORKSPACE_VERSION_INVALID",
    )?;
    let ops_value = required(fields, "ops")?;
    let ops = array(ops_value, "SETTLEMENT_WORKSPACE_OPS_EMPTY")?;
    if ops.is_empty() {
        return Err("SETTLEMENT_WORKSPACE_OPS_EMPTY".into());
    }
    let executor = boolean(
        required(fields, "executorIsLeft")?,
        "SETTLEMENT_WORKSPACE_EXECUTOR_INVALID",
    )?;
    let memo = optional_string(fields, "memo", "SETTLEMENT_WORKSPACE_MEMO_INVALID")?;
    let current = account.state().settlement_workspace().cloned();
    validate_upsert_predecessor(account, current.as_ref(), fields, revision)?;
    let compiled = compile_ops(ops, proposer == Side::Left)?;
    let workspace = unsigned_workspace(
        account,
        revision,
        ops_value.clone(),
        proposer == Side::Left,
        executor,
        memo,
        current.as_ref(),
        timestamp,
    )?;
    let mut planned = BTreeMap::new();
    if let Some(previous) = current.as_ref() {
        plan_hold_release(account, &workspace_view(previous)?, &mut planned)?;
    }
    plan_hold_add(account, &compiled.diffs, &mut planned)?;
    publish_deltas(account, planned)?;
    account.state_mut().set_settlement_workspace(workspace);
    Ok(format!("Settlement workspace v{revision} committed"))
}

fn apply_hanko(
    account: &mut AccountReplica,
    fields: &[(String, CanonicalValue)],
    proposer: Side,
    context: &AccountExecutionContext,
) -> Result<String, String> {
    let binding = context
        .settlement
        .as_ref()
        .ok_or("SETTLEMENT_HANKO_CONTEXT_MISSING")?;
    let stored = account
        .state()
        .settlement_workspace()
        .cloned()
        .ok_or("SETTLEMENT_WORKSPACE_MISSING")?;
    let workspace = current_workspace(account, &stored, fields)?;
    if workspace.status == "submitted" {
        return Err("SETTLEMENT_HANKO_SUBMITTED_FORBIDDEN".into());
    }
    let settlement_nonce = positive_safe_number(
        required(fields, "settlementNonce")?,
        "SETTLEMENT_HANKO_NONCE_INVALID",
    )?;
    assert_settlement_nonce(account, &workspace, settlement_nonce, binding)?;
    let compiled = compile_ops(workspace.ops, workspace.last_modified_by_left)?;
    let expected_settlement_hash = settlement_hash(account, &compiled, settlement_nonce)?;
    let supplied_settlement_hash = hex32(
        string(
            required(fields, "settlementHash")?,
            "SETTLEMENT_HANKO_HASH_INVALID",
        )?,
        "SETTLEMENT_HANKO_HASH_INVALID",
    )?;
    if supplied_settlement_hash != expected_settlement_hash {
        return Err(format!(
            "SETTLEMENT_HANKO_HASH_MISMATCH:{supplied_settlement_hash}:{expected_settlement_hash}"
        ));
    }
    if let Some(pinned) = optional_string_ref(
        workspace.fields,
        "settlementHash",
        "SETTLEMENT_HANKO_PINNED_HASH_INVALID",
    )? && pinned.to_ascii_lowercase() != expected_settlement_hash
    {
        return Err(format!(
            "SETTLEMENT_HANKO_PINNED_HASH_MISMATCH:{pinned}:{expected_settlement_hash}"
        ));
    }
    let post = object(
        required(fields, "postProof")?,
        "POST_SETTLEMENT_PROOF_INVALID",
    )?;
    let post_nonce = positive_safe_number(
        required(post, "nonce")?,
        "POST_SETTLEMENT_PROOF_NONCE_INVALID",
    )?;
    if settlement_nonce.checked_add(1) != Some(post_nonce) {
        return Err(format!(
            "POST_SETTLEMENT_PROOF_NONCE_MISMATCH:{post_nonce}:{}",
            settlement_nonce.saturating_add(1)
        ));
    }
    let proposer_is_left = boolean(
        required(post, "proposerIsLeft")?,
        "POST_SETTLEMENT_PROOF_PROPOSER_INVALID",
    )?;
    let proof_body_hash = projected_proof_body_hash(account, &compiled)?;
    let supplied_body = hex32(
        string(
            required(post, "proofBodyHash")?,
            "POST_SETTLEMENT_PROOF_BODY_HASH_INVALID",
        )?,
        "POST_SETTLEMENT_PROOF_BODY_HASH_INVALID",
    )?;
    let expected_body = hex_hash(proof_body_hash);
    if supplied_body != expected_body {
        return Err(format!(
            "POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH:{supplied_body}:{expected_body}"
        ));
    }
    let identity = account.state().identity();
    let expected_dispute = crate::dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.left().as_bytes(),
        identity.right().as_bytes(),
        post_nonce,
        proposer_is_left,
        &proof_body_hash,
        identity.watch_seed().bytes(),
    );
    let expected_dispute_hash = hex_hash(expected_dispute);
    let supplied_dispute = hex32(
        string(
            required(post, "disputeHash")?,
            "POST_SETTLEMENT_DISPUTE_HASH_INVALID",
        )?,
        "POST_SETTLEMENT_DISPUTE_HASH_INVALID",
    )?;
    if supplied_dispute != expected_dispute_hash {
        return Err(format!(
            "POST_SETTLEMENT_DISPUTE_HASH_MISMATCH:{supplied_dispute}:{expected_dispute_hash}"
        ));
    }
    assert_pinned_post_proof(
        &workspace,
        post_nonce,
        &expected_body,
        &expected_dispute_hash,
        proposer_is_left,
    )?;
    let source = account.state().identity().entity(proposer);
    let post_hanko_text = exact_hanko_text(post, "hanko", "POST_SETTLEMENT_PROOF_HANKO_MISSING")?;
    let post_hanko = decode_hex_bytes(post_hanko_text)?;
    crate::consensus::signing::verify_dispute_hanko_with_authority(
        &post_hanko,
        &expected_dispute,
        source.as_bytes(),
        binding.proposer_board_authority.as_ref(),
        context.committed_timestamp,
        true,
    )
    .map_err(|_| "POST_SETTLEMENT_PROOF_HANKO_INVALID".to_string())?;
    let source_is_executor = workspace.executor_is_left == (proposer == Side::Left);
    let settlement_hanko_text =
        optional_nonempty_string(fields, "settlementHanko").map(str::to_owned);
    let settlement_hanko = settlement_hanko_text
        .as_deref()
        .map(decode_hex_bytes)
        .transpose()?;
    if source_is_executor && settlement_hanko.is_some() {
        return Err("SETTLEMENT_EXECUTOR_HANKO_FORBIDDEN".into());
    }
    if !source_is_executor {
        let settlement_hanko = settlement_hanko
            .as_ref()
            .ok_or("SETTLEMENT_NONEXECUTOR_HANKO_MISSING")?;
        crate::consensus::signing::verify_frame_hanko_with_authority(
            settlement_hanko,
            &decode_hash(&expected_settlement_hash)?,
            source.as_bytes(),
            binding.proposer_board_authority.as_ref(),
        )
        .map_err(|_| "SETTLEMENT_NONEXECUTOR_HANKO_INVALID".to_string())?;
    }
    let next = commit_hanko(
        &workspace,
        proposer,
        context.committed_timestamp,
        settlement_nonce,
        &compiled,
        &expected_settlement_hash,
        &expected_body,
        &expected_dispute_hash,
        post_nonce,
        proposer_is_left,
        post_hanko_text,
        settlement_hanko_text.as_deref(),
    )?;
    account.state_mut().set_settlement_workspace(next);
    Ok(format!(
        "Settlement workspace v{} Hanko attached",
        workspace.revision
    ))
}

fn assert_settlement_nonce(
    account: &AccountReplica,
    workspace: &WorkspaceView<'_>,
    supplied: u64,
    binding: &crate::SettlementExecutionContext,
) -> Result<(), String> {
    if let Some(pinned) = field(workspace.fields, "nonceAtSign") {
        let pinned = positive_safe_number(pinned, "SETTLEMENT_HANKO_NONCE_INVALID")?;
        return if pinned == supplied {
            Ok(())
        } else {
            Err(format!(
                "SETTLEMENT_HANKO_NONCE_MISMATCH:{pinned}:{supplied}"
            ))
        };
    }
    let minimum = account
        .state()
        .j_nonce()
        .saturating_add(1)
        .max(binding.next_proof_nonce)
        .max(
            binding
                .current_dispute_proof_nonce
                .unwrap_or(0)
                .saturating_add(1),
        )
        .max(
            binding
                .counterparty_dispute_proof_nonce
                .unwrap_or(0)
                .saturating_add(1),
        );
    if supplied != minimum {
        return Err(format!(
            "SETTLEMENT_HANKO_NONCE_MISMATCH:{supplied}:{minimum}:j={}:next={}:local={}:peer={}",
            account.state().j_nonce(),
            binding.next_proof_nonce,
            binding.current_dispute_proof_nonce.unwrap_or(0),
            binding.counterparty_dispute_proof_nonce.unwrap_or(0),
        ));
    }
    Ok(())
}

fn projected_proof_body_hash(
    account: &AccountReplica,
    compiled: &CompiledOps,
) -> Result<[u8; 32], String> {
    let transformer = account
        .delta_transformer()
        .ok_or("SETTLEMENT_DELTA_TRANSFORMER_MISSING")?;
    let mut projected = account.clone();
    for diff in &compiled.diffs {
        let mut delta = projected
            .state()
            .delta_or_zero(diff.token_id)
            .map_err(|error| error.to_string())?;
        delta
            .apply_j_settlement(
                &(delta.collateral() + &diff.collateral),
                &(delta.ondelta() + &diff.ondelta),
            )
            .map_err(|error| error.to_string())?;
        projected
            .state_mut()
            .put_delta(delta)
            .map_err(|error| error.to_string())?;
    }
    for token in &compiled.forgive {
        if projected.state().delta(*token).is_none() {
            let delta = projected
                .state()
                .delta_or_zero(*token)
                .map_err(|error| error.to_string())?;
            projected
                .state_mut()
                .put_delta(delta)
                .map_err(|error| error.to_string())?;
        }
    }
    crate::proof_body_hash(&projected, transformer).map_err(|error| error.to_string())
}

fn settlement_hash(
    account: &AccountReplica,
    compiled: &CompiledOps,
    nonce: u64,
) -> Result<String, String> {
    let identity = account.state().identity();
    let head_size = 7 * 32;
    let account_key_size = 32 + 64;
    let diffs_size = 32 + compiled.diffs.len() * 5 * 32;
    let mut encoded = Vec::with_capacity(
        head_size + account_key_size + diffs_size + 32 + compiled.forgive.len() * 32,
    );
    encoded.extend_from_slice(&abi_u64(0));
    encoded.extend_from_slice(&abi_u64(identity.domain().chain_id()));
    encoded.extend_from_slice(&abi_address(identity.domain().depository_address().bytes()));
    encoded.extend_from_slice(&abi_u64(head_size as u64));
    encoded.extend_from_slice(&abi_u64(nonce));
    encoded.extend_from_slice(&abi_u64((head_size + account_key_size) as u64));
    encoded.extend_from_slice(&abi_u64((head_size + account_key_size + diffs_size) as u64));
    encoded.extend_from_slice(&abi_u64(64));
    encoded.extend_from_slice(identity.left().as_bytes());
    encoded.extend_from_slice(identity.right().as_bytes());
    encoded.extend_from_slice(&abi_u64(compiled.diffs.len() as u64));
    for diff in &compiled.diffs {
        encoded.extend_from_slice(&abi_u64(u64::from(diff.token_id.get())));
        encoded.extend_from_slice(&abi_int(&diff.left)?);
        encoded.extend_from_slice(&abi_int(&diff.right)?);
        encoded.extend_from_slice(&abi_int(&diff.collateral)?);
        encoded.extend_from_slice(&abi_int(&diff.ondelta)?);
    }
    encoded.extend_from_slice(&abi_u64(compiled.forgive.len() as u64));
    for token in &compiled.forgive {
        encoded.extend_from_slice(&abi_u64(u64::from(token.get())));
    }
    Ok(hex_hash(Keccak256::digest(encoded).into()))
}

#[allow(clippy::too_many_arguments)]
fn commit_hanko(
    workspace: &WorkspaceView<'_>,
    proposer: Side,
    timestamp: u64,
    settlement_nonce: u64,
    compiled: &CompiledOps,
    settlement_hash: &str,
    proof_body_hash: &str,
    dispute_hash: &str,
    post_nonce: u64,
    proposer_is_left: bool,
    post_hanko: &str,
    settlement_hanko: Option<&str>,
) -> Result<CanonicalValue, String> {
    let prior_post = field(workspace.fields, "postSettlementDisputeProof")
        .map(|value| object(value, "POST_SETTLEMENT_PROOF_PIN_MISMATCH"))
        .transpose()?;
    let post_side = if proposer == Side::Left {
        "leftHanko"
    } else {
        "rightHanko"
    };
    assert_same_hanko(
        prior_post.and_then(|proof| optional_nonempty_string(proof, post_side)),
        post_hanko,
        "POST_SETTLEMENT_PROOF_EQUIVOCATION",
    )?;
    let settlement_side = if proposer == Side::Left {
        "leftHanko"
    } else {
        "rightHanko"
    };
    if let Some(hanko) = settlement_hanko {
        assert_same_hanko(
            optional_nonempty_string(workspace.fields, settlement_side),
            hanko,
            "SETTLEMENT_HANKO_EQUIVOCATION",
        )?;
    }
    let mut post_fields = vec![
        (
            "disputeHash".into(),
            CanonicalValue::String(dispute_hash.into()),
        ),
        (
            "proofBodyHash".into(),
            CanonicalValue::String(proof_body_hash.into()),
        ),
        ("nonce".into(), number(post_nonce)?),
        (
            "proposerIsLeft".into(),
            CanonicalValue::Bool(proposer_is_left),
        ),
    ];
    for side in ["leftHanko", "rightHanko"] {
        if let Some(hanko) = prior_post.and_then(|proof| optional_nonempty_string(proof, side)) {
            post_fields.push((side.into(), CanonicalValue::String(hanko.into())));
        }
    }
    if let Some(value) = field_mut(&mut post_fields, post_side) {
        *value = CanonicalValue::String(post_hanko.into());
    } else {
        post_fields.push((post_side.into(), CanonicalValue::String(post_hanko.into())));
    }
    let compiled_diffs = CanonicalValue::Array(
        compiled
            .diffs
            .iter()
            .map(canonical_diff)
            .collect::<Result<_, _>>()?,
    );
    let forgive = CanonicalValue::Array(
        compiled
            .forgive
            .iter()
            .map(|token| CanonicalValue::Number(CanonicalNumber::from_u16(token.get())))
            .collect(),
    );
    let mut replacements = vec![
        ("compiledDiffs", compiled_diffs),
        ("compiledForgiveTokenIds", forgive),
        ("nonceAtSign", number(settlement_nonce)?),
        (
            "settlementHash",
            CanonicalValue::String(settlement_hash.into()),
        ),
        (
            "postSettlementDisputeProof",
            CanonicalValue::Object(post_fields.clone()),
        ),
        ("lastUpdatedAt", number(timestamp)?),
    ];
    if let Some(hanko) = settlement_hanko {
        replacements.push((settlement_side, CanonicalValue::String(hanko.into())));
    }
    let nonexecutor_side = if workspace.executor_is_left {
        "rightHanko"
    } else {
        "leftHanko"
    };
    let has_nonexecutor = replacements.iter().any(|(key, value)| {
        *key == nonexecutor_side
            && matches!(value, CanonicalValue::String(text) if !text.is_empty())
    }) || optional_nonempty_string(workspace.fields, nonexecutor_side)
        .is_some();
    let post_left = optional_nonempty_string(&post_fields, "leftHanko").is_some();
    let post_right = optional_nonempty_string(&post_fields, "rightHanko").is_some();
    replacements.push((
        "status",
        CanonicalValue::String(
            if has_nonexecutor && post_left && post_right {
                "ready_to_submit"
            } else {
                "awaiting_counterparty"
            }
            .into(),
        ),
    ));
    Ok(replace_fields(workspace.fields, &replacements))
}

fn assert_pinned_post_proof(
    workspace: &WorkspaceView<'_>,
    nonce: u64,
    body: &str,
    dispute: &str,
    proposer_is_left: bool,
) -> Result<(), String> {
    let Some(value) = field(workspace.fields, "postSettlementDisputeProof") else {
        return Ok(());
    };
    let proof = object(value, "POST_SETTLEMENT_PROOF_PIN_MISMATCH")?;
    let exact = safe_number(
        required(proof, "nonce")?,
        "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
    )? == nonce
        && hex32(
            string(
                required(proof, "proofBodyHash")?,
                "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
            )?,
            "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
        )? == body
        && hex32(
            string(
                required(proof, "disputeHash")?,
                "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
            )?,
            "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
        )? == dispute
        && boolean(
            required(proof, "proposerIsLeft")?,
            "POST_SETTLEMENT_PROOF_PIN_MISMATCH",
        )? == proposer_is_left;
    if exact {
        Ok(())
    } else {
        Err("POST_SETTLEMENT_PROOF_PIN_MISMATCH".into())
    }
}

fn canonical_diff(diff: &OpDiff) -> Result<CanonicalValue, String> {
    Ok(CanonicalValue::Object(vec![
        (
            "tokenId".into(),
            CanonicalValue::Number(CanonicalNumber::from_u16(diff.token_id.get())),
        ),
        ("leftDiff".into(), CanonicalValue::BigInt(diff.left.clone())),
        (
            "rightDiff".into(),
            CanonicalValue::BigInt(diff.right.clone()),
        ),
        (
            "collateralDiff".into(),
            CanonicalValue::BigInt(diff.collateral.clone()),
        ),
        (
            "ondeltaDiff".into(),
            CanonicalValue::BigInt(diff.ondelta.clone()),
        ),
    ]))
}

fn assert_same_hanko(existing: Option<&str>, supplied: &str, error: &str) -> Result<(), String> {
    if existing.is_some_and(|value| !value.eq_ignore_ascii_case(supplied)) {
        Err(error.into())
    } else {
        Ok(())
    }
}

fn exact_hanko_text<'a>(
    fields: &'a [(String, CanonicalValue)],
    key: &str,
    error: &str,
) -> Result<&'a str, String> {
    let value = optional_nonempty_string(fields, key).ok_or(error)?;
    if value == "0x" {
        return Err(error.into());
    }
    decode_hex_bytes(value)
        .map(|_| value)
        .map_err(|_| error.into())
}

fn decode_hex_bytes(value: &str) -> Result<Vec<u8>, String> {
    let body = value
        .strip_prefix("0x")
        .ok_or("SETTLEMENT_HANKO_HEX_INVALID")?;
    if body.is_empty() || body.len() % 2 != 0 || !body.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("SETTLEMENT_HANKO_HEX_INVALID".into());
    }
    body.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair)
                .map_err(|_| "SETTLEMENT_HANKO_HEX_INVALID".to_string())?;
            u8::from_str_radix(text, 16).map_err(|_| "SETTLEMENT_HANKO_HEX_INVALID".to_string())
        })
        .collect()
}

fn decode_hash(value: &str) -> Result<[u8; 32], String> {
    decode_hex_bytes(value)?
        .try_into()
        .map_err(|_| "SETTLEMENT_HASH_LENGTH_INVALID".into())
}

fn abi_u64(value: u64) -> [u8; 32] {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn abi_address(value: &[u8; 20]) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(value);
    word
}

fn abi_int(value: &BigInt) -> Result<[u8; 32], String> {
    let modulus = BigInt::from(1) << 256usize;
    let encoded = if value.sign() == num_bigint::Sign::Minus {
        &modulus + value
    } else {
        value.clone()
    };
    let (_, bytes) = encoded.to_bytes_be();
    if bytes.len() > 32 {
        return Err("SETTLEMENT_INT256_RANGE".into());
    }
    let mut word = [0; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(word)
}

fn apply_submit(
    account: &mut AccountReplica,
    fields: &[(String, CanonicalValue)],
    proposer: Side,
    timestamp: u64,
) -> Result<String, String> {
    let stored = account
        .state()
        .settlement_workspace()
        .cloned()
        .ok_or("SETTLEMENT_WORKSPACE_MISSING")?;
    let current = current_workspace(account, &stored, fields)?;
    if current.status == "submitted" {
        return Err("SETTLEMENT_WORKSPACE_ALREADY_SUBMITTED".into());
    }
    if (proposer == Side::Left) != current.executor_is_left {
        return Err("SETTLEMENT_SUBMIT_EXECUTOR_MISMATCH".into());
    }
    let counterparty_hanko = if proposer == Side::Left {
        "rightHanko"
    } else {
        "leftHanko"
    };
    if optional_nonempty_string(current.fields, counterparty_hanko).is_none() {
        return Err("SETTLEMENT_SUBMIT_COUNTERPARTY_HANKO_MISSING".into());
    }
    let proof = field(current.fields, "postSettlementDisputeProof")
        .and_then(|value| object(value, "SETTLEMENT_SUBMIT_POST_PROOF_INCOMPLETE").ok());
    if current.status != "ready_to_submit"
        || proof
            .and_then(|value| optional_nonempty_string(value, "leftHanko"))
            .is_none()
        || proof
            .and_then(|value| optional_nonempty_string(value, "rightHanko"))
            .is_none()
    {
        return Err("SETTLEMENT_SUBMIT_POST_PROOF_INCOMPLETE".into());
    }
    let mut planned = BTreeMap::new();
    plan_hold_release(account, &current, &mut planned)?;
    let submitted = replace_fields(
        current.fields,
        &[
            ("status", CanonicalValue::String("submitted".into())),
            ("lastUpdatedAt", number(timestamp)?),
        ],
    );
    publish_deltas(account, planned)?;
    account.state_mut().set_settlement_workspace(submitted);
    Ok(format!(
        "Settlement workspace v{} submitted",
        current.revision
    ))
}

fn apply_clear(
    account: &mut AccountReplica,
    fields: &[(String, CanonicalValue)],
) -> Result<String, String> {
    let stored = account
        .state()
        .settlement_workspace()
        .cloned()
        .ok_or("SETTLEMENT_WORKSPACE_MISSING")?;
    let current = current_workspace(account, &stored, fields)?;
    if current.status == "submitted" {
        return Err("SETTLEMENT_CLEAR_SUBMITTED_FORBIDDEN".into());
    }
    if !is_unsigned(&current) {
        return Err("SETTLEMENT_CLEAR_SIGNED_FORBIDDEN".into());
    }
    let mut planned = BTreeMap::new();
    plan_hold_release(account, &current, &mut planned)?;
    publish_deltas(account, planned)?;
    account.state_mut().clear_settlement_workspace();
    Ok(format!(
        "Settlement workspace v{} cleared",
        current.revision
    ))
}

fn validate_upsert_predecessor(
    account: &AccountReplica,
    current: Option<&CanonicalValue>,
    fields: &[(String, CanonicalValue)],
    revision: u64,
) -> Result<(), String> {
    if revision == 1 {
        if current.is_some() {
            return Err("SETTLEMENT_WORKSPACE_ALREADY_EXISTS".into());
        }
        if field(fields, "previousWorkspaceHash").is_some() {
            return Err("SETTLEMENT_WORKSPACE_PREVIOUS_HASH_UNEXPECTED".into());
        }
        return Ok(());
    }
    let current = current.ok_or("SETTLEMENT_WORKSPACE_PREVIOUS_MISSING")?;
    let view = workspace_view(current)?;
    if field(view.fields, "leftHanko").is_some() || field(view.fields, "rightHanko").is_some() {
        return Err("SETTLEMENT_WORKSPACE_SIGNED_UPDATE_FORBIDDEN".into());
    }
    if view.revision.checked_add(1) != Some(revision) {
        return Err(format!(
            "SETTLEMENT_WORKSPACE_NON_CONTIGUOUS_VERSION:{}:{revision}",
            view.revision
        ));
    }
    let current_hash = assert_workspace_hash(account, &view)?;
    let previous = hex32(
        string(
            required(fields, "previousWorkspaceHash")?,
            "SETTLEMENT_WORKSPACE_PREVIOUS_HASH_INVALID",
        )?,
        "SETTLEMENT_WORKSPACE_PREVIOUS_HASH_INVALID",
    )?;
    if current_hash != previous {
        return Err(format!(
            "SETTLEMENT_WORKSPACE_PREVIOUS_HASH_MISMATCH:{current_hash}:{previous}"
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn unsigned_workspace(
    account: &AccountReplica,
    revision: u64,
    ops: CanonicalValue,
    last_modified_by_left: bool,
    executor_is_left: bool,
    memo: Option<String>,
    current: Option<&CanonicalValue>,
    timestamp: u64,
) -> Result<CanonicalValue, String> {
    let created_at = current
        .map(workspace_view)
        .transpose()?
        .map_or(timestamp, |workspace| {
            number_u64(workspace.fields, "createdAt").unwrap_or(timestamp)
        });
    let mut fields = vec![
        (
            "workspaceHash".into(),
            CanonicalValue::String(String::new()),
        ),
        ("ops".into(), ops),
        (
            "lastModifiedByLeft".into(),
            CanonicalValue::Bool(last_modified_by_left),
        ),
        (
            "status".into(),
            CanonicalValue::String("awaiting_counterparty".into()),
        ),
    ];
    if let Some(memo) = memo {
        fields.push(("memo".into(), CanonicalValue::String(memo)));
    }
    fields.extend([
        ("revision".into(), number(revision)?),
        ("createdAt".into(), number(created_at)?),
        ("lastUpdatedAt".into(), number(timestamp)?),
        (
            "executorIsLeft".into(),
            CanonicalValue::Bool(executor_is_left),
        ),
    ]);
    let mut workspace = CanonicalValue::Object(fields);
    let view = workspace_view(&workspace)?;
    let hash = create_workspace_hash(account, &view)?;
    if let CanonicalValue::Object(fields) = &mut workspace {
        *field_mut(fields, "workspaceHash").expect("workspaceHash") = CanonicalValue::String(hash);
    }
    Ok(workspace)
}

fn current_workspace<'a>(
    account: &AccountReplica,
    workspace: &'a CanonicalValue,
    transition: &[(String, CanonicalValue)],
) -> Result<WorkspaceView<'a>, String> {
    let revision = positive_safe_number(
        required(transition, "revision")?,
        "SETTLEMENT_WORKSPACE_VERSION_INVALID",
    )?;
    let target = hex32(
        string(
            required(transition, "workspaceHash")?,
            "SETTLEMENT_WORKSPACE_TARGET_HASH_INVALID",
        )?,
        "SETTLEMENT_WORKSPACE_TARGET_HASH_INVALID",
    )?;
    let view = workspace_view(workspace)?;
    let current = assert_workspace_hash(account, &view)?;
    if view.revision != revision {
        return Err(format!(
            "SETTLEMENT_WORKSPACE_VERSION_MISMATCH:{}:{revision}",
            view.revision
        ));
    }
    if current != target {
        return Err(format!(
            "SETTLEMENT_WORKSPACE_TARGET_HASH_MISMATCH:{current}:{target}"
        ));
    }
    Ok(view)
}

fn workspace_view(value: &CanonicalValue) -> Result<WorkspaceView<'_>, String> {
    let fields = object(value, "SETTLEMENT_WORKSPACE_OBJECT_REQUIRED")?;
    let ops = array(required(fields, "ops")?, "SETTLEMENT_WORKSPACE_OPS_EMPTY")?;
    let view = WorkspaceView {
        fields,
        revision: positive_safe_number(
            required(fields, "revision")?,
            "SETTLEMENT_WORKSPACE_VERSION_INVALID",
        )?,
        workspace_hash: string(
            required(fields, "workspaceHash")?,
            "SETTLEMENT_WORKSPACE_HASH_INVALID",
        )?,
        ops,
        last_modified_by_left: boolean(
            required(fields, "lastModifiedByLeft")?,
            "SETTLEMENT_WORKSPACE_PHASE_INVALID",
        )?,
        executor_is_left: boolean(
            required(fields, "executorIsLeft")?,
            "SETTLEMENT_WORKSPACE_PHASE_INVALID",
        )?,
        status: string(
            required(fields, "status")?,
            "SETTLEMENT_WORKSPACE_PHASE_INVALID",
        )?,
        memo: optional_string_ref(fields, "memo", "SETTLEMENT_WORKSPACE_MEMO_INVALID")?,
    };
    match view.status {
        "draft" | "awaiting_counterparty" | "ready_to_submit" | "submitted" => Ok(view),
        status => Err(format!("SETTLEMENT_WORKSPACE_PHASE_INVALID:{status}")),
    }
}

fn assert_workspace_hash(
    account: &AccountReplica,
    workspace: &WorkspaceView<'_>,
) -> Result<String, String> {
    let stored = hex32(
        workspace.workspace_hash,
        "SETTLEMENT_WORKSPACE_HASH_INVALID",
    )?;
    let expected = create_workspace_hash(account, workspace)?;
    if stored != expected {
        return Err(format!(
            "SETTLEMENT_WORKSPACE_HASH_CORRUPTION:{stored}:{expected}"
        ));
    }
    Ok(expected)
}

fn create_workspace_hash(
    account: &AccountReplica,
    workspace: &WorkspaceView<'_>,
) -> Result<String, String> {
    let identity = account.state().identity();
    settlement_workspace_body_hash(
        &identity.left().to_string().to_lowercase(),
        &identity.right().to_string().to_lowercase(),
        workspace.revision,
        workspace.ops,
        workspace.last_modified_by_left,
        workspace.executor_is_left,
        workspace.memo,
    )
}

/// Canonical settlement workspace identity shared by Entity admission and the
/// Account transition.  Entity must pin continuation/deferred work before the
/// Account frame commits, so both layers call this one protocol function
/// instead of carrying a second hash implementation.
pub fn settlement_workspace_body_hash(
    left_entity: &str,
    right_entity: &str,
    revision: u64,
    ops: &[CanonicalValue],
    last_modified_by_left: bool,
    executor_is_left: bool,
    memo: Option<&str>,
) -> Result<String, String> {
    let mut body = vec![
        (
            "domain".into(),
            CanonicalValue::String(WORKSPACE_DOMAIN.into()),
        ),
        (
            "leftEntity".into(),
            CanonicalValue::String(left_entity.to_string()),
        ),
        (
            "rightEntity".into(),
            CanonicalValue::String(right_entity.to_string()),
        ),
        ("revision".into(), number(revision)?),
        ("ops".into(), CanonicalValue::Array(ops.to_vec())),
        (
            "lastModifiedByLeft".into(),
            CanonicalValue::Bool(last_modified_by_left),
        ),
        (
            "executorIsLeft".into(),
            CanonicalValue::Bool(executor_is_left),
        ),
    ];
    if let Some(memo) = memo {
        body.push(("memo".into(), CanonicalValue::String(memo.into())));
    }
    let value = encode_account_state_value(&CanonicalValue::Object(body))
        .map_err(|error| error.to_string())?;
    let key: [u8; 32] = Keccak256::digest(b"xln.settlement.workspace.body").into();
    let domain = MERKLE_LEAF_DOMAIN.as_bytes();
    let mut preimage = Vec::with_capacity(2 + domain.len() + 32 + value.len());
    preimage.extend_from_slice(&(domain.len() as u16).to_be_bytes());
    preimage.extend_from_slice(domain);
    preimage.extend_from_slice(&key);
    preimage.extend_from_slice(&value);
    Ok(hex_hash(Keccak256::digest(preimage).into()))
}

/// Validate the exact typed operation compiler without mutating an Account.
/// Entity uses this before admission because TS rejects malformed settlement
/// bodies in the Entity frame, while Account calls the same compiler again at
/// the bilateral trust boundary.
pub fn validate_settlement_ops(
    ops: &[CanonicalValue],
    proposer_is_left: bool,
) -> Result<(), String> {
    compile_ops(ops, proposer_is_left).map(|_| ())
}

/// Exact TypeScript `canAutoApproveWorkspace` policy. Entity calls this only
/// after the bilateral Account frame has committed the workspace body.
pub fn can_auto_approve_settlement_ops(
    ops: &[CanonicalValue],
    proposer_is_left: bool,
    viewer_is_left: bool,
) -> Result<bool, String> {
    for (index, value) in ops.iter().enumerate() {
        let fields = object(
            value,
            &format!("SETTLEMENT_WORKSPACE_OP_INVALID:index={index}"),
        )?;
        if matches!(
            string(
                required(fields, "type")?,
                &format!("SETTLEMENT_WORKSPACE_OP_INVALID:index={index}"),
            )?,
            "forgive" | "rawDiff"
        ) {
            return Ok(false);
        }
    }
    let compiled = compile_ops(ops, proposer_is_left)?;
    Ok(compiled.diffs.iter().all(|diff| {
        let reserve = if viewer_is_left {
            &diff.left
        } else {
            &diff.right
        };
        let collateral_share = if viewer_is_left {
            diff.ondelta.clone()
        } else {
            &diff.collateral - &diff.ondelta
        };
        reserve >= &BigInt::from(0) && collateral_share >= BigInt::from(0)
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementHankoDraft {
    pub tx: crate::AccountTx,
    pub settlement_hash: Option<[u8; 32]>,
    pub dispute_hash: [u8; 32],
    pub settlement_nonce: u64,
    pub proof_nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedSettlementDiff {
    pub token_id: TokenId,
    pub left_diff: BigInt,
    pub right_diff: BigInt,
    pub collateral_diff: BigInt,
    pub ondelta_diff: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedSettlementExecution {
    pub revision: u64,
    pub workspace_hash: String,
    pub nonce: u64,
    pub diffs: Vec<PreparedSettlementDiff>,
    pub forgive_token_ids: Vec<TokenId>,
    pub counterparty_hanko: Vec<u8>,
}

pub fn attach_settlement_hanko_witnesses(
    mut draft: SettlementHankoDraft,
    settlement_hanko: Option<&[u8]>,
    dispute_hanko: &[u8],
) -> Result<crate::AccountTx, String> {
    if draft.settlement_hash.is_some() != settlement_hanko.is_some() {
        return Err("SETTLEMENT_MANIFEST_WITNESS_LAYOUT_INVALID".into());
    }
    let crate::AccountTx::SettleTransition { data } = &mut draft.tx else {
        return Err("SETTLEMENT_DRAFT_TX_INVALID".into());
    };
    let fields = match data {
        CanonicalValue::Object(fields) => fields,
        _ => return Err("SETTLEMENT_DRAFT_DATA_INVALID".into()),
    };
    if let Some(hanko) = settlement_hanko {
        fields.push((
            "settlementHanko".into(),
            CanonicalValue::String(hex_bytes(hanko)),
        ));
    }
    let post = field_mut(fields, "postProof").ok_or("SETTLEMENT_DRAFT_POST_PROOF_MISSING")?;
    let post = match post {
        CanonicalValue::Object(fields) => fields,
        _ => return Err("SETTLEMENT_DRAFT_POST_PROOF_INVALID".into()),
    };
    post.push((
        "hanko".into(),
        CanonicalValue::String(hex_bytes(dispute_hanko)),
    ));
    Ok(draft.tx)
}

/// Build the unsigned local settlement-Hanko Account transaction and the exact
/// Entity-manifest digests that must authorize it. Witness bytes are attached
/// only after the containing Entity frame commits; this function never signs
/// and never mutates Account state or mempool.
pub fn build_settlement_hanko_draft(
    account: &AccountReplica,
    context: &crate::SettlementExecutionContext,
) -> Result<SettlementHankoDraft, String> {
    let stored = account
        .state()
        .settlement_workspace()
        .ok_or("SETTLEMENT_WORKSPACE_MISSING")?;
    let workspace = workspace_view(stored)?;
    if workspace.status == "submitted" {
        return Err("SETTLEMENT_HANKO_SUBMITTED_FORBIDDEN".into());
    }
    let local_side = account.owner_side();
    let proof = field(workspace.fields, "postSettlementDisputeProof")
        .map(|value| object(value, "POST_SETTLEMENT_PROOF_INVALID"))
        .transpose()?;
    let local_proof_field = if local_side == Side::Left {
        "leftHanko"
    } else {
        "rightHanko"
    };
    if proof.is_some_and(|fields| field(fields, local_proof_field).is_some()) {
        return Err("SETTLEMENT_SIDE_HANKO_ALREADY_ATTACHED".into());
    }
    let workspace_hash = assert_workspace_hash(account, &workspace)?;
    let minimum_nonce = account
        .state()
        .j_nonce()
        .saturating_add(1)
        .max(context.next_proof_nonce)
        .max(
            context
                .current_dispute_proof_nonce
                .unwrap_or(0)
                .saturating_add(1),
        )
        .max(
            context
                .counterparty_dispute_proof_nonce
                .unwrap_or(0)
                .saturating_add(1),
        );
    let settlement_nonce = field(workspace.fields, "nonceAtSign")
        .map(|value| positive_safe_number(value, "SETTLEMENT_HANKO_NONCE_INVALID"))
        .transpose()?
        .unwrap_or(minimum_nonce);
    let compiled = compile_ops(workspace.ops, workspace.last_modified_by_left)?;
    let settlement_hash_text = settlement_hash(account, &compiled, settlement_nonce)?;
    let settlement_hash = decode_hash(&settlement_hash_text)?;
    if let Some(pinned) = optional_nonempty_string(workspace.fields, "settlementHash")
        && pinned.to_ascii_lowercase() != settlement_hash_text
    {
        return Err(format!(
            "SETTLEMENT_SIGNED_HASH_MISMATCH:{pinned}:{settlement_hash_text}"
        ));
    }
    let proof_body_hash = projected_proof_body_hash(account, &compiled)?;
    let proof_nonce = settlement_nonce
        .checked_add(1)
        .ok_or("POST_SETTLEMENT_PROOF_NONCE_OVERFLOW")?;
    let identity = account.state().identity();
    let dispute_hash = crate::dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.left().as_bytes(),
        identity.right().as_bytes(),
        proof_nonce,
        workspace.last_modified_by_left,
        &proof_body_hash,
        identity.watch_seed().bytes(),
    );
    let source_is_executor = workspace.executor_is_left == (local_side == Side::Left);
    let data = CanonicalValue::Object(vec![
        ("kind".into(), CanonicalValue::String("hanko".into())),
        ("revision".into(), number(workspace.revision)?),
        (
            "workspaceHash".into(),
            CanonicalValue::String(workspace_hash),
        ),
        ("settlementNonce".into(), number(settlement_nonce)?),
        (
            "settlementHash".into(),
            CanonicalValue::String(settlement_hash_text),
        ),
        (
            "postProof".into(),
            CanonicalValue::Object(vec![
                (
                    "proofBodyHash".into(),
                    CanonicalValue::String(hex_hash(proof_body_hash)),
                ),
                (
                    "disputeHash".into(),
                    CanonicalValue::String(hex_hash(dispute_hash)),
                ),
                ("nonce".into(), number(proof_nonce)?),
                (
                    "proposerIsLeft".into(),
                    CanonicalValue::Bool(workspace.last_modified_by_left),
                ),
            ]),
        ),
    ]);
    Ok(SettlementHankoDraft {
        tx: crate::AccountTx::SettleTransition { data },
        settlement_hash: (!source_is_executor).then_some(settlement_hash),
        dispute_hash,
        settlement_nonce,
        proof_nonce,
    })
}

pub fn prepare_settlement_execution(
    account: &AccountReplica,
) -> Result<PreparedSettlementExecution, String> {
    let stored = account
        .state()
        .settlement_workspace()
        .ok_or("SETTLEMENT_WORKSPACE_MISSING")?;
    let workspace = workspace_view(stored)?;
    let workspace_hash = assert_workspace_hash(account, &workspace)?;
    if workspace.status != "ready_to_submit" {
        return Err(format!("SETTLEMENT_HANKOS_INCOMPLETE:{}", workspace.status));
    }
    if workspace.executor_is_left != (account.owner_side() == Side::Left) {
        return Err(format!(
            "SETTLEMENT_EXECUTOR_MISMATCH:expected={}",
            if workspace.executor_is_left {
                "left"
            } else {
                "right"
            }
        ));
    }
    let nonce = positive_safe_number(
        required(workspace.fields, "nonceAtSign")?,
        "SETTLEMENT_SIGNED_NONCE_MISSING",
    )?;
    let compiled = compile_ops(workspace.ops, workspace.last_modified_by_left)?;
    let expected_hash = settlement_hash(account, &compiled, nonce)?;
    let stored_hash = optional_nonempty_string(workspace.fields, "settlementHash")
        .ok_or("SETTLEMENT_SIGNED_HASH_MISSING")?;
    if stored_hash.to_ascii_lowercase() != expected_hash {
        return Err(format!(
            "SETTLEMENT_SIGNED_HASH_MISMATCH:{stored_hash}:{expected_hash}"
        ));
    }
    let counterparty_hanko_field = if account.owner_side() == Side::Left {
        "rightHanko"
    } else {
        "leftHanko"
    };
    let counterparty_hanko = decode_hex_bytes(exact_hanko_text(
        workspace.fields,
        counterparty_hanko_field,
        "SETTLEMENT_COUNTERPARTY_HANKO_MISSING",
    )?)?;
    let post = object(
        required(workspace.fields, "postSettlementDisputeProof")?,
        "POST_SETTLEMENT_PROOF_MISSING",
    )?;
    let post_nonce = positive_safe_number(
        required(post, "nonce")?,
        "POST_SETTLEMENT_PROOF_NONCE_MISMATCH",
    )?;
    if post_nonce != nonce.saturating_add(1) {
        return Err(format!(
            "POST_SETTLEMENT_PROOF_NONCE_MISMATCH:{post_nonce}:{}",
            nonce.saturating_add(1)
        ));
    }
    exact_hanko_text(post, "leftHanko", "POST_SETTLEMENT_PROOF_HANKO_MISSING")?;
    exact_hanko_text(post, "rightHanko", "POST_SETTLEMENT_PROOF_HANKO_MISSING")?;
    let expected_body = projected_proof_body_hash(account, &compiled)?;
    let stored_body = decode_hash(
        optional_nonempty_string(post, "proofBodyHash")
            .ok_or("POST_SETTLEMENT_PROOF_BODY_HASH_MISSING")?,
    )?;
    if stored_body != expected_body {
        return Err("POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH".into());
    }
    let proposer_is_left = boolean(
        required(post, "proposerIsLeft")?,
        "POST_SETTLEMENT_PROPOSER_INVALID",
    )?;
    let identity = account.state().identity();
    let expected_dispute = crate::dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.left().as_bytes(),
        identity.right().as_bytes(),
        post_nonce,
        proposer_is_left,
        &expected_body,
        identity.watch_seed().bytes(),
    );
    let stored_dispute = decode_hash(
        optional_nonempty_string(post, "disputeHash")
            .ok_or("POST_SETTLEMENT_DISPUTE_HASH_MISSING")?,
    )?;
    if stored_dispute != expected_dispute {
        return Err("POST_SETTLEMENT_PROOF_HASH_MISMATCH".into());
    }
    Ok(PreparedSettlementExecution {
        revision: workspace.revision,
        workspace_hash,
        nonce,
        diffs: compiled
            .diffs
            .into_iter()
            .map(|diff| PreparedSettlementDiff {
                token_id: diff.token_id,
                left_diff: diff.left,
                right_diff: diff.right,
                collateral_diff: diff.collateral,
                ondelta_diff: diff.ondelta,
            })
            .collect(),
        forgive_token_ids: compiled.forgive,
        counterparty_hanko,
    })
}

fn compile_ops(ops: &[CanonicalValue], proposer_is_left: bool) -> Result<CompiledOps, String> {
    // TypeScript's Map preserves the first occurrence of every token. This
    // order is part of the ABI settlement hash, so a BTreeMap here would
    // silently re-sort otherwise valid user operations and break parity.
    let mut diffs = Vec::<OpDiff>::new();
    let mut forgive = Vec::<TokenId>::new();
    let mut forgiven = BTreeSet::<TokenId>::new();
    for (index, value) in ops.iter().enumerate() {
        let fields = object(
            value,
            &format!("SETTLEMENT_WORKSPACE_OP_INVALID:index={index}"),
        )?;
        let kind = string(
            required(fields, "type")?,
            &format!("SETTLEMENT_WORKSPACE_OP_INVALID:index={index}"),
        )?;
        let token_value = safe_number(
            required(fields, "tokenId")?,
            &format!("SETTLEMENT_TOKEN_INVALID:workspace-op={index}"),
        )?;
        let token = TokenId::new(
            u32::try_from(token_value)
                .map_err(|_| format!("SETTLEMENT_TOKEN_INVALID:workspace-op={index}"))?,
        )
        .map_err(|_| format!("SETTLEMENT_TOKEN_INVALID:workspace-op={index}"))?;
        if kind == "forgive" {
            if !forgiven.insert(token) {
                return Err(format!("SETTLEMENT_DUPLICATE_FORGIVENESS_TOKEN:{token}"));
            }
            forgive.push(token);
            continue;
        }
        let position = diffs
            .iter()
            .position(|diff| diff.token_id == token)
            .unwrap_or_else(|| {
                diffs.push(OpDiff {
                    token_id: token,
                    left: 0.into(),
                    right: 0.into(),
                    collateral: 0.into(),
                    ondelta: 0.into(),
                });
                diffs.len() - 1
            });
        let diff = &mut diffs[position];
        if kind == "rawDiff" {
            diff.left += bigint(required(fields, "leftDiff")?, index)?;
            diff.right += bigint(required(fields, "rightDiff")?, index)?;
            diff.collateral += bigint(required(fields, "collateralDiff")?, index)?;
            diff.ondelta += bigint(required(fields, "ondeltaDiff")?, index)?;
            continue;
        }
        let amount = bigint(required(fields, "amount")?, index)?;
        if amount <= BigInt::from(0) {
            return Err(format!("SETTLEMENT_WORKSPACE_AMOUNT_INVALID:index={index}"));
        }
        match (kind, proposer_is_left) {
            ("r2c", true) => {
                diff.left -= &amount;
                diff.collateral += &amount;
                diff.ondelta += amount;
            }
            ("r2c", false) => {
                diff.right -= &amount;
                diff.collateral += amount;
            }
            ("c2r", true) => {
                diff.collateral -= &amount;
                diff.left += &amount;
                diff.ondelta -= amount;
            }
            ("c2r", false) => {
                diff.collateral -= &amount;
                diff.right += amount;
            }
            ("r2r", true) => {
                diff.left -= &amount;
                diff.right += amount;
            }
            ("r2r", false) => {
                diff.right -= &amount;
                diff.left += amount;
            }
            _ => {
                return Err(format!(
                    "SETTLEMENT_WORKSPACE_OP_INVALID:index={index}:type={kind}"
                ));
            }
        }
    }
    if diffs.len() > MAX_SETTLEMENT_ROWS {
        return Err(format!(
            "SETTLEMENT_DIFF_LIMIT_EXCEEDED:{}:{MAX_SETTLEMENT_ROWS}",
            diffs.len()
        ));
    }
    if forgive.len() > MAX_SETTLEMENT_ROWS {
        return Err(format!(
            "SETTLEMENT_FORGIVENESS_LIMIT_EXCEEDED:{}:{MAX_SETTLEMENT_ROWS}",
            forgive.len()
        ));
    }
    let min = -(BigInt::from(1) << 255usize);
    let max = (BigInt::from(1) << 255usize) - 1;
    for diff in &diffs {
        for (name, value) in [
            ("leftDiff", &diff.left),
            ("rightDiff", &diff.right),
            ("collateralDiff", &diff.collateral),
            ("ondeltaDiff", &diff.ondelta),
        ] {
            if value < &min || value > &max {
                return Err(format!(
                    "SETTLEMENT_INT256_RANGE:{name}:token={}",
                    diff.token_id
                ));
            }
        }
        if diff.left == min || diff.right == min || diff.collateral == min {
            return Err(format!(
                "SETTLEMENT_INT256_NEGATION:token={}",
                diff.token_id
            ));
        }
        let sum = &diff.left + &diff.right + &diff.collateral;
        if sum != BigInt::from(0) {
            return Err(format!(
                "SETTLEMENT_INVARIANT_VIOLATION:tokenId={}:sum={sum}",
                diff.token_id
            ));
        }
    }
    Ok(CompiledOps { diffs, forgive })
}

fn plan_hold_release(
    account: &AccountReplica,
    workspace: &WorkspaceView<'_>,
    planned: &mut BTreeMap<TokenId, crate::Delta>,
) -> Result<(), String> {
    for diff in compile_ops(workspace.ops, workspace.last_modified_by_left)?.diffs {
        for (side, amount) in hold_plan(&diff) {
            if amount == BigInt::from(0) {
                continue;
            }
            let delta = planned_delta(account, planned, diff.token_id, "release")?;
            if delta.hold(side) < &amount {
                let label = if side == Side::Left { "left" } else { "right" };
                return Err(format!(
                    "SETTLEMENT_HOLD_UNDERFLOW:{label}:token={}:hold={}:release={amount}",
                    diff.token_id,
                    delta.hold(side)
                ));
            }
            delta
                .release_hold(side, &amount)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn plan_hold_add(
    account: &AccountReplica,
    diffs: &[OpDiff],
    planned: &mut BTreeMap<TokenId, crate::Delta>,
) -> Result<(), String> {
    for diff in diffs {
        for (side, amount) in hold_plan(diff) {
            if amount == BigInt::from(0) {
                continue;
            }
            let reserve_deposit = match side {
                Side::Left => diff.left < BigInt::from(0) && diff.collateral > BigInt::from(0),
                Side::Right => diff.right < BigInt::from(0) && diff.collateral > BigInt::from(0),
            };
            let delta = planned_delta(account, planned, diff.token_id, "add")?;
            if !reserve_deposit && amount > delta.perspective(side).out_capacity {
                let label = if side == Side::Left { "left" } else { "right" };
                return Err(format!(
                    "SETTLEMENT_HOLD_CAPACITY:{label}:token={}",
                    diff.token_id
                ));
            }
            delta
                .add_hold(side, &amount)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn hold_plan(diff: &OpDiff) -> [(Side, BigInt); 2] {
    [
        (
            Side::Left,
            if diff.left < BigInt::from(0) {
                -&diff.left
            } else {
                0.into()
            },
        ),
        (
            Side::Right,
            if diff.right < BigInt::from(0) {
                -&diff.right
            } else {
                0.into()
            },
        ),
    ]
}

fn planned_delta<'a>(
    account: &AccountReplica,
    planned: &'a mut BTreeMap<TokenId, crate::Delta>,
    token: TokenId,
    operation: &str,
) -> Result<&'a mut crate::Delta, String> {
    match planned.entry(token) {
        std::collections::btree_map::Entry::Occupied(entry) => Ok(entry.into_mut()),
        std::collections::btree_map::Entry::Vacant(entry) => {
            let delta = account.state().delta(token).ok_or_else(|| {
                format!("SETTLEMENT_HOLD_DELTA_MISSING:{operation}:token={token}")
            })?;
            Ok(entry.insert(delta.clone()))
        }
    }
}

fn publish_deltas(
    account: &mut AccountReplica,
    planned: BTreeMap<TokenId, crate::Delta>,
) -> Result<(), String> {
    for delta in planned.into_values() {
        account
            .state_mut()
            .put_delta(delta)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn is_unsigned(workspace: &WorkspaceView<'_>) -> bool {
    matches!(workspace.status, "draft" | "awaiting_counterparty")
        && [
            "compiledDiffs",
            "compiledForgiveTokenIds",
            "leftHanko",
            "rightHanko",
            "settlementHash",
            "nonceAtSign",
            "postSettlementDisputeProof",
        ]
        .iter()
        .all(|key| field(workspace.fields, key).is_none())
}

fn replace_fields(
    fields: &[(String, CanonicalValue)],
    replacements: &[(&str, CanonicalValue)],
) -> CanonicalValue {
    let mut next = fields.to_vec();
    for (key, value) in replacements {
        if let Some(current) = field_mut(&mut next, key) {
            *current = value.clone();
        } else {
            next.push(((*key).into(), value.clone()));
        }
    }
    CanonicalValue::Object(next)
}

fn rejected(message: String) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(
        ValidationRejection::AccountTx { message },
    ))
}

fn object<'a>(
    value: &'a CanonicalValue,
    error: &str,
) -> Result<&'a [(String, CanonicalValue)], String> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(error.into()),
    }
}
fn array<'a>(value: &'a CanonicalValue, error: &str) -> Result<&'a [CanonicalValue], String> {
    match value {
        CanonicalValue::Array(values) => Ok(values),
        _ => Err(error.into()),
    }
}
fn field<'a>(fields: &'a [(String, CanonicalValue)], key: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}
fn field_mut<'a>(
    fields: &'a mut [(String, CanonicalValue)],
    key: &str,
) -> Option<&'a mut CanonicalValue> {
    fields
        .iter_mut()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}
fn required<'a>(
    fields: &'a [(String, CanonicalValue)],
    key: &str,
) -> Result<&'a CanonicalValue, String> {
    field(fields, key).ok_or_else(|| format!("SETTLEMENT_FIELD_MISSING:{key}"))
}
fn string<'a>(value: &'a CanonicalValue, error: &str) -> Result<&'a str, String> {
    match value {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(error.into()),
    }
}
fn boolean(value: &CanonicalValue, error: &str) -> Result<bool, String> {
    match value {
        CanonicalValue::Bool(value) => Ok(*value),
        _ => Err(error.into()),
    }
}
fn safe_number(value: &CanonicalValue, error: &str) -> Result<u64, String> {
    match value {
        CanonicalValue::Number(value) => value.as_str().parse::<u64>().map_err(|_| error.into()),
        _ => Err(error.into()),
    }
}
fn positive_safe_number(value: &CanonicalValue, error: &str) -> Result<u64, String> {
    let value = safe_number(value, error)?;
    if value == 0 {
        Err(error.into())
    } else {
        Ok(value)
    }
}
fn number(value: u64) -> Result<CanonicalValue, String> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| error.to_string())
}
fn bigint(value: &CanonicalValue, index: usize) -> Result<BigInt, String> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(format!(
            "SETTLEMENT_WORKSPACE_RAW_DIFF_INVALID:index={index}"
        )),
    }
}
fn optional_string(
    fields: &[(String, CanonicalValue)],
    key: &str,
    error: &str,
) -> Result<Option<String>, String> {
    optional_string_ref(fields, key, error).map(|value| value.map(str::to_owned))
}
fn optional_string_ref<'a>(
    fields: &'a [(String, CanonicalValue)],
    key: &str,
    error: &str,
) -> Result<Option<&'a str>, String> {
    field(fields, key)
        .map(|value| string(value, error))
        .transpose()
}
fn optional_nonempty_string<'a>(
    fields: &'a [(String, CanonicalValue)],
    key: &str,
) -> Option<&'a str> {
    field(fields, key).and_then(|value| match value {
        CanonicalValue::String(value) if !value.is_empty() => Some(value.as_str()),
        _ => None,
    })
}
fn number_u64(fields: &[(String, CanonicalValue)], key: &str) -> Option<u64> {
    field(fields, key).and_then(|value| safe_number(value, key).ok())
}
fn hex32(value: &str, error: &str) -> Result<String, String> {
    let lower = value.to_ascii_lowercase();
    if lower.len() == 66
        && lower.starts_with("0x")
        && lower[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(lower)
    } else {
        Err(format!("{error}:{value}"))
    }
}
fn hex_hash(value: [u8; 32]) -> String {
    hex_bytes(&value)
}
fn hex_bytes(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(value.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in value {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AccountDisputeConfig, AccountDomain, AccountIdentity, AccountState, Delta,
        DepositoryAddress, EntityId, WatchSeed,
    };

    fn entity(byte: u8) -> EntityId {
        EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
    }

    fn replica() -> AccountReplica {
        let identity = AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            entity(0x11),
            entity(0x22),
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("seed"),
        )
        .expect("identity");
        let delta = Delta::new(
            TokenId::new(1).expect("token"),
            0.into(),
            0.into(),
            0.into(),
            100.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
        )
        .expect("delta");
        AccountReplica::new(
            entity(0x11),
            AccountState::new(
                identity,
                AccountDisputeConfig::new(10, 10).expect("dispute"),
                vec![delta],
            )
            .expect("state"),
        )
        .expect("replica")
    }

    fn upsert() -> CanonicalValue {
        CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("upsert".into())),
            ("revision".into(), number(1).expect("number")),
            (
                "ops".into(),
                CanonicalValue::Array(vec![CanonicalValue::Object(vec![
                    ("type".into(), CanonicalValue::String("r2r".into())),
                    (
                        "tokenId".into(),
                        CanonicalValue::Number(CanonicalNumber::from_u16(1)),
                    ),
                    ("amount".into(), CanonicalValue::BigInt(10.into())),
                ])]),
            ),
            ("executorIsLeft".into(), CanonicalValue::Bool(true)),
            ("memo".into(), CanonicalValue::String("unit".into())),
        ])
    }

    #[test]
    fn upsert_and_clear_are_atomic_and_release_exact_holds() {
        let mut account = replica();
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 0, 10);
        assert!(matches!(
            apply(&mut account, &upsert(), Side::Left, &context).expect("apply"),
            MutationDecision::Applied { .. }
        ));
        assert_eq!(
            account
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Left),
            &BigInt::from(10)
        );
        let workspace = workspace_view(account.state().settlement_workspace().expect("workspace"))
            .expect("view");
        assert_eq!(
            workspace.workspace_hash,
            "0x8bb1e2e3599f041fae795125505f6d6f0d3899db89c40e6f52c9f1a0f6b9284c",
            "TypeScript createSettlementWorkspaceHash vector",
        );
        let clear = CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("clear".into())),
            (
                "revision".into(),
                number(workspace.revision).expect("number"),
            ),
            (
                "workspaceHash".into(),
                CanonicalValue::String(workspace.workspace_hash.into()),
            ),
        ]);
        assert!(matches!(
            apply(&mut account, &clear, Side::Left, &context).expect("clear"),
            MutationDecision::Applied { .. }
        ));
        assert_eq!(
            account
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Left),
            &BigInt::from(0)
        );
        assert!(account.state().settlement_workspace().is_none());
    }

    #[test]
    fn account_settled_finality_clears_unsigned_workspace_and_releases_hold() {
        let mut account = replica();
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 0, 10);
        assert!(matches!(
            apply(&mut account, &upsert(), Side::Left, &context).expect("apply"),
            MutationDecision::Applied { .. }
        ));
        let effect = apply_finalized_account_settlement(&mut account, 1).expect("finality");
        assert!(effect.is_none());
        assert!(account.state().settlement_workspace().is_none());
        assert_eq!(
            account
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Left),
            &BigInt::from(0)
        );
    }

    #[test]
    fn account_settled_finality_activates_exact_post_settlement_proof_effect() {
        let mut account = replica();
        let transformer = [0x77; 20];
        account.set_delta_transformer(transformer);
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 0, 10);
        assert!(matches!(
            apply(&mut account, &upsert(), Side::Left, &context).expect("apply"),
            MutationDecision::Applied { .. }
        ));
        let body = crate::proof_body_hash(&account, &transformer).expect("proof body");
        let dispute = [0x66; 32];
        let workspace = workspace_view(account.state().settlement_workspace().expect("workspace"))
            .expect("view");
        let signed = replace_fields(
            workspace.fields,
            &[
                ("status", CanonicalValue::String("submitted".into())),
                (
                    "settlementHash",
                    CanonicalValue::String(hex_hash([0x55; 32])),
                ),
                ("nonceAtSign", number(3).expect("number")),
                (
                    "postSettlementDisputeProof",
                    CanonicalValue::Object(vec![
                        (
                            "disputeHash".into(),
                            CanonicalValue::String(hex_hash(dispute)),
                        ),
                        (
                            "proofBodyHash".into(),
                            CanonicalValue::String(hex_hash(body)),
                        ),
                        ("nonce".into(), number(4).expect("number")),
                        ("proposerIsLeft".into(), CanonicalValue::Bool(true)),
                        ("leftHanko".into(), CanonicalValue::String("0x01".into())),
                        ("rightHanko".into(), CanonicalValue::String("0x02".into())),
                    ]),
                ),
            ],
        );
        account.state_mut().set_settlement_workspace(signed);
        let effect = apply_finalized_account_settlement(&mut account, 3)
            .expect("finality")
            .expect("activation");
        let crate::tx::apply_types::AccountConsensusEffect::ActivatePostSettlementProof {
            local,
            counterparty,
            next_proof_nonce,
        } = effect;
        assert_eq!(local.hanko, Some(vec![1]));
        assert_eq!(counterparty.hanko, Some(vec![2]));
        assert_eq!(local.hash, dispute);
        assert_eq!(local.proof_body_hash, body);
        assert_eq!(local.nonce, 4);
        assert_eq!(next_proof_nonce, 5);
        assert!(account.state().settlement_workspace().is_none());
    }

    #[test]
    fn account_root_excludes_only_hanko_witness_bytes() {
        let mut account = replica();
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 0, 10);
        let _ = apply(&mut account, &upsert(), Side::Left, &context).expect("apply");
        let root = account
            .state()
            .payment_profile_account_state_root()
            .expect("root");
        let mut fields = object(
            account.state().settlement_workspace().expect("workspace"),
            "workspace",
        )
        .expect("object")
        .to_vec();
        fields.push(("leftHanko".into(), CanonicalValue::String("0x0102".into())));
        account
            .state_mut()
            .set_settlement_workspace(CanonicalValue::Object(fields));
        assert_eq!(
            account
                .state()
                .payment_profile_account_state_root()
                .expect("hanko root"),
            root
        );
        let mut fields = object(
            account.state().settlement_workspace().expect("workspace"),
            "workspace",
        )
        .expect("object")
        .to_vec();
        *field_mut(&mut fields, "memo").expect("memo") = CanonicalValue::String("changed".into());
        account
            .state_mut()
            .set_settlement_workspace(CanonicalValue::Object(fields));
        assert_ne!(
            account
                .state()
                .payment_profile_account_state_root()
                .expect("changed root"),
            root
        );
    }

    #[test]
    fn cooperative_settlement_hash_matches_typescript_abi_vector() {
        let account = replica();
        let ops = match field(object(&upsert(), "upsert").expect("object"), "ops").expect("ops") {
            CanonicalValue::Array(ops) => ops.clone(),
            _ => panic!("ops"),
        };
        let compiled = compile_ops(&ops, true).expect("compile");
        assert_eq!(
            settlement_hash(&account, &compiled, 5).expect("hash"),
            "0xe00418cfb7593ce22f8ce8d7355f5a824454a0b4e6ed031fa260f16acf946e86",
        );
    }

    #[test]
    fn compiled_rows_preserve_typescript_map_insertion_order() {
        let op = |token: u16| {
            CanonicalValue::Object(vec![
                ("type".into(), CanonicalValue::String("r2r".into())),
                (
                    "tokenId".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u16(token)),
                ),
                ("amount".into(), CanonicalValue::BigInt(1.into())),
            ])
        };
        let compiled = compile_ops(&[op(2), op(1), op(2)], true).expect("compile");
        assert_eq!(
            compiled
                .diffs
                .iter()
                .map(|diff| diff.token_id.get())
                .collect::<Vec<_>>(),
            vec![2, 1],
        );
    }

    #[test]
    fn malformed_transition_is_a_rejection_not_a_fail_stop() {
        let mut account = replica();
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 0, 10);
        assert!(matches!(
            apply(
                &mut account,
                &CanonicalValue::Object(Vec::new()),
                Side::Left,
                &context,
            )
            .expect("transition"),
            MutationDecision::Rejected { .. }
        ));
    }
}
