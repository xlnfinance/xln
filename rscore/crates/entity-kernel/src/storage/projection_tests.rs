use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::*;
use crate::commitment::{
    CanonicalOrderbookStorageFields, canonical_orderbook_ext_from_storage_fields,
    collection_commitment,
};
use crate::scheduler::canonical_crontab_state_from_storage;
use crate::{
    ConsensusMode, CrontabState, CrontabTaskMethod, CrontabTaskParam, CrontabTaskState,
    EntityCanonicalCollection, EntityConsensusConfig, EntityConsensusState, EntityFrameAuthority,
    EntityLeaderState, EntityReferral, HubProfile, OrderbookConsensusMetadata, OrderbookState,
    PaybookEntry, PaybookState, ScheduledHook, SpreadDistribution, compute_entity_owned_sections,
    compute_entity_section_digest, project_entity_consensus_sections,
};

const ENTITY: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PEER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const SIGNER: &str = "0x3333333333333333333333333333333333333333";

fn authority() -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![SIGNER.to_string()],
            shares: BTreeMap::from([(SIGNER.to_string(), 1)]),
            jurisdiction: Some(CanonicalValue::Object(vec![
                (
                    "name".into(),
                    CanonicalValue::String("native-jurisdiction".into()),
                ),
                (
                    "address".into(),
                    CanonicalValue::String("jreplica://native-jurisdiction".into()),
                ),
                (
                    "chainId".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(31_337)),
                ),
                (
                    "depositoryAddress".into(),
                    CanonicalValue::String("0x000000000000000000000000000000000000dead".into()),
                ),
                (
                    "entityProviderAddress".into(),
                    CanonicalValue::String("0x000000000000000000000000000000000000beef".into()),
                ),
                (
                    "blockTimeMs".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(1_000)),
                ),
            ])),
        },
        leader_state: EntityLeaderState {
            active_validator_id: SIGNER.to_string(),
            view: 2,
            changed_at_height: 3,
        },
    }
}

fn orderbook_metadata() -> OrderbookConsensusMetadata {
    OrderbookConsensusMetadata {
        hub_profile: HubProfile {
            entity_id: ENTITY.to_string(),
            name: "storage-projection".to_string(),
            spread_distribution: SpreadDistribution {
                maker_bps: 0,
                taker_bps: 10_000,
                hub_bps: 0,
                maker_referrer_bps: 0,
                taker_referrer_bps: 0,
            },
            reference_token_id: 1,
            usd_quote_authority_entity_id: ENTITY.to_string(),
            min_trade_size: BigInt::from(0),
            supported_pairs: Vec::new(),
        },
        referrals: BTreeMap::from([(
            PEER.to_string(),
            EntityReferral {
                entity_id: PEER.to_string(),
                referrer_id: None,
                timestamp: 7,
            },
        )]),
    }
}

fn state() -> EntityStateSlice {
    let mut state = EntityStateSlice::empty(ENTITY, 101);
    state.height = 9;
    state.last_finalized_j_height = 8;
    state.j_history_finality = Some(CanonicalValue::String("finality".into()));
    state.certified_board_state = Some(crate::CertifiedBoardState::empty([0x45; 32]));
    state.j_batch_state = Some(crate::JBatchState::default());
    state.hub_rebalance_config = Some(CanonicalValue::String("rebalance".into()));
    state.entity_encryption_public_key = [0x44; 32];
    state.reserves.insert(1, BigInt::from(500));
    state.deferred_account_proposals = Some(
        EntityCanonicalCollection::from_entries([(
            PEER.to_string(),
            CanonicalValue::String(format!("0x{}", "61".repeat(32))),
        )])
        .expect("deferred proposals"),
    );
    state.settlement_continuations = Some(
        EntityCanonicalCollection::from_entries([(
            PEER.to_string(),
            CanonicalValue::Object(vec![
                (
                    "workspaceHash".into(),
                    CanonicalValue::String(format!("0x{}", "62".repeat(32))),
                ),
                ("actions".into(), CanonicalValue::Array(Vec::new())),
                ("broadcast".into(), CanonicalValue::Bool(false)),
            ]),
        )])
        .expect("settlement continuations"),
    );
    state.paybook = PaybookState::from_entries(
        [PaybookEntry {
            hashlock: format!("0x{}", "ab".repeat(32)),
            description: Some("invoice".to_string()),
            token_id: Some(1),
            amount: Some(BigInt::from(20)),
            started_at_ms: Some(90),
            originated: true,
            inbound_entity: None,
            outbound_entity: Some(PEER.to_string()),
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: Some(BigInt::from(1)),
            created_timestamp: 91,
        }],
        BigInt::from(3),
    )
    .expect("paybook");
    state.crontab = Some(crontab());
    state.orderbook = Some(OrderbookState::empty(10_000));
    state.orderbook_metadata = Some(orderbook_metadata());
    state
}

fn crontab() -> CrontabState {
    CrontabState {
        tasks: BTreeMap::from([(
            CrontabTaskMethod::HubRebalance,
            CrontabTaskState {
                method: CrontabTaskMethod::HubRebalance,
                interval_ms: 1_000,
                last_run: 100,
                enabled: true,
                params: BTreeMap::from([(
                    "limit".to_string(),
                    CrontabTaskParam::Number(CanonicalNumber::from_u32(4)),
                )]),
            },
        )]),
        hooks: crate::ScheduledHookMap::restore(BTreeMap::from([(
            format!("dispute-deadline:{PEER}"),
            ScheduledHook {
                id: format!("dispute-deadline:{PEER}"),
                trigger_at: 120,
                kind: crate::ScheduledHookKind::DisputeDeadline {
                    account_id: PEER.to_string(),
                },
            },
        )]))
        .expect("scheduled hooks"),
    }
}

fn logical_commitment(rows: &BTreeMap<String, CanonicalValue>) -> CanonicalValue {
    collection_commitment(
        rows.iter()
            .map(|(key, value)| Ok::<_, EntityKernelError>((key.clone(), value.clone()))),
    )
    .expect("logical collection")
}

fn assert_section(sections: &BTreeMap<String, String>, field: &str, value: &CanonicalValue) {
    assert_eq!(
        compute_entity_section_digest(value).expect("section digest"),
        sections[field],
        "{field}",
    );
}

#[test]
fn storage_projection_values_reproduce_owned_consensus_digests() {
    let state = state();
    let consensus = ResidentEntityConsensusReplica {
        state: EntityConsensusState {
            sections: Vec::new(),
            authority: authority(),
        },
        certified_frame_head: None,
    };
    let projection = project_entity_storage(&state, &consensus).expect("projection");
    let owned = compute_entity_owned_sections(&state, [0x55; 32], 1).expect("owned sections");
    let sections = project_entity_consensus_sections(&[], owned, &consensus.state.authority)
        .expect("complete sections")
        .into_iter()
        .map(|section| (section.field, section.digest))
        .collect::<BTreeMap<_, _>>();

    for (field, value) in [
        ("entityId", &projection.entity_id),
        ("height", &projection.height),
        ("timestamp", &projection.timestamp),
        ("reserves", &projection.reserves),
        ("lastFinalizedJHeight", &projection.last_finalized_j_height),
        (
            "jHistoryFinality",
            projection.j_history_finality.as_ref().expect("j finality"),
        ),
        (
            "certifiedBoardState",
            projection
                .certified_board_state
                .as_ref()
                .expect("certified board"),
        ),
        (
            "jBatchState",
            projection.j_batch_state.as_ref().expect("j batch"),
        ),
        (
            "hubRebalanceConfig",
            projection
                .hub_rebalance_config
                .as_ref()
                .expect("hub config"),
        ),
        (
            "entityEncryptionPublicKey",
            &projection.entity_encryption_public_key,
        ),
        ("profile", &projection.profile),
    ] {
        assert_section(&sections, field, value);
    }
    let (stored_config, stored_leader) = consensus
        .state
        .authority
        .storage_values()
        .expect("stored authority");
    let (committed_config, committed_leader) = consensus
        .state
        .authority
        .commitment_values()
        .expect("committed authority");
    assert_eq!(projection.config, stored_config);
    assert_eq!(projection.leader_state, stored_leader);
    assert_ne!(stored_config, committed_config);
    assert_eq!(stored_leader, committed_leader);
    assert_section(&sections, "config", &committed_config);
    assert_section(&sections, "leaderState", &committed_leader);
    let CanonicalValue::Object(paybook_scalar) = &projection.paybook else {
        panic!("paybook scalar");
    };
    let fees = paybook_scalar
        .iter()
        .find(|(key, _)| key == "feesEarned")
        .map(|(_, value)| value.clone())
        .expect("paybook fees");
    let paybook = CanonicalValue::Object(vec![
        (
            "entries".to_string(),
            CanonicalValue::Object(vec![
                (
                    "radix".to_string(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(16)),
                ),
                (
                    "leafCount".to_string(),
                    CanonicalValue::Number(
                        CanonicalNumber::try_from_u64(
                            u64::try_from(projection.paybook_entries.len()).expect("paybook count"),
                        )
                        .expect("canonical paybook count"),
                    ),
                ),
                (
                    "root".to_string(),
                    CanonicalValue::String(format!(
                        "0x{}",
                        hex::encode(state.paybook.entries.root_hash())
                    )),
                ),
            ]),
        ),
        ("feesEarned".to_string(), fees),
    ]);
    assert_section(&sections, "paybook", &paybook);

    let crontab = canonical_crontab_state_from_storage(
        projection.crontab_state.clone().expect("crontab scalar"),
        logical_commitment(&projection.crontab_hooks),
    )
    .expect("crontab consensus");
    assert_section(&sections, "crontabState", &crontab);
    assert_section(
        &sections,
        "deferredAccountProposals",
        &logical_commitment(&projection.deferred_account_proposals),
    );
    assert_section(
        &sections,
        "settlementContinuations",
        &logical_commitment(&projection.settlement_continuations),
    );

    let orderbook = canonical_orderbook_ext_from_storage_fields(
        state.orderbook.as_ref().expect("orderbook"),
        CanonicalOrderbookStorageFields {
            hub_profile: projection.orderbook_hub_profile.clone().expect("hub"),
            referrals: projection.orderbook_referrals.clone().expect("referrals"),
            pair_dimensions: projection
                .orderbook_pair_dimensions
                .clone()
                .expect("dimensions"),
        },
    )
    .expect("orderbook consensus");
    assert_section(&sections, "orderbookExt", &orderbook);
    assert_eq!(
        projection
            .scalar_fields()
            .map(|(tag, _)| tag)
            .collect::<Vec<_>>(),
        vec![
            1, 2, 3, 6, 7, 9, 10, 14, 15, 16, 17, 18, 20, 21, 22, 34, 35, 36, 37,
        ],
    );
}
