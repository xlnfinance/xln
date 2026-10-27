mod support;

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use support::{MAKER, commit, token};
use xln_rscore_batch::{
    AccountId, AccountInput, AccountInputKind, AccountInputRow, AccountSeed, EngineGeneration,
    EntityInboundRequest, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountInputEnvelope, AccountReplica,
    AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId,
    IncomingAck, RebalanceRefundReason, ReceiverClock, SigningIdentity, TokenId, WatchSeed,
    derive_signer_key,
};
use xln_rscore_entity_kernel::{
    AdmittedLocalEntityTx, ConsensusMode, DeterministicContext, DirectPaymentEntityTx,
    EntityConsensusConfig, EntityFrameAuthority, EntityFrameEvent, EntityKernelError,
    EntityLeaderState, EntityStateSlice, JurisdictionScope, LocalEntityControlTx,
    LocalEntityFinancialTx, LocalEntityTx, ProfileUpdate, RejectedInboundAccountInput,
    ResidentEntityError, ResidentEntityOperation, ResidentEntityRequest, ResidentEntityResult,
    apply_entity_kernel, apply_resident_entity_round,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const TIMESTAMP: u64 = 1_700_000_000_000;
const HUB_SIGNER: &str = "reject-hub";

#[test]
fn state_only_transactions_are_inert_but_cross_j_fails_loudly() {
    let mut state = EntityStateSlice::empty(support::HUB, 1);
    state.known_accounts = BTreeSet::from([MAKER.to_string()]).into();
    let unknown = commit(
        MAKER,
        0x61,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    let applied = apply_entity_kernel(
        state.clone(),
        &[unknown],
        &DeterministicContext::hlt_default(),
        &Default::default(),
    )
    .expect("Account-only genesis transaction has no Entity effect");
    assert_eq!(applied.state, state);
    assert!(applied.outputs.is_empty());
    assert!(applied.proposal_work.is_empty());

    for tx in [
        AccountTx::RequestCollateral {
            token_id: token(1),
            amount: BigInt::from(100),
            fee_token_id: Some(token(1)),
            fee_amount: BigInt::from(1),
            policy_version: 1,
        },
        AccountTx::RebalanceRefund {
            request_id: "refund-1".into(),
            request_token_id: token(1),
            amount: BigInt::from(100),
            reason: RebalanceRefundReason::Timeout,
        },
    ] {
        let account_only = commit(MAKER, 0x63, 2, tx, Vec::new());
        let applied = apply_entity_kernel(
            state.clone(),
            &[account_only],
            &DeterministicContext::hlt_default(),
            &Default::default(),
        )
        .expect("committed Account-only transition must not invent an Entity effect");
        assert_eq!(applied.state, state);
        assert!(applied.outputs.is_empty());
        assert!(applied.proposal_work.is_empty());
    }

    let mut cross = commit(
        MAKER,
        0x62,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    cross.scope = JurisdictionScope::Cross;
    assert_eq!(
        apply_entity_kernel(
            state,
            &[cross],
            &DeterministicContext::hlt_default(),
            &Default::default()
        ),
        Err(EntityKernelError::CrossJurisdictionUnsupported {
            account_id: MAKER.to_string(),
        })
    );
}

// ---------------------------------------------------------------------------
// Owner canon (AGENTS.md REJECT POLICY): a sender-caused failure is a typed
// reject decided inside the transition without reading env; the Runtime loop
// applies fail-fast/drop once, outside the state machine; granularity is per
// transaction (one evicted frame tx, the rest of the queue certified).
// ---------------------------------------------------------------------------

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

fn hub_authority() -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![HUB_SIGNER.to_string()],
            shares: BTreeMap::from([(HUB_SIGNER.to_string(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: HUB_SIGNER.to_string(),
            view: 0,
            changed_at_height: 0,
        },
    }
}

fn engine(seeds: Vec<AccountSeed>) -> ResidentConsensusEngine {
    ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x71; 8]),
        2,
        0,
        derive_signer_key(SEED, HUB_SIGNER).expect("hub key"),
        HUB_SIGNER.to_string(),
        support::market(),
        seeds,
    )
    .expect("resident accounts")
}

fn account_state(first: &EntityId, second: &EntityId) -> AccountState {
    let (left, right) = if first < second {
        (first.clone(), second.clone())
    } else {
        (second.clone(), first.clone())
    };
    let capacity = BigInt::from(10_u8).pow(30);
    let deltas = [1, 2]
        .into_iter()
        .map(|token_id| {
            Delta::new(
                TokenId::new(token_id).expect("token"),
                capacity.clone(),
                BigInt::from(0),
                BigInt::from(0),
                capacity.clone(),
                capacity.clone(),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
            )
            .expect("delta")
        })
        .collect();
    AccountState::new(
        AccountIdentity::new(
            domain(),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("account identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        deltas,
    )
    .expect("account state")
}

/// One resident Entity round over a fresh engine, exactly as the Runtime loop
/// drives one attempt: the Entity state is passed by value, so a rejected
/// attempt leaves nothing behind for the retry.
fn run_round(
    accounts: &mut ResidentConsensusEngine,
    hub: &EntityId,
    state: EntityStateSlice,
    rows: Vec<AccountInputRow>,
    operations: Vec<ResidentEntityOperation>,
) -> Result<ResidentEntityResult, ResidentEntityError> {
    let expected_accounts_root = accounts.accounts_root();
    let has_rows = !rows.is_empty();
    let mut operations = operations;
    if has_rows {
        operations.insert(
            0,
            ResidentEntityOperation::AccountRange {
                start: 0,
                len: rows.len(),
            },
        );
    }
    apply_resident_entity_round(
        accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                owning_entity_is_hub: false,
                expected_accounts_root,
                clock: ReceiverClock {
                    entity_timestamp: TIMESTAMP,
                    finalized_j_height: 100,
                },
                rows,
                post_accounts: false,
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            propose_accounts_now: Vec::new(),
            expected_proposer_signer_id: HUB_SIGNER.to_string(),
            finalized_j_events: None,
            entity_authority: Some(hub_authority()),
            local_account_genesis_policy: None,
            cross_j_opening_sibling_views: Vec::new(),
            operations,
        },
        &DeterministicContext::hlt_default(),
    )
}

fn local(tx: LocalEntityTx) -> ResidentEntityOperation {
    ResidentEntityOperation::Local(vec![AdmittedLocalEntityTx {
        signer_id: HUB_SIGNER.to_string(),
        board_epoch: 1,
        tx,
    }])
}

fn chat(message: &str) -> LocalEntityTx {
    LocalEntityTx::Control(LocalEntityControlTx::ChatMessage {
        message: message.to_string(),
    })
}

/// A well-formed wire tx whose route is empty: TS `directPaymentInvariant`
/// (`rejectFailure`) territory, i.e. a user error, never a kernel fault.
fn malformed_direct_payment() -> LocalEntityTx {
    LocalEntityTx::Financial(LocalEntityFinancialTx::DirectPayment(
        DirectPaymentEntityTx {
            target_entity_id: MAKER.to_string(),
            token_id: token(1),
            amount: BigInt::from(1),
            route: Vec::new(),
            description: None,
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
    ))
}

fn status_messages(result: &ResidentEntityResult) -> Vec<String> {
    result
        .entity_frame_events
        .iter()
        .filter_map(|event| match event {
            EntityFrameEvent::Status { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn ack_row(hub: &EntityId, peer: &EntityId) -> AccountInputRow {
    AccountInputRow {
        operation_index: 0,
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        genesis_policy: None,
        certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        input: AccountInput {
            envelope: AccountInputEnvelope {
                from_entity_id: *peer.as_bytes(),
                to_entity_id: *hub.as_bytes(),
                domain: domain(),
                dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                watch_seed: Some(
                    WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                ),
            },
            // No frame is pending on this Account: the ACK matches nothing.
            kind: AccountInputKind::Ack(IncomingAck {
                height: 1,
                frame_hash: [0x42; 32],
                frame_hanko: None,
                dispute: None,
            }),
        },
    }
}

/// Signer queue [valid, malformed, valid]: the kernel returns the typed reject
/// for exactly the malformed frame tx (`operation_index` 1) and the Runtime
/// loop (`apply.rs` `LocalCommandRejected` arm) evicts only that tx and
/// retries, so the certified round carries tx0 and tx2. No lane is dropped.
#[test]
fn reject_evicts_exactly_malformed_tx() {
    let hub = entity(&identity(HUB_SIGNER));
    let state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    let queue = || {
        vec![
            local(chat("tx0")),
            local(malformed_direct_payment()),
            local(chat("tx2")),
        ]
    };

    let mut accounts = engine(Vec::new());
    let attempt = run_round(&mut accounts, &hub, state.clone(), Vec::new(), queue());
    let Err(ResidentEntityError::LocalCommandRejected {
        operation_index,
        kind,
        detail,
    }) = attempt
    else {
        panic!("malformed user tx must be a typed per-tx reject");
    };
    assert_eq!(
        (operation_index, kind, detail.as_str()),
        (1, "directPayment", "ROUTE")
    );

    // Runtime-loop eviction: drop exactly the rejected operation, retry.
    let mut retry = queue();
    retry.remove(operation_index);
    let certified = run_round(&mut accounts, &hub, state, Vec::new(), retry)
        .expect("the rest of the signer queue certifies");
    assert_eq!(status_messages(&certified), vec!["tx0", "tx2"]);
    assert!(certified.rejected_inbound_inputs.is_empty());
}

/// The reject disposition is decided by the transition, never by process env:
/// `NODE_ENV=production` and an unset env produce byte-identical outcomes
/// (same typed reject, same certified state and events after eviction, same
/// recorded inbound reject) and neither halts the round.
#[test]
fn reject_disposition_env_independent() {
    let hub_identity = identity(HUB_SIGNER);
    let hub = entity(&hub_identity);
    let peer = entity(&identity("reject-env-peer"));
    let state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    let queue = || {
        vec![
            local(chat("tx0")),
            local(malformed_direct_payment()),
            local(chat("tx2")),
        ]
    };
    let seed = || AccountSeed {
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        replica: AccountReplica::new(hub.clone(), account_state(&hub, &peer)).expect("replica"),
        consensus: None,
    };
    let mut known = state.clone();
    known.known_accounts.insert(peer.to_string());

    let observe = || {
        let mut accounts = engine(Vec::new());
        let attempt = run_round(&mut accounts, &hub, state.clone(), Vec::new(), queue());
        let rejected = match attempt {
            Err(ResidentEntityError::LocalCommandRejected {
                operation_index,
                kind,
                detail,
            }) => (operation_index, kind, detail),
            other => panic!("expected a typed reject, got {:?}", other.err()),
        };
        let mut retry = queue();
        retry.remove(rejected.0);
        let certified = run_round(&mut accounts, &hub, state.clone(), Vec::new(), retry)
            .expect("retry certifies");
        let mut inbound_engine = engine(vec![seed()]);
        let root_before = inbound_engine.accounts_root();
        let inbound = run_round(
            &mut inbound_engine,
            &hub,
            known.clone(),
            vec![ack_row(&hub, &peer)],
            Vec::new(),
        )
        .expect("a rejected peer ACK never halts the round");
        assert_eq!(inbound_engine.accounts_root(), root_before);
        let statuses = status_messages(&certified);
        (
            rejected,
            certified.state,
            statuses,
            certified.commitments,
            inbound.rejected_inbound_inputs,
        )
    };

    // Env is process-global; this crate's transitions never read it, so the
    // order of these two observations is irrelevant to the outcome.
    // SAFETY: single-threaded within this test; no other test in this binary
    // reads NODE_ENV or XLN_REJECT_FAIL_FAST.
    unsafe {
        std::env::set_var("NODE_ENV", "production");
        std::env::remove_var("XLN_REJECT_FAIL_FAST");
    }
    let production = observe();
    unsafe {
        std::env::remove_var("NODE_ENV");
    }
    let unset = observe();

    assert_eq!(production.0, (1, "directPayment", "ROUTE".to_string()));
    assert_eq!(production.0, unset.0);
    assert_eq!(production.1, unset.1, "certified Entity state");
    assert_eq!(production.2, unset.2, "certified frame events");
    assert_eq!(production.3, unset.3, "canonical commitments");
    assert_eq!(production.4, unset.4, "recorded inbound rejects");
    assert_eq!(production.4.len(), 1);
    assert_eq!(production.4[0].verdict, "AckRejected");
}

/// User-authored Financial and Control txs that fail handler validation are
/// the typed reject class (`EntityKernelError::into_user_reject`), while a
/// genuine kernel/context fault under the same error variant stays fatal.
#[test]
fn reject_user_invalid_financial_control_typed_reject() {
    let hub = entity(&identity(HUB_SIGNER));
    let state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);

    // Financial: TS `directPaymentInvariant` is `rejectFailure`.
    let mut accounts = engine(Vec::new());
    let financial = run_round(
        &mut accounts,
        &hub,
        state.clone(),
        Vec::new(),
        vec![local(malformed_direct_payment())],
    );
    assert!(matches!(
        financial,
        Err(ResidentEntityError::LocalCommandRejected {
            operation_index: 0,
            kind: "directPayment",
            ref detail,
        }) if detail == "ROUTE"
    ));

    // Control: a profile update addressed to another entity.
    let mut accounts = engine(Vec::new());
    let control = run_round(
        &mut accounts,
        &hub,
        state.clone(),
        Vec::new(),
        vec![local(LocalEntityTx::Control(
            LocalEntityControlTx::ProfileUpdate(ProfileUpdate {
                entity_id: format!("0x{}", "ab".repeat(32)),
                name: Some("intruder".into()),
                entity_kind: None,
                sectors: None,
                avatar: None,
                bio: None,
                website: None,
            }),
        ))],
    );
    assert!(matches!(
        control,
        Err(ResidentEntityError::LocalCommandRejected {
            operation_index: 0,
            kind: "profile-update",
            ref detail,
        }) if detail.starts_with("INVALID_ENTITY:")
    ));

    // Kernel/context fault under the same variant stays fatal: j_broadcast
    // needs a jurisdiction on the certified authority, which is Runtime
    // context, not user data.
    let mut accounts = engine(Vec::new());
    let fatal = run_round(
        &mut accounts,
        &hub,
        state,
        Vec::new(),
        vec![local(LocalEntityTx::Control(
            LocalEntityControlTx::JBroadcast {
                fee_overrides: None,
            },
        ))],
    );
    assert!(matches!(
        fatal,
        Err(ResidentEntityError::Entity(
            EntityKernelError::InvalidLocalEntityTx {
                kind: "j_broadcast",
                ..
            }
        ))
    ));
}

/// A standalone rejected ACK (no frame in the same input) is recorded and
/// logged as a `[ERROR][reject]` line exactly like a rejected frame: the
/// Account mutates nothing, the round completes, and the Runtime loop alone
/// decides halt-vs-drop from `rejected_inbound_inputs`.
#[test]
fn standalone_ack_rejection_is_logged() {
    let hub = entity(&identity(HUB_SIGNER));
    let peer = entity(&identity("reject-ack-peer"));
    let seed = AccountSeed {
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        replica: AccountReplica::new(hub.clone(), account_state(&hub, &peer)).expect("replica"),
        consensus: None,
    };
    let mut accounts = engine(vec![seed]);
    let root_before = accounts.accounts_root();
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts.insert(peer.to_string());

    let result = run_round(
        &mut accounts,
        &hub,
        state,
        vec![ack_row(&hub, &peer)],
        Vec::new(),
    )
    .expect("a rejected peer ACK is a typed reject, never a round fault");

    assert_eq!(result.rejected_inbound_inputs.len(), 1);
    let reject: &RejectedInboundAccountInput = &result.rejected_inbound_inputs[0];
    assert_eq!(reject.operation_index, 0);
    assert_eq!(reject.account_id, peer.to_string());
    assert_eq!(reject.verdict, "AckRejected");
    assert!(
        !reject.reason.is_empty(),
        "reject reason is the audit detail"
    );
    assert!(matches!(
        result.inbound.applied[0].verdict,
        xln_rscore_batch::AccountInputVerdict::AckRejected { .. }
    ));
    assert_eq!(
        accounts.accounts_root(),
        root_before,
        "a rejected ACK must leave the Account unchanged"
    );
}

/// Index-space regression for the Runtime eviction path.
///
/// `RejectedInboundAccountInput::operation_index` is a position inside
/// `EntityInboundRequest::rows`, never a position inside
/// `ResidentEntityRequest::operations`. Both peer ACKs below live in the SAME
/// `AccountRange` (operation-plan position 0) yet are two independent parent
/// `accountInput` Entity transactions, so the second reject must report row 1.
/// Reporting the plan position would make `apply.rs` evict the first peer's
/// innocent transaction and diverge from TS, which rejects "the exact parent
/// Entity transaction" (`core/entity/tx/handlers/account/input-phases.ts`).
#[test]
fn inbound_rejects_report_the_row_that_names_their_parent_account_input_tx() {
    let hub = entity(&identity(HUB_SIGNER));
    let first = entity(&identity("reject-row-peer-a"));
    let second = entity(&identity("reject-row-peer-b"));
    let seed = |peer: &EntityId| AccountSeed {
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        replica: AccountReplica::new(hub.clone(), account_state(&hub, peer)).expect("replica"),
        consensus: None,
    };
    let mut accounts = engine(vec![seed(&first), seed(&second)]);
    let root_before = accounts.accounts_root();
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts.insert(first.to_string());
    state.known_accounts.insert(second.to_string());

    // Plan: [AccountRange { start: 0, len: 2 }, Local(chat)]. `run_round`
    // inserts the single merged range in front of the local operations.
    let result = run_round(
        &mut accounts,
        &hub,
        state,
        vec![ack_row(&hub, &first), ack_row(&hub, &second)],
        vec![local(chat("healthy neighbour tx"))],
    )
    .expect("two rejected peer ACKs are typed rejects, never a round fault");

    let rejects: Vec<(u64, String, &'static str)> = result
        .rejected_inbound_inputs
        .iter()
        .map(|reject| {
            (
                reject.operation_index,
                reject.account_id.clone(),
                reject.verdict,
            )
        })
        .collect();
    assert_eq!(
        rejects,
        vec![
            (0, first.to_string(), "AckRejected"),
            (1, second.to_string(), "AckRejected"),
        ],
        "rejects are reported by row position, in row order",
    );
    // The operation-plan position of BOTH rows is 0: it cannot distinguish the
    // two parent transactions, which is exactly why the Runtime maps a reject
    // through `SelectedEntityWork::row_work_indices` instead.
    assert_eq!(
        result.inbound.applied.len(),
        2,
        "one merged AccountRange still carries one applied row per parent tx",
    );
    assert!(
        status_messages(&result)
            .iter()
            .any(|message| message.contains("healthy neighbour tx"))
    );
    assert_eq!(
        accounts.accounts_root(),
        root_before,
        "rejected peer ACKs leave both Accounts unchanged",
    );
}
