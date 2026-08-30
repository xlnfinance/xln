use std::collections::BTreeMap;

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_canonical_consensus_bytes};

use crate::{EntityKernelError, LocalEntityTx};

const ACTION_DOMAIN: &str = "xln:entity-proposal-action:v1";
const MAX_PENDING: usize = 100;
const MAX_VOTES: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityVoteChoice {
    Yes,
    No,
    Abstain,
}

impl EntityVoteChoice {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Abstain => "abstain",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProposalVote {
    pub choice: EntityVoteChoice,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProposal {
    pub id: String,
    pub proposer: String,
    pub board_hash: String,
    pub board_epoch: u64,
    pub action: CanonicalValue,
    pub action_hash: String,
    pub votes: BTreeMap<String, EntityProposalVote>,
    pub created: u64,
}

pub type EntityProposals = BTreeMap<String, EntityProposal>;

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("proposal", detail)
}

fn hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(ALPHABET[usize::from(byte >> 4)] as char);
        output.push(ALPHABET[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn fixed_hex(value: &str, bytes: usize, code: &str) -> Result<String, EntityKernelError> {
    let canonical = value.trim().to_ascii_lowercase();
    if canonical.len() != 2 + bytes * 2
        || !canonical.starts_with("0x")
        || !canonical[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid(code));
    }
    Ok(canonical)
}

pub fn hash_entity_proposal_action(action: &CanonicalValue) -> Result<String, EntityKernelError> {
    let encoded = encode_canonical_consensus_bytes(&object(vec![
        ("domain", CanonicalValue::String(ACTION_DOMAIN.into())),
        ("action", action.clone()),
    ]))
    .map_err(|error| invalid(format!("ENTITY_PROPOSAL_ACTION_ENCODING:{error}")))?;
    Ok(hex(&Keccak256::digest(encoded)))
}

/// Exact `safeStringify` preimage used by TypeScript `generateProposalId`.
/// Keys are UTF-16/ASCII sorted; the command nonce uses the canonical tagged
/// BigInt envelope produced by `safeStringify`.
pub fn generate_entity_proposal_id(
    action_hash: &str,
    proposer: &str,
    board_hash: &str,
    board_epoch: u64,
    command_nonce: &BigInt,
) -> Result<String, EntityKernelError> {
    let action_hash = fixed_hex(action_hash, 32, "ENTITY_PROPOSAL_ACTION_HASH_INVALID")?;
    let board_hash = fixed_hex(board_hash, 32, "ENTITY_PROPOSAL_BOARD_HASH_INVALID")?;
    if command_nonce < &BigInt::from(1_u8) {
        return Err(invalid("ENTITY_PROPOSAL_COMMAND_NONCE_INVALID"));
    }
    let proposer = proposer.trim().to_ascii_lowercase();
    if proposer.is_empty() {
        return Err(invalid("ENTITY_PROPOSAL_PROPOSER_REQUIRED"));
    }
    let preimage = format!(
        "{{\"actionHash\":\"{action_hash}\",\"boardEpoch\":{board_epoch},\"boardHash\":\"{board_hash}\",\"commandNonce\":{{\"__xlnType\":\"BigInt\",\"value\":\"{command_nonce}\"}},\"proposer\":\"{proposer}\"}}"
    );
    let digest = Sha256::digest(preimage.as_bytes());
    Ok(format!("prop_{}", &hex(&digest)[2..]))
}

fn canonical_vote(vote: &EntityProposalVote) -> CanonicalValue {
    match &vote.comment {
        None => CanonicalValue::String(vote.choice.as_str().into()),
        Some(comment) => object(vec![
            (
                "choice",
                CanonicalValue::String(vote.choice.as_str().into()),
            ),
            ("comment", CanonicalValue::String(comment.clone())),
        ]),
    }
}

pub fn canonical_entity_proposals(
    proposals: &EntityProposals,
) -> Result<CanonicalValue, EntityKernelError> {
    if proposals.len() > MAX_PENDING {
        return Err(invalid("ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED"));
    }
    let rows = proposals
        .iter()
        .map(|(id, proposal)| {
            if id != &proposal.id || proposal.votes.len() > MAX_VOTES {
                return Err(invalid("ENTITY_PROPOSAL_STATE_INVALID"));
            }
            let votes = proposal
                .votes
                .iter()
                .map(|(signer, vote)| {
                    (CanonicalValue::String(signer.clone()), canonical_vote(vote))
                })
                .collect();
            Ok((
                CanonicalValue::String(id.clone()),
                object(vec![
                    ("id", CanonicalValue::String(id.clone())),
                    (
                        "proposer",
                        CanonicalValue::String(proposal.proposer.clone()),
                    ),
                    (
                        "boardHash",
                        CanonicalValue::String(proposal.board_hash.clone()),
                    ),
                    (
                        "boardEpoch",
                        CanonicalValue::Number(
                            CanonicalNumber::try_from_u64(proposal.board_epoch)
                                .map_err(|error| invalid(error.to_string()))?,
                        ),
                    ),
                    ("action", proposal.action.clone()),
                    (
                        "actionHash",
                        CanonicalValue::String(proposal.action_hash.clone()),
                    ),
                    ("votes", CanonicalValue::Map(votes)),
                    (
                        "created",
                        CanonicalValue::Number(
                            CanonicalNumber::try_from_u64(proposal.created)
                                .map_err(|error| invalid(error.to_string()))?,
                        ),
                    ),
                ]),
            ))
        })
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    Ok(CanonicalValue::Map(rows))
}

fn map<'a>(
    value: &'a CanonicalValue,
    code: &str,
) -> Result<&'a [(CanonicalValue, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Map(entries) => Ok(entries),
        _ => Err(invalid(code)),
    }
}

fn fields<'a>(
    value: &'a CanonicalValue,
    code: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(entries) => Ok(entries),
        _ => Err(invalid(code)),
    }
}

fn get<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("ENTITY_PROPOSAL_FIELD_MISSING:{name}")))
}

fn text(value: &CanonicalValue, code: &str) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(code)),
    }
}

fn unsigned(value: &CanonicalValue, code: &str) -> Result<u64, EntityKernelError> {
    match value {
        CanonicalValue::Number(value) => value.as_str().parse().map_err(|_| invalid(code)),
        _ => Err(invalid(code)),
    }
}

fn decode_choice(value: &str) -> Result<EntityVoteChoice, EntityKernelError> {
    match value {
        "yes" => Ok(EntityVoteChoice::Yes),
        "no" => Ok(EntityVoteChoice::No),
        "abstain" => Ok(EntityVoteChoice::Abstain),
        _ => Err(invalid("ENTITY_PROPOSAL_VOTE_CHOICE_INVALID")),
    }
}

pub fn decode_canonical_entity_proposals(
    value: &CanonicalValue,
) -> Result<EntityProposals, EntityKernelError> {
    let rows = map(value, "ENTITY_PROPOSALS_MAP_REQUIRED")?;
    if rows.len() > MAX_PENDING {
        return Err(invalid("ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED"));
    }
    let mut proposals = BTreeMap::new();
    let mut proposers = std::collections::BTreeSet::new();
    for (key, value) in rows {
        let id = text(key, "ENTITY_PROPOSAL_ID_INVALID")?;
        let entry = fields(value, "ENTITY_PROPOSAL_OBJECT_REQUIRED")?;
        let proposer = text(get(entry, "proposer")?, "ENTITY_PROPOSAL_PROPOSER_INVALID")?;
        if !proposers.insert(proposer.clone()) {
            return Err(invalid("ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT"));
        }
        let stored_id = text(get(entry, "id")?, "ENTITY_PROPOSAL_ID_INVALID")?;
        if stored_id != id || !id.starts_with("prop_") || id.len() != 69 {
            return Err(invalid("ENTITY_PROPOSAL_ID_INVALID"));
        }
        let mut votes = BTreeMap::new();
        for (raw_signer, raw_vote) in
            map(get(entry, "votes")?, "ENTITY_PROPOSAL_VOTES_MAP_REQUIRED")?
        {
            let signer = text(raw_signer, "ENTITY_PROPOSAL_VOTER_INVALID")?;
            let vote = match raw_vote {
                CanonicalValue::String(choice) => EntityProposalVote {
                    choice: decode_choice(choice)?,
                    comment: None,
                },
                CanonicalValue::Object(fields) => EntityProposalVote {
                    choice: decode_choice(&text(
                        get(fields, "choice")?,
                        "ENTITY_PROPOSAL_VOTE_CHOICE_INVALID",
                    )?)?,
                    comment: Some(text(
                        get(fields, "comment")?,
                        "ENTITY_PROPOSAL_VOTE_COMMENT_INVALID",
                    )?),
                },
                _ => return Err(invalid("ENTITY_PROPOSAL_VOTE_INVALID")),
            };
            if votes.insert(signer, vote).is_some() {
                return Err(invalid("ENTITY_PROPOSAL_DUPLICATE_VOTE"));
            }
        }
        if votes.len() > MAX_VOTES {
            return Err(invalid("ENTITY_PROPOSAL_VOTES_OVERSIZED"));
        }
        let proposal = EntityProposal {
            id: id.clone(),
            proposer,
            board_hash: fixed_hex(
                &text(
                    get(entry, "boardHash")?,
                    "ENTITY_PROPOSAL_BOARD_HASH_INVALID",
                )?,
                32,
                "ENTITY_PROPOSAL_BOARD_HASH_INVALID",
            )?,
            board_epoch: unsigned(
                get(entry, "boardEpoch")?,
                "ENTITY_PROPOSAL_BOARD_EPOCH_INVALID",
            )?,
            action: get(entry, "action")?.clone(),
            action_hash: fixed_hex(
                &text(
                    get(entry, "actionHash")?,
                    "ENTITY_PROPOSAL_ACTION_HASH_INVALID",
                )?,
                32,
                "ENTITY_PROPOSAL_ACTION_HASH_INVALID",
            )?,
            votes,
            created: unsigned(get(entry, "created")?, "ENTITY_PROPOSAL_CREATED_INVALID")?,
        };
        if hash_entity_proposal_action(&proposal.action)? != proposal.action_hash {
            return Err(invalid("ENTITY_PROPOSAL_ACTION_HASH_MISMATCH"));
        }
        if proposals.insert(id, proposal).is_some() {
            return Err(invalid("ENTITY_PROPOSAL_DUPLICATE"));
        }
    }
    Ok(proposals)
}

pub(crate) fn decode_approved_entity_txs(
    action: &CanonicalValue,
) -> Result<Vec<LocalEntityTx>, EntityKernelError> {
    crate::command::decode_collective_action_txs(action).map_err(|error| invalid(error.to_string()))
}

pub(crate) fn action_kind(action: &CanonicalValue) -> Result<&str, EntityKernelError> {
    let fields = fields(action, "ENTITY_PROPOSAL_ACTION_INVALID")?;
    text(get(fields, "type")?, "ENTITY_PROPOSAL_ACTION_TYPE_INVALID")
        .map(|value| match value.as_str() {
            "collective_message" => "collective_message",
            "entity_transaction" => "entity_transaction",
            _ => "invalid",
        })
        .and_then(|kind| {
            (kind != "invalid")
                .then_some(kind)
                .ok_or_else(|| invalid("ENTITY_PROPOSAL_ACTION_TYPE_INVALID"))
        })
}

pub(crate) fn collective_message(
    action: &CanonicalValue,
) -> Result<Option<String>, EntityKernelError> {
    if action_kind(action)? != "collective_message" {
        return Ok(None);
    }
    let action = fields(action, "ENTITY_PROPOSAL_ACTION_INVALID")?;
    let data = fields(get(action, "data")?, "ENTITY_PROPOSAL_MESSAGE_DATA_INVALID")?;
    Ok(Some(text(
        get(data, "message")?,
        "ENTITY_PROPOSAL_MESSAGE_DATA_INVALID",
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_action_hash_and_id_match_typescript() {
        let action = object(vec![
            ("type", CanonicalValue::String("collective_message".into())),
            (
                "data",
                object(vec![("message", CanonicalValue::String("hello".into()))]),
            ),
        ]);
        let action_hash = hash_entity_proposal_action(&action).expect("action hash");
        assert_eq!(
            action_hash,
            "0x959bfa6f1d4fbbd4f2ac37f33063bd6bdc295bc4c7ccd5da28eb70fbceffd55f"
        );
        assert_eq!(
            generate_entity_proposal_id(
                &action_hash,
                "alice",
                &format!("0x{}", "11".repeat(32)),
                7,
                &BigInt::from(3_u8),
            )
            .expect("proposal id"),
            "prop_24db0674c620bea8191e0c9e5695aa4918335b77ba8db9364fefcc758dae6b7d"
        );
    }

    #[test]
    fn proposal_state_round_trips_without_derived_copies() {
        let action = object(vec![
            ("type", CanonicalValue::String("collective_message".into())),
            (
                "data",
                object(vec![("message", CanonicalValue::String("hello".into()))]),
            ),
        ]);
        let action_hash = hash_entity_proposal_action(&action).expect("action hash");
        let id = generate_entity_proposal_id(
            &action_hash,
            "alice",
            &format!("0x{}", "11".repeat(32)),
            7,
            &BigInt::from(3_u8),
        )
        .expect("id");
        let proposal = EntityProposal {
            id: id.clone(),
            proposer: "alice".into(),
            board_hash: format!("0x{}", "11".repeat(32)),
            board_epoch: 7,
            action,
            action_hash,
            votes: BTreeMap::from([(
                "alice".into(),
                EntityProposalVote {
                    choice: EntityVoteChoice::Yes,
                    comment: Some("ship".into()),
                },
            )]),
            created: 99,
        };
        let state = BTreeMap::from([(id, proposal)]);
        let encoded = canonical_entity_proposals(&state).expect("encode");
        assert_eq!(
            decode_canonical_entity_proposals(&encoded).expect("decode"),
            state
        );
    }
}
