use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalValue, compute_flat_integrity_root};

use crate::{AccountDisputeConfig, AccountIdentity, StateError};

const ACCOUNT_STATE_NAMESPACE: &str = "account.state";
const EMPTY_J_CLAIM_DOMAIN: &[u8] = b"xln.account-j-claim.empty.v1";

pub(crate) struct PaymentAccountRoots {
    pub deltas: [u8; 32],
    pub locks: [u8; 32],
    pub lending_intents: [u8; 32],
    pub rebalance_fee_policies: [u8; 32],
    pub swap_offers: [u8; 32],
}

pub(crate) struct AccountJournal {
    pub j_nonce: u64,
    pub last_finalized_j_height: u64,
}

/// Sections the engine does not interpret but must commit verbatim.
///
/// No supported transaction (payments, HTLC lock/resolve) mutates any of
/// them, so carrying their roots preserves the exact account state root of a
/// live account whose swap/pull/lending/rebalance/J-claim state is non-empty.
/// What the engine computes itself (deltas, locks, the accounts tree) is still
/// verified independently; these are faithfully preserved, not re-derived.
#[derive(Clone, Default)]
pub struct CarriedSections {
    pub pulls_root: [u8; 32],
    pub subcontracts_root: [u8; 32],
    pub requested_rebalance_root: [u8; 32],
    pub requested_rebalance_fee_state_root: [u8; 32],
    pub left_pending_j_claims: JClaimAccumulator,
    pub right_pending_j_claims: JClaimAccumulator,
}

#[derive(Clone)]
pub struct JClaimAccumulator {
    pub root: [u8; 32],
    pub count: u64,
}

impl Default for JClaimAccumulator {
    fn default() -> Self {
        Self {
            root: Keccak256::digest(EMPTY_J_CLAIM_DOMAIN).into(),
            count: 0,
        }
    }
}

pub(crate) fn payment_account_state_root(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: PaymentAccountRoots,
    journal: AccountJournal,
    carried: &CarriedSections,
) -> Result<[u8; 32], StateError> {
    compute_flat_integrity_root(
        ACCOUNT_STATE_NAMESPACE,
        &account_state_entries(identity, dispute_config, roots, journal, carried),
    )
    .map_err(|error| StateError::AccountStateRoot(error.to_string()))
}

fn account_state_entries(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: PaymentAccountRoots,
    journal: AccountJournal,
    carried: &CarriedSections,
) -> Vec<(String, CanonicalValue)> {
    vec![
        ("identity".into(), identity_value(identity)),
        (
            "financial".into(),
            object(vec![
                ("deltasRoot", root_value(&roots.deltas)),
                ("jNonce", number(journal.j_nonce)),
                ("disputeConfig", dispute_config_value(dispute_config)),
            ]),
        ),
        (
            "commitments".into(),
            object(vec![
                ("locksRoot", root_value(&roots.locks)),
                ("pullsRoot", root_value(&carried.pulls_root)),
                ("swapOffersRoot", root_value(&roots.swap_offers)),
                ("subcontractsRoot", root_value(&carried.subcontracts_root)),
                ("lendingIntentsRoot", root_value(&roots.lending_intents)),
            ]),
        ),
        (
            "jurisdiction".into(),
            object(vec![
                (
                    "lastFinalizedJHeight",
                    number(journal.last_finalized_j_height),
                ),
                (
                    "leftPendingJClaims",
                    claim_value(&carried.left_pending_j_claims),
                ),
                (
                    "rightPendingJClaims",
                    claim_value(&carried.right_pending_j_claims),
                ),
            ]),
        ),
        (
            "rebalance".into(),
            object(vec![
                (
                    "requestedRebalanceRoot",
                    root_value(&carried.requested_rebalance_root),
                ),
                (
                    "requestedRebalanceFeeStateRoot",
                    root_value(&carried.requested_rebalance_fee_state_root),
                ),
                (
                    "rebalanceFeePoliciesRoot",
                    root_value(&roots.rebalance_fee_policies),
                ),
            ]),
        ),
    ]
}

fn identity_value(identity: &AccountIdentity) -> CanonicalValue {
    object(vec![
        ("chainId", number(identity.domain().chain_id())),
        (
            "depositoryAddress",
            text(identity.domain().depository_address().as_hex()),
        ),
        ("leftEntity", text(identity.left().as_hex())),
        ("rightEntity", text(identity.right().as_hex())),
        ("watchSeed", text(identity.watch_seed().as_hex())),
    ])
}

fn dispute_config_value(config: AccountDisputeConfig) -> CanonicalValue {
    object(vec![
        (
            "leftResponseSeconds",
            number(u64::from(config.left_response_seconds())),
        ),
        (
            "rightResponseSeconds",
            number(u64::from(config.right_response_seconds())),
        ),
    ])
}

fn claim_value(accumulator: &JClaimAccumulator) -> CanonicalValue {
    object(vec![
        ("version", number(1)),
        ("root", root_value(&accumulator.root)),
        (
            "count",
            CanonicalValue::BigInt(BigInt::from(accumulator.count)),
        ),
    ])
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(value as f64)
}

fn text(value: String) -> CanonicalValue {
    CanonicalValue::String(value)
}

fn root_value(root: &[u8; 32]) -> CanonicalValue {
    text(hex_32(root))
}

fn hex_32(bytes: &[u8; 32]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
