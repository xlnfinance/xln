//! The two-sided stand every consensus-engine test runs on: one engine per
//! side of every account pair, each with its own signer, driven the way the
//! runtime drives them.

// Each test binary uses a different part of the stand.
#![allow(dead_code)]

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputResult, AccountInputRow, AccountInputVerdict,
    AccountSeed, EngineGeneration, EntityWave, ProposalRow, ReceiverClock, StatefulConsensusEngine,
    WaveOp, WaveRequest,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState, AccountTx,
    BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId, SigningIdentity, TokenId,
    WatchSeed,
};

/// The key the runtime would derive for a signer label, which is what the
/// engine is handed now — it never sees the seed.
pub fn signer_key(signer_id: &str) -> [u8; 32] {
    xln_rscore_engine::derive_signer_key(SEED, signer_id).expect("signer key")
}

pub fn signing_identity(signer_id: &str) -> SigningIdentity {
    SigningIdentity::lazy_from_seed(SEED, signer_id, 1, 1, BoardDelays::default())
        .expect("signing identity")
}

pub const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const WORKERS: usize = 4;

// ------------------------------------------------------------- the fixture

pub fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn entity_of(signer_id: &str) -> ([u8; 32], EntityId) {
    let identity = signing_identity(signer_id);
    let bytes = *identity.entity_id();
    let parsed = EntityId::parse(&format!("0x{}", hex_of(&bytes))).expect("entity");
    (bytes, parsed)
}

pub fn account_state(left: &EntityId, right: &EntityId) -> AccountState {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000_000),
        BigInt::from(500_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state")
}

pub struct Pair {
    pub payer_account: AccountId,
    pub payee_account: AccountId,
    pub payer: EntityId,
    pub payee: EntityId,
    pub payer_entity: [u8; 32],
    pub payee_entity: [u8; 32],
}

pub struct Stand {
    pub payer: StatefulConsensusEngine,
    pub payee: StatefulConsensusEngine,
    pub pairs: Vec<Pair>,
}

pub fn engine() -> StatefulConsensusEngine {
    engine_with_market(std::sync::Arc::default())
}

/// A fresh engine that already knows the stand's payer signers.
///
/// A restore needs them: this process is handed keys, never the seed that
/// makes them, so it cannot rebuild an entity's key from a checkpoint row the
/// way it once could.
pub fn engine_knowing(stand: &Stand) -> StatefulConsensusEngine {
    let mut engine = engine();
    for (index, pair) in stand.pairs.iter().enumerate() {
        let signer = format!("payer-{index}");
        engine
            .register_signer(pair.payer_entity, signer_key(&signer), &signer)
            .expect("payer signer");
    }
    engine
}

/// The registry tables the runtime installs with Hello. They are not account
/// state, so an engine that never received them prices swaps differently from
/// TypeScript — which is why the market is a constructor argument and not a
/// default.
pub fn market() -> std::sync::Arc<xln_rscore_engine::SwapMarketPolicy> {
    std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::new(
        vec![
            xln_rscore_engine::SwapToken {
                token_id: 1,
                decimals: 6,
                liquid: false,
            },
            xln_rscore_engine::SwapToken {
                token_id: 2,
                decimals: 6,
                liquid: true,
            },
        ],
        Vec::new(),
    ))
}

pub fn engine_with_market(
    swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> StatefulConsensusEngine {
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        WORKERS,
        0,
        xln_rscore_engine::derive_signer_key(SEED, "1").expect("signer key"),
        "1".to_string(),
        swap_market,
        Vec::new(),
    )
    .expect("engine")
}

/// An engine restored with accounts already in it, the way a process comes up
/// from a checkpoint: the replicas are handed to the constructor rather than
/// upserted afterwards.
pub fn seeded_engine(
    revision: u64,
    rows: &[xln_rscore_batch::AccountRestore],
    signer_id: &str,
) -> StatefulConsensusEngine {
    let seeds = rows
        .iter()
        .map(|row| AccountSeed {
            account_id: row.account_id,
            replica: row.replica.clone(),
            consensus: None,
        })
        .collect();
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        WORKERS,
        revision,
        signer_key(signer_id),
        signer_id.to_string(),
        std::sync::Arc::default(),
        seeds,
    )
    .expect("seeded engine")
}

pub fn stand(accounts: usize) -> Stand {
    stand_with_market(accounts, std::sync::Arc::default())
}

pub fn stand_with_market(
    accounts: usize,
    swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Stand {
    let mut payer_engine = engine_with_market(std::sync::Arc::clone(&swap_market));
    let mut payee_engine = engine_with_market(swap_market);
    let mut payer_seeds = Vec::with_capacity(accounts);
    let mut payee_seeds = Vec::with_capacity(accounts);
    let mut pairs = Vec::with_capacity(accounts);
    for index in 0..accounts {
        let payer_signer = format!("payer-{index}");
        let payee_signer = format!("payee-{index}");
        let (payer_bytes, payer) = entity_of(&payer_signer);
        let (payee_bytes, payee) = entity_of(&payee_signer);
        let (left, right) = if payer.to_string() < payee.to_string() {
            (payer.clone(), payee.clone())
        } else {
            (payee.clone(), payer.clone())
        };
        let state = account_state(&left, &right);
        payer_engine
            .register_signer(payer_bytes, signer_key(&payer_signer), &payer_signer)
            .expect("payer signer");
        payee_engine
            .register_signer(payee_bytes, signer_key(&payee_signer), &payee_signer)
            .expect("payee signer");
        payer_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payee_bytes),
            replica: AccountReplica::new(payer.clone(), state.clone()).expect("payer replica"),
            consensus: None,
        });
        payee_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payer_bytes),
            replica: AccountReplica::new(payee.clone(), state).expect("payee replica"),
            consensus: None,
        });
        pairs.push(Pair {
            payer_account: AccountId::from_bytes(payee_bytes),
            payee_account: AccountId::from_bytes(payer_bytes),
            payer,
            payee,
            payer_entity: payer_bytes,
            payee_entity: payee_bytes,
        });
    }
    payer_engine
        .upsert_accounts(payer_seeds)
        .expect("payer seeds");
    payee_engine
        .upsert_accounts(payee_seeds)
        .expect("payee seeds");
    Stand {
        payer: payer_engine,
        payee: payee_engine,
        pairs,
    }
}

/// The receiver's clock, level with the frame being applied.
pub fn clock(timestamp: u64) -> ReceiverClock {
    ReceiverClock {
        entity_timestamp: timestamp,
        finalized_j_height: 100,
    }
}

pub fn payment(pair: &Pair, amount: i64) -> (AccountId, Vec<AccountTx>) {
    (
        pair.payer_account,
        vec![AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(amount),
            route: vec![pair.payee.to_string()],
            description: None,
            from_entity_id: pair.payer.to_string(),
            to_entity_id: pair.payee.to_string(),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        }],
    )
}

/// A maker offer on the funded token. Six decimals so one lot is one unit:
/// the point of the transaction is which market priced it, not its size.
pub fn swap_offer(pair: &Pair) -> (AccountId, Vec<AccountTx>) {
    (
        pair.payer_account,
        vec![AccountTx::SwapOffer {
            offer_id: "offer-1".to_string(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(1_000_000),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: BigInt::from(2_000_000),
            max_fee: BigInt::from(0),
            min_net_receive: BigInt::from(1_900_000),
            time_in_force: None,
            price_ticks: None,
        }],
    )
}

pub fn pair_by_payer_account(pairs: &[Pair], account_id: &AccountId) -> usize {
    pairs
        .iter()
        .position(|pair| pair.payer_account == *account_id)
        .expect("pair")
}

pub fn pair_by_payee_account(pairs: &[Pair], account_id: &AccountId) -> usize {
    pairs
        .iter()
        .position(|pair| pair.payee_account == *account_id)
        .expect("pair")
}

/// One payment per pair, all the way to both sides committing it.
pub fn round(stand: &mut Stand, timestamp: u64, amount: i64) {
    let admissions: Vec<(AccountId, Vec<AccountTx>)> = stand
        .pairs
        .iter()
        .map(|pair| payment(pair, amount))
        .collect();
    stand.payer.admit_txs(admissions).expect("admit");
    let proposals = stand
        .payer
        .propose_frames(timestamp, 100, None)
        .expect("propose");
    let frames: Vec<AccountInputRow> = proposals
        .iter()
        .enumerate()
        .map(|(index, proposal)| {
            let pair = &stand.pairs[pair_by_payer_account(&stand.pairs, &proposal.account_id)];
            AccountInputRow {
                operation_index: index as u64,
                account_id: pair.payee_account,
                from_entity_id: pair.payer_entity,
                kind: AccountInputKind::Frame(Box::new(
                    proposal.incoming().expect("the attempt produced a frame"),
                )),
            }
        })
        .collect();
    let applied = stand
        .payee
        .apply_inputs(clock(timestamp), frames)
        .expect("apply frames");
    let acks: Vec<AccountInputRow> = applied
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let pair = &stand.pairs[pair_by_payee_account(&stand.pairs, &result.account_id)];
            let AccountInputVerdict::FrameCommitted {
                height,
                state_hash,
                ack_hanko,
                ..
            } = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            AccountInputRow {
                operation_index: index as u64,
                account_id: pair.payer_account,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                    dispute: None,
                },
            }
        })
        .collect();
    let acked = stand
        .payer
        .apply_inputs(clock(timestamp), acks)
        .expect("apply acks");
    for result in &acked {
        assert!(
            matches!(result.verdict, AccountInputVerdict::AckCommitted { .. }),
            "expected an ack commit: {:?}",
            result.verdict,
        );
    }
}

/// One wave out of work already labelled with the Entity that owns it.
///
/// Groups keep the order the rows were given, and every row of one Entity
/// stays in the group it arrived in: that order is the whole point of the
/// wave, so a helper that sorted it would hide what the tests are checking.
pub fn wave_of(rows: Vec<([u8; 32], WaveOp)>, timestamp: u64, propose: bool) -> WaveRequest {
    let mut entities: Vec<EntityWave> = Vec::new();
    for (owner_entity_id, op) in rows {
        if let Some(existing) = entities
            .iter_mut()
            .find(|entity| entity.owner_entity_id == owner_entity_id)
        {
            existing.ops.push(op);
            continue;
        }
        entities.push(EntityWave {
            owner_entity_id,
            timestamp,
            j_height: 100,
            clock: clock(timestamp),
            ops: vec![op],
            propose,
        });
    }
    WaveRequest { entities }
}

/// A wave in which one Entity queues nothing and only proposes what it
/// already holds.
pub fn propose_only_wave(owner_entity_id: [u8; 32], timestamp: u64) -> WaveRequest {
    WaveRequest {
        entities: vec![EntityWave {
            owner_entity_id,
            timestamp,
            j_height: 100,
            clock: clock(timestamp),
            ops: Vec::new(),
            propose: true,
        }],
    }
}

/// Local transactions to queue, labelled with the Entity that queued them.
pub fn admit_ops(stand: &Stand, amount: i64) -> Vec<([u8; 32], WaveOp)> {
    stand
        .pairs
        .iter()
        .enumerate()
        .map(|(operation_index, pair)| {
            let (account_id, txs) = payment(pair, amount);
            (
                pair.payer_entity,
                WaveOp::Admit {
                    operation_index: operation_index as u64,
                    account_id,
                    txs,
                },
            )
        })
        .collect()
}

/// The payee's view of the payer's proposals, as wave operations.
pub fn frame_ops(stand: &Stand, proposals: &[ProposalRow]) -> Vec<([u8; 32], WaveOp)> {
    frames_for(stand, proposals)
        .into_iter()
        .map(|row| {
            let pair = &stand.pairs[pair_by_payee_account(&stand.pairs, &row.account_id)];
            (pair.payee_entity, WaveOp::Input(row))
        })
        .collect()
}

/// The payer's view of the payee's commits, as wave operations.
pub fn ack_ops(stand: &Stand, applied: &[AccountInputResult]) -> Vec<([u8; 32], WaveOp)> {
    acks_for(stand, applied)
        .into_iter()
        .map(|row| {
            let pair = &stand.pairs[pair_by_payer_account(&stand.pairs, &row.account_id)];
            (pair.payer_entity, WaveOp::Input(row))
        })
        .collect()
}

/// The payee's view of the payer's proposals, as account inputs.
pub fn frames_for(stand: &Stand, proposals: &[ProposalRow]) -> Vec<AccountInputRow> {
    proposals
        .iter()
        .enumerate()
        .map(|(index, proposal)| {
            let pair = &stand.pairs[pair_by_payer_account(&stand.pairs, &proposal.account_id)];
            AccountInputRow {
                operation_index: index as u64,
                account_id: pair.payee_account,
                from_entity_id: pair.payer_entity,
                kind: AccountInputKind::Frame(Box::new(
                    proposal.incoming().expect("the attempt produced a frame"),
                )),
            }
        })
        .collect()
}

/// The payer's view of the payee's commits, as acks.
pub fn acks_for(stand: &Stand, applied: &[AccountInputResult]) -> Vec<AccountInputRow> {
    applied
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let pair = &stand.pairs[pair_by_payee_account(&stand.pairs, &result.account_id)];
            let AccountInputVerdict::FrameCommitted {
                height,
                state_hash,
                ack_hanko,
                ..
            } = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            AccountInputRow {
                operation_index: index as u64,
                account_id: pair.payer_account,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                    dispute: None,
                },
            }
        })
        .collect()
}
