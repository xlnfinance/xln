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
    EntityConsensusConfig, EntityConsensusState, EntityFrameAuthority, EntityHtlcNoteIndex,
    EntityLeaderState, EntityReferral, HtlcRoute, HubProfile, LockBookEntry,
    OrderbookConsensusMetadata, OrderbookState, ScheduledHook, SpreadDistribution,
    compute_entity_owned_sections, compute_entity_section_digest,
    project_entity_consensus_sections,
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
            jurisdiction: None,
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
    state.reserves.insert(1, BigInt::from(500));
    state.htlc_fees_earned = BigInt::from(3);
    state.htlc_routes.insert(
        "route-1".to_string(),
        HtlcRoute {
            hashlock: "route-1".to_string(),
            token_id: Some(1),
            amount: Some(BigInt::from(20)),
            started_at_ms: Some(90),
            originated: true,
            inbound_entity: None,
            inbound_lock_id: None,
            outbound_entity: Some(PEER.to_string()),
            outbound_lock_id: Some("lock-1".to_string()),
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: Some(BigInt::from(1)),
            created_timestamp: 91,
        },
    );
    state.lock_book.insert(
        "lock-1".to_string(),
        LockBookEntry {
            lock_id: "lock-1".to_string(),
            account_id: PEER.to_string(),
            token_id: 1,
            amount: BigInt::from(20),
            hashlock: "route-1".to_string(),
            timelock: BigInt::from(120),
            outgoing: true,
            created_at: BigInt::from(91),
        },
    );
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
        hooks: BTreeMap::from([(
            "htlc-timeout:lock-1".to_string(),
            ScheduledHook::htlc_timeout(PEER.to_string(), "lock-1".to_string(), 120),
        )]),
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
        htlc_notes: EntityHtlcNoteIndex::default(),
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
        ("config", &projection.config),
        ("leaderState", &projection.leader_state),
        ("reserves", &projection.reserves),
        ("lastFinalizedJHeight", &projection.last_finalized_j_height),
        ("htlcFeesEarned", &projection.htlc_fees_earned),
    ] {
        assert_section(&sections, field, value);
    }
    assert_section(
        &sections,
        "htlcRoutes",
        &logical_commitment(&projection.htlc_routes),
    );
    assert_section(
        &sections,
        "lockBook",
        &logical_commitment(&projection.lock_book),
    );

    let crontab = canonical_crontab_state_from_storage(
        projection.crontab_state.clone().expect("crontab scalar"),
        logical_commitment(&projection.crontab_hooks),
    )
    .expect("crontab consensus");
    assert_section(&sections, "crontabState", &crontab);

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
        vec![1, 2, 3, 7, 9, 10, 14, 17, 23, 35, 36, 37],
    );
}
