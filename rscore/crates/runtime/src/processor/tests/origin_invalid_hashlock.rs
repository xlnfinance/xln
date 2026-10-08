use super::*;

#[test]
fn real_bad_origin_reject_preserves_nonce_then_valid_pay_and_exact_wal() {
    run_empty_route_payments(Some("hashlock"));
}

pub(super) fn reject_bad_origin(
    service: &mut ResidentRuntimeService,
    key: &RuntimeEntityKey,
    payment: &Value,
    case: &str,
) {
    let before = &service.processor().replica().unwrap().state.e_replicas[key];
    let root = before.accounts_root;
    let nonce = before.entity.entity_command_nonces.clone();
    let signed_frontier = nonce
        .as_ref()
        .expect("baseline payment committed a signed command nonce");
    assert!(
        signed_frontier
            .by_signer
            .get(&key.signer_id)
            .expect("baseline signer owns its nonce")
            .nonce
            > BigInt::from(0)
    );
    let mut bad = payment.clone();
    let source = payment["entityId"].clone();
    let data = &mut bad["entityTxs"][0]["data"];
    let target = data["targetEntityId"].clone();
    match case {
        "hashlock" => data["hashlock"] = json!(format!("0x{}", "ff".repeat(32))),
        "route" => data["route"] = json!([target, source]),
        "loop" => data["route"] = json!([source, target, source, target]),
        "started_at" => data["startedAtMs"] = json!(1),
        "description" => data["description"] = json!(" padded "),
        "max_debit" => data["maxSenderDebit"]["value"] = json!("6"),
        "no_route" => data["targetEntityId"] = json!(format!("0x{}", "ef".repeat(32))),
        "capacity" => {
            data["amount"]["value"] = json!("1000000000000000000000000000000");
            data["maxSenderDebit"]["value"] = data["amount"]["value"].clone();
        }
        _ => panic!("unknown sender case"),
    }
    let expected_data = data.clone();
    let rejected = service
        .process_local_entity_inputs(vec![RuntimeEntityInput::decode(bad).unwrap()])
        .unwrap_or_else(|error| {
            panic!("sender-invalid {case} must reject without halting the Runtime: {error:?}")
        })
        .expect("bad command admission is a real WAL frame");
    service.sync_committed().unwrap();
    let after = &service.processor().replica().unwrap().state.e_replicas[key];
    assert_eq!(
        after.accounts_root, root,
        "rejected command cannot change money"
    );
    assert_eq!(
        after.entity.entity_command_nonces, nonce,
        "atomic rejection cannot consume signed command nonce"
    );
    let height = rejected.commitments.unwrap().height;
    let record = service.read_durable_frame(height).unwrap();
    let frame = crate::decode_storage_payload(&record.frame_bytes).unwrap();
    let inputs = frame["runtimeInput"]["entityInputs"].as_array().unwrap();
    assert!(inputs.iter().any(|input| {
        input["entityTxs"]
            .as_array()
            .is_some_and(|txs| txs.iter().any(|tx| tx["data"] == expected_data))
    }));
}

macro_rules! sender_case {
    ($test:ident, $case:literal) => {
        #[test]
        fn $test() {
            run_empty_route_payments(Some($case));
        }
    };
}
sender_case!(real_bad_origin_route, "route");
sender_case!(real_bad_origin_loop, "loop");
sender_case!(real_bad_origin_started_at, "started_at");
sender_case!(real_bad_origin_description, "description");
sender_case!(real_bad_origin_max_debit, "max_debit");
sender_case!(real_bad_origin_no_route, "no_route");

sender_case!(real_bad_origin_capacity, "capacity");
