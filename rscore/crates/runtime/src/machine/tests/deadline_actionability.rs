use xln_rscore_engine::AccountEnvelope;
use xln_rscore_entity_kernel::{PaybookEntry, PaybookState};
use xln_rscore_protocol::CanonicalValue;

#[test]
fn secret_ack_wakes_require_an_existing_active_inbound_account() {
    for (status, known) in [
        ("active", true),
        ("active", false),
        ("dispute_preparing", true),
        ("disputed", true),
    ] {
        let mut runtime = crate::machine::tests::replica_with_account_setup(
            crate::RuntimeLimits::hlt(),
            Vec::new(),
            |mut seed| {
                seed.replica.set_envelope(
                    AccountEnvelope::new(
                        vec![("status".into(), CanonicalValue::String(status.into()))],
                        Vec::new(),
                    )
                    .expect("current Account status"),
                );
                seed
            },
        )
        .expect("resident Runtime");
        let key = crate::RuntimeEntityKey::new(
            crate::machine::tests::owner_bytes(),
            &crate::machine::tests::entity_signer_id(),
        )
        .expect("entity key");
        let hashlock = format!("0x{}", "44".repeat(32));
        let state = runtime.state.e_replicas.get_mut(&key).expect("state");
        let peer = format!("0x{}", if known { "ff" } else { "ee" }.repeat(32));
        state.entity.paybook = PaybookState::from_entries(
            vec![PaybookEntry {
                hashlock: hashlock.clone(),
                description: None,
                token_id: Some(1),
                amount: Some(10.into()),
                started_at_ms: None,
                originated: false,
                inbound_entity: Some(peer),
                outbound_entity: None,
                inbound_settled: false,
                outbound_settled: true,
                secret: Some(format!("0x{}", "55".repeat(32))),
                secret_ack_pending: true,
                secret_ack_started_at: Some(100),
                secret_ack_deadline_at: Some(200),
                pending_fee: None,
                created_timestamp: 100,
            }],
            0.into(),
        )
        .expect("pending secret ACK");
        let live = runtime.e_replicas.get_mut(&key).expect("live replica");
        let jobs = super::derived_wake_jobs(state, live, 200).expect("derived wakes");
        assert_eq!(
            jobs.len(),
            usize::from(known && status == "active"),
            "status={status} known={known}"
        );
        if let Some(job) = jobs.first() {
            assert_eq!(job.id, format!("htlc-secret-ack:{hashlock}"));
            assert_eq!(job.due_at, 200);
        }
    }
}

#[test]
fn fixpay_5_runtime_ack_wake_uses_timelock_while_refund_uses_expired_height() {
    use xln_rscore_engine::{
        AccountExecutionContext, AccountTx, Delta, HtlcHashlock, HtlcLockTx,
        SequentialAccountEngine, TokenId,
    };
    let hashlock = format!("0x{}", "44".repeat(32));
    let token = TokenId::new(1).unwrap();
    let delta = Delta::new(
        token,
        1000.into(),
        0.into(),
        0.into(),
        1000.into(),
        1000.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .unwrap();
    let mut runtime = crate::machine::tests::replica_with_account_setup(
        crate::RuntimeLimits::hlt(),
        vec![delta],
        |mut seed| {
            seed.replica = SequentialAccountEngine::apply_with_context(
                &seed.replica,
                seed.replica.owner_side().opposite(),
                &AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: hashlock.clone(),
                    hashlock: HtlcHashlock::parse(&hashlock).unwrap(),
                    timelock: 100_000.into(),
                    reveal_before_height: 100,
                    amount: 10.into(),
                    token_id: token,
                    delivery_mode: None,
                    envelope: None,
                }),
                &AccountExecutionContext::new(100, 100, 90, 0, 90),
            )
            .unwrap()
            .committed()
            .unwrap();
            seed
        },
    )
    .unwrap();
    let key = crate::RuntimeEntityKey::new(
        crate::machine::tests::owner_bytes(),
        &crate::machine::tests::entity_signer_id(),
    )
    .unwrap();
    let state = runtime.state.e_replicas.get_mut(&key).unwrap();
    state.entity.timestamp = 50_000;
    state.entity.last_finalized_j_height = 101;
    state.entity.paybook = PaybookState::from_entries(
        vec![PaybookEntry {
            hashlock: hashlock.clone(),
            description: None,
            token_id: Some(1),
            amount: Some(10.into()),
            started_at_ms: None,
            originated: false,
            inbound_entity: Some(format!("0x{}", "ff".repeat(32))),
            outbound_entity: None,
            inbound_settled: false,
            outbound_settled: true,
            secret: Some(format!("0x{}", "55".repeat(32))),
            secret_ack_pending: true,
            secret_ack_started_at: Some(100),
            secret_ack_deadline_at: Some(170_000),
            pending_fee: None,
            created_timestamp: 100,
        }],
        0.into(),
    )
    .unwrap();
    let live = runtime.e_replicas.get_mut(&key).unwrap();
    live.entity_consensus.state.authority.config.jurisdiction =
        Some(CanonicalValue::Object(vec![(
            "blockTimeMs".into(),
            CanonicalValue::Number(
                xln_rscore_protocol::CanonicalNumber::try_from_u64(3000).unwrap(),
            ),
        )]));
    assert!(
        super::derived_wake_jobs(state, live, 50_000)
            .unwrap()
            .is_empty()
    );
    let jobs = super::derived_wake_jobs(state, live, 70_000).unwrap();
    assert_eq!(
        jobs,
        vec![xln_rscore_entity_kernel::ScheduledWakeJob {
            kind: xln_rscore_entity_kernel::ScheduledWakeJobKind::Hook,
            id: format!("htlc-secret-ack:{hashlock}"),
            due_at: 70_000,
        }]
    );
    state.entity.paybook =
        PaybookState::from_entries(Vec::<PaybookEntry>::new(), 0.into()).unwrap();
    assert_eq!(
        super::derived_wake_jobs(state, live, 50_000).unwrap(),
        vec![xln_rscore_entity_kernel::ScheduledWakeJob {
            kind: xln_rscore_entity_kernel::ScheduledWakeJobKind::Hook,
            id: format!("htlc-timeout:{hashlock}"),
            due_at: 50_000,
        }]
    );
}
