use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDomain, AccountOutput, AccountSettledEvent, AccountTx, DepositoryAddress, EntityId,
    ExternalAllowance, ExternalTokenBalance, ExternalWalletDeltaEvent, ExternalWalletSnapshotEvent,
    JEventClaimTx, JEventMetadata, JurisdictionEvent, ReserveUpdatedEvent, TokenId,
    canonical_tx_digest,
};
use xln_rscore_entity_kernel::{
    CommittedAccountTransition, ConsensusMode, DeterministicContext, EMPTY_J_HISTORY_ROOT,
    EntityConsensusConfig, EntityFrameAuthority, EntityFrameEvent, EntityKernelError,
    EntityKernelOutput, EntityLeaderState, EntityStateSlice, FinalizedJEventBatch, JClaimIngress,
    JReserveUpdate, JurisdictionScope, OrderedAccountCommit, apply_entity_kernel,
    apply_finalized_j_event_batches, canonical_j_event_blocks, canonical_j_event_range_hash,
    capture_entity_state, compute_entity_owned_sections, fold_j_history_root, j_event_range_digest,
    restore_entity_state,
};

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
}

fn metadata(height: u64, block: u8, tx: u8, log_index: u64) -> JEventMetadata {
    JEventMetadata {
        block_number: Some(height),
        block_hash: Some([block; 32]),
        transaction_hash: Some([tx; 32]),
        log_index: Some(log_index),
        event_index: None,
    }
}

fn authority(validator: String) -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![validator.clone()],
            shares: BTreeMap::from([(validator.clone(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: validator,
            view: 0,
            changed_at_height: 0,
        },
    }
}

#[allow(clippy::too_many_arguments)] // Fixture builder mirrors the signed claim fields one-for-one.
fn claim(
    owner: &EntityId,
    counterparty: &EntityId,
    height: u64,
    block: u8,
    tx: u8,
    log_index: u64,
    token_id: u32,
    own_reserve: i64,
    collateral: i64,
    ondelta: i64,
) -> (JClaimIngress, JReserveUpdate) {
    let token = TokenId::new(token_id).expect("token");
    let event = JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: Some(height),
            block_hash: Some([block; 32]),
            transaction_hash: Some([tx; 32]),
            log_index: Some(log_index),
            event_index: None,
        },
        left_entity: owner.clone(),
        right_entity: counterparty.clone(),
        token_id: token,
        left_reserve: own_reserve.into(),
        right_reserve: 1_999_999_000_000_i64.into(),
        collateral: collateral.into(),
        ondelta: ondelta.into(),
        nonce: 0,
    });
    (
        JClaimIngress {
            account_id: counterparty.clone(),
            tx: AccountTx::JEventClaim(JEventClaimTx {
                j_height: height,
                j_block_hash: [block; 32],
                events: vec![event],
                left_proof: None,
                right_proof: None,
            }),
        },
        JReserveUpdate {
            token_id: token.get(),
            own_reserve: own_reserve.into(),
        },
    )
}

fn claim_events(claims: &[&JClaimIngress]) -> Vec<JurisdictionEvent> {
    claims
        .iter()
        .flat_map(|claim| match &claim.tx {
            AccountTx::JEventClaim(tx) => tx.events.clone(),
            _ => Vec::new(),
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn reserve_event(
    owner: &EntityId,
    height: u64,
    block: u8,
    tx: u8,
    log_index: u64,
    token_id: i64,
    balance: i64,
) -> JurisdictionEvent {
    JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
        metadata: JEventMetadata {
            block_number: Some(height),
            block_hash: Some([block; 32]),
            transaction_hash: Some([tx; 32]),
            log_index: Some(log_index),
            event_index: None,
        },
        entity: owner.as_hex(),
        token_id,
        new_balance: balance.into(),
    })
}

#[test]
fn watcher_ingress_matches_typescript_claim_and_reserves_goldens() {
    let owner = entity(0xaa);
    let peer = entity(0xbb);
    let mut state = EntityStateSlice::empty(owner.as_hex(), 1);
    state.known_accounts.insert(peer.as_hex());
    state.reserves.insert(2, BigInt::from(9));
    let (claim, reserve) = claim(&owner, &peer, 43, 0xcc, 0xdd, 1, 1, 0, 1_000_000, 0);
    let batch = FinalizedJEventBatch {
        j_height: 43,
        j_block_hash: [0xcc; 32],
        events: {
            let mut events = claim_events(&[&claim]);
            events.push(reserve_event(&owner, 43, 0xcc, 0xdd, 2, 1, 0));
            xln_rscore_engine::canonical_events(&events).expect("events")
        },
        dispute_finalization_evidence: vec![],
        reserve_updates: vec![reserve],
        account_claims: vec![claim],
    };
    let result = apply_finalized_j_event_batches(
        &mut state,
        43,
        &[batch],
        "runtime-seed",
        None,
        &BTreeSet::from([peer.as_hex()]),
        &BTreeMap::new(),
    )
    .expect("watcher ingress");
    assert_eq!(state.last_finalized_j_height, 43);
    assert_eq!(state.reserves.get(&1), Some(&BigInt::from(0)));
    assert_eq!(result.proposal_work.len(), 1);
    let tx = &result.proposal_work[0].txs[0];
    assert_eq!(
        hex::encode(canonical_tx_digest(tx).expect("claim digest")),
        // Generated by TS canonicalAccountTxForFrameHash +
        // encodeAccountStateValue for `j_event_claim/minimal`.
        "8d60ef9635ae2ac1f894d68226d49b9ff264703093b1044bc0103eeb6c4cdb7f"
    );
    let reserves = compute_entity_owned_sections(&state, [0; 32], 1)
        .expect("owned sections")
        .into_iter()
        .find(|section| section.field == "reserves")
        .expect("reserves section");
    assert_eq!(
        reserves.digest,
        // Generated by TS computeIntegrityDigest(encodeCanonicalConsensusBytes(
        // new Map([[1, 0n], [2, 9n]]))).
        "0xcb9a8dce0258ce9096584ba054f8b44b1696072dd38079c62a2d0df3509be0d6"
    );
    assert_eq!(result.queued_claims[0].counterparty_id, peer.as_hex());
    assert_eq!(
        result.frame_events,
        vec![
            EntityFrameEvent::Status {
                message: "⚖️ OBSERVED: bbbb | coll=1.0 USDC | j-block 43 (awaiting 2-of-2)".into(),
            },
            EntityFrameEvent::Status {
                message: "📊 RESERVE: 0 raw units of token #1 | Block 43 | Tx 0xdddddddd...".into(),
            },
        ]
    );
    let snapshot = capture_entity_state(&state, [0; 32], 1).expect("snapshot");
    let restored = restore_entity_state(snapshot, [0; 32], 1).expect("restore");
    assert_eq!(restored.reserves, state.reserves);
}

#[test]
fn watcher_ingress_applies_external_wallet_snapshot_then_delta() {
    let owner = entity(0xaa);
    let wallet_owner = [0x11; 20];
    let token = [0x22; 20];
    let spender = [0x33; 20];
    let snapshot = JurisdictionEvent::ExternalWalletSnapshot(ExternalWalletSnapshotEvent {
        metadata: metadata(43, 0x43, 0x44, 1),
        entity_id: owner.as_hex(),
        owner: wallet_owner,
        native_balance: Some(BigInt::from(5)),
        token_balances: vec![ExternalTokenBalance {
            token_address: token,
            token_id: Some(7),
            balance: BigInt::from(100),
        }],
        allowances: vec![ExternalAllowance {
            token_address: token,
            spender,
            allowance: BigInt::from(10),
        }],
    });
    let delta = JurisdictionEvent::ExternalWalletDelta(ExternalWalletDeltaEvent {
        metadata: metadata(43, 0x43, 0x45, 2),
        entity_id: owner.as_hex(),
        owner: wallet_owner,
        token_address: token,
        token_id: Some(7),
        balance_delta: Some(BigInt::from(7)),
        spender: Some(spender),
        allowance: Some(BigInt::from(9)),
    });
    let events = xln_rscore_engine::canonical_events(&[snapshot, delta]).expect("events");
    let mut state = EntityStateSlice::empty(owner.as_hex(), 1);
    let result = apply_finalized_j_event_batches(
        &mut state,
        43,
        &[FinalizedJEventBatch {
            j_height: 43,
            j_block_hash: [0x43; 32],
            events,
            dispute_finalization_evidence: vec![],
            reserve_updates: vec![],
            account_claims: vec![],
        }],
        "runtime-seed",
        Some(&authority(format!("0x{}", hex::encode(wallet_owner)))),
        &BTreeSet::new(),
        &BTreeMap::new(),
    )
    .expect("wallet ingress");
    assert_eq!(
        result.frame_events,
        vec![
            EntityFrameEvent::Status {
                message: "💼 EXTERNAL: 0x11111111 snapshot | Block 43 | Tx 0x44444444...".into(),
            },
            EntityFrameEvent::Status {
                message: "💼 EXTERNAL: 0x11111111 delta | Block 43 | Tx 0x45454545...".into(),
            },
        ]
    );
    let wallet = state.external_wallet.as_ref().expect("wallet state");
    assert_eq!(
        wallet
            .balance(&wallet_owner, &token)
            .expect("token balance")
            .balance,
        BigInt::from(107)
    );
    assert_eq!(
        wallet
            .balance(&wallet_owner, &[0; 20])
            .expect("native balance")
            .balance,
        BigInt::from(5)
    );
    assert_eq!(
        wallet
            .allowance(&wallet_owner, &token, &spender)
            .expect("allowance")
            .allowance,
        BigInt::from(9)
    );
}

#[test]
fn j_history_range_hashes_match_typescript_goldens() {
    let owner = entity(0xaa);
    let peer = entity(0xbb);
    let (claim, _reserve) = claim(&owner, &peer, 43, 0xcc, 0xdd, 1, 1, 0, 1_000_000, 0);
    let batch = FinalizedJEventBatch {
        j_height: 43,
        j_block_hash: [0xcc; 32],
        events: claim_events(&[&claim]),
        dispute_finalization_evidence: vec![],
        reserve_updates: vec![],
        account_claims: vec![claim],
    };
    let blocks = canonical_j_event_blocks(&[batch]).expect("canonical J blocks");
    assert_eq!(
        hex::encode(blocks[0].events_hash),
        "9d3d69db1a897eb444ebffc7f811dc5f582e8c8126be33803455ec0bf2eb9f9d"
    );
    assert_eq!(
        hex::encode(EMPTY_J_HISTORY_ROOT),
        "11f189b4db640a8bcbdf48da58bca9fc0764f07c068815d73c698457bbb01ec2"
    );
    let jurisdiction_ref = format!("chain:31337:depository:0x{}", "88".repeat(20));
    let range_hash = canonical_j_event_range_hash(&blocks).expect("range hash");
    assert_eq!(
        hex::encode(range_hash),
        "a03dc8e602bc485be6f6531ec61b710bb2dbd4dfb5d4131ecee1823d1d42d091"
    );
    let history_root = fold_j_history_root(EMPTY_J_HISTORY_ROOT, &jurisdiction_ref, &blocks);
    assert_eq!(
        hex::encode(history_root),
        "48d351cb5d1fc7ad935cab9cfa8ce004d713914703c207e863fcbba3c0f54232"
    );
    let digest = j_event_range_digest(
        &owner.as_hex(),
        &jurisdiction_ref,
        &format!("0x{}", "11".repeat(20)),
        0,
        43,
        &[0xcc; 32],
        &history_root,
        &range_hash,
    )
    .expect("range digest");
    assert_eq!(
        hex::encode(digest),
        "35c3d84e153353c001a5e873eeccf05ffe8b4c4ee5e7a96407ab07baca3a5507"
    );
}

#[test]
fn ingress_orders_claims_but_updates_every_observed_reserve() {
    let owner = entity(0xaa);
    let active_b = entity(0xbb);
    let active_c = entity(0xcc);
    let inactive = entity(0xdd);
    let missing = entity(0xee);
    let mut state = EntityStateSlice::empty(owner.as_hex(), 1);
    state
        .known_accounts
        .extend([active_b.as_hex(), active_c.as_hex(), inactive.as_hex()]);
    let (claim_c, reserve_c) = claim(&owner, &active_c, 43, 0x43, 0x12, 2, 2, 20, 2, 2);
    let (claim_b, reserve_b) = claim(&owner, &active_b, 43, 0x43, 0x11, 1, 1, 10, 1, 1);
    let (claim_d, reserve_d) = claim(&owner, &inactive, 43, 0x43, 0x13, 3, 3, 30, 3, 3);
    let (claim_e, reserve_e) = claim(&owner, &missing, 43, 0x43, 0x14, 4, 4, 40, 4, 4);
    let result = apply_finalized_j_event_batches(
        &mut state,
        45,
        &[FinalizedJEventBatch {
            j_height: 43,
            j_block_hash: [0x43; 32],
            events: {
                let mut events = claim_events(&[&claim_b, &claim_c, &claim_d, &claim_e]);
                events.extend([
                    reserve_event(&owner, 43, 0x43, 0x11, 5, 1, 10),
                    reserve_event(&owner, 43, 0x43, 0x12, 6, 2, 20),
                    reserve_event(&owner, 43, 0x43, 0x13, 7, 3, 30),
                    reserve_event(&owner, 43, 0x43, 0x14, 8, 4, 40),
                ]);
                xln_rscore_engine::canonical_events(&events).expect("events")
            },
            dispute_finalization_evidence: vec![],
            reserve_updates: vec![reserve_b, reserve_c, reserve_d, reserve_e],
            account_claims: vec![claim_c, claim_b, claim_d, claim_e],
        }],
        "runtime-seed",
        None,
        &BTreeSet::from([active_b.as_hex(), active_c.as_hex()]),
        &BTreeMap::new(),
    )
    .expect("ordered ingress");
    assert_eq!(
        result
            .proposal_work
            .iter()
            .map(|work| work.account_id.as_str())
            .collect::<Vec<_>>(),
        vec![active_b.as_hex(), active_c.as_hex()]
    );
    assert_eq!(result.queued_claims.len(), 2);
    assert_eq!(state.reserves.len(), 4);
    assert_eq!(state.last_finalized_j_height, 45);
}

#[test]
fn malformed_watcher_projection_is_atomic_and_unsupported_tx_is_loud() {
    let owner = entity(0xaa);
    let peer = entity(0xbb);
    let mut state = EntityStateSlice::empty(owner.as_hex(), 1);
    state.known_accounts.insert(peer.as_hex());
    let before = state.clone();
    let (claim, mut reserve) = claim(&owner, &peer, 43, 0x43, 0x11, 1, 1, 10, 1, 1);
    reserve.own_reserve = BigInt::from(11);
    assert!(matches!(
        apply_finalized_j_event_batches(
            &mut state,
            43,
            &[FinalizedJEventBatch {
                j_height: 43,
                j_block_hash: [0x43; 32],
                events: claim_events(&[&claim]),
                dispute_finalization_evidence: vec![],
                reserve_updates: vec![reserve],
                account_claims: vec![claim],
            }],
            "runtime-seed",
            None,
            &BTreeSet::from([peer.as_hex()]),
            &BTreeMap::new(),
        ),
        Err(EntityKernelError::JEventInvalid { detail })
            if detail == "ACCOUNT_SETTLED_RESERVE_PROJECTION"
    ));
    assert_eq!(state, before);

    let error = apply_finalized_j_event_batches(
        &mut state,
        43,
        &[FinalizedJEventBatch {
            j_height: 43,
            j_block_hash: [0x43; 32],
            events: vec![reserve_event(&owner, 43, 0x43, 0x22, 1, 1, 7)],
            dispute_finalization_evidence: vec![],
            reserve_updates: vec![JReserveUpdate {
                token_id: 1,
                own_reserve: 7.into(),
            }],
            account_claims: vec![JClaimIngress {
                account_id: peer.clone(),
                tx: AccountTx::AddDelta {
                    token_id: TokenId::new(1).expect("token"),
                },
            }],
        }],
        "runtime-seed",
        None,
        &BTreeSet::from([peer.as_hex()]),
        &BTreeMap::new(),
    )
    .expect_err("non J-event Account transaction must be rejected");
    assert!(
        matches!(
            error,
            EntityKernelError::UnsupportedJEventIngress { kind: "add_delta" }
        ),
        "unexpected error: {error:?}",
    );
}

#[test]
fn committed_bilateral_finality_projects_the_exact_runtime_event() {
    let owner = entity(0xaa);
    let peer = entity(0xbb);
    let mut state = EntityStateSlice::empty(owner.as_hex(), 1);
    state.known_accounts.insert(peer.as_hex());
    let (ingress, _) = claim(&owner, &peer, 43, 0xcc, 0xdd, 1, 1, 0, 1_000_000, -7);
    let AccountTx::JEventClaim(claim) = ingress.tx else {
        panic!("claim");
    };
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "44".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let result = apply_entity_kernel(
        state,
        &[OrderedAccountCommit {
            account_id: peer.as_hex(),
            domain,
            scope: JurisdictionScope::Same,
            committed_via_new_frame: true,
            frame_state_hash: format!("0x{}", "55".repeat(32)),
            frame_height: 1,
            frame_timestamp: 1,
            transitions: vec![CommittedAccountTransition {
                tx: AccountTx::JEventClaim(claim),
                outputs: vec![AccountOutput::AccountSettledFinalized {
                    token_id: TokenId::new(1).expect("token"),
                    j_height: 43,
                    collateral: BigInt::from(1_000_000),
                    ondelta: BigInt::from(-7),
                }],
            }],
        }],
        &DeterministicContext::hlt_default(),
    )
    .expect("committed claim");
    assert_eq!(
        result.outputs,
        vec![EntityKernelOutput::AccountSettledFinalizedBilateral {
            entity_id: owner.as_hex(),
            account_id: peer.as_hex(),
            token_id: 1,
            j_height: 43,
            collateral: BigInt::from(1_000_000),
            ondelta: BigInt::from(-7),
        }]
    );
}
