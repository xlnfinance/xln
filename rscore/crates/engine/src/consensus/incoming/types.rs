use std::fmt;

use crate::{AccountConsensus, AccountDisputeConfig, AccountDomain, AccountFrame, WatchSeed};

/// The exact common fields carried by every bilateral Account peer input.
///
/// `watch_seed` deliberately preserves presence. Existing accounts accept an
/// omitted seed, but a present seed must match; silently filling an omitted
/// value would change the Entity-owned input envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountPeerEnvelope {
    pub from_entity_id: [u8; 32],
    pub to_entity_id: [u8; 32],
    pub domain: AccountDomain,
    pub dispute_config: AccountDisputeConfig,
    pub watch_seed: Option<WatchSeed>,
}

/// One exact frame proposal as received from the peer.
///
/// The frame retains its received deltas. Replay derives a second delta vector
/// and compares the two before the received frame may become the chain head.
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameAckPhase {
    Ack,
    Frame,
}

impl fmt::Display for FrameAckPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ack => "ack",
            Self::Frame => "frame",
        })
    }
}

/// The single result of applying a canonical `frame_ack` input.
///
/// `Applied` means both phases were non-rejecting and the candidate was
/// published. `Rejected` means neither phase changed the caller's account.
#[derive(Clone, Debug)]
pub enum FrameAckOutcome {
    Applied {
        ack: Box<super::apply::AckOutcome>,
        frame: Box<super::apply::IncomingOutcome>,
    },
    Rejected {
        phase: FrameAckPhase,
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerEnvelopeRejection {
    Owner,
    Parties,
    Domain,
    DisputeConfig,
    WatchSeed,
}

impl fmt::Display for PeerEnvelopeRejection {
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
pub fn validate_peer_envelope(
    account: &AccountConsensus,
    envelope: &AccountPeerEnvelope,
) -> Result<(), PeerEnvelopeRejection> {
    let replica = account.replica();
    if replica.owner().as_bytes() != &envelope.to_entity_id {
        return Err(PeerEnvelopeRejection::Owner);
    }
    if replica.counterparty().as_bytes() != &envelope.from_entity_id {
        return Err(PeerEnvelopeRejection::Parties);
    }
    let state = replica.state();
    let identity = state.identity();
    if identity.domain() != &envelope.domain {
        return Err(PeerEnvelopeRejection::Domain);
    }
    if state.dispute_config() != envelope.dispute_config {
        return Err(PeerEnvelopeRejection::DisputeConfig);
    }
    if envelope
        .watch_seed
        .as_ref()
        .is_some_and(|seed| seed != identity.watch_seed())
    {
        return Err(PeerEnvelopeRejection::WatchSeed);
    }
    Ok(())
}
