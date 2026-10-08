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
