use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalValue, JS_MAX_SAFE_INTEGER};

pub(super) type Fields = [(String, CanonicalValue)];

pub(super) fn get<'a>(fields: &'a Fields, key: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

// Match String(value) in the TS integer rejection, including malformed types.
fn js_string(value: Option<&CanonicalValue>) -> String {
    match value {
        None => "undefined".into(),
        Some(CanonicalValue::Null) => "null".into(),
        Some(CanonicalValue::Bool(value)) => value.to_string(),
        Some(CanonicalValue::String(value)) => value.clone(),
        Some(CanonicalValue::Number(value)) => value.as_str().into(),
        Some(CanonicalValue::BigInt(value)) => value.to_string(),
        Some(CanonicalValue::Array(values)) => values
            .iter()
            .map(|value| {
                if matches!(value, CanonicalValue::Null) {
                    String::new()
                } else {
                    js_string(Some(value))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(CanonicalValue::Map(_)) => "[object Map]".into(),
        Some(CanonicalValue::Set(_)) => "[object Set]".into(),
        Some(CanonicalValue::Object(_)) => "[object Object]".into(),
    }
}

fn list_keys(keys: &[&str]) -> String {
    if keys.is_empty() {
        return "none".into();
    }
    let mut shown = keys
        .iter()
        .take(8)
        .map(|key| {
            let units = key.encode_utf16().take(65).collect::<Vec<_>>();
            if units.len() > 64 {
                format!("{}...", String::from_utf16_lossy(&units[..64]))
            } else {
                (*key).to_owned()
            }
        })
        .collect::<Vec<_>>();
    if keys.len() > 8 {
        shown.push(format!("+{}", keys.len() - 8));
    }
    shown.join(",")
}

pub(super) fn shape<'a>(
    value: Option<&'a CanonicalValue>,
    required: &[&str],
    optional: &[&str],
    code: &str,
) -> Result<&'a Fields, String> {
    let Some(CanonicalValue::Object(fields)) = value else {
        return Err(code.into());
    };
    let missing = required
        .iter()
        .copied()
        .filter(|key| get(fields, key).is_none())
        .collect::<Vec<_>>();
    let extra = fields
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| !required.contains(key) && !optional.contains(key))
        .collect::<Vec<_>>();
    if !missing.is_empty() || !extra.is_empty() {
        return Err(format!(
            "{code}_FIELDS:missing={}:extra={}",
            list_keys(&missing),
            list_keys(&extra)
        ));
    }
    Ok(fields)
}

pub(super) fn string(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    if matches!(value, Some(CanonicalValue::String(text)) if !text.is_empty()) {
        Ok(())
    } else {
        Err(code.into())
    }
}

pub(super) fn integer(
    value: Option<&CanonicalValue>,
    code: &str,
    minimum: u64,
) -> Result<(), String> {
    if matches!(value, Some(CanonicalValue::Number(number)) if number.as_str().parse::<u64>()
        .is_ok_and(|number| (minimum..=JS_MAX_SAFE_INTEGER).contains(&number)))
    {
        Ok(())
    } else {
        Err(format!("{code}:{}", js_string(value)))
    }
}

pub(super) fn bigint(
    value: Option<&CanonicalValue>,
    code: &str,
    minimum: Option<i32>,
) -> Result<(), String> {
    if matches!(value, Some(CanonicalValue::BigInt(number)) if minimum.is_none_or(|min| number >= &BigInt::from(min)))
    {
        Ok(())
    } else {
        Err(code.into())
    }
}

pub(super) fn literal(
    value: Option<&CanonicalValue>,
    allowed: &[&str],
    code: &str,
) -> Result<(), String> {
    if matches!(value, Some(CanonicalValue::String(text)) if allowed.contains(&text.as_str())) {
        Ok(())
    } else {
        Err(code.into())
    }
}
