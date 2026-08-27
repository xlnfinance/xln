//! Shared read-only helpers for native replay binaries.

use xln_rscore_abi::{AbiValue, BodyTuple, Envelope, MessageKind, OpTag};

use crate::ProcessSession;
use crate::session::ResidentAuthorityBootstrap;
use crate::transcript::TranscriptPair;

/// Decode the single bootstrap snapshot without replaying Account restore.
/// A durable Runtime replay restores Accounts from its LevelDB checkpoint;
/// executing the transcript restore as well would build and hash a second
/// forest that is immediately discarded.
pub fn decode_entity_bootstrap_snapshot(
    pairs: &[TranscriptPair],
) -> Result<xln_rscore_entity_kernel::EntityStateSnapshot, String> {
    let mut snapshot = None;
    for (index, pair) in pairs.iter().enumerate() {
        if pair.request.op_tag != OpTag::BootstrapEntity {
            continue;
        }
        let decoded = match crate::wire_decode::decode_command(&pair.request)
            .map_err(|error| format!("NATIVE_REPLAY_ENTITY_BOOTSTRAP:{index}:{error}"))?
        {
            crate::wire_decode::Command::BootstrapEntity { snapshot } => *snapshot,
            _ => return Err(format!("NATIVE_REPLAY_ENTITY_BOOTSTRAP_KIND:{index}")),
        };
        if snapshot.replace(decoded).is_some() {
            return Err("NATIVE_REPLAY_ENTITY_BOOTSTRAP_DUPLICATE".to_string());
        }
    }
    snapshot.ok_or_else(|| "NATIVE_REPLAY_ENTITY_BOOTSTRAP_MISSING".to_string())
}

fn tuple(value: &AbiValue) -> Result<&[AbiValue], String> {
    let AbiValue::Tuple(tuple) = value else {
        return Err("NATIVE_REPLAY_TUPLE_REQUIRED".to_string());
    };
    Ok(tuple.fields())
}

fn replace_tuple_field(
    value: AbiValue,
    index: usize,
    replacement: AbiValue,
) -> Result<AbiValue, String> {
    let AbiValue::Tuple(tuple) = value else {
        return Err("NATIVE_REPLAY_REPLACE_TUPLE".to_string());
    };
    let mut fields = tuple.into_fields();
    let slot = fields
        .get_mut(index)
        .ok_or_else(|| format!("NATIVE_REPLAY_REPLACE_INDEX:{index}"))?;
    *slot = replacement;
    Ok(AbiValue::Tuple(BodyTuple::from_vec(fields)))
}

pub fn tune_request(mut request: Envelope, workers: usize) -> Result<Envelope, String> {
    let body_fields = request.body.clone().into_fields();
    let [payload] = body_fields.as_slice() else {
        return Err("NATIVE_REPLAY_REQUEST_BODY".to_string());
    };
    let replacement = match request.op_tag {
        OpTag::Hello => replace_tuple_field(
            payload.clone(),
            1,
            AbiValue::Integer(
                i128::try_from(workers).map_err(|_| "NATIVE_REPLAY_WORKERS".to_string())?,
            ),
        )?,
        OpTag::EntityRound => replace_tuple_field(payload.clone(), 5, AbiValue::Bool(false))?,
        _ => return Ok(request),
    };
    request.body = BodyTuple::from_array([replacement]);
    Ok(request)
}

fn normalize_round(value: AbiValue) -> Result<AbiValue, String> {
    let value = replace_tuple_field(value, 6, AbiValue::Tuple(BodyTuple::from_vec(Vec::new())))?;
    replace_tuple_field(value, 10, AbiValue::Integer(0))
}

pub fn normalize_response(mut response: Envelope) -> Result<Envelope, String> {
    if response.op_tag == OpTag::Hello {
        let body_fields = response.body.clone().into_fields();
        let [payload] = body_fields.as_slice() else {
            return Err("NATIVE_REPLAY_HELLO_RESPONSE".to_string());
        };
        response.body = BodyTuple::from_array([replace_tuple_field(
            payload.clone(),
            2,
            AbiValue::Integer(0),
        )?]);
    } else if response.op_tag == OpTag::EntityRound {
        let body_fields = response.body.clone().into_fields();
        let [payload] = body_fields.as_slice() else {
            return Err("NATIVE_REPLAY_ENTITY_RESPONSE".to_string());
        };
        let fields = tuple(payload)?;
        if fields.len() != 6 {
            return Err("NATIVE_REPLAY_ENTITY_RESPONSE_ARITY".to_string());
        }
        let mut normalized = fields.to_vec();
        normalized[0] = normalize_round(normalized[0].clone())?;
        normalized[1] = normalize_round(normalized[1].clone())?;
        normalized[5] = AbiValue::Integer(0);
        response.body = BodyTuple::from_array([AbiValue::Tuple(BodyTuple::from_vec(normalized))]);
    }
    Ok(response)
}

pub fn bootstrap_resident_authority(
    pairs: &[TranscriptPair],
    workers: usize,
) -> Result<(ResidentAuthorityBootstrap, usize), String> {
    let mut session = ProcessSession::try_new().map_err(|error| error.to_string())?;
    for (pair_index, pair) in pairs.iter().enumerate() {
        if pair.request.op_tag == OpTag::EntityRound {
            return session
                .into_resident_authority()
                .map(|bootstrap| (bootstrap, pair_index))
                .map_err(|error| error.to_string());
        }
        let request = tune_request(pair.request.clone(), workers)?;
        let request_op = request.op_tag;
        let request_body = request.body.clone();
        let reply = session.handle(request);
        if reply.envelope.message_kind != MessageKind::Ok {
            return Err(format!(
                "NATIVE_REPLAY_BOOTSTRAP_ERROR:index={pair_index}:op={request_op:?}:requestBody={request_body:?}:error={:?}",
                reply.envelope.body,
            ));
        }
        let actual = normalize_response(reply.envelope)?;
        let expected = normalize_response(pair.expected.clone())?;
        if actual != expected {
            return Err(format!(
                "NATIVE_REPLAY_BOOTSTRAP_PARITY:{:?}",
                actual.op_tag
            ));
        }
    }
    Err("NATIVE_REPLAY_ENTITY_ROUND_MISSING".to_string())
}
