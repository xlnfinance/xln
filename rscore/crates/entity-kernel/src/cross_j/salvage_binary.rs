// TS decodeHashLadderBinary owns the public reveal grammar and error text.
// Normalize only its decoded ratio; the engine still verifies every secret
// against the signed ladder. In particular, parseInt("001g", 16) is 1 in TS,
// so rejecting it as raw hex would change both status and registry admission.
pub(super) fn normalize(binary: &str) -> Result<String, String> {
    let units: Vec<u16> = binary.encode_utf16().collect();
    if !binary.starts_with("0x") || !units.len().is_multiple_of(2) {
        return Err("HASHLADDER_BINARY_INVALID_HEX".into());
    }
    let length = (units.len() - 2) / 2;
    match length {
        0 => Ok(binary.into()),
        32 if binary[2..].bytes().all(|byte| byte.is_ascii_hexdigit()) => Ok(binary.into()),
        32 => Err("HASHLADDER_FULL_BINARY_INVALID".into()),
        130 => {
            let ratio = partial_ratio(&String::from_utf16_lossy(&units[2..6]))?;
            if !units[6..]
                .iter()
                .all(|unit| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_hexdigit()))
            {
                return Err("HASHLADDER_PARTIAL_BINARY_REVEALS_INVALID".into());
            }
            Ok(format!(
                "0x{ratio:04x}{}",
                String::from_utf16_lossy(&units[6..])
            ))
        }
        _ => Err(format!("HASHLADDER_BINARY_INVALID_LENGTH:{length}")),
    }
}

fn partial_ratio(prefix: &str) -> Result<u16, String> {
    // The same ECMAScript whitespace set is used for private-seed trim.
    let prefix = super::trim_runtime_seed(prefix);
    let (negative, digits) = if let Some(digits) = prefix.strip_prefix('-') {
        (true, digits)
    } else {
        (false, prefix.strip_prefix('+').unwrap_or(prefix))
    };
    let digits = digits.strip_prefix("0x").unwrap_or(digits);
    let digits: String = digits.chars().take_while(char::is_ascii_hexdigit).collect();
    let parsed = i32::from_str_radix(&digits, 16).ok();
    let parsed = parsed.map(|ratio| if negative { -ratio } else { ratio });
    match parsed {
        Some(ratio) if ratio > 0 && ratio < 65535 => Ok(ratio as u16),
        _ => Err(format!(
            "HASHLADDER_PARTIAL_BINARY_RATIO_INVALID:{}",
            parsed.map_or_else(|| "NaN".into(), |ratio| ratio.to_string())
        )),
    }
}
