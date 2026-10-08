//! Exact direct Account document from the committed native Account read head.
use serde_json::Value;
use xln_rscore_batch::AccountId;
use xln_rscore_runtime::{
    ResidentRuntimeService, RuntimeEntityKey, RuntimeReplica, tagged_json_from_canonical_value,
};

fn error(value: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:ACCOUNT_READ:{value}")
}
fn entity_id(value: &str) -> Result<[u8; 32], String> {
    let value = value
        .strip_prefix("0x")
        .ok_or("E_BAD_PATH:entity id must have 0x prefix")?;
    let bytes = hex::decode(value).map_err(|_| "E_BAD_PATH:entity id must be hex")?;
    bytes
        .try_into()
        .map_err(|_| "E_BAD_PATH:entity id must be 32 bytes".into())
}
pub(in crate::runtime_adapter) fn owner(
    replica: &RuntimeReplica,
    entity: &str,
    peer: &str,
) -> Result<(RuntimeEntityKey, AccountId), String> {
    let entity = entity_id(entity)?;
    let peer = entity_id(peer)?;
    let mut owners = replica
        .state
        .e_replicas
        .iter()
        .filter(|(key, _)| key.entity_id == entity);
    let (key, state) = owners.next().ok_or("E_NOT_FOUND:account owner")?;
    if owners.next().is_some() {
        return Err("E_INTERNAL:ACCOUNT_OWNER_AMBIGUOUS".into());
    }
    if !state
        .entity
        .known_accounts
        .contains(&format!("0x{}", hex::encode(peer)))
    {
        return Err("E_NOT_FOUND:account".into());
    }
    Ok((key.clone(), AccountId::from_bytes(peer)))
}
pub(in crate::runtime_adapter) fn document(
    mut rows: Vec<(AccountId, xln_rscore_protocol::CanonicalValue)>,
    wanted: AccountId,
) -> Result<Value, String> {
    if rows.len() != 1 {
        return Err("E_INTERNAL:ACCOUNT_READ_RESULT_COUNT".into());
    }
    let (id, value) = rows.pop().expect("one committed Account");
    if id != wanted {
        return Err("E_INTERNAL:ACCOUNT_READ_RESULT_ID".into());
    }
    tagged_json_from_canonical_value(&value).map_err(error)
}
pub fn read(
    service: &mut ResidentRuntimeService,
    entity: &str,
    peer: &str,
) -> Result<Value, String> {
    let (key, id) = owner(service.processor().replica().map_err(error)?, entity, peer)?;
    let rows = service
        .read_account_views(
            &key,
            vec![id],
            crate::runtime_adapter::views::account_projection::account_view,
        )
        .map_err(error)?;
    document(rows, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_batch::{AccountSeed, EngineGeneration, ResidentConsensusEngine};
    use xln_rscore_engine::{
        AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica,
        AccountState, BoardDelays, Delta, DepositoryAddress, EntityId, SigningIdentity, TokenId,
        WatchSeed, derive_signer_address, derive_signer_key,
    };
    #[test]
    fn direct_account_document_reads_exact_committed_native_forest_without_mutating_root() {
        let seed = "native-direct-account-read";
        let identity = |label| {
            SigningIdentity::lazy_from_seed(seed, label, 1, 1, BoardDelays::default()).unwrap()
        };
        let owner =
            EntityId::parse(&format!("0x{}", hex::encode(identity("owner").entity_id()))).unwrap();
        let peer =
            EntityId::parse(&format!("0x{}", hex::encode(identity("peer").entity_id()))).unwrap();
        let (left, right) = if owner < peer {
            (owner.clone(), peer.clone())
        } else {
            (peer.clone(), owner.clone())
        };
        let state = AccountState::new(
            AccountIdentity::new(
                AccountDomain::new(
                    31337,
                    DepositoryAddress::parse("0x8888888888888888888888888888888888888888").unwrap(),
                )
                .unwrap(),
                left,
                right,
                WatchSeed::parse(&format!("0x{}", "99".repeat(32))).unwrap(),
            )
            .unwrap(),
            AccountDisputeConfig::new(10, 10).unwrap(),
            vec![
                Delta::new(
                    TokenId::new(1).unwrap(),
                    500.into(),
                    0.into(),
                    17.into(),
                    1000.into(),
                    2000.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                )
                .unwrap(),
            ],
        )
        .unwrap();
        let account = AccountConsensus::new(AccountReplica::new(owner, state).unwrap());
        let id = AccountId::from_bytes(*peer.as_bytes());
        let mut forest = ResidentConsensusEngine::restore(
            EngineGeneration::from_bytes([0x31; 8]),
            1,
            0,
            derive_signer_key(seed, "owner").unwrap(),
            format!(
                "0x{}",
                hex::encode(derive_signer_address(seed, "owner").unwrap())
            ),
            std::sync::Arc::new(xln_rscore_runtime::canonical_swap_market_policy()),
            vec![AccountSeed {
                account_id: id,
                replica: account.replica().clone(),
                consensus: Some(account.consensus_snapshot()),
            }],
        )
        .unwrap();
        let root = forest.accounts_root();
        let expected = tagged_json_from_canonical_value(
            &crate::runtime_adapter::views::account_projection::account_view(&account).unwrap(),
        )
        .unwrap();
        let rows = forest
            .read_account_views(
                vec![id],
                crate::runtime_adapter::views::account_projection::account_view,
            )
            .unwrap();
        let actual = document(rows, id).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(actual["currentHeight"], 0);
        assert_eq!(
            actual["currentFrame"]["accountStateRoot"],
            expected["currentFrame"]["accountStateRoot"]
        );
        assert_eq!(forest.accounts_root(), root);
        assert_eq!(forest.account_count(), 1);
    }
    #[test]
    fn malformed_counterparty_ids_are_typed_rejects() {
        for id in ["", "0x11", "0x🦀", "11"] {
            assert!(entity_id(id).unwrap_err().starts_with("E_BAD_PATH:"));
        }
    }
}
