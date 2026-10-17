mod fixture;

use xln_rscore_batch::{AccountSeed, EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::{
    AccountConsensus, AccountEnvelope, AccountReplica, AccountState, AccountTx, Delta,
    HtlcHashlock, HtlcLock, HtlcResolveOutcome, HtlcResolveTx, ProposalOutcome, Side,
    propose_account_frame,
};
use xln_rscore_protocol::CanonicalValue;

#[test]
fn queued_resolves_and_frozen_accounts_do_not_rearm_htlc_deadlines() {
    let pair = fixture::pair();
    let (left, right) = if pair.payer < pair.payee {
        (&pair.payer, &pair.payee)
    } else {
        (&pair.payee, &pair.payer)
    };
    for workers in [1, 4] {
        for (queued, pending, status) in [
            (false, false, "active"),
            (true, false, "active"),
            (true, true, "active"),
            (false, false, "dispute_preparing"),
            (false, false, "disputed"),
        ] {
            let base = AccountReplica::new(pair.payer.clone(), fixture::account_state(left, right))
                .expect("base");
            let side = base.owner_side();
            let hashlock = format!("0x{}", "44".repeat(32));
            let lock = HtlcLock::restore(
                hashlock.clone(),
                HtlcHashlock::parse(&hashlock).expect("hashlock"),
                2_000.into(),
                100,
                10.into(),
                xln_rscore_engine::TokenId::new(1).expect("token"),
                side,
                1,
                1,
                None,
            )
            .expect("committed lock");
            let mut deltas = base.state().deltas().cloned().collect::<Vec<_>>();
            let row = deltas
                .iter_mut()
                .find(|row| row.token_id().get() == 1)
                .expect("delta");
            *row = Delta::new(
                row.token_id(),
                row.collateral().clone(),
                row.ondelta().clone(),
                row.offdelta().clone(),
                row.left_credit_limit().clone(),
                row.right_credit_limit().clone(),
                row.allowance(Side::Left).clone(),
                row.allowance(Side::Right).clone(),
                if side == Side::Left {
                    10.into()
                } else {
                    0.into()
                },
                if side == Side::Right {
                    10.into()
                } else {
                    0.into()
                },
            )
            .expect("lock hold");
            let state = AccountState::restore(
                base.state().identity().clone(),
                base.state().dispute_config(),
                deltas,
                vec![lock],
            )
            .expect("state");
            let mut replica = AccountReplica::new(pair.payer.clone(), state).expect("replica");
            if status != "active" {
                replica.set_envelope(
                    AccountEnvelope::new(
                        vec![("status".into(), CanonicalValue::String(status.into()))],
                        Vec::new(),
                    )
                    .expect("envelope"),
                );
            }
            let mut consensus = AccountConsensus::new(replica.clone());
            if queued {
                consensus
                    .admit_txs(
                        vec![AccountTx::HtlcResolve(HtlcResolveTx {
                            lock_id: hashlock.clone(),
                            outcome: HtlcResolveOutcome::Error {
                                reason: Some("timeout".into()),
                            },
                        })],
                        "deadline-regression",
                    )
                    .expect("resolve admission");
            }
            if pending {
                let proposed = propose_account_frame(
                    &mut consensus,
                    &fixture::signing_identity("payer-0"),
                    2_000,
                    100,
                    &fixture::market(),
                )
                .expect("propose timeout resolve");
                assert!(matches!(proposed, ProposalOutcome::Proposed(_)));
                assert!(consensus.mempool().is_empty());
            }
            let mut engine = ResidentConsensusEngine::restore(
                EngineGeneration::from_bytes([0x42; 8]),
                workers,
                1,
                fixture::signer_key("payer-0"),
                "payer-0".into(),
                fixture::market(),
                vec![AccountSeed {
                    account_id: pair.payer_account,
                    replica,
                    consensus: Some(consensus.consensus_snapshot()),
                }],
            )
            .expect("resident restore");
            let (earliest, due) = engine
                .selected_htlc_deadlines(engine.accounts_root(), 2_000)
                .expect("deadlines");
            assert_eq!(
                earliest,
                if queued || status != "active" {
                    None
                } else {
                    Some(2_000)
                },
                "workers={workers} queued={queued} pending={pending} status={status}"
            );
            assert_eq!(due.len(), usize::from(!queued && status == "active"));
            let actionable = engine
                .selected_secret_ack_account_ids(
                    engine.accounts_root(),
                    vec![
                        pair.payer_account,
                        xln_rscore_batch::AccountId::from_bytes([0xee; 32]),
                    ],
                )
                .expect("selected actionability");
            assert_eq!(actionable.contains(&pair.payer_account), status == "active");
            assert_eq!(actionable.len(), usize::from(status == "active"));
        }
    }
}
