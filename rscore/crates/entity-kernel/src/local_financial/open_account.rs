use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountSeed, EntityAccountGenesisPolicy, LocalGenesisSeedParams,
    build_local_genesis_seed,
};
use xln_rscore_engine::{AccountTx, EntityId, TokenId};
use xln_rscore_protocol::CanonicalValue;

use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::OpenAccountEntityTx;

const DEFAULT_TOKENS: [u32; 3] = [1, 3, 2];
const MAX_PROFILE_ADVERTISED_ACCOUNTS: usize = 100;

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("openAccount", detail.into())
}

fn object_field<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
}

fn hub_policy_tx(config: &CanonicalValue, token_id: u32) -> Result<AccountTx, EntityKernelError> {
    let policy_version = match object_field(config, "policyVersion") {
        Some(CanonicalValue::Number(value)) => value
            .as_str()
            .parse::<u64>()
            .map_err(|_| invalid("HUB_POLICY_VERSION"))?,
        _ => return Err(invalid("HUB_POLICY_VERSION")),
    };
    let liquidity_fee_bps = match object_field(config, "rebalanceLiquidityFeeBps") {
        Some(CanonicalValue::BigInt(value)) => value.clone(),
        _ => return Err(invalid("HUB_POLICY_LIQUIDITY_FEE")),
    };
    let decimals = match token_id {
        1 | 3 => 6_u32,
        2 => 18_u32,
        _ => return Err(invalid(format!("TOKEN_DECIMALS_UNKNOWN:{token_id}"))),
    };
    Ok(AccountTx::RebalancePolicy {
        token_id,
        policy_version,
        base_fee: BigInt::from(10_u8).pow(decimals - 1),
        liquidity_fee_bps,
        gas_fee: BigInt::from(0_u8),
    })
}

pub(super) fn apply(
    state: &mut EntityStateSlice,
    tx: OpenAccountEntityTx,
    genesis_policy: Option<&EntityAccountGenesisPolicy>,
    account_creates: &mut Vec<AccountSeed>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    if state.known_accounts.contains(&tx.target_entity_id) {
        return Err(invalid(format!(
            "OPEN_ACCOUNT_ALREADY_EXISTS:{}:{}",
            state.entity_id, tx.target_entity_id
        )));
    }
    let policy = genesis_policy.ok_or_else(|| invalid("GENESIS_POLICY_REQUIRED"))?;
    if tx.account_domain != policy.expected_domain {
        return Err(invalid("OPEN_ACCOUNT_DOMAIN_MISMATCH"));
    }
    let owner = EntityId::parse(&state.entity_id).map_err(|_| invalid("OWNER_ENTITY_ID"))?;
    let target = EntityId::parse(&tx.target_entity_id).map_err(|_| invalid("TARGET_ENTITY_ID"))?;
    if owner == target {
        return Err(invalid("ACCOUNT_PARTIES_INVALID"));
    }

    let mut policy_rows = policy.shadow_policy_rows.clone();
    let has_policy_override = tx.rebalance_policy.is_some();
    if let Some(override_policy) = tx.rebalance_policy {
        let value = CanonicalValue::Object(vec![
            (
                "r2cRequestSoftLimit".into(),
                CanonicalValue::BigInt(override_policy.r2c_request_soft_limit),
            ),
            (
                "hardLimit".into(),
                CanonicalValue::BigInt(override_policy.hard_limit),
            ),
            (
                "maxAcceptableFee".into(),
                CanonicalValue::BigInt(override_policy.max_acceptable_fee),
            ),
        ]);
        if let Some((_, existing)) = policy_rows
            .iter_mut()
            .find(|(token_id, _)| *token_id == u32::from(tx.token_id.get()))
        {
            *existing = value;
        } else {
            policy_rows.push((u32::from(tx.token_id.get()), value));
        }
    }
    if !policy_rows
        .iter()
        .any(|(token_id, _)| *token_id == u32::from(tx.token_id.get()))
    {
        return Err(invalid(format!(
            "REBALANCE_POLICY_TOKEN_MISSING:{}",
            tx.token_id
        )));
    }

    // Existing pinned Accounts are immutable. The first hundred locally
    // opened Accounts are the only ones that can be advertised; inbound Hub
    // users are never pinned. The resident aggregate will replace this
    // conservative count once the profile projection is native.
    let public_pinned =
        tx.pin_public && state.known_accounts.len() < MAX_PROFILE_ADVERTISED_ACCOUNTS;
    let seed = build_local_genesis_seed(LocalGenesisSeedParams {
        owner_entity_id: *owner.as_bytes(),
        account_id: AccountId::from_bytes(*target.as_bytes()),
        domain: tx.account_domain,
        watch_seed: tx.watch_seed,
        dispute_config: tx.dispute_config,
        delta_transformer: policy.delta_transformer,
        public_pinned,
        policy_rows,
    })
    .map_err(|error| invalid(format!("CREATE:{error}")))?;
    if seed.replica.envelope().rebalance_shadow_policy_root() != policy.shadow_policy_root {
        // A transaction override intentionally changes one row and therefore
        // the root. Without an override the Runtime-derived policy must bind
        // rows and root exactly; accepting a mismatched pair creates two
        // authorities for the same Account leaf.
        if !has_policy_override {
            return Err(invalid("GENESIS_POLICY_ROWS_ROOT_MISMATCH"));
        }
    }
    account_creates.push(seed);
    state.known_accounts.insert(tx.target_entity_id.clone());

    // Account outputs are positional protocol data. Preserve the TypeScript
    // default-token order instead of sorting it through a BTreeSet: sorting
    // [1, 3, 2] into [1, 2, 3] changes the signed Entity output sequence even
    // though the same AddDelta set is eventually admitted.
    let mut token_ids = DEFAULT_TOKENS.to_vec();
    let requested_token_id = u32::from(tx.token_id.get());
    if !token_ids.contains(&requested_token_id) {
        token_ids.push(requested_token_id);
    }
    for token_id in token_ids {
        let token = TokenId::new(token_id).map_err(|_| invalid("TOKEN_ID"))?;
        account_txs.push((
            tx.target_entity_id.clone(),
            AccountTx::AddDelta { token_id: token },
        ));
        if let Some(config) = state.hub_rebalance_config.as_ref() {
            account_txs.push((
                tx.target_entity_id.clone(),
                hub_policy_tx(config, token_id)?,
            ));
        }
    }
    if let Some(amount) = tx
        .credit_amount
        .filter(|amount| amount > &BigInt::from(0_u8))
    {
        account_txs.push((
            tx.target_entity_id.clone(),
            AccountTx::SetCreditLimit {
                token_id: tx.token_id,
                amount,
            },
        ));
    }
    events.extend([
        EntityFrameEvent::Status {
            message: format!("💳 Opening account with Entity {}...", tx.target_entity_id),
        },
        EntityFrameEvent::Status {
            message: format!(
                "✅ Account opening request sent to Entity {}",
                tx.target_entity_id
            ),
        },
    ]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{AccountDisputeConfig, AccountDomain, DepositoryAddress, WatchSeed};

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    fn policy_value() -> CanonicalValue {
        CanonicalValue::Object(vec![
            (
                "r2cRequestSoftLimit".into(),
                CanonicalValue::BigInt(500.into()),
            ),
            ("hardLimit".into(), CanonicalValue::BigInt(10_000.into())),
            ("maxAcceptableFee".into(), CanonicalValue::BigInt(15.into())),
        ])
    }

    #[test]
    fn open_account_uses_the_resident_create_path_and_initial_account_txs() {
        let owner = EntityId::parse(&entity("11")).expect("owner");
        let peer = EntityId::parse(&entity("22")).expect("peer");
        let domain = AccountDomain::new(
            31_337,
            DepositoryAddress::parse(&format!("0x{}", "33".repeat(20))).expect("depository"),
        )
        .expect("domain");
        let watch_seed = WatchSeed::parse(&format!("0x{}", "44".repeat(32))).expect("watch");
        let dispute = AccountDisputeConfig::new(10, 20).expect("dispute");
        let rows = vec![
            (1, policy_value()),
            (3, policy_value()),
            (2, policy_value()),
        ];
        let reference = build_local_genesis_seed(LocalGenesisSeedParams {
            owner_entity_id: *owner.as_bytes(),
            account_id: AccountId::from_bytes(*peer.as_bytes()),
            domain: domain.clone(),
            watch_seed: watch_seed.clone(),
            dispute_config: dispute,
            delta_transformer: [0x55; 20],
            public_pinned: false,
            policy_rows: rows.clone(),
        })
        .expect("reference seed");
        let policy = EntityAccountGenesisPolicy {
            expected_domain: domain.clone(),
            shadow_policy_root: reference.replica.envelope().rebalance_shadow_policy_root(),
            shadow_policy_rows: rows,
            delta_transformer: [0x55; 20],
            public_pinned: false,
        };
        let mut state = EntityStateSlice::empty(owner.to_string(), 100);
        let mut creates = Vec::new();
        let mut txs = Vec::new();
        let mut events = Vec::new();
        apply(
            &mut state,
            OpenAccountEntityTx {
                target_entity_id: peer.to_string(),
                dispute_config: dispute,
                account_domain: domain,
                watch_seed,
                credit_amount: Some(BigInt::from(7)),
                token_id: TokenId::new(1).expect("token"),
                pin_public: true,
                rebalance_policy: None,
            },
            Some(&policy),
            &mut creates,
            &mut txs,
            &mut events,
        )
        .expect("open");
        assert_eq!(creates.len(), 1);
        assert!(state.known_accounts.contains(&peer.to_string()));
        assert_eq!(txs.len(), 4);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            txs.last(),
            Some((account, AccountTx::SetCreditLimit { amount, .. }))
                if account == &peer.to_string() && amount == &BigInt::from(7)
        ));
    }
}
