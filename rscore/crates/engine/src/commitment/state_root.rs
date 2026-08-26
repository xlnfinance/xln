use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, compute_flat_integrity_root};

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
        &account_state_entries(identity, dispute_config, roots, journal, carried)?,
    )
    .map_err(|error| StateError::AccountStateRoot(error.to_string()))
}

/// Per-section memo for the account state root.
///
/// A payment moves one section (the deltas root inside `financial`); the other
/// four are byte-identical to the previous commit. Each section is therefore
/// keyed by the exact inputs it commits, so an unchanged section is reused
/// instead of being rebuilt as a canonical value, encoded and hashed again.
/// `(deltas root, jNonce, left response seconds, right response seconds)`.
type FinancialKey = ([u8; 32], u64, u32, u32);
/// `(last finalized J height, left claims root+count, right claims root+count)`.
type JurisdictionKey = (u64, [u8; 32], u64, [u8; 32], u64);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountRootCache {
    identity: Option<[u8; 32]>,
    financial: Option<(FinancialKey, [u8; 32])>,
    commitments: Option<([[u8; 32]; 5], [u8; 32])>,
    jurisdiction: Option<(JurisdictionKey, [u8; 32])>,
    rebalance: Option<([[u8; 32]; 3], [u8; 32])>,
}

/// Sections in the order `compute_flat_integrity_root` sorts them, with their
/// label digests resolved once instead of per commit.
struct SectionLabels {
    ordered: [([u8; 32], usize); 5],
}

fn section_labels() -> &'static SectionLabels {
    static LABELS: std::sync::OnceLock<SectionLabels> = std::sync::OnceLock::new();
    LABELS.get_or_init(|| {
        let mut ordered: [([u8; 32], usize); 5] = [
            (label_digest("identity"), 0),
            (label_digest("financial"), 1),
            (label_digest("commitments"), 2),
            (label_digest("jurisdiction"), 3),
            (label_digest("rebalance"), 4),
        ];
        ordered.sort_unstable_by_key(|(digest, _)| *digest);
        SectionLabels { ordered }
    })
}

fn label_digest(path: &str) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    Sha256::digest(format!("xln.{ACCOUNT_STATE_NAMESPACE}.{path}").as_bytes()).into()
}

fn section_hash(value: &CanonicalValue) -> Result<[u8; 32], StateError> {
    use sha2::{Digest as _, Sha256};
    let mut writer = xln_rscore_protocol::RlpWriter::with_capacity(512);
    xln_rscore_protocol::write_account_state_value(&mut writer, value)
        .map_err(|error| StateError::AccountStateRoot(error.to_string()))?;
    Ok(Sha256::digest(writer.as_slice()).into())
}

fn combine_sections(sections: &[[u8; 32]; 5]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"xln.flat-digest.v1");
    for (label, index) in section_labels().ordered {
        digest.update(label);
        digest.update(sections[index]);
    }
    digest.finalize().into()
}

fn financial_key(
    roots: &PaymentAccountRoots,
    journal: &AccountJournal,
    dispute_config: AccountDisputeConfig,
) -> FinancialKey {
    // The section commits the dispute config too; keying without it would
    // reuse a stale digest for an account whose config changed.
    (
        roots.deltas,
        journal.j_nonce,
        dispute_config.left_response_seconds(),
        dispute_config.right_response_seconds(),
    )
}

fn commitments_key(roots: &PaymentAccountRoots, carried: &CarriedSections) -> [[u8; 32]; 5] {
    [
        roots.locks,
        carried.pulls_root,
        roots.swap_offers,
        carried.subcontracts_root,
        roots.lending_intents,
    ]
}

fn jurisdiction_key(journal: &AccountJournal, carried: &CarriedSections) -> JurisdictionKey {
    (
        journal.last_finalized_j_height,
        carried.left_pending_j_claims.root,
        carried.left_pending_j_claims.count,
        carried.right_pending_j_claims.root,
        carried.right_pending_j_claims.count,
    )
}

fn rebalance_key(roots: &PaymentAccountRoots, carried: &CarriedSections) -> [[u8; 32]; 3] {
    [
        carried.requested_rebalance_root,
        carried.requested_rebalance_fee_state_root,
        roots.rebalance_fee_policies,
    ]
}

/// The root from the memo alone, or None when any section moved.
pub(crate) fn cached_payment_account_state_root(
    cache: &AccountRootCache,
    dispute_config: AccountDisputeConfig,
    roots: &PaymentAccountRoots,
    journal: &AccountJournal,
    carried: &CarriedSections,
) -> Option<[u8; 32]> {
    let identity = cache.identity?;
    let (financial_cached, financial) = cache.financial.as_ref()?;
    if *financial_cached != financial_key(roots, journal, dispute_config) {
        return None;
    }
    let (commitments_cached, commitments) = cache.commitments.as_ref()?;
    if *commitments_cached != commitments_key(roots, carried) {
        return None;
    }
    let (jurisdiction_cached, jurisdiction) = cache.jurisdiction.as_ref()?;
    if *jurisdiction_cached != jurisdiction_key(journal, carried) {
        return None;
    }
    let (rebalance_cached, rebalance) = cache.rebalance.as_ref()?;
    if *rebalance_cached != rebalance_key(roots, carried) {
        return None;
    }
    Some(combine_sections(&[
        identity,
        *financial,
        *commitments,
        *jurisdiction,
        *rebalance,
    ]))
}

/// Recompute exactly the sections whose inputs moved and refresh the memo.
pub(crate) fn refresh_payment_account_state_root(
    cache: &mut AccountRootCache,
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: &PaymentAccountRoots,
    journal: &AccountJournal,
    carried: &CarriedSections,
) -> Result<[u8; 32], StateError> {
    let entries = account_state_entries_ref(identity, dispute_config, roots, journal, carried)?;
    let identity_hash = match cache.identity {
        Some(hash) => hash,
        None => {
            let hash = section_hash(&entries[0])?;
            cache.identity = Some(hash);
            hash
        }
    };
    let financial = refresh_section(
        &mut cache.financial,
        financial_key(roots, journal, dispute_config),
        &entries[1],
    )?;
    let commitments = refresh_section(
        &mut cache.commitments,
        commitments_key(roots, carried),
        &entries[2],
    )?;
    let jurisdiction = refresh_section(
        &mut cache.jurisdiction,
        jurisdiction_key(journal, carried),
        &entries[3],
    )?;
    let rebalance = refresh_section(
        &mut cache.rebalance,
        rebalance_key(roots, carried),
        &entries[4],
    )?;
    Ok(combine_sections(&[
        identity_hash,
        financial,
        commitments,
        jurisdiction,
        rebalance,
    ]))
}

fn refresh_section<K: PartialEq>(
    slot: &mut Option<(K, [u8; 32])>,
    key: K,
    value: &CanonicalValue,
) -> Result<[u8; 32], StateError> {
    if let Some((cached_key, hash)) = slot.as_ref()
        && *cached_key == key
    {
        return Ok(*hash);
    }
    let hash = section_hash(value)?;
    *slot = Some((key, hash));
    Ok(hash)
}

/// The five section values, in the fixed order the memo indexes them by.
fn account_state_entries_ref(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: &PaymentAccountRoots,
    journal: &AccountJournal,
    carried: &CarriedSections,
) -> Result<[CanonicalValue; 5], StateError> {
    let entries = account_state_entries(
        identity,
        dispute_config,
        PaymentAccountRoots {
            deltas: roots.deltas,
            locks: roots.locks,
            lending_intents: roots.lending_intents,
            rebalance_fee_policies: roots.rebalance_fee_policies,
            swap_offers: roots.swap_offers,
        },
        AccountJournal {
            j_nonce: journal.j_nonce,
            last_finalized_j_height: journal.last_finalized_j_height,
        },
        carried,
    )?;
    let mut values = entries.into_iter().map(|(_, value)| value);
    Ok([
        values.next().expect("identity"),
        values.next().expect("financial"),
        values.next().expect("commitments"),
        values.next().expect("jurisdiction"),
        values.next().expect("rebalance"),
    ])
}

fn account_state_entries(
    identity: &AccountIdentity,
    dispute_config: AccountDisputeConfig,
    roots: PaymentAccountRoots,
    journal: AccountJournal,
    carried: &CarriedSections,
) -> Result<Vec<(String, CanonicalValue)>, StateError> {
    Ok(vec![
        ("identity".into(), identity_value(identity)?),
        (
            "financial".into(),
            object(vec![
                ("deltasRoot", root_value(&roots.deltas)),
                ("jNonce", number(journal.j_nonce)?),
                ("disputeConfig", dispute_config_value(dispute_config)?),
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
                    number(journal.last_finalized_j_height)?,
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
    ])
}

fn identity_value(identity: &AccountIdentity) -> Result<CanonicalValue, StateError> {
    Ok(object(vec![
        ("chainId", number(identity.domain().chain_id())?),
        (
            "depositoryAddress",
            text(identity.domain().depository_address().as_hex()),
        ),
        ("leftEntity", text(identity.left().as_hex())),
        ("rightEntity", text(identity.right().as_hex())),
        ("watchSeed", text(identity.watch_seed().as_hex())),
    ]))
}

fn dispute_config_value(config: AccountDisputeConfig) -> Result<CanonicalValue, StateError> {
    Ok(object(vec![
        (
            "leftResponseSeconds",
            number(u64::from(config.left_response_seconds()))?,
        ),
        (
            "rightResponseSeconds",
            number(u64::from(config.right_response_seconds()))?,
        ),
    ]))
}

fn claim_value(accumulator: &JClaimAccumulator) -> CanonicalValue {
    object(vec![
        (
            "version",
            CanonicalValue::Number(CanonicalNumber::from_u32(1)),
        ),
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

fn number(value: u64) -> Result<CanonicalValue, StateError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| StateError::AccountStateRoot(error.to_string()))
}

fn text(value: String) -> CanonicalValue {
    CanonicalValue::String(value)
}

fn root_value(root: &[u8; 32]) -> CanonicalValue {
    text(hex_32(root))
}

fn hex_32(bytes: &[u8; 32]) -> String {
    crate::state::identity::render_hex(bytes)
}
