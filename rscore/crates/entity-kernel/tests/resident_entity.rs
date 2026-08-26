mod support;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputRow, AccountPeerInput, AccountSeed, EngineGeneration,
    EntityInboundRequest, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountPeerEnvelope,
    AccountReplica, AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress,
    EntityId, IncomingFrame, ProposalOutcome, ReceiverClock, SigningIdentity, TokenId, WatchSeed,
    derive_signer_key, propose_account_frame,
};
use xln_rscore_entity_kernel::{
    DeterministicContext, EntityStateSlice, ResidentEntityRequest, apply_resident_entity_round,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const TIMESTAMP: u64 = 1_700_000_000_000;

fn identity(label: &str) -> SigningIdentity {
    SigningIdentity::lazy_from_seed(SEED, label, 1, 1, BoardDelays::default())
        .expect("signing identity")
}

fn entity(identity: &SigningIdentity) -> EntityId {
    EntityId::parse(&format!("0x{}", hex::encode(identity.entity_id()))).expect("entity")
}

fn domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse("0x8888888888888888888888888888888888888888").expect("depository"),
    )
    .expect("domain")
}

fn account_state(first: &EntityId, second: &EntityId) -> AccountState {
    let (left, right) = if first < second {
        (first.clone(), second.clone())
    } else {
        (second.clone(), first.clone())
    };
    let capacity = BigInt::from(1_000_000_000_u64);
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        capacity.clone(),
        BigInt::from(0),
        BigInt::from(0),
        capacity.clone(),
        capacity,
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        AccountIdentity::new(
            domain(),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("account identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("account state")
}

#[test]
fn resident_entity_fuses_inbound_paybook_and_outbound_account_visit() {
    let payer_identity = identity("payer");
    let hub_identity = identity("hub");
    let next_identity = identity("next");
    let payer = entity(&payer_identity);
    let hub = entity(&hub_identity);
    let next = entity(&next_identity);
    let payer_id = AccountId::from_bytes(*payer.as_bytes());
    let next_id = AccountId::from_bytes(*next.as_bytes());
    let payer_account_state = account_state(&payer, &hub);
    let next_account_state = account_state(&hub, &next);

    let mut payer_account = AccountConsensus::new(
        AccountReplica::new(payer.clone(), payer_account_state.clone()).expect("payer replica"),
    );
    let payment = AccountTx::DirectPayment {
        token_id: TokenId::new(1).expect("token"),
        amount: BigInt::from(100),
        route: vec![hub.to_string(), next.to_string()],
        description: None,
        from_entity_id: payer.to_string(),
        to_entity_id: hub.to_string(),
        delivery_mode: DeliveryMode::Trusted,
        trusted_gateway_entity_id: Some(hub.to_string()),
    };
    payer_account
        .admit_txs(vec![payment], "resident-entity-test")
        .expect("admit payment");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut payer_account,
        &payer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .expect("payer proposal") else {
        panic!("payer must propose")
    };
    let proposed = *proposed;

    let seeds = vec![
        AccountSeed {
            account_id: payer_id,
            replica: AccountReplica::new(hub.clone(), payer_account_state)
                .expect("hub payer replica"),
            consensus: None,
        },
        AccountSeed {
            account_id: next_id,
            replica: AccountReplica::new(hub.clone(), next_account_state)
                .expect("hub next replica"),
            consensus: None,
        },
    ];
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        seeds,
    )
    .expect("resident accounts");
    let base_root = accounts.accounts_root();
    let inbound = EntityInboundRequest {
        owner_entity_id: *hub.as_bytes(),
        expected_accounts_root: base_root,
        clock: ReceiverClock {
            entity_timestamp: TIMESTAMP,
            finalized_j_height: 100,
        },
        rows: vec![AccountInputRow {
            operation_index: 0,
            account_id: payer_id,
            genesis_policy: None,
            input: AccountPeerInput {
                envelope: AccountPeerEnvelope {
                    from_entity_id: *payer.as_bytes(),
                    to_entity_id: *hub.as_bytes(),
                    domain: domain(),
                    dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                    watch_seed: Some(
                        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                    ),
                },
                kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                    frame: proposed.frame,
                    state_hash: proposed.state_hash,
                    frame_hanko: Some(proposed.hanko),
                    dispute: None,
                })),
            },
        }],
        post_accounts: false,
    };
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts = BTreeSet::from([payer.to_string(), next.to_string()]);
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound,
            creates: Vec::new(),
            failed_htlc_routes: Vec::new(),
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident entity round");

    assert_eq!(result.inbound.applied.len(), 1);
    assert_eq!(result.outbound.admissions.len(), 1);
    assert_eq!(result.outbound.proposals.len(), 1);
    let proposal = result.outbound.proposals[0]
        .proposed
        .as_ref()
        .expect("forward proposal");
    assert_eq!(result.outbound.proposals[0].account_id, next_id);
    assert_eq!(proposal.frame.txs.len(), 1);
    let AccountTx::DirectPayment {
        from_entity_id,
        to_entity_id,
        route,
        ..
    } = &proposal.frame.txs[0]
    else {
        panic!("paybook must produce a direct payment")
    };
    assert_eq!(from_entity_id, &hub.to_string());
    assert_eq!(to_entity_id, &next.to_string());
    assert_eq!(route, &[next.to_string()]);
    assert_ne!(result.outbound.accounts_root, base_root);
}
