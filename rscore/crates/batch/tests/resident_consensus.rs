mod fixture;

use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputVerdict, AccountRestore, AccountSeed, BatchError,
    EngineGeneration, EntityAccountGenesisPolicy, EntityInboundRequest, EntityOutboundRequest,
    FailedHtlcRoute, ResidentConsensusEngine, StatefulConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity, AccountReplica,
    AccountState, AccountTx, CounterpartyDispute, DepositoryAddress, HtlcHashlock, HtlcLockTx,
    TokenId, WatchSeed,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

const TIMESTAMP: u64 = 1_700_000_000_000;
const REVISION: u64 = 7;

fn resident(
    workers: usize,
    signer: &str,
    revision: u64,
    market: Arc<xln_rscore_engine::SwapMarketPolicy>,
    seeds: Vec<AccountSeed>,
) -> ResidentConsensusEngine {
    ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        revision,
        fixture::signer_key(signer),
        signer.to_string(),
        market,
        seeds,
    )
    .expect("resident restore")
}

fn legacy(
    workers: usize,
    signer: &str,
    revision: u64,
    market: Arc<xln_rscore_engine::SwapMarketPolicy>,
    seeds: Vec<AccountSeed>,
) -> StatefulConsensusEngine {
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        revision,
        fixture::signer_key(signer),
        signer.to_string(),
        market,
        seeds,
    )
    .expect("legacy restore")
}

fn funded_seed() -> (AccountSeed, fixture::Pair) {
    let stand = fixture::stand_with_market(1, fixture::market());
    let pair = stand.pairs.into_iter().next().expect("pair");
    let account = stand
        .payer
        .account(&pair.payer_account)
        .expect("payer account");
    (
        AccountSeed {
            account_id: pair.payer_account,
            replica: account.replica().clone(),
            consensus: Some(account.consensus_snapshot()),
        },
        pair,
    )
}

fn mixed_txs(pair: &fixture::Pair) -> Vec<AccountTx> {
    let mut txs = fixture::payment(pair, 25).1;
    txs.extend(fixture::swap_offer(pair).1);
    txs.push(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: format!("0x{}", "4b".repeat(32)),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "5a".repeat(32))).expect("hashlock"),
        timelock: BigInt::from(TIMESTAMP + 60_000),
        reveal_before_height: 200,
        amount: BigInt::from(10),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    }));
    txs
}

fn enter_legacy(engine: &mut StatefulConsensusEngine, owner: [u8; 32]) {
    engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: owner,
            expected_accounts_root: engine.accounts_root(),
            clock: fixture::clock(TIMESTAMP),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("legacy inbound");
}

fn enter_resident(engine: &mut ResidentConsensusEngine, owner: [u8; 32]) {
    engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: owner,
            expected_accounts_root: engine.accounts_root(),
            clock: fixture::clock(TIMESTAMP),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("resident inbound");
}

fn outbound_request(
    owner: [u8; 32],
    account_id: AccountId,
    txs: Vec<AccountTx>,
) -> EntityOutboundRequest {
    EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: vec![(account_id, txs)],
        propose: vec![account_id],
        materialize: Vec::new(),
        failed_htlc_routes: Vec::new(),
        checkpoint_due: false,
        post_accounts: true,
    }
}

fn empty_checkpoint_request(owner: [u8; 32]) -> EntityOutboundRequest {
    EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: Vec::new(),
        propose: Vec::new(),
        materialize: Vec::new(),
        failed_htlc_routes: Vec::new(),
        checkpoint_due: true,
        post_accounts: false,
    }
}

fn exact_restore_row(
    engine: &StatefulConsensusEngine,
    account_id: AccountId,
    signer_id: &str,
) -> AccountRestore {
    let account = engine.account(&account_id).expect("restore account");
    AccountRestore {
        account_id,
        replica: account.replica().clone(),
        consensus: account.consensus_snapshot(),
        signer_id: signer_id.to_string(),
        account_leaf: account.entity_account_leaf().expect("account leaf"),
    }
}

#[test]
fn exact_restore_refuses_every_corrupt_binding_before_returning_an_engine() {
    let (seed, pair) = funded_seed();
    let source = legacy(4, "payer-0", REVISION, fixture::market(), vec![seed]);
    let token = source.checkpoint_token().expect("checkpoint token");
    let restore = |expected, rows| {
        ResidentConsensusEngine::restore_exact(
            EngineGeneration::from_bytes([0x42; 8]),
            4,
            fixture::signer_key("payer-0"),
            "payer-0".to_string(),
            fixture::market(),
            expected,
            rows,
        )
    };

    let exact = restore(
        token,
        vec![exact_restore_row(&source, pair.payer_account, "payer-0")],
    )
    .expect("exact resident restore");
    assert_eq!(exact.revision(), token.revision);
    assert_eq!(exact.accounts_root(), token.accounts_root);
    assert_eq!(exact.account_count(), token.account_count);

    assert!(matches!(
        restore(token, Vec::new()),
        Err(BatchError::CheckpointIncomplete { .. })
    ));
    let mut duplicate_token = token;
    duplicate_token.account_count = 2;
    assert!(matches!(
        restore(
            duplicate_token,
            vec![
                exact_restore_row(&source, pair.payer_account, "payer-0"),
                exact_restore_row(&source, pair.payer_account, "payer-0"),
            ],
        ),
        Err(BatchError::DuplicateAccount(_))
    ));
    let mut bad_leaf = exact_restore_row(&source, pair.payer_account, "payer-0");
    bad_leaf.account_leaf[0] ^= 1;
    assert!(matches!(
        restore(token, vec![bad_leaf]),
        Err(BatchError::CheckpointAccountLeaf { .. })
    ));
    let mut bad_root = token;
    bad_root.accounts_root[0] ^= 1;
    assert!(matches!(
        restore(
            bad_root,
            vec![exact_restore_row(&source, pair.payer_account, "payer-0")],
        ),
        Err(BatchError::CheckpointRoot { .. })
    ));
    let mut bad_digest = token;
    bad_digest.signer_digest[0] ^= 1;
    assert!(matches!(
        restore(
            bad_digest,
            vec![exact_restore_row(&source, pair.payer_account, "payer-0")],
        ),
        Err(BatchError::CheckpointSignerDigest { .. })
    ));
    assert!(matches!(
        restore(
            token,
            vec![exact_restore_row(
                &source,
                pair.payer_account,
                "other-signer"
            )],
        ),
        Err(BatchError::SignerRebind { .. })
    ));
}

#[test]
fn resident_pay_htlc_swap_result_matches_the_legacy_oracle() {
    let (seed, pair) = funded_seed();
    let expected_domain = seed.replica.state().identity().domain().clone();
    let expected_dispute_config = seed.replica.state().dispute_config();
    let expected_watch_seed = seed.replica.state().identity().watch_seed().clone();
    let market = fixture::market();
    let mut legacy = legacy(
        4,
        "payer-0",
        REVISION,
        Arc::clone(&market),
        vec![seed.clone()],
    );
    let mut resident = resident(4, "payer-0", REVISION, market, vec![seed]);
    assert_eq!(legacy.accounts_root(), resident.accounts_root());
    enter_legacy(&mut legacy, pair.payer_entity);
    enter_resident(&mut resident, pair.payer_entity);

    let expected = legacy
        .entity_outbound(outbound_request(
            pair.payer_entity,
            pair.payer_account,
            mixed_txs(&pair),
        ))
        .expect("legacy outbound");
    let actual = resident
        .entity_outbound(outbound_request(
            pair.payer_entity,
            pair.payer_account,
            mixed_txs(&pair),
        ))
        .expect("resident outbound");

    assert_eq!(actual.revision, expected.revision);
    assert_eq!(actual.accounts_root, expected.accounts_root);
    assert_eq!(actual.admissions, expected.admissions);
    assert_eq!(actual.touched, expected.touched);
    assert_eq!(actual.proposals.len(), 1);
    assert_eq!(actual.post_accounts.len(), 1);
    let expected_proposal = expected.proposals[0]
        .proposed
        .as_ref()
        .expect("legacy frame");
    let actual_proposal = actual.proposals[0]
        .proposed
        .as_ref()
        .expect("resident frame");
    assert_eq!(actual_proposal.frame, expected_proposal.frame);
    assert_eq!(actual_proposal.state_hash, expected_proposal.state_hash);
    assert_eq!(actual_proposal.hanko, expected_proposal.hanko);
    assert_eq!(actual_proposal.events, expected_proposal.events);
    assert_eq!(actual_proposal.outputs, expected_proposal.outputs);
    let outbound = actual.proposals[0]
        .outbound_input
        .as_ref()
        .expect("Account consensus authored its exact outbound input");
    assert_eq!(outbound.envelope.from_entity_id, pair.payer_entity);
    assert_eq!(outbound.envelope.to_entity_id, pair.payee_entity);
    assert_eq!(outbound.envelope.domain, expected_domain);
    assert_eq!(outbound.envelope.dispute_config, expected_dispute_config);
    assert_eq!(
        outbound.envelope.watch_seed.as_ref(),
        Some(&expected_watch_seed)
    );
    let AccountInputKind::Frame(frame) = &outbound.kind else {
        panic!("first proposal must be a frame");
    };
    assert_eq!(frame.frame, actual_proposal.frame);
    assert_eq!(frame.state_hash, actual_proposal.state_hash);
    assert_eq!(frame.frame_hanko.as_ref(), Some(&actual_proposal.hanko));
    assert_eq!(
        frame.dispute.as_ref().map(|draft| (
            draft.hanko.as_ref(),
            draft.hash,
            draft.proof_body_hash,
            draft.nonce,
            draft.proposer_is_left,
        )),
        actual_proposal.dispute.as_ref().map(|draft| (
            None,
            draft.hash,
            draft.proof_body_hash,
            draft.nonce,
            draft.proposer_is_left,
        )),
    );
    assert_eq!(
        actual.post_accounts[0].account_leaf,
        expected.post_accounts[0].account_leaf
    );
    assert_eq!(
        actual.post_accounts[0].sections,
        expected.post_accounts[0].sections
    );
    assert_eq!(
        (
            actual.post_accounts[0].put_count(),
            actual.post_accounts[0].del_count()
        ),
        (
            expected.post_accounts[0].put_count(),
            expected.post_accounts[0].del_count()
        )
    );
}

#[test]
fn checkpoint_due_exports_exact_dirty_rows_once() {
    let (seed, pair) = funded_seed();
    let market = fixture::market();
    let mut legacy = legacy(
        4,
        "payer-0",
        REVISION,
        Arc::clone(&market),
        vec![seed.clone()],
    );
    let mut resident = resident(4, "payer-0", REVISION, market, vec![seed]);
    enter_legacy(&mut legacy, pair.payer_entity);
    enter_resident(&mut resident, pair.payer_entity);

    let expected = legacy
        .entity_outbound(outbound_request(
            pair.payer_entity,
            pair.payer_account,
            mixed_txs(&pair),
        ))
        .expect("legacy materialization oracle");
    let mut request = outbound_request(pair.payer_entity, pair.payer_account, mixed_txs(&pair));
    request.checkpoint_due = true;
    request.post_accounts = false;
    let checkpointed = resident
        .entity_outbound(request)
        .expect("resident checkpoint export");
    assert_eq!(checkpointed.accounts_root, expected.accounts_root);
    assert!(checkpointed.post_accounts.is_empty());
    let checkpoint = checkpointed
        .checkpoint
        .as_ref()
        .expect("checkpoint manifest");
    assert_eq!(checkpoint.base_revision(), REVISION);
    assert_eq!(checkpoint.revision(), checkpointed.revision);
    assert_eq!(checkpoint.accounts_root(), checkpointed.accounts_root);
    assert_eq!(checkpoint.token.account_count, 1);
    assert_eq!(checkpoint.accounts.len(), 1);
    assert!(checkpoint.removed.is_empty());
    assert_eq!(
        checkpoint.accounts[0].account_leaf,
        expected.post_accounts[0].account_leaf
    );
    assert_eq!(
        checkpoint.accounts[0].sections,
        expected.post_accounts[0].sections
    );
    assert_eq!(
        (
            checkpoint.accounts[0].put_count(),
            checkpoint.accounts[0].del_count(),
        ),
        (
            expected.post_accounts[0].put_count(),
            expected.post_accounts[0].del_count(),
        )
    );

    resident
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: pair.payer_entity,
            expected_accounts_root: checkpointed.accounts_root,
            clock: fixture::clock(TIMESTAMP + 1),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("promote checkpointed head");
    let empty = resident
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: pair.payer_entity,
            timestamp: TIMESTAMP + 1,
            j_height: 101,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            checkpoint_due: true,
            post_accounts: false,
        })
        .expect("second checkpoint");
    let empty_checkpoint = empty.checkpoint.expect("empty exact checkpoint manifest");
    assert!(empty_checkpoint.accounts.is_empty());
    assert!(empty_checkpoint.removed.is_empty());
    assert_eq!(empty_checkpoint.base_revision(), checkpointed.revision);
    assert_eq!(empty_checkpoint.revision(), empty.revision);
    assert_eq!(empty_checkpoint.accounts_root(), empty.accounts_root);
    assert_eq!(empty_checkpoint.token.account_count, 1);
    assert_eq!(
        empty_checkpoint.restore_token().base_revision,
        empty_checkpoint.revision()
    );
    assert_eq!(empty.accounts_root, checkpointed.accounts_root);
}

#[test]
fn explicit_existing_import_exports_every_seed_until_acked_but_normal_restore_is_clean() {
    let (seed, pair) = funded_seed();
    let mut imported = ResidentConsensusEngine::import_existing(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        fixture::signer_key("payer-0"),
        "payer-0".to_string(),
        fixture::market(),
        vec![seed.clone()],
    )
    .expect("explicit existing import");
    let imported_root = imported.accounts_root();
    enter_resident(&mut imported, pair.payer_entity);
    let first = imported
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("first imported checkpoint")
        .checkpoint
        .expect("first imported manifest");
    assert_eq!(first.base_revision(), 0);
    assert_eq!(first.revision(), 0);
    assert_eq!(first.accounts_root(), imported_root);
    assert_eq!(first.token.account_count, 1);
    assert_eq!(first.accounts.len(), 1);
    assert_eq!(first.accounts[0].account_id, pair.payer_account);

    let retried = imported
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("retry imported checkpoint before ack")
        .checkpoint
        .expect("retry imported manifest");
    assert_eq!(retried.token, first.token);
    assert_eq!(retried.accounts.len(), 1);
    assert_eq!(retried.accounts[0].account_id, first.accounts[0].account_id);
    assert_eq!(
        retried.accounts[0].account_leaf,
        first.accounts[0].account_leaf
    );
    assert_eq!(retried.accounts[0].sections, first.accounts[0].sections);
    assert_eq!(
        retried.accounts[0].put_count(),
        first.accounts[0].put_count()
    );
    assert_eq!(
        retried.accounts[0].del_count(),
        first.accounts[0].del_count()
    );

    let mut restored = resident(4, "payer-0", 0, fixture::market(), vec![seed]);
    enter_resident(&mut restored, pair.payer_entity);
    let clean = restored
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("normal restore checkpoint")
        .checkpoint
        .expect("normal restore manifest");
    assert_eq!(clean.accounts_root(), imported_root);
    assert_eq!(clean.token.account_count, 1);
    assert!(clean.accounts.is_empty());
}

#[test]
fn resident_failed_forward_fixed_point_matches_the_legacy_oracle() {
    let mut stand = fixture::stand(1);
    let owner = stand.pairs[0].payer_entity;
    let downstream = stand.pairs[0].payer_account;
    let payer = stand.pairs[0].payer.clone();
    let (upstream_bytes, upstream_peer) = fixture::entity_of("upstream-peer");
    let (left, right) = if payer < upstream_peer {
        (payer.clone(), upstream_peer)
    } else {
        (upstream_peer, payer.clone())
    };
    let upstream = AccountId::from_bytes(upstream_bytes);
    stand
        .payer
        .upsert_accounts(vec![AccountSeed {
            account_id: upstream,
            replica: AccountReplica::new(payer, fixture::account_state(&left, &right))
                .expect("upstream replica"),
            consensus: None,
        }])
        .expect("upstream Account");
    let seeds = [downstream, upstream]
        .into_iter()
        .map(|account_id| {
            let account = stand.payer.account(&account_id).expect("seed account");
            AccountSeed {
                account_id,
                replica: account.replica().clone(),
                consensus: Some(account.consensus_snapshot()),
            }
        })
        .collect();
    let mut resident = resident(4, "payer-0", stand.payer.revision(), Arc::default(), seeds);
    enter_legacy(&mut stand.payer, owner);
    enter_resident(&mut resident, owner);
    let hashlock = HtlcHashlock::parse(&format!("0x{}", "5a".repeat(32))).expect("hashlock");
    let downstream_lock_id = format!("0x{}", "4b".repeat(32));
    let upstream_lock_id = format!("0x{}", "3c".repeat(32));
    let request = || EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: vec![(
            downstream,
            vec![AccountTx::HtlcLock(HtlcLockTx {
                lock_id: downstream_lock_id.clone(),
                hashlock: hashlock.clone(),
                timelock: BigInt::from(TIMESTAMP - 1),
                reveal_before_height: 200,
                amount: BigInt::from(10),
                token_id: TokenId::new(1).expect("token"),
                delivery_mode: None,
                envelope: None,
            })],
        )],
        propose: vec![downstream],
        materialize: Vec::new(),
        failed_htlc_routes: vec![FailedHtlcRoute {
            hashlock: *hashlock.bytes(),
            outbound_account_id: downstream,
            outbound_lock_id: downstream_lock_id.clone(),
            inbound_account_id: upstream,
            inbound_lock_id: upstream_lock_id.clone(),
        }],
        checkpoint_due: false,
        post_accounts: true,
    };
    let expected = stand
        .payer
        .entity_outbound(request())
        .expect("legacy fixed point");
    let actual = resident
        .entity_outbound(request())
        .expect("resident fixed point");
    assert_eq!(actual.revision, expected.revision);
    assert_eq!(actual.accounts_root, expected.accounts_root);
    assert_eq!(actual.admissions, expected.admissions);
    assert_eq!(actual.touched, expected.touched);
    assert_eq!(actual.proposals.len(), expected.proposals.len());
    for (actual, expected) in actual.proposals.iter().zip(&expected.proposals) {
        assert_eq!(actual.account_id, expected.account_id);
        match (&actual.proposed, &expected.proposed) {
            (Some(actual_frame), Some(expected_frame)) => {
                assert_eq!(actual_frame.frame, expected_frame.frame);
                assert_eq!(actual_frame.state_hash, expected_frame.state_hash);
                assert_eq!(actual_frame.hanko, expected_frame.hanko);
                assert_eq!(actual_frame.events, expected_frame.events);
                assert_eq!(actual_frame.outputs, expected_frame.outputs);
            }
            (None, None) => {}
            _ => panic!("resident and legacy proposal presence diverged"),
        }
        assert_eq!(
            actual.failed_htlc_locks.len(),
            expected.failed_htlc_locks.len()
        );
        for (actual_failed, expected_failed) in actual
            .failed_htlc_locks
            .iter()
            .zip(&expected.failed_htlc_locks)
        {
            assert_eq!(actual_failed.hashlock, expected_failed.hashlock);
            assert_eq!(actual_failed.lock_id, expected_failed.lock_id);
            assert_eq!(actual_failed.reason, expected_failed.reason);
            let actual_upstream = actual_failed.upstream_resolution.as_ref();
            let expected_upstream = expected_failed.upstream_resolution.as_ref();
            assert_eq!(
                actual_upstream.map(|row| (row.account_id, &row.lock_id, &row.reason)),
                expected_upstream.map(|row| (row.account_id, &row.lock_id, &row.reason)),
            );
        }
    }
}

#[test]
fn resident_result_is_root_identical_with_1_2_4_8_16_workers() {
    let (seed, pair) = funded_seed();
    let mut expected = None;
    for workers in [1, 2, 4, 8, 16] {
        let mut engine = resident(
            workers,
            "payer-0",
            REVISION,
            fixture::market(),
            vec![seed.clone()],
        );
        enter_resident(&mut engine, pair.payer_entity);
        let result = engine
            .entity_outbound(outbound_request(
                pair.payer_entity,
                pair.payer_account,
                mixed_txs(&pair),
            ))
            .expect("resident outbound");
        let signature = (
            result.revision,
            result.accounts_root,
            result.touched,
            result.proposals[0]
                .proposed
                .as_ref()
                .expect("frame")
                .state_hash,
        );
        if let Some(expected) = &expected {
            assert_eq!(&signature, expected, "workers={workers}");
        } else {
            expected = Some(signature);
        }
    }
}

#[test]
fn resident_refuses_to_guess_proposability_for_an_unrepresented_settlement_workspace() {
    let (mut seed, _) = funded_seed();
    seed.replica.set_settlement_workspace_present(true);
    let error = match ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        1,
        REVISION,
        fixture::signer_key("payer-0"),
        "payer-0".to_string(),
        fixture::market(),
        vec![seed],
    ) {
        Ok(_) => panic!("settlement eligibility cannot be inferred from a presence bit"),
        Err(error) => error,
    };
    assert_eq!(error, BatchError::ProposabilitySettlementUnrepresented,);
}

#[test]
fn failed_outbound_restores_the_exact_post_inbound_head() {
    let (seed, pair) = funded_seed();
    let mut engine = resident(4, "payer-0", REVISION, fixture::market(), vec![seed]);
    enter_resident(&mut engine, pair.payer_entity);
    let root = engine.accounts_root();
    let revision = engine.revision();
    let count = engine.account_count();
    let proposable = engine
        .proposable_account_ids()
        .expect("pre-error proposer index");
    let (created, owner, _) = genesis_seed("payer-0", "new-peer");
    assert_eq!(owner, pair.payer_entity);
    let error = match engine.entity_outbound(EntityOutboundRequest {
        owner_entity_id: pair.payer_entity,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: vec![created],
        admits: vec![(pair.payer_account, fixture::payment(&pair, 25).1)],
        propose: Vec::new(),
        materialize: vec![AccountId::from_bytes([0xfe; 32])],
        failed_htlc_routes: Vec::new(),
        checkpoint_due: false,
        post_accounts: false,
    }) {
        Ok(_) => panic!("unknown materialization account must fail"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        xln_rscore_batch::BatchError::AccountNotFound { .. }
            | xln_rscore_batch::BatchError::CandidateAccountNotFound(_)
    ));
    assert_eq!(engine.accounts_root(), root);
    assert_eq!(engine.revision(), revision);
    assert_eq!(engine.account_count(), count);
    assert_eq!(
        engine
            .proposable_account_ids()
            .expect("post-error proposer index"),
        proposable,
    );
}

#[test]
fn checkpoint_after_local_creation_restores_exactly_and_binds_signer_digest() {
    let (created, owner, _) = genesis_seed("payer-0", "new-peer");
    let account_id = created.account_id;
    let request = || EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: vec![created.clone()],
        admits: Vec::new(),
        propose: Vec::new(),
        materialize: vec![account_id],
        failed_htlc_routes: Vec::new(),
        checkpoint_due: true,
        post_accounts: false,
    };

    let mut oracle = legacy(4, "payer-0", 0, Arc::default(), Vec::new());
    enter_legacy(&mut oracle, owner);
    oracle
        .entity_outbound(request())
        .expect("legacy local creation");
    let restore_row = exact_restore_row(&oracle, account_id, "payer-0");

    let mut engine = resident(4, "payer-0", 0, Arc::default(), Vec::new());
    enter_resident(&mut engine, owner);
    let result = engine
        .entity_outbound(request())
        .expect("resident local creation checkpoint");
    let checkpoint = result.checkpoint.expect("creation checkpoint manifest");
    assert_eq!(checkpoint.token.account_count, 1);
    assert_eq!(checkpoint.accounts.len(), 1);
    assert_eq!(checkpoint.accounts[0].account_id, account_id);

    let restored = ResidentConsensusEngine::restore_exact(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        fixture::signer_key("payer-0"),
        "payer-0".to_string(),
        Arc::default(),
        checkpoint.restore_token(),
        vec![restore_row],
    )
    .expect("exact restore after local creation");
    assert_eq!(restored.accounts_root(), checkpoint.accounts_root());
    assert_eq!(restored.account_count(), checkpoint.token.account_count);

    let mut wrong_signer_digest = checkpoint.restore_token();
    wrong_signer_digest.signer_digest[0] ^= 1;
    let bad_row = exact_restore_row(&oracle, account_id, "payer-0");
    assert!(matches!(
        ResidentConsensusEngine::restore_exact(
            EngineGeneration::from_bytes([0x42; 8]),
            4,
            fixture::signer_key("payer-0"),
            "payer-0".to_string(),
            Arc::default(),
            wrong_signer_digest,
            vec![bad_row],
        ),
        Err(BatchError::CheckpointSignerDigest { .. })
    ));
}

fn number(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

fn genesis_seed(owner_signer: &str, peer_signer: &str) -> (AccountSeed, [u8; 32], [u8; 32]) {
    let (owner_bytes, owner) = fixture::entity_of(owner_signer);
    let (peer_bytes, peer) = fixture::entity_of(peer_signer);
    let (left, right) = if owner < peer {
        (owner.clone(), peer.clone())
    } else {
        (peer.clone(), owner.clone())
    };
    let state = AccountState::new(
        AccountIdentity::new(
            test_domain(),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute"),
        Vec::new(),
    )
    .expect("state");
    let mut replica = AccountReplica::new(owner, state).expect("replica");
    replica.set_delta_transformer([0x77; 20]);
    replica.set_envelope(genesis_envelope(&replica));
    (
        AccountSeed {
            account_id: AccountId::from_bytes(peer_bytes),
            replica,
            consensus: None,
        },
        owner_bytes,
        peer_bytes,
    )
}

fn test_domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain")
}

fn genesis_envelope(replica: &AccountReplica) -> AccountEnvelope {
    let zero = CanonicalValue::String(format!("0x{}", "00".repeat(32)));
    AccountEnvelope::new(
        vec![
            (
                "status".to_string(),
                CanonicalValue::String("active".to_string()),
            ),
            ("currentHeight".to_string(), number(0)),
            ("rollbackCount".to_string(), number(0)),
            (
                "proofHeader".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "fromEntity".to_string(),
                        CanonicalValue::String(replica.owner().to_string()),
                    ),
                    (
                        "toEntity".to_string(),
                        CanonicalValue::String(replica.counterparty().to_string()),
                    ),
                    ("nextProofNonce".to_string(), number(1)),
                ]),
            ),
            (
                "currentFrameHash".to_string(),
                CanonicalValue::String(String::new()),
            ),
            ("pendingWithdrawals".to_string(), zero.clone()),
            (
                "shadow".to_string(),
                CanonicalValue::Object(vec![(
                    "rebalance".to_string(),
                    CanonicalValue::Object(vec![
                        (
                            "policyRoot".to_string(),
                            CanonicalValue::String(format!("0x{}", "00".repeat(32))),
                        ),
                        ("submittedAtByTokenRoot".to_string(), zero),
                    ]),
                )]),
            ),
        ],
        Vec::new(),
    )
    .expect("H0 envelope")
}

fn genesis_policy() -> EntityAccountGenesisPolicy {
    EntityAccountGenesisPolicy {
        expected_domain: test_domain(),
        shadow_policy_root: [0; 32],
        delta_transformer: [0x77; 20],
        public_pinned: false,
    }
}

fn certify_dispute(
    row: &mut xln_rscore_batch::AccountInputRow,
    proposal: &xln_rscore_batch::ProposalRow,
    signer_id: &str,
) {
    let Some(draft) = proposal
        .proposed
        .as_ref()
        .and_then(|proposed| proposed.dispute.as_ref())
    else {
        return;
    };
    let AccountInputKind::Frame(frame) = &mut row.input.kind else {
        panic!("expected frame");
    };
    frame.dispute = Some(CounterpartyDispute {
        hanko: Some(
            fixture::signing_identity(signer_id)
                .sign_frame(&draft.hash)
                .expect("dispute Hanko"),
        ),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    });
}

#[test]
fn authenticated_h1_creates_exact_account_and_bad_h1_changes_nothing() {
    let (sender_seed, sender, receiver) = genesis_seed("1", "2");
    let (receiver_seed, _, _) = genesis_seed("2", "1");
    let mut sender_engine = legacy(4, "1", 0, Arc::default(), vec![sender_seed]);
    enter_legacy(&mut sender_engine, sender);
    let proposal = sender_engine
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: sender,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(
                AccountId::from_bytes(receiver),
                vec![AccountTx::AddDelta {
                    token_id: TokenId::new(1).expect("token"),
                }],
            )],
            propose: vec![AccountId::from_bytes(receiver)],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            checkpoint_due: false,
            post_accounts: false,
        })
        .expect("H1 proposal");
    let mut row = fixture::input_row(
        0,
        AccountId::from_bytes(sender),
        sender,
        receiver,
        AccountInputKind::Frame(Box::new(
            proposal.proposals[0].incoming().expect("incoming H1"),
        )),
    );
    certify_dispute(&mut row, &proposal.proposals[0], "1");

    let mut old_receiver = legacy(4, "2", 0, Arc::default(), vec![receiver_seed.clone()]);
    let old = old_receiver
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: receiver,
            expected_accounts_root: old_receiver.accounts_root(),
            clock: fixture::clock(TIMESTAMP),
            rows: vec![row.clone()],
            post_accounts: false,
        })
        .expect("precreated oracle accepts H1");

    let mut resident_receiver = resident(4, "2", 0, Arc::default(), Vec::new());
    let empty_root = resident_receiver.accounts_root();
    let mut bad = row.clone();
    bad.genesis_policy = Some(genesis_policy());
    if let AccountInputKind::Frame(frame) = &mut bad.input.kind {
        frame.frame_hanko = Some(vec![0x01]);
    } else {
        panic!("expected frame");
    }
    assert!(
        resident_receiver
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: receiver,
                expected_accounts_root: empty_root,
                clock: fixture::clock(TIMESTAMP),
                rows: vec![bad],
                post_accounts: false,
            })
            .is_err()
    );
    assert_eq!(resident_receiver.accounts_root(), empty_root);
    assert_eq!(resident_receiver.account_count(), 0);
    assert_eq!(resident_receiver.revision(), 0);

    let mut ack_only = fixture::input_row(
        0,
        AccountId::from_bytes(sender),
        sender,
        receiver,
        AccountInputKind::Ack(fixture::incoming_ack(1, [0x11; 32], vec![0x22])),
    );
    ack_only.genesis_policy = Some(genesis_policy());
    assert!(
        resident_receiver
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: receiver,
                expected_accounts_root: empty_root,
                clock: fixture::clock(TIMESTAMP),
                rows: vec![ack_only],
                post_accounts: false,
            })
            .is_err(),
        "an ACK cannot create an Account"
    );
    let mut non_genesis = row.clone();
    non_genesis.genesis_policy = Some(genesis_policy());
    if let AccountInputKind::Frame(frame) = &mut non_genesis.input.kind {
        frame.frame.height = 2;
    }
    assert!(
        resident_receiver
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: receiver,
                expected_accounts_root: empty_root,
                clock: fixture::clock(TIMESTAMP),
                rows: vec![non_genesis],
                post_accounts: false,
            })
            .is_err(),
        "only H=1 may create an Account"
    );
    assert_eq!(resident_receiver.accounts_root(), empty_root);
    assert_eq!(resident_receiver.account_count(), 0);
    assert_eq!(resident_receiver.revision(), 0);

    let mut valid = row.clone();
    valid.genesis_policy = Some(genesis_policy());
    let created = resident_receiver
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: receiver,
            expected_accounts_root: empty_root,
            clock: fixture::clock(TIMESTAMP),
            rows: vec![valid],
            post_accounts: false,
        })
        .expect("authenticated H1 creates");
    assert_eq!(created.accounts_root, old.accounts_root);
    assert_eq!(created.revision, old.revision);
    assert_eq!(created.touched, old.touched);
    assert_eq!(created.created_accounts.len(), 1);
    assert_eq!(created.created_accounts[0].account_leaf, old.touched[0].1);
    assert_eq!(resident_receiver.account_count(), 1);

    let h1_checkpointed = resident_receiver
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: receiver,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            checkpoint_due: true,
            post_accounts: false,
        })
        .expect("H1 checkpoint");
    let h1_checkpoint = h1_checkpointed
        .checkpoint
        .as_ref()
        .expect("H1 exact manifest");
    assert_eq!(h1_checkpoint.token.account_count, 1);
    let h1_restored = ResidentConsensusEngine::restore_exact(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        fixture::signer_key("2"),
        "2".to_string(),
        Arc::default(),
        h1_checkpoint.restore_token(),
        vec![exact_restore_row(
            &old_receiver,
            AccountId::from_bytes(sender),
            "2",
        )],
    )
    .expect("exact restore after authenticated H1 creation");
    assert_eq!(h1_restored.accounts_root(), h1_checkpoint.accounts_root());

    let (height, state_hash, ack_hanko, ack_dispute) = match &old.applied[0].verdict {
        AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_hanko,
            ack_dispute,
            ..
        } => (*height, *state_hash, ack_hanko.clone(), ack_dispute.clone()),
        verdict => panic!("expected committed H1, got {verdict:?}"),
    };
    let mut ack = fixture::incoming_ack(height, state_hash, ack_hanko);
    ack.dispute = ack_dispute.map(|draft| CounterpartyDispute {
        hanko: Some(
            fixture::signing_identity("2")
                .sign_frame(&draft.hash)
                .expect("ack dispute Hanko"),
        ),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    });
    sender_engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: sender,
            expected_accounts_root: proposal.accounts_root,
            clock: fixture::clock(TIMESTAMP + 1),
            rows: vec![fixture::input_row(
                0,
                AccountId::from_bytes(receiver),
                receiver,
                sender,
                AccountInputKind::Ack(ack),
            )],
            post_accounts: false,
        })
        .expect("sender commits H1 ack");
    let h2_proposal = sender_engine
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: sender,
            timestamp: TIMESTAMP + 2,
            j_height: 101,
            creates: Vec::new(),
            admits: vec![(
                AccountId::from_bytes(receiver),
                vec![AccountTx::SetCreditLimit {
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(123),
                }],
            )],
            propose: vec![AccountId::from_bytes(receiver)],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            checkpoint_due: false,
            post_accounts: false,
        })
        .expect("H2 proposal");
    let mut h2_row = fixture::input_row(
        1,
        AccountId::from_bytes(sender),
        sender,
        receiver,
        AccountInputKind::Frame(Box::new(
            h2_proposal.proposals[0].incoming().expect("incoming H2"),
        )),
    );
    certify_dispute(&mut h2_row, &h2_proposal.proposals[0], "1");

    let mut h1_oracle = legacy(4, "2", 0, Arc::default(), vec![receiver_seed.clone()]);
    let h1_materialized = h1_oracle
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: receiver,
            expected_accounts_root: h1_oracle.accounts_root(),
            clock: fixture::clock(TIMESTAMP),
            rows: vec![row.clone()],
            post_accounts: true,
        })
        .expect("H1 materialization oracle");
    let mut final_oracle = legacy(4, "2", 0, Arc::default(), vec![receiver_seed]);
    let final_expected = final_oracle
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: receiver,
            expected_accounts_root: final_oracle.accounts_root(),
            clock: fixture::clock(TIMESTAMP + 2),
            rows: vec![row.clone(), h2_row.clone()],
            post_accounts: false,
        })
        .expect("H1 and H2 final oracle");
    let mut multi = resident(4, "2", 0, Arc::default(), Vec::new());
    let mut h1_with_policy = row;
    h1_with_policy.genesis_policy = Some(genesis_policy());
    let multi_result = multi
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: receiver,
            expected_accounts_root: multi.accounts_root(),
            clock: fixture::clock(TIMESTAMP + 2),
            rows: vec![h1_with_policy, h2_row],
            post_accounts: false,
        })
        .expect("fresh account applies H1 then H2");
    assert_eq!(multi_result.accounts_root, final_expected.accounts_root);
    assert_eq!(multi_result.touched, final_expected.touched);
    assert_eq!(multi_result.created_accounts.len(), 1);
    assert_eq!(h1_materialized.post_accounts.len(), 1);
    assert_eq!(
        multi_result.created_accounts[0].account_leaf,
        h1_materialized.post_accounts[0].account_leaf
    );
    assert_eq!(
        multi_result.created_accounts[0].sections,
        h1_materialized.post_accounts[0].sections
    );
    assert_ne!(
        multi_result.created_accounts[0].account_leaf, multi_result.touched[0].1,
        "the mandatory creation row is the committed H1, not the later H2 state"
    );
}
