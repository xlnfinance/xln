use super::*;
fn body() -> Value {
    json!({"entityId":format!("0x{}","12".repeat(32)),"owner":"0x52908400098527886E0F7030069857D2E4169EE7"})
}
#[test]
fn canonical_request_binds_owner_entity_and_registered_tokens() {
    let tokens = vec![json!({"address":"0x0000000000000000000000000000000000000001","tokenId":1})];
    let (entity, owner, addresses, allowances) = requests(&body(), &tokens).unwrap();
    assert_eq!(entity, format!("0x{}", "12".repeat(32)));
    assert_eq!(owner, "0x52908400098527886e0f7030069857d2e4169ee7");
    assert_eq!(
        addresses,
        vec!["0x0000000000000000000000000000000000000001"]
    );
    assert!(allowances.is_empty());
}
#[test]
fn malformed_and_duplicate_requests_reject_before_rpc() {
    let mut input = body();
    input["tokenAddresses"] = json!([
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000001"
    ]);
    assert_eq!(requests(&input, &[]).unwrap_err().status, 400);
    input["tokenAddresses"] = json!(vec!["0x0000000000000000000000000000000000000001"; 129]);
    assert_eq!(requests(&input, &[]).unwrap_err().status, 413);
    input = body();
    input["owner"] = json!("0x52908400098527886e0F7030069857D2E4169EE7");
    assert!(requests(&input, &[]).is_err());
    input = body();
    input["allowances"] = json!([{"tokenAddress":"0x0000000000000000000000000000000000000001","spender":"0x0000000000000000000000000000000000000002","extra":1}]);
    assert!(requests(&input, &[]).is_err());
}
#[test]
fn missing_or_malformed_rpc_uint_never_becomes_zero() {
    for value in [
        Value::Null,
        json!("0x"),
        json!("0xGG"),
        json!("-1"),
        json!(format!("0x{}", "f".repeat(65))),
    ] {
        assert!(quantity(&value).is_err());
    }
    assert_eq!(quantity(&json!("0x0")).unwrap().to_string(), "0");
    assert_eq!(
        quantity(&json!(format!("0x{}", "f".repeat(64))))
            .unwrap()
            .bits(),
        256
    );
}
