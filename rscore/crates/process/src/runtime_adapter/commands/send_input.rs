//! Validate every RuntimeInput field before command admission; no silent lanes.
use serde_json::Value;
pub fn entity_inputs(input: &Value) -> Result<&[Value], String> {
    let input = input.as_object().ok_or("E_BAD_QUERY:input")?;
    for key in input.keys() {
        if !matches!(key.as_str(), "runtimeTxs" | "entityInputs" | "jInputs") {
            return Err(format!(
                "E_BAD_QUERY:unsupported native RuntimeInput field:{key}"
            ));
        }
    }
    let runtime_txs = input
        .get("runtimeTxs")
        .and_then(Value::as_array)
        .ok_or("E_BAD_QUERY:runtimeTxs")?;
    if !runtime_txs.is_empty() {
        return Err("E_BAD_QUERY:remote runtime transaction kind unsupported".into());
    }
    if let Some(j_inputs) = input.get("jInputs") {
        let j_inputs = j_inputs.as_array().ok_or("E_BAD_QUERY:jInputs")?;
        if !j_inputs.is_empty() {
            return Err("E_BAD_QUERY:remote jurisdiction input unsupported".into());
        }
    }
    input
        .get("entityInputs")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 10_000)
        .map(Vec::as_slice)
        .ok_or_else(|| "E_BAD_QUERY:entityInputs".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn mixed_payment_lending_adapter_request_reaches_runtime_admission() {
        let owner = format!("0x{}", "11".repeat(32));
        let hub = format!("0x{}", "22".repeat(32));
        let signer = format!("0x{}", "33".repeat(20));
        let payment = json!({"entityId":owner,"signerId":signer,"entityTxs":[{
            "type":"directPayment","data":{"targetEntityId":hub,"tokenId":1,
                "amount":{"__xlnType":"BigInt","value":"7"},"route":[owner,hub],"deliveryMode":"direct"}}]});
        for kind in [
            "lendingOffer",
            "lendingBorrow",
            "lendingRepay",
            "lendingClosePosition",
            "lendingApprove",
            "lendingSetTerms",
        ] {
            let lending = json!({"entityId":owner,"signerId":signer,"entityTxs":[{"type":kind,"data":{"hubEntityId":hub}}]});
            let request =
                json!({"input":{"runtimeTxs":[],"entityInputs":[payment,lending],"jInputs":[]}});
            let decoded = entity_inputs(&request["input"])
                .unwrap()
                .iter()
                .cloned()
                .map(xln_rscore_runtime::RuntimeEntityInput::decode)
                .collect::<Result<Vec<_>, _>>()
                .expect(
                    "malformed lending must reach runtime per-command eviction, not E_BAD_QUERY",
                );
            assert_eq!(decoded.len(), 2);
            assert_eq!(decoded[0].canonical(), &request["input"]["entityInputs"][0]);
            assert_eq!(decoded[1].canonical(), &request["input"]["entityInputs"][1]);
        }
    }

    #[test]
    fn remote_privileged_lanes_and_timestamps_are_never_silently_dropped() {
        let valid = json!({"runtimeTxs":[],"entityInputs":[],"jInputs":[]});
        assert!(entity_inputs(&valid).is_ok());
        for (field, value) in [
            ("jInputs", json!([{"type":"anything"}])),
            ("jInputs", Value::Null),
            (
                "runtimeTxs",
                json!([{"type":"recordRuntimeAdapterCommand"}]),
            ),
            ("timestamp", json!(123)),
            ("queuedAt", json!(123)),
            ("unknown", json!(true)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(entity_inputs(&invalid).is_err(), "{field}");
        }
    }
}
