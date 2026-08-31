use std::fmt;

use crate::{AccountConsensus, AccountDisputeConfig, AccountDomain, AccountFrame, WatchSeed};

/// The exact common fields carried by every bilateral Account input.
///
/// `watch_seed` deliberately preserves presence. Existing accounts accept an
/// omitted seed, but a present seed must match; silently filling an omitted
/// value would change the Entity-owned input envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountInputEnvelope {
    pub from_entity_id: [u8; 32],
    pub to_entity_id: [u8; 32],
    pub domain: AccountDomain,
    pub dispute_config: AccountDisputeConfig,
    pub watch_seed: Option<WatchSeed>,
}

/// One exact frame proposal as received from the peer. Replay must reproduce
/// its `account_state_root` before the frame may become the chain head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncomingFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub frame_hanko: Option<Vec<u8>>,
    pub dispute: Option<crate::consensus::replica::CounterpartyDispute>,
}

/// One exact acknowledgement as received from the peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncomingAck {
    pub height: u64,
    pub frame_hash: [u8; 32],
    pub frame_hanko: Option<Vec<u8>>,
    pub dispute: Option<crate::consensus::replica::CounterpartyDispute>,
}

/// Witness rotation for an already committed Account frame. It never creates
/// a frame or spends a dispute nonce; it only replaces certificates after the
/// parent Entity has certified the named board activation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardHankoRefreshInput {
    pub height: u64,
    pub frame_hash: [u8; 32],
    pub frame_hanko: Option<Vec<u8>>,
    pub dispute: Option<crate::consensus::replica::CounterpartyDispute>,
    pub board_activation_j_height: u64,
    pub board_activation_log_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StandaloneInputOutcome {
    Applied { events: Vec<String> },
    Rejected { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckFramePhase {
    Ack,
    Frame,
}

impl fmt::Display for AckFramePhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ack => "ack",
            Self::Frame => "frame",
        })
    }
}

/// The single result of applying a canonical `ack_frame` input.
///
/// `Applied` means the ACK phase was non-rejecting and the proposal phase was
/// attempted. Its nested frame may itself be rejected; a committed ACK is not
/// rolled back. `Rejected` is reserved for an ACK-phase rejection, before any
/// phase could mutate the caller's account.
#[derive(Clone, Debug)]
pub enum AckFrameOutcome {
    Applied {
        ack: Box<super::apply::AckOutcome>,
        frame: Box<super::apply::IncomingOutcome>,
    },
    Rejected {
        phase: AckFramePhase,
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountInputEnvelopeRejection {
    Owner,
    Parties,
    Domain,
    DisputeConfig,
    WatchSeed,
}

impl fmt::Display for AccountInputEnvelopeRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Owner => "ACCOUNT_INPUT_OWNER_MISMATCH",
            Self::Parties => "ACCOUNT_INPUT_PARTY_MISMATCH",
            Self::Domain => "ACCOUNT_INPUT_DOMAIN_MISMATCH",
            Self::DisputeConfig => "ACCOUNT_INPUT_DISPUTE_CONFIG_MISMATCH",
            Self::WatchSeed => "ACCOUNT_WATCH_SEED_MISMATCH",
        })
    }
}

/// Validate every common envelope assertion against the live replica.
///
/// This runs before authentication, replay, or consensus coordination can
/// mutate the Account. The Account-map key is owned by the parent batch layer
/// and is checked there against `from_entity_id`.
pub fn validate_account_input_envelope(
    account: &AccountConsensus,
    envelope: &AccountInputEnvelope,
) -> Result<(), AccountInputEnvelopeRejection> {
    let replica = account.replica();
    if replica.owner().as_bytes() != &envelope.to_entity_id {
        return Err(AccountInputEnvelopeRejection::Owner);
    }
    if replica.counterparty().as_bytes() != &envelope.from_entity_id {
        return Err(AccountInputEnvelopeRejection::Parties);
    }
    let state = replica.state();
    let identity = state.identity();
    if identity.domain() != &envelope.domain {
        return Err(AccountInputEnvelopeRejection::Domain);
    }
    if state.dispute_config() != envelope.dispute_config {
        return Err(AccountInputEnvelopeRejection::DisputeConfig);
    }
    if envelope
        .watch_seed
        .as_ref()
        .is_some_and(|seed| seed != identity.watch_seed())
    {
        return Err(AccountInputEnvelopeRejection::WatchSeed);
    }
    Ok(())
}
