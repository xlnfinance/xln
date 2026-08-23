use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalValue, compute_flat_integrity_root};

use crate::{AccountDisputeConfig, AccountIdentity, StateError};

const ACCOUNT_STATE_NAMESPACE: &str = "account.state";
const EMPTY_J_CLAIM_DOMAIN: &[u8] = b"xln.account-j-claim.empty.v1";
const EMPTY_ROOT: [u8; 32] = [0; 32];

pub(crate) struct PaymentAccountRoots {
    pub deltas: [u8; 32],
    pub locks: [u8; 32],
    pub lending_intents: [u8; 32],
}

pub(crate) fn payment_account_state_root(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: PaymentAccountRoots,
) -> Result<[u8; 32], StateError> {
    compute_flat_integrity_root(
        ACCOUNT_STATE_NAMESPACE,
        &account_state_entries(identity, dispute_config, roots),
    )
    .map_err(|error| StateError::AccountStateRoot(error.to_string()))
}

fn account_state_entries(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: PaymentAccountRoots,
) -> Vec<(String, CanonicalValue)> {
    let zero = root_value(&EMPTY_ROOT);
    vec![
        ("identity".into(), identity_value(identity)),
        (
            "financial".into(),
            object(vec![
                ("deltasRoot", root_value(&roots.deltas)),
                ("jNonce", number(0)),
                ("disputeConfig", dispute_config_value(dispute_config)),
            ]),
        ),
        (
            "commitments".into(),
            object(vec![
                ("locksRoot", root_value(&roots.locks)),
                ("pullsRoot", zero.clone()),
                ("swapOffersRoot", zero.clone()),
                ("subcontractsRoot", zero.clone()),
                ("lendingIntentsRoot", root_value(&roots.lending_intents)),
            ]),
        ),
        (
            "jurisdiction".into(),
            object(vec![
                ("lastFinalizedJHeight", number(0)),
                ("leftPendingJClaims", empty_claim_value()),
                ("rightPendingJClaims", empty_claim_value()),
            ]),
        ),
        (
            "rebalance".into(),
            object(vec![
                ("requestedRebalanceRoot", zero.clone()),
                ("requestedRebalanceFeeStateRoot", zero.clone()),
                ("rebalanceFeePoliciesRoot", zero),
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

fn empty_claim_value() -> CanonicalValue {
    let root: [u8; 32] = Keccak256::digest(EMPTY_J_CLAIM_DOMAIN).into();
    object(vec![
        ("version", number(1)),
        ("root", root_value(&root)),
        ("count", CanonicalValue::BigInt(BigInt::from(0))),
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
