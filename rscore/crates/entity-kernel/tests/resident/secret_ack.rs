use super::*;
#[path = "secret_ack_fixture.rs"]
mod fixture;
use fixture::{Case, DUE, run_case};

fn base_case() -> Case {
    Case {
        peers: 1,
        locks_per_peer: 1,
        ..Default::default()
    }
}

fn account_statuses(accounts: &mut ResidentConsensusEngine, peers: &[EntityId]) -> Vec<String> {
    peers
        .iter()
        .map(|peer| {
            let views = accounts
                .local_financial_views(vec![(
                    AccountId::from_bytes(*peer.as_bytes()),
                    xln_rscore_batch::ResidentAccountFinancialViewRequest {
                        dispute: true,
                        ..Default::default()
                    },
                )])
                .unwrap();
            views[0].1.dispute.as_ref().unwrap().status.clone()
        })
        .collect()
}

#[test]
fn due_secret_ack_prepares_in_same_frame_and_missing_lock_terminates_w1_w4() {
    for case in [
        base_case(),
        Case {
            missing_lock: true,
            ..base_case()
        },
        Case {
            queued_starts: 8,
            ..base_case()
        },
    ] {
        let mut oracle = None;
        for workers in [1, 4] {
            let (result, mut accounts, peers) = run_case(workers, case);
            let status = account_statuses(&mut accounts, &peers);
            if case.queued_starts == 8 {
                assert_eq!(status, ["active"]);
                let entry = result.state.paybook.entries.iter().next().unwrap().1;
                assert_eq!(entry.secret_ack_deadline_at, Some(DUE + 1));
                assert_eq!(
                    result
                        .state
                        .j_batch_state
                        .as_ref()
                        .unwrap()
                        .batch
                        .dispute_starts
                        .len(),
                    8
                );
            } else if case.missing_lock {
                assert_eq!(status, ["active"]);
                assert!(result.state.paybook.entries.is_empty());
            } else {
                assert_eq!(status, ["dispute_preparing"]);
                assert_eq!(result.state.paybook.entries.len(), 1);
            }
            let evidence = (
                result.commitments,
                result.entity_frame_events,
                result.outputs,
            );
            if let Some(expected) = &oracle {
                assert_eq!(&evidence, expected);
            } else {
                oracle = Some(evidence);
            }
        }
    }
}

#[test]
fn due_secret_ack_deduplicates_peer_and_reserves_last_slot_in_deadline_order() {
    for workers in [1, 4] {
        let (result, mut accounts, peers) = run_case(
            workers,
            Case {
                peers: 2,
                locks_per_peer: 2,
                queued_starts: 7,
                ..Default::default()
            },
        );
        assert!(peers[0] > peers[1]);
        assert_eq!(
            account_statuses(&mut accounts, &peers),
            ["dispute_preparing", "active"]
        );
        let prepared = result
            .entity_frame_events
            .iter()
            .filter(|event| {
                matches!(event,
                    EntityFrameEvent::Status { message } if message.contains("Dispute prepared")
                )
            })
            .count();
        assert_eq!(prepared, 1, "two locks must prepare their peer only once");
        for (_, entry) in result.state.paybook.entries.iter() {
            let expected = if entry.inbound_entity.as_deref() == Some(peers[0].to_string().as_str())
            {
                DUE - 10
            } else {
                DUE + 1
            };
            assert_eq!(entry.secret_ack_deadline_at, Some(expected));
        }
    }
}

#[test]
fn due_secret_ack_active_dispute_and_unknown_account_are_idempotent() {
    for case in [
        Case {
            active_dispute: true,
            ..base_case()
        },
        Case {
            unknown_account: true,
            ..base_case()
        },
    ] {
        let (result, mut accounts, peers) = run_case(1, case);
        assert_eq!(
            account_statuses(&mut accounts, &peers),
            [if case.active_dispute {
                "disputed"
            } else {
                "active"
            }]
        );
        assert!(result.entity_frame_events.is_empty());
        assert_eq!(result.state.paybook.entries.len(), 1);
        assert_eq!(
            result
                .state
                .paybook
                .entries
                .iter()
                .next()
                .unwrap()
                .1
                .secret_ack_deadline_at,
            Some(DUE - 10)
        );
    }
}

#[test]
fn due_secret_ack_with_expired_lock_keeps_prepare_in_same_frame_w1_w4() {
    let mut oracle = None;
    for workers in [1, 4] {
        let (result, mut accounts, peers) = run_case(
            workers,
            Case {
                expired_lock: true,
                ..base_case()
            },
        );
        assert_eq!(
            account_statuses(&mut accounts, &peers),
            ["dispute_preparing"]
        );
        let evidence = (
            result.commitments,
            result.entity_frame_events,
            result.outputs,
        );
        if let Some(expected) = &oracle {
            assert_eq!(&evidence, expected);
        } else {
            oracle = Some(evidence);
        }
    }
}

#[test]
fn due_secret_ack_with_verified_peer_hanko_starts_dispute_in_same_frame() {
    let mut oracle = None;
    for workers in [1, 4] {
        let (result, mut accounts, peers) = run_case(
            workers,
            Case {
                ready_proof: true,
                ..base_case()
            },
        );
        assert_eq!(account_statuses(&mut accounts, &peers), ["disputed"]);
        let views = accounts
            .local_financial_views(vec![(
                AccountId::from_bytes(*peers[0].as_bytes()),
                xln_rscore_batch::ResidentAccountFinancialViewRequest {
                    dispute: true,
                    ..Default::default()
                },
            )])
            .unwrap();
        let dispute = views[0].1.dispute.as_ref().unwrap();
        let counter = dispute.counterparty_dispute.as_ref().unwrap();
        let starts = &result
            .state
            .j_batch_state
            .as_ref()
            .unwrap()
            .batch
            .dispute_starts;
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].counterentity, *peers[0].as_bytes());
        assert_eq!(
            starts[0].nonce,
            ethabi::ethereum_types::U256::from(counter.nonce)
        );
        assert_eq!(starts[0].proofbody_hash, counter.proof_body_hash);
        assert_eq!(starts[0].sig, *counter.hanko.as_ref().unwrap());
        assert!(
            starts[0]
                .starter_initial_arguments
                .windows(32)
                .any(|word| word == [1; 32]),
            "the verified lock's known secret must enter enforcement arguments"
        );
        assert!(
            result.j_outputs.is_empty(),
            "drafting the dispute does not broadcast without certification"
        );
        let repeated = fixture::repeat_wake(result.state.clone(), &mut accounts);
        assert_eq!(repeated.state.j_batch_state, result.state.j_batch_state);
        assert!(repeated.routed_entity_outputs.is_empty());
        assert!(repeated.entity_frame_events.is_empty());
        let evidence = (
            result.commitments,
            result.entity_frame_events,
            result.outputs,
        );
        if let Some(expected) = &oracle {
            assert_eq!(&evidence, expected);
        } else {
            oracle = Some(evidence);
        }
    }
}

#[test]
fn scheduled_prepare_is_visible_to_later_manual_prepare_in_same_frame() {
    for workers in [1, 4] {
        let (_, mut accounts, peers) = run_case(
            workers,
            Case {
                manual_prepare: true,
                ..base_case()
            },
        );
        let views = accounts
            .local_financial_views(vec![(
                AccountId::from_bytes(*peers[0].as_bytes()),
                xln_rscore_batch::ResidentAccountFinancialViewRequest {
                    dispute: true,
                    ..Default::default()
                },
            )])
            .unwrap();
        let dispute = views[0].1.dispute.as_ref().unwrap();
        assert_eq!(dispute.status, "dispute_preparing");
        let CanonicalValue::Object(prepare) = dispute.dispute_prepare.as_ref().unwrap() else {
            panic!("prepare object");
        };
        let value = |name: &str| &prepare.iter().find(|(key, _)| key == name).unwrap().1;
        assert_eq!(
            value("readyAfter"),
            &CanonicalValue::Number(CanonicalNumber::try_from_u64(DUE).unwrap()),
            "later manual cooldown cannot overwrite the wake-owned intent"
        );
        assert_eq!(
            value("reason"),
            &CanonicalValue::String("auto-prepare-dispute-after-secret-ack-timeout".into())
        );
    }
}
