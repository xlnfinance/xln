use super::{input, run_worker};
use serde_json::{Value, json};
use std::io::ErrorKind;
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

const SIGNER: &str = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";

fn request(rpc: &str) -> Value {
    json!({
        "name":"Ticket09", "key":"ticket09", "rpcUrl":rpc,
        "expectedChainId":31337, "blockTimeMs":250, "currency":"ETH", "explorer":"",
        "signerId":SIGNER, "foundationRecipient":SIGNER,
        "stablecoin":{"kind":"test"}, "publication":"local", "confirmations":12,
    })
}

fn body(mode: &str) -> Value {
    json!({"request":request("http://127.0.0.1:1"),
        "execution":{"deploymentId":format!("ticket09-missing-{}", std::process::id()), "mode":mode}})
}

#[test]
fn rejects_missing_unknown_and_retired_outer_fields() {
    for invalid in [
        Value::Null,
        json!([]),
        json!({}),
        request("http://127.0.0.1:1"),
        json!({"request":request("http://127.0.0.1:1")}),
        json!({"execution":{"deploymentId":"ticket09","mode":"new"}}),
        json!({"request":{},"execution":{},"signerPrivateKey":"caller-controlled"}),
    ] {
        assert_eq!(
            input::deploy_signer(&invalid),
            Err("STACK_MANAGER_INVOCATION_KEYS_INVALID")
        );
    }
}

#[test]
fn signer_selection_comes_from_the_nested_request() {
    assert_eq!(input::deploy_signer(&body("new")), Ok(SIGNER));
    for invalid in [
        Value::Null,
        json!({}),
        json!({"signerId":null}),
        json!({"signerId":1}),
    ] {
        assert_eq!(
            input::deploy_signer(&json!({"request":invalid,"execution":{}})),
            Err("STACK_MANAGER_SIGNER_REQUIRED")
        );
    }
}

#[test]
fn private_input_preserves_new_and_resume_without_accepting_an_http_key() {
    for mode in ["new", "resume"] {
        let body = body(mode);
        let private = input::deploy_input(&body, &[0x11; 32]);
        assert_eq!(private.as_object().unwrap().len(), 4);
        assert_eq!(private["op"], "deploy");
        assert_eq!(private["request"], body["request"]);
        assert_eq!(private["execution"], body["execution"]);
        assert_eq!(
            private["signerPrivateKey"],
            format!("0x{}", "11".repeat(32))
        );
        assert!(body.get("signerPrivateKey").is_none());
    }
}

fn assert_worker_rejects_without_rpc(mut body: Value, expected: &str) {
    // Observe transport only; there is no fake RPC or financial executor.
    let observer = TcpListener::bind("127.0.0.1:0").unwrap();
    observer.set_nonblocking(true).unwrap();
    body["request"]["rpcUrl"] = json!(format!("http://{}", observer.local_addr().unwrap()));
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../core/api/server/control/stack-manager/native-worker.ts")
        .canonicalize()
        .unwrap();
    let value = run_worker(
        input::deploy_input(&body, &[0x11; 32]),
        Arc::new(Mutex::new(json!({"phase":"idle","active":false}))),
        "bun",
        script.to_str().unwrap(),
    );
    assert_eq!(value, Err(expected.to_string()));
    assert_eq!(observer.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
}

#[test]
fn real_worker_receives_resume_and_rejects_absent_identity_before_rpc() {
    let body = body("resume");
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/evidence/stack-manager")
        .join(body["execution"]["deploymentId"].as_str().unwrap());
    assert!(!directory.exists());
    assert_worker_rejects_without_rpc(body, "STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID");
    assert!(!directory.exists());
}

#[test]
fn real_worker_owns_nested_execution_validation() {
    for (execution, error) in [
        (Value::Null, "STACK_MANAGER_EXECUTION_INVALID"),
        (
            json!({"deploymentId":"ticket09"}),
            "STACK_MANAGER_EXECUTION_KEYS_INVALID",
        ),
        (
            json!({"deploymentId":"ticket09","mode":"resume","unknown":1}),
            "STACK_MANAGER_EXECUTION_KEYS_INVALID",
        ),
        (
            json!({"deploymentId":"../other","mode":"new"}),
            "STACK_MANAGER_DEPLOYMENT_ID_INVALID",
        ),
        (
            json!({"deploymentId":"ticket09","mode":"other"}),
            "STACK_MANAGER_DEPLOYMENT_MODE_INVALID",
        ),
    ] {
        let mut body = body("resume");
        body["execution"] = execution;
        assert_worker_rejects_without_rpc(body, error);
    }
}

#[test]
fn real_worker_rejects_request_key_injection() {
    let mut body = body("new");
    body["request"]["signerPrivateKey"] = json!(format!("0x{}", "22".repeat(32)));
    assert_worker_rejects_without_rpc(body, "STACK_MANAGER_REQUEST_KEYS_INVALID");
}

#[test]
fn real_worker_receives_new_and_enforces_signer_and_foundation_authority() {
    let mut wrong_signer = body("new");
    wrong_signer["request"]["signerId"] = json!(format!("0x{}", "ff".repeat(20)));
    assert_worker_rejects_without_rpc(wrong_signer, "STACK_MANAGER_SIGNER_KEY_MISMATCH");
    let mut wrong_foundation = body("new");
    wrong_foundation["request"]["foundationRecipient"] = json!(format!("0x{}", "ff".repeat(20)));
    assert_worker_rejects_without_rpc(wrong_foundation, "FOUNDATION_LISTING_SIGNER_MISMATCH");
}
