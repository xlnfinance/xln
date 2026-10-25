//! Live certified board rotation must be visible to Account verification.
//!
//! Divergence this closes: the Rust Runtime used to answer Account board
//! lookups from a registry copy frozen at restore. A `BoardActivated` committed
//! mid-run left that copy on the old board, so the peer's refreshed frame Hanko
//! was rejected with `ACCOUNT_BOARD_HANKO_REFRESH_CERTIFIED_BOARD_MISSING`
//! while TypeScript accepted it — a silent state split, because a reject is not
//! a halt. The authority now reads the committed Entity state, so this test
//! resolves the rotated board in the same process, without any restore.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use num_bigint::BigInt;
use serde_json::Value;
use xln_rscore_batch::{
    AccountId, AccountInput, AccountInputBoardAuthority, AccountInputKind, AccountInputRow,
    AccountInputVerdict, AccountSeed, CertifiedBoardAuthorityResolver, EngineGeneration,
    EntityInboundRequest, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountInputEnvelope, AccountReplica,
    AccountState, BoardActivatedEvent, BoardDelays, BoardHankoRefreshInput,
    CertifiedBoardAuthority, Delta, DepositoryAddress, EntityId, EntityRegisteredEvent,
    FoundationBootstrappedEvent, JEventMetadata, JurisdictionEvent, ReceiverClock, SigningIdentity,
    SwapMarketPolicy, SwapToken, TokenId, WatchSeed, derive_signer_key,
};
use xln_rscore_entity_kernel::{
    ConsensusMode, DeterministicContext, EntityConsensusConfig, EntityFrameAuthority,
    EntityLeaderState, EntityStateSlice, FinalizedJEventBatch, JPrefixRangeClaim,
    ResidentEntityError, ResidentEntityOperation, ResidentEntityRequest, ResidentEntityResult,
    ResidentJEventProjection, apply_finalized_j_event_batches, apply_resident_entity_round,
    certified_board_stack_key,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};
use xln_rscore_runtime::RuntimeEntityState;

const FIXTURE: &str = include_str!("../../../fixtures/certified-board-rotation/rotation-v1.json");

fn canonical(value: &Value) -> CanonicalValue {
    match value {
        Value::Null => CanonicalValue::Null,
        Value::Bool(value) => CanonicalValue::Bool(*value),
        Value::String(value) => CanonicalValue::String(value.clone()),
        Value::Number(value) => CanonicalValue::Number(
            CanonicalNumber::try_from_u64(value.as_u64().expect("fixture unsigned integer"))
                .expect("fixture safe integer"),
        ),
        Value::Array(values) => CanonicalValue::Array(values.iter().map(canonical).collect()),
        Value::Object(fields) => CanonicalValue::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
    }
}

fn word(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.strip_prefix("0x").expect("0x prefix")).expect("hex word");
    bytes.try_into().expect("bytes32")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("fixture text")
}

fn metadata(event: &Value) -> JEventMetadata {
    JEventMetadata {
        block_number: Some(event["blockNumber"].as_u64().expect("blockNumber")),
        block_hash: Some(word(text(&event["blockHash"]))),
        transaction_hash: Some(word(text(&event["transactionHash"]))),
        log_index: Some(event["logIndex"].as_u64().expect("logIndex")),
        event_index: None,
    }
}

/// Rebuild the exact J event the TypeScript oracle replayed.
fn j_event(event: &Value) -> JurisdictionEvent {
    let data = &event["data"];
    match text(&event["type"]) {
        "FoundationBootstrapped" => {
            JurisdictionEvent::FoundationBootstrapped(FoundationBootstrappedEvent {
                metadata: metadata(event),
                recipient: hex::decode(text(&data["recipient"]).strip_prefix("0x").expect("0x"))
                    .expect("recipient hex")
                    .try_into()
                    .expect("address"),
                board_hash: word(text(&data["boardHash"])),
                control_token_id: text(&data["controlTokenId"])
                    .parse::<BigInt>()
                    .expect("control token"),
                dividend_token_id: text(&data["dividendTokenId"])
                    .parse::<BigInt>()
                    .expect("dividend token"),
            })
        }
        "EntityRegistered" => JurisdictionEvent::EntityRegistered(EntityRegisteredEvent {
            metadata: metadata(event),
            entity_id: EntityId::parse(text(&data["entityId"])).expect("entity id"),
            entity_number: text(&data["entityNumber"])
                .parse::<BigInt>()
                .expect("entity number"),
            board_hash: word(text(&data["boardHash"])),
        }),
        "BoardActivated" => JurisdictionEvent::BoardActivated(BoardActivatedEvent {
            metadata: metadata(event),
            entity_id: EntityId::parse(text(&data["entityId"])).expect("entity id"),
            previous_board_hash: word(text(&data["previousBoardHash"])),
            new_board_hash: word(text(&data["newBoardHash"])),
            previous_board_valid_until: BigInt::from(
                data["previousBoardValidUntil"]
                    .as_u64()
                    .expect("previousBoardValidUntil"),
            ),
            board_epoch: text(&data["boardEpoch"])
                .parse::<BigInt>()
                .expect("boardEpoch"),
        }),
        other => panic!("unsupported fixture J event: {other}"),
    }
}

fn authority(fixture: &Value, owner: &str) -> EntityFrameAuthority {
    let validator = owner.to_string();
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![validator.clone()],
            shares: BTreeMap::from([(validator.clone(), 1)]),
            jurisdiction: Some(canonical(&fixture["jurisdiction"])),
        },
        leader_state: EntityLeaderState {
            active_validator_id: validator,
            view: 0,
            changed_at_height: 0,
        },
    }
}

#[test]
fn board_rotation_committed_by_an_earlier_frame_is_resolved_without_restore() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("shared rotation fixture");
    let owner = text(&fixture["ownerEntityId"]).to_string();
    let peer = word(text(&fixture["peerEntityId"]));
    let authority = authority(&fixture, &owner);
    assert_eq!(
        certified_board_stack_key(
            authority
                .config
                .jurisdiction
                .as_ref()
                .expect("jurisdiction")
        )
        .expect("stack key"),
        word(text(&fixture["stackKey"])),
        "stack key derivation must match TypeScript",
    );

    let mut state = RuntimeEntityState {
        accounts_root: [0; 32],
        entity: EntityStateSlice::empty(owner, 2_000),
    };
    let events = fixture["events"].as_array().expect("fixture events");
    let steps = fixture["steps"].as_array().expect("fixture steps");
    assert_eq!(events.len(), steps.len());

    let mut before_rotation: Option<RuntimeEntityState> = None;
    for (event, step) in events.iter().zip(steps) {
        if text(&step["event"]) == "BoardActivated" {
            before_rotation = Some(RuntimeEntityState {
                accounts_root: state.accounts_root,
                entity: state.entity.clone(),
            });
        }
        let raw = &event["event"];
        let j_height = raw["blockNumber"].as_u64().expect("blockNumber");
        let batch = FinalizedJEventBatch {
            j_height,
            j_block_hash: word(text(&raw["blockHash"])),
            events: vec![j_event(raw)],
            dispute_finalization_evidence: Vec::new(),
            reserve_updates: Vec::new(),
            account_claims: Vec::new(),
        };
        // One committed frame carrying exactly this J event.
        apply_finalized_j_event_batches(
            &mut state.entity,
            j_height,
            &[batch],
            "certified-board-rotation-fixture",
            Some(&authority),
            &BTreeSet::new(),
            &BTreeMap::new(),
        )
        .expect("production J event ingress");

        let committed = state
            .entity
            .certified_board_state
            .as_ref()
            .expect("committed board tree");
        assert_eq!(
            format!("0x{}", hex::encode(committed.board_registry_root)),
            text(&step["boardRegistryRoot"]),
            "{}: committed boardRegistryRoot",
            text(&step["event"]),
        );

        // The exact resolver `AccountInputRow::resolve_certified_boards` uses.
        let resolved = state
            .certified_board_authority()
            .resolve_certified_board(&peer)
            .expect("board resolution");
        match &step["resolvedPeerBoard"] {
            Value::Null => assert_eq!(
                resolved,
                AccountInputBoardAuthority::Lazy,
                "{}: peer is not registered yet",
                text(&step["event"]),
            ),
            expected => {
                let AccountInputBoardAuthority::Certified(actual) = resolved else {
                    panic!("{}: expected a certified board", text(&step["event"]));
                };
                assert_eq!(actual.entity_id, word(text(&expected["entityId"])));
                assert_eq!(
                    actual.registered_board_hash,
                    word(text(&expected["boardHash"])),
                    "{}: registered board hash",
                    text(&step["event"]),
                );
                assert_eq!(
                    actual.previous_board_hash,
                    word(text(&expected["previousBoardHash"])),
                );
                assert_eq!(
                    actual.previous_board_valid_until,
                    expected["previousBoardValidUntil"]
                        .as_u64()
                        .expect("previousBoardValidUntil"),
                );
                assert_eq!(
                    actual.board_epoch,
                    expected["boardEpoch"].as_u64().expect("boardEpoch"),
                );
                assert_eq!(
                    committed
                        .resolve(&peer)
                        .expect("committed record")
                        .board_epoch,
                    expected["boardEpoch"].as_u64().expect("boardEpoch"),
                    "{}: board epoch",
                    text(&step["event"]),
                );
            }
        }
    }

    // The rotation is the regression: no restore happened in this process, and
    // the Account path already answers with the new board.
    let last = steps.last().expect("rotation step");
    assert_eq!(text(&last["event"]), "BoardActivated");
    let rotated = text(&last["resolvedPeerBoard"]["boardHash"]).to_string();
    assert_eq!(
        state
            .certified_board_authority()
            .current_board_hash(&peer)
            .map(|hash| format!("0x{}", hex::encode(hash))),
        Some(rotated.clone()),
    );

    // Adversarial counterexample. Any authority snapshot taken before the
    // rotation still answers the retired board; that is precisely what the
    // restore-time registry copy did for the whole life of the process, and
    // why the peer's refreshed Hanko was rejected while TypeScript accepted it.
    // The only way to stay exact is to read the committed state, as above.
    let stale = before_rotation.expect("state before the rotation");
    let stale_board = stale
        .certified_board_authority()
        .current_board_hash(&peer)
        .map(|hash| format!("0x{}", hex::encode(hash)))
        .expect("registered board");
    assert_ne!(stale_board, rotated);
    assert_eq!(
        stale_board,
        text(&steps[1]["resolvedPeerBoard"]["boardHash"]),
    );
}

// ---------------------------------------------------------------------------
// Intra-frame ordering: the frame shape is FORBIDDEN.
//
// TypeScript applies the transactions of one Entity frame strictly in order
// (`core/entity/consensus/frame/application.ts`, `applyEntityTxsInOrder`), and
// the certified J range is prepended to the proposal
// (`core/entity/consensus/proposal/selection.ts`), so a `j_event` carrying
// `BoardActivated` for a counterparty mutates `state.certifiedBoardState`
// (`core/entity/tx/j-events-board.ts`) before a later `accountInput` from that
// same counterparty resolves its board
// (`core/entity/tx/handlers/account/input-phases.ts`) — the NEW board.
//
// Rust resolves every inbound row from the state as it stood at the START of
// the frame (`rscore/crates/runtime/src/machine/apply.rs`) and only then enters
// the kernel, which applies that frame's J events after the inbound Account
// stage (`rscore/crates/entity-kernel/src/resident.rs`) — the RETIRED board.
//
// `05a90c88e` recorded that split and presented the fork. The owner chose to
// forbid the frame shape rather than reconcile the two orders. These tests keep
// the same fixture and the same evidence, and now prove the refusal:
//
// * `the_two_frame_orders_resolve_different_counterparty_boards` keeps the
//   reason — the two orders really do resolve different boards for one row.
// * `a_frame_activating_a_counterparty_board_refuses_that_counterparty_s_row`
//   proves the kernel refuses the mixed frame before any mutation, with a typed
//   error the Runtime turns into a deferral, never a halt.
// * `a_frame_without_the_activation_processes_the_counterparty_row_normally` is
//   the control: the refusal is specific to the mixed shape.
// ---------------------------------------------------------------------------

const ORDERING_SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const ORDERING_SIGNER: &str = "certified-board-ordering";
const ORDERING_TIMESTAMP: u64 = 1_700_000_000_000;

fn ordering_domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse("0x8888888888888888888888888888888888888888")
            .expect("ordering depository"),
    )
    .expect("ordering domain")
}

fn ordering_watch_seed() -> WatchSeed {
    WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("ordering watch seed")
}

fn ordering_dispute_config() -> AccountDisputeConfig {
    AccountDisputeConfig::new(10, 10).expect("ordering dispute config")
}

fn ordering_market() -> Arc<SwapMarketPolicy> {
    Arc::new(SwapMarketPolicy::new(
        vec![SwapToken {
            token_id: 1,
            decimals: 6,
            liquid: true,
        }],
        Vec::new(),
    ))
}

/// One funded bilateral Account between the fixture owner and the fixture peer.
fn ordering_engine(owner: &EntityId, peer: &EntityId) -> ResidentConsensusEngine {
    let (left, right) = if owner < peer {
        (owner.clone(), peer.clone())
    } else {
        (peer.clone(), owner.clone())
    };
    let capacity = num_bigint::BigInt::from(10_u8).pow(30);
    let delta = Delta::new(
        TokenId::new(1).expect("ordering token"),
        capacity.clone(),
        num_bigint::BigInt::from(0),
        num_bigint::BigInt::from(0),
        capacity.clone(),
        capacity,
        num_bigint::BigInt::from(0),
        num_bigint::BigInt::from(0),
        num_bigint::BigInt::from(0),
        num_bigint::BigInt::from(0),
    )
    .expect("ordering delta");
    let state = AccountState::new(
        AccountIdentity::new(ordering_domain(), left, right, ordering_watch_seed())
            .expect("ordering account identity"),
        ordering_dispute_config(),
        vec![delta],
    )
    .expect("ordering account state");
    ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x71; 8]),
        1,
        0,
        derive_signer_key(ORDERING_SEED, ORDERING_SIGNER).expect("ordering signer key"),
        ORDERING_SIGNER.to_string(),
        ordering_market(),
        vec![AccountSeed {
            account_id: AccountId::from_bytes(*peer.as_bytes()),
            replica: AccountReplica::new(owner.clone(), state).expect("ordering replica"),
            consensus: None,
        }],
    )
    .expect("ordering resident accounts")
}

/// The counterparty's refresh of its Account Hanko under the board activated at
/// J height 3, log index 0 — the exact rotation this fixture commits.
fn board_hanko_refresh_row(owner: &EntityId, peer: &EntityId) -> AccountInputRow {
    AccountInputRow {
        operation_index: 0,
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        genesis_policy: None,
        // Deliberately `Unresolved`: only the parent Entity may resolve it, and
        // WHEN it does is the whole question.
        certified_board_authority: AccountInputBoardAuthority::Unresolved,
        local_certified_board_authority: AccountInputBoardAuthority::Unresolved,
        input: AccountInput {
            envelope: AccountInputEnvelope {
                from_entity_id: *peer.as_bytes(),
                to_entity_id: *owner.as_bytes(),
                domain: ordering_domain(),
                dispute_config: ordering_dispute_config(),
                watch_seed: Some(ordering_watch_seed()),
            },
            kind: AccountInputKind::BoardHankoRefresh(BoardHankoRefreshInput {
                height: 1,
                frame_hash: [0x5a; 32],
                frame_hanko: Some(vec![0x01]),
                dispute: None,
                board_epoch: 1,
            }),
        },
    }
}

/// The certified J range this one frame carries, exactly as `apply.rs` hands it
/// to the kernel: the projection whose batches the kernel applies after the
/// inbound Account stage.
fn ordering_j_projection(rotation: &FinalizedJEventBatch) -> ResidentJEventProjection {
    ResidentJEventProjection {
        scanned_through: 3,
        batches: vec![rotation.clone()],
        runtime_seed: ORDERING_SEED.to_string(),
        claim: JPrefixRangeClaim {
            jurisdiction_ref: "certified-board-rotation-fixture".to_string(),
            base_height: 2,
            scanned_through_height: 3,
            tip_block_hash: format!("0x{}", hex::encode(rotation.j_block_hash)),
            event_history_root: format!("0x{}", "00".repeat(32)),
            range_hash: format!("0x{}", "00".repeat(32)),
            headers: Vec::new(),
            blocks: Vec::new(),
        },
        proposer_signer_id: ORDERING_SIGNER.to_string(),
        proposer_signature: String::new(),
    }
}

/// Exactly one resident Entity round over the rows the parent already resolved,
/// mirroring `apply_resident_entity_round` as `apply.rs` drives it.
fn ordering_round(
    accounts: &mut ResidentConsensusEngine,
    owner: &EntityId,
    state: EntityStateSlice,
    rows: Vec<AccountInputRow>,
    authority: &EntityFrameAuthority,
    finalized_j_events: Option<ResidentJEventProjection>,
) -> Result<ResidentEntityResult, ResidentEntityError> {
    let expected_accounts_root = accounts.accounts_root();
    let len = rows.len();
    apply_resident_entity_round(
        accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *owner.as_bytes(),
                owning_entity_is_hub: false,
                expected_accounts_root,
                clock: ReceiverClock {
                    entity_timestamp: ORDERING_TIMESTAMP,
                    finalized_j_height: 3,
                },
                rows,
                post_accounts: false,
            },
            local_certified_board_authority: AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: ORDERING_TIMESTAMP,
            outbound_j_height: 3,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            propose_accounts_now: Vec::new(),
            expected_proposer_signer_id: ORDERING_SIGNER.to_string(),
            finalized_j_events,
            entity_authority: Some(authority.clone()),
            local_account_genesis_policy: None,
            cross_j_opening_sibling_views: Vec::new(),
            operations: vec![ResidentEntityOperation::AccountRange { start: 0, len }],
        },
        &DeterministicContext::hlt_default(),
    )
}

/// Everything the two orderings share: the fixture, the pre-rotation Entity
/// state (FoundationBootstrapped + EntityRegistered committed), and the
/// `BoardActivated` batch this one frame carries.
struct IntraFrameCase {
    owner: EntityId,
    peer: EntityId,
    authority: EntityFrameAuthority,
    state: RuntimeEntityState,
    rotation: FinalizedJEventBatch,
}

fn intra_frame_case() -> IntraFrameCase {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("shared rotation fixture");
    // The owner is the local signer's own lazy Entity: the resident Account
    // engine refuses to hold an Account it cannot sign for. The rotation the
    // fixture commits belongs to the PEER, so the owner id is free.
    let identity = SigningIdentity::lazy_from_seed(
        ORDERING_SEED,
        ORDERING_SIGNER,
        1,
        1,
        BoardDelays::default(),
    )
    .expect("ordering signing identity");
    let owner_text = format!("0x{}", hex::encode(identity.entity_id()));
    let owner = EntityId::parse(&owner_text).expect("owner entity id");
    let peer = EntityId::parse(text(&fixture["peerEntityId"])).expect("peer entity id");
    let mut authority = authority(&fixture, &owner_text);
    // The proposer of this frame is the local signer that also drives the
    // resident Account engine.
    authority.config.validators = vec![ORDERING_SIGNER.to_string()];
    authority.config.shares = BTreeMap::from([(ORDERING_SIGNER.to_string(), 1)]);
    authority.leader_state.active_validator_id = ORDERING_SIGNER.to_string();

    let mut state = RuntimeEntityState {
        accounts_root: [0; 32],
        entity: EntityStateSlice::empty(owner_text, ORDERING_TIMESTAMP),
    };
    state.entity.known_accounts.insert(peer.to_string());

    let events = fixture["events"].as_array().expect("fixture events");
    let mut rotation = None;
    for (index, event) in events.iter().enumerate() {
        let raw = &event["event"];
        let j_height = raw["blockNumber"].as_u64().expect("blockNumber");
        let batch = FinalizedJEventBatch {
            j_height,
            j_block_hash: word(text(&raw["blockHash"])),
            events: vec![j_event(raw)],
            dispute_finalization_evidence: Vec::new(),
            reserve_updates: Vec::new(),
            account_claims: Vec::new(),
        };
        if index + 1 == events.len() {
            // The last event is the rotation this frame carries; every earlier
            // one is already committed history.
            rotation = Some(batch);
            break;
        }
        apply_finalized_j_event_batches(
            &mut state.entity,
            j_height,
            &[batch],
            "certified-board-rotation-fixture",
            Some(&authority),
            &BTreeSet::new(),
            &BTreeMap::new(),
        )
        .expect("prior committed J events");
    }
    IntraFrameCase {
        owner,
        peer,
        authority,
        state,
        rotation: rotation.expect("rotation batch"),
    }
}

fn commit_rotation(case: &mut IntraFrameCase) {
    apply_finalized_j_event_batches(
        &mut case.state.entity,
        case.rotation.j_height,
        std::slice::from_ref(&case.rotation),
        "certified-board-rotation-fixture",
        Some(&case.authority),
        &BTreeSet::new(),
        &BTreeMap::new(),
    )
    .expect("the rotation this frame carries");
}

fn refresh_reject_reason(verdict: &AccountInputVerdict) -> &str {
    match verdict {
        AccountInputVerdict::BoardHankoRefreshRejected { reason } => reason.as_str(),
        other => panic!("expected a board Hanko refresh verdict, got {other:?}"),
    }
}

/// Why the shape is forbidden, kept exactly as `05a90c88e` measured it: one
/// identical row resolves two different certified boards depending on which
/// side of the frame's J ingress the resolution happens.
///
/// Rust production order: `apply.rs` resolves the row from the pre-frame state,
/// then `resident.rs` applies this frame's `BoardActivated`. TypeScript order:
/// `applyEntityTxsInOrder` runs the `j_event` tx first, so `input-phases.ts`
/// resolves the row from the rotated board. Neither order is wrong on its own;
/// carrying both events in ONE frame is what makes them disagree, so that frame
/// is what the two engines now refuse.
#[test]
fn the_two_frame_orders_resolve_different_counterparty_boards() {
    let mut case = intra_frame_case();

    // Rust order: resolved from the state as it stood at the start of the frame.
    let mut rust_order = board_hanko_refresh_row(&case.owner, &case.peer);
    rust_order
        .resolve_certified_boards(&case.state.certified_board_authority())
        .expect("row board resolution");
    let AccountInputBoardAuthority::Certified(resolved) = rust_order.certified_board_authority
    else {
        panic!("the peer is registered, so the row must carry a certified board");
    };
    assert_eq!(
        resolved.board_epoch, 0,
        "the retired registration board, not the rotation this frame commits",
    );

    // TypeScript order: the frame's `j_event` transaction commits first.
    commit_rotation(&mut case);
    let mut typescript_order = board_hanko_refresh_row(&case.owner, &case.peer);
    typescript_order
        .resolve_certified_boards(&case.state.certified_board_authority())
        .expect("row board resolution");
    assert_eq!(
        typescript_order.certified_board_authority,
        AccountInputBoardAuthority::Certified(CertifiedBoardAuthority {
            entity_id: *case.peer.as_bytes(),
            registered_board_hash: word(&format!("0x{}", "c3".repeat(32))),
            previous_board_hash: word(&format!("0x{}", "b2".repeat(32))),
            previous_board_valid_until: 1_700_604_800,
            board_epoch: 1,
        }),
        "the board this frame activated",
    );
    assert_ne!(
        rust_order.certified_board_authority, typescript_order.certified_board_authority,
        "one row, one frame, two certified boards — the reason the shape is refused",
    );
}

/// The refusal. One frame carrying the counterparty's `BoardActivated` AND that
/// counterparty's `accountInput` is rejected by the kernel before any mutation,
/// with a typed error naming the exact row. The Runtime maps it to a deferral of
/// that one parent `accountInput` and rebuilds the frame
/// (`RSCORE_ENTITY_COUNTERPARTY_BOARD_ACTIVATION_DEFERRED`); it never halts, and
/// no Account or Entity state was touched here.
#[test]
fn a_frame_activating_a_counterparty_board_refuses_that_counterparty_s_row() {
    let case = intra_frame_case();
    let mut accounts = ordering_engine(&case.owner, &case.peer);
    let mut row = board_hanko_refresh_row(&case.owner, &case.peer);
    row.resolve_certified_boards(&case.state.certified_board_authority())
        .expect("row board resolution");

    let state = case.state.entity.clone();
    let Err(error) = ordering_round(
        &mut accounts,
        &case.owner,
        state,
        vec![row],
        &case.authority,
        Some(ordering_j_projection(&case.rotation)),
    ) else {
        panic!("the mixed frame shape must be refused");
    };
    let ResidentEntityError::CounterpartyBoardActivationMixed {
        row_index,
        counterparty,
    } = &error
    else {
        panic!("expected the frame-shape refusal, got {error:?}");
    };
    assert_eq!(*row_index, 0);
    assert_eq!(counterparty.as_str(), case.peer.to_string().as_str());
    assert_eq!(
        error.to_string(),
        format!(
            "ENTITY_FRAME_COUNTERPARTY_BOARD_ACTIVATION_MIXED:row=0:counterparty={}",
            case.peer
        ),
    );
}

/// Control: the refusal is specific to the mixed shape. The identical row in a
/// frame that does NOT activate the counterparty's board is processed by the
/// ordinary reducer and reaches its ordinary Account-height reject — the row is
/// deferred by one frame, not discarded, and the peer is not punished for the
/// proposer's scheduling.
#[test]
fn a_frame_without_the_activation_processes_the_counterparty_row_normally() {
    let mut case = intra_frame_case();
    let mut accounts = ordering_engine(&case.owner, &case.peer);
    let mut row = board_hanko_refresh_row(&case.owner, &case.peer);

    // The activation is committed by an EARLIER frame; this frame carries only
    // the counterparty's row, which is exactly the shape the policy produces.
    commit_rotation(&mut case);
    row.resolve_certified_boards(&case.state.certified_board_authority())
        .expect("row board resolution");

    let state = case.state.entity.clone();
    let result = ordering_round(
        &mut accounts,
        &case.owner,
        state,
        vec![row],
        &case.authority,
        None,
    )
    .expect("a rejected board Hanko refresh is a typed reject, never a round fault");
    assert_eq!(
        refresh_reject_reason(&result.inbound.applied[0].verdict),
        "ACCOUNT_BOARD_HANKO_REFRESH_HEIGHT_MISMATCH:1:0",
        "the activation check passed; only the Account frame height rejects",
    );
}
