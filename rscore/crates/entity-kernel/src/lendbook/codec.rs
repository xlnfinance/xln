use super::state::*;
use crate::EntityKernelError as E;
use xln_rscore_engine::LendingTermId;
use xln_rscore_engine::lending::{MAX_CLOCK, term_ms};
use xln_rscore_protocol::CanonicalValue as V;
pub fn term(value: &str) -> Result<LendingTermId, E> {
    match value {
        "1h" => Ok(LendingTermId::OneHour),
        "1d" => Ok(LendingTermId::OneDay),
        "1m" => Ok(LendingTermId::OneMonth),
        "demand" => Ok(LendingTermId::Demand),
        _ => Err(err("LENDING_POLICY_TERM_INVALID")),
    }
}
pub fn exact(v: &V, required: &[&str], optional: &[&str], code: &str) -> Result<(), E> {
    let V::Object(rows) = v else {
        return Err(err(code));
    };
    let mut seen = std::collections::BTreeSet::new();
    if rows.iter().any(|(k, _)| {
        !seen.insert(k) || !required.contains(&k.as_str()) && !optional.contains(&k.as_str())
    }) || required.iter().any(|k| !seen.contains(&k.to_string()))
    {
        return Err(err(code));
    }
    Ok(())
}
fn domain(v: &V) -> Result<(), E> {
    if number(v, "chainId")? == 0 || number(v, "tokenId")? == 0 {
        return Err(err("LENDING_POLICY_DOMAIN_INVALID"));
    }
    let a = text(v, "depositoryAddress")?;
    if !hex_id(a, 40) {
        return Err(err("LENDING_POLICY_DOMAIN_INVALID"));
    }
    Ok(())
}
pub fn hex_id(v: &str, len: usize) -> bool {
    v.strip_prefix("0x").is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn validate_terms(v: &V) -> Result<(), E> {
    exact(
        v,
        &[
            "chainId",
            "depositoryAddress",
            "tokenId",
            "termId",
            "savingsInterestBps",
            "loanInterestBps",
            "loanLateMs",
            "expiresAt",
        ],
        &[],
        "LENDING_TERMS_FIELDS",
    )?;
    let t = term(text(v, "termId")?)?;
    domain(v)?;
    let savings = number(v, "savingsInterestBps")?;
    let loan = number(v, "loanInterestBps")?;
    let late = number(v, "loanLateMs")?;
    if savings > 10000 || loan > 10000 {
        return Err(err("LENDING_POLICY_RATE_INVALID"));
    }
    if t == LendingTermId::Demand && (loan != 0 || late != 0) {
        return Err(err("LENDING_DEMAND_SAVINGS_ONLY"));
    }
    if number(v, "expiresAt")?
        .checked_add(term_ms(t))
        .and_then(|n| n.checked_add(late))
        .is_none_or(|v| v > MAX_CLOCK)
    {
        return Err(err(format!(
            "LENDING_POLICY_CLOCK_OVERFLOW:{:.0}",
            number(v, "expiresAt")? as f64 + term_ms(t) as f64 + late as f64
        )));
    }
    Ok(())
}
pub fn validate_facility(v: &V) -> Result<(), E> {
    exact(
        v,
        &[
            "borrowerEntityId",
            "chainId",
            "depositoryAddress",
            "jNonce",
            "tokenId",
            "termId",
            "maxPrincipal",
            "expiresAt",
        ],
        &[],
        "LENDING_FACILITY_FIELDS",
    )?;
    if term(text(v, "termId")?)? == LendingTermId::Demand {
        return Err(err("LENDING_LOAN_TERM_REQUIRED"));
    }
    domain(v)?;
    if !hex_id(text(v, "borrowerEntityId")?, 64) {
        return Err(err("LENDING_FACILITY_BORROWER_INVALID"));
    }
    number(v, "jNonce")?;
    number(v, "expiresAt")?;
    let amount = big(v, "maxPrincipal")?;
    if amount < 0.into() || amount > (num_bigint::BigInt::from(1) << 256) - 1 {
        return Err(err("LENDING_FACILITY_AMOUNT_INVALID"));
    }
    Ok(())
}
fn rows(v: &V) -> Result<Rows, E> {
    let V::Map(rows) = v else {
        return Err(err("LENDING_BOOK_MAP_INVALID"));
    };
    let mut seen = std::collections::BTreeSet::new();
    rows.iter()
        .map(|(k, v)| {
            let key = string(k)?.to_owned();
            if !seen.insert(key.clone()) {
                return Err(err("LENDING_DUPLICATE_KEY"));
            }
            Ok((key, v.clone()))
        })
        .collect()
}
pub fn decode_canonical_lending_state(v: &V) -> Result<LendingState, E> {
    exact(
        v,
        &["savings", "loans"],
        &["terms", "facilities"],
        "LENDING_BOOK_FIELDS",
    )?;
    let book = LendingState {
        savings: rows(get(v, "savings")?)?,
        loans: rows(get(v, "loans")?)?,
        terms: optional(v, "terms").map(rows).transpose()?,
        facilities: optional(v, "facilities").map(rows).transpose()?,
    };
    let mut orders = std::collections::BTreeSet::new();
    for (_, v) in &book.savings {
        if optional(v, "availableAmount").is_some() || optional(v, "borrowedAmount").is_some() {
            return Err(err("LENDING_ALLOCATION_MIGRATION_REQUIRED"));
        }
        if text(v, "status")? == "closing" {
            return Err(err("LENDING_WITHDRAWAL_MIGRATION_REQUIRED"));
        }
        if text(v, "status")? == "queued" || optional(v, "closeOrder").is_some() {
            let order = number(v, "closeOrder")?;
            if order == 0 || text(v, "status")? == "open" || !orders.insert(order) {
                return Err(err("LENDING_WITHDRAWAL_ORDER_INVALID"));
            }
            let opened = number(v, "createdAt")?;
            if number(v, "updatedAt")? < opened
                || number(v, "termMs")? == 0
                || opened
                    .checked_add(number(v, "termMs")?)
                    .is_none_or(|v| v > MAX_CLOCK)
            {
                return Err(err("LENDING_WITHDRAWAL_CLOCK_INVALID"));
            }
        }
    }
    for (key, v) in book.terms.iter().flatten() {
        validate_terms(v)?;
        if *key != terms_key(v)? {
            return Err(err("LENDING_TERMS_KEY_INVALID"));
        }
    }
    for (key, v) in book.facilities.iter().flatten() {
        validate_facility(v)?;
        if *key != facility_key(v)? {
            return Err(err("LENDING_FACILITY_KEY_INVALID"));
        }
    }
    for (_, v) in &book.loans {
        if optional(v, "lenderEntityId").is_some() || optional(v, "positionId").is_some() {
            return Err(err("LENDING_ALLOCATION_MIGRATION_REQUIRED"));
        }
        let clock = loan_clock(v)?;
        clock.validate_clock().map_err(|e| err(e.to_string()))?;
        if let Some(a) = optional(v, "approval") {
            validate_facility(a)?;
            for k in ["borrowerEntityId", "tokenId", "termId"] {
                if get(a, k)? != get(v, k)? {
                    return Err(err("LENDING_LOAN_APPROVAL_BINDING"));
                }
            }
        }
    }
    Ok(book)
}

/// Raw signed policy fields are checked before deriving the Account epoch.
pub fn policy_input(v: &V, facility: bool) -> Result<(), E> {
    let fields = if facility {
        vec![
            ("borrowerEntityId", 0),
            ("tokenId", 1),
            ("termId", 0),
            ("maxPrincipal", 2),
            ("expiresAt", 1),
        ]
    } else {
        vec![
            ("chainId", 1),
            ("depositoryAddress", 0),
            ("tokenId", 1),
            ("termId", 0),
            ("savingsInterestBps", 1),
            ("loanInterestBps", 1),
            ("loanLateMs", 1),
            ("expiresAt", 1),
        ]
    };
    let V::Object(rows) = v else {
        return Err(err("LENDING_POLICY_INPUT_DATA"));
    };
    let missing = fields
        .iter()
        .filter(|(k, _)| !rows.iter().any(|(key, _)| key == k))
        .map(|(k, _)| *k)
        .collect::<Vec<_>>();
    let mut extra = rows
        .iter()
        .filter(|(k, _)| !fields.iter().any(|(key, _)| k == key))
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>();
    extra.sort();
    if !missing.is_empty() || !extra.is_empty() {
        return Err(err(format!(
            "LENDING_POLICY_INPUT_DATA_FIELDS:missing={}:extra={}",
            if missing.is_empty() {
                "none".into()
            } else {
                missing.join(",")
            },
            if extra.is_empty() {
                "none".into()
            } else {
                extra.join(",")
            }
        )));
    }
    for (key, kind) in fields {
        let code = format!("LENDING_POLICY_INPUT_DATA_{}", key.to_uppercase());
        let raw = get(v, key)?;
        match kind {
            0 => {
                if !matches!(raw,V::String(s)if !s.is_empty()) {
                    return Err(err(code));
                }
            }
            1 => {
                if number(v, key).is_err() {
                    let rendered = match raw {
                        V::Number(n) => n.as_str().to_string(),
                        V::String(s) => s.clone(),
                        V::Null => "null".into(),
                        _ => "undefined".into(),
                    };
                    return Err(err(format!("{code}:{rendered}")));
                }
            }
            _ => {
                if !matches!(raw, V::BigInt(_)) {
                    return Err(err(code));
                }
            }
        }
    }
    let term = text(v, "termId")?;
    if !matches!(term, "1h" | "1d" | "1m") && (facility || term != "demand") {
        return Err(err("LENDING_POLICY_INPUT_DATA_TERMID_VALUE"));
    }
    if facility {
        let amount = big(v, "maxPrincipal")?;
        if amount < 0.into() || amount > (num_bigint::BigInt::from(1) << 256) - 1 {
            return Err(err("LENDING_FACILITY_AMOUNT_INVALID"));
        }
        if !hex_id(text(v, "borrowerEntityId")?, 64) {
            return Err(err("LENDING_FACILITY_BORROWER_INVALID"));
        }
        if number(v, "tokenId")? == 0 {
            return Err(err("LENDING_POLICY_TOKEN_INVALID:0"));
        }
    }
    Ok(())
}
