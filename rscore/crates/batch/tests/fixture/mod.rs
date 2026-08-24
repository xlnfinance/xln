//! The two-sided stand every consensus-engine test runs on: one engine per
//! side of every account pair, each with its own signer, driven the way the
//! runtime drives them.

// Each test binary uses a different part of the stand.
#![allow(dead_code)]

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputResult, AccountInputRow, AccountInputVerdict,
    AccountSeed, EngineGeneration, ProposalRow, ReceiverClock, StatefulConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState, AccountTx,
    AckOutcome, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId, IncomingFrame,
    IncomingOutcome, SigningIdentity, TokenId, WatchSeed,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
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
    let identity = SigningIdentity::lazy_from_seed(SEED, signer_id, 1, 1, BoardDelays::default())
        .expect("identity");
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
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        WORKERS,
        0,
        SEED.to_string(),
        "1".to_string(),
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
        })
        .collect();
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        WORKERS,
        revision,
        SEED.to_string(),
        signer_id.to_string(),
        seeds,
    )
    .expect("seeded engine")
}

pub fn stand(accounts: usize) -> Stand {
    let mut payer_engine = engine();
    let mut payee_engine = engine();
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
            .register_signer(payer_bytes, &payer_signer)
            .expect("payer signer");
        payee_engine
            .register_signer(payee_bytes, &payee_signer)
            .expect("payee signer");
        payer_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payee_bytes),
            replica: AccountReplica::new(payer.clone(), state.clone()).expect("payer replica"),
        });
        payee_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payer_bytes),
            replica: AccountReplica::new(payee.clone(), state).expect("payee replica"),
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
                input_index: index as u32,
                account_id: pair.payee_account,
                from_entity_id: pair.payer_entity,
                kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                    height: proposal.frame.height,
                    timestamp: proposal.frame.timestamp,
                    j_height: proposal.frame.j_height,
                    txs: proposal.frame.txs.clone(),
                    prev_frame_hash: proposal.frame.prev_frame_hash.clone(),
                    account_state_root: proposal.frame.account_state_root,
                    by_left: proposal.frame.by_left,
                    state_hash: proposal.state_hash,
                    hanko: proposal.hanko.clone(),
                })),
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
            let AccountInputVerdict::Frame(IncomingOutcome::Committed {
                height,
                state_hash,
                ack_hanko,
                ..
            }) = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            AccountInputRow {
                input_index: index as u32,
                account_id: pair.payer_account,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
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
            matches!(
                result.verdict,
                AccountInputVerdict::Ack(AckOutcome::Committed { .. })
            ),
            "expected an ack commit: {:?}",
            result.verdict,
        );
    }
}

/// The payee's view of the payer's proposals, as account inputs.
pub fn frames_for(stand: &Stand, proposals: &[ProposalRow]) -> Vec<AccountInputRow> {
    proposals
        .iter()
        .enumerate()
        .map(|(index, proposal)| {
            let pair = &stand.pairs[pair_by_payer_account(&stand.pairs, &proposal.account_id)];
            AccountInputRow {
                input_index: index as u32,
                account_id: pair.payee_account,
                from_entity_id: pair.payer_entity,
                kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                    height: proposal.frame.height,
                    timestamp: proposal.frame.timestamp,
                    j_height: proposal.frame.j_height,
                    txs: proposal.frame.txs.clone(),
                    prev_frame_hash: proposal.frame.prev_frame_hash.clone(),
                    account_state_root: proposal.frame.account_state_root,
                    by_left: proposal.frame.by_left,
                    state_hash: proposal.state_hash,
                    hanko: proposal.hanko.clone(),
                })),
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
            let AccountInputVerdict::Frame(IncomingOutcome::Committed {
                height,
                state_hash,
                ack_hanko,
                ..
            }) = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            AccountInputRow {
                input_index: index as u32,
                account_id: pair.payer_account,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                },
            }
        })
        .collect()
}
