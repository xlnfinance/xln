use super::*;
fn entity(byte: &str) -> String {
    format!("0x{}", byte.repeat(32))
}
#[test]
fn empty_lending_api_has_canonical_zero_totals() {
    let query = LendingStateQuery::parse(&format!("/?hubEntityId={}", entity("11"))).unwrap();
    let value = lending_state_response(None, &query, 1000, &Default::default()).unwrap();
    assert_eq!(value["success"], true);
    assert_eq!(value["totals"]["savingsPrincipalAmount"], "0");
    assert_eq!(value["savings"], serde_json::json!([]));
}
#[test]
fn lending_query_rejects_malformed_ids_and_token_filters() {
    for query in [
        "/".to_string(),
        "/?hubEntityId=bad".into(),
        format!("/?hubEntityId={}&userEntityId=bad", entity("11")),
        format!("/?hubEntityId={}&tokenId=NaN", entity("11")),
        format!("/?hubEntityId={}&tokenId=0", entity("11")),
        format!("/?hubEntityId={}&tokenId=-2", entity("11")),
    ] {
        assert!(LendingStateQuery::parse(&query).is_err());
    }
    let query =
        LendingStateQuery::parse(&format!("/?hubEntityId={}&tokenId=1.9", entity("11"))).unwrap();
    assert_eq!(query.token_id, Some(1.0));
}
