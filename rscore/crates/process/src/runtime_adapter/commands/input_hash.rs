//! Hash the decoded browser command like TS keccak256(safeStringify(input)).
//! Never hash raw JSON object order or unnormalized BigInt/Map/Set envelopes.
use num_bigint::BigInt;
use serde_json::{Map, Value};
use sha3::{Digest, Keccak256};

pub fn input_hash(input: &Value) -> Result<String, String> {
    Ok(format!(
        "0x{}",
        hex::encode(Keccak256::digest(canonical(input)?.as_bytes()))
    ))
}

fn quote(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("E_BAD_QUERY:{error}"))
}
fn utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|index| *index != u32::MAX && index.to_string() == key)
}
fn primitive_key(value: &Value) -> bool {
    !value.is_array() && (!value.is_object() || value["__xlnType"] == "BigInt")
}
fn encode_rows(rows: &[Value], map: bool) -> Result<String, String> {
    let mut encoded: Vec<(String, String, bool)> = Vec::new();
    for row in rows {
        let (key, value) = if map {
            let pair = row
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or("E_BAD_QUERY:Map pair")?;
            (&pair[0], Some(&pair[1]))
        } else {
            (row, None)
        };
        let key_text = canonical(key)?;
        let value_text = value.map(canonical).transpose()?.unwrap_or_default();
        // JSON.parse's reviver constructs Map/Set before safeStringify. Its
        // primitive duplicate keys use the last Map value / first Set entry.
        if primitive_key(key)
            && let Some(existing) = encoded
                .iter_mut()
                .find(|entry| entry.2 && entry.0 == key_text)
        {
            if map {
                existing.1 = value_text;
            }
            continue;
        }
        encoded.push((key_text, value_text, primitive_key(key)));
    }
    encoded.sort_by(|left, right| utf16(&left.0, &right.0).then_with(|| utf16(&left.1, &right.1)));
    let body = encoded
        .into_iter()
        .map(|(key, value, _)| if map { format!("[{key},{value}]") } else { key })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"__xlnType\":\"{}\",\"value\":[{body}]}}",
        if map { "Map" } else { "Set" }
    ))
}
fn object(fields: &Map<String, Value>) -> Result<String, String> {
    if let Some(tag) = fields.get("__xlnType").and_then(Value::as_str) {
        match tag {
            "BigInt" if fields.get("value").is_some_and(Value::is_string) => {
                let value = fields["value"]
                    .as_str()
                    .unwrap()
                    .parse::<BigInt>()
                    .map_err(|_| "E_BAD_QUERY:BigInt")?;
                return Ok(format!(
                    "{{\"__xlnType\":\"BigInt\",\"value\":{}}}",
                    quote(&value.to_string())?
                ));
            }
            "Map" | "Set" if fields.get("value").is_some_and(Value::is_array) => {
                return encode_rows(fields["value"].as_array().unwrap(), tag == "Map");
            }
            // These types are not admitted by RuntimeEntityInput's canonical
            // value decoder. Reject before frontier hashing, never reinterpret.
            "TypedArray" | "Buffer" | "Date" => {
                return Err(format!("E_BAD_QUERY:unsupported RuntimeInput tag:{tag}"));
            }
            _ => {}
        }
    }
    let mut keys = fields
        .keys()
        .filter(|key| key.as_str() != "provider" && key.as_str() != "ethersProvider")
        .collect::<Vec<_>>();
    // JS Object keys enumerate integer indices first even when inserted in
    // UTF-16 lexical order by safeStringify's normalization pass.
    keys.sort_by(
        |left, right| match (array_index(left), array_index(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => utf16(left, right),
        },
    );
    let entries = keys
        .into_iter()
        .map(|key| Ok(format!("{}:{}", quote(key)?, canonical(&fields[key])?)))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("{{{}}}", entries.join(",")))
}
fn canonical(value: &Value) -> Result<String, String> {
    match value {
        Value::Object(fields) => object(fields),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::String(value) => quote(value),
        Value::Number(value) => {
            let number = value.as_f64().ok_or("E_BAD_QUERY:number")?;
            if !number.is_finite() {
                return Err("E_BAD_QUERY:nonfinite number".into());
            }
            Ok(ryu_js::Buffer::new().format(number).to_owned())
        }
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_signed_account_command_and_codec_edge_vectors_match_ts() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/runtime-adapter-input-hash.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            assert_eq!(
                canonical(&vector["input"]).unwrap(),
                vector["canonical"].as_str().unwrap(),
                "{}",
                vector["name"]
            );
            assert_eq!(
                input_hash(&vector["input"]).unwrap(),
                vector["hash"].as_str().unwrap(),
                "{}",
                vector["name"]
            );
        }
    }
}
