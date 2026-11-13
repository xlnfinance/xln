use serde_json::{Value, json};

pub(super) fn deploy_signer(body: &Value) -> Result<&str, &'static str> {
    if !body.as_object().is_some_and(|input| {
        input.len() == 2 && input.contains_key("request") && input.contains_key("execution")
    }) {
        return Err("STACK_MANAGER_INVOCATION_KEYS_INVALID");
    }
    body["request"]["signerId"]
        .as_str()
        .ok_or("STACK_MANAGER_SIGNER_REQUIRED")
}

pub(super) fn deploy_input(body: &Value, owned_key: &[u8]) -> Value {
    // The authenticated route obtains this key from Runtime custody after selecting
    // request.signerId. HTTP input cannot supply a key or infer a new/resume intent:
    // accepting a caller's key here would bypass the Runtime's signer authority.
    // The canonical TS worker owns validation of the nested request/execution.
    json!({
        "op": "deploy",
        "request": body["request"],
        "execution": body["execution"],
        "signerPrivateKey": format!("0x{}", hex::encode(owned_key)),
    })
}
