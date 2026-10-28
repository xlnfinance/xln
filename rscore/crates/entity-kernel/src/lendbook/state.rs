//! The canonical bank book stores savings liabilities independently of loans.
use crate::EntityKernelError as E;
use num_bigint::BigInt;
use xln_rscore_engine::lending::LendingCovenant;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue as V};
pub type Rows = Vec<(String, V)>;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LendingState {
    pub savings: Rows,
    pub loans: Rows,
    pub terms: Option<Rows>,
    pub facilities: Option<Rows>,
}
pub fn err(message: impl Into<String>) -> E {
    E::SnapshotInvalid {
        detail: message.into(),
    }
}
pub fn get<'a>(v: &'a V, key: &str) -> Result<&'a V, E> {
    let V::Object(rows) = v else {
        return Err(err("LENDING_RECORD_INVALID"));
    };
    rows.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
        .ok_or_else(|| err(format!("LENDING_FIELD_MISSING:{key}")))
}
pub fn optional<'a>(v: &'a V, key: &str) -> Option<&'a V> {
    if let V::Object(rows) = v {
        rows.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    } else {
        None
    }
}
pub fn string(v: &V) -> Result<&str, E> {
    if let V::String(v) = v {
        Ok(v)
    } else {
        Err(err("LENDING_STRING_INVALID"))
    }
}
pub fn text<'a>(v: &'a V, key: &str) -> Result<&'a str, E> {
    string(get(v, key)?)
}
pub fn number(v: &V, key: &str) -> Result<u64, E> {
    if let V::Number(v) = get(v, key)? {
        let n = v
            .as_str()
            .parse::<u64>()
            .map_err(|_| err("LENDING_INTEGER_INVALID"))?;
        if n <= xln_rscore_engine::lending::MAX_CLOCK {
            return Ok(n);
        }
    }
    Err(err("LENDING_INTEGER_INVALID"))
}
pub fn big(v: &V, key: &str) -> Result<BigInt, E> {
    if let V::BigInt(v) = get(v, key)? {
        Ok(v.clone())
    } else {
        Err(err("LENDING_AMOUNT_INVALID"))
    }
}
pub fn n(v: u64) -> V {
    V::Number(CanonicalNumber::try_from_u64(v).expect("validated lending clock"))
}
pub fn s(v: impl Into<String>) -> V {
    V::String(v.into())
}
pub fn obj(fields: Vec<(&str, V)>) -> V {
    V::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub fn set(v: &mut V, key: &str, value: V) {
    let V::Object(rows) = v else {
        unreachable!("validated record")
    };
    if let Some((_, v)) = rows.iter_mut().find(|(k, _)| k == key) {
        *v = value;
    } else {
        rows.push((key.into(), value));
    }
}
pub fn find<'a>(rows: &'a Rows, id: &str) -> Option<&'a V> {
    rows.iter().find(|(k, _)| k == id).map(|(_, v)| v)
}
pub fn find_mut<'a>(rows: &'a mut Rows, id: &str) -> Option<&'a mut V> {
    rows.iter_mut().find(|(k, _)| k == id).map(|(_, v)| v)
}
pub fn put(rows: &mut Rows, id: String, value: V) {
    if let Some(v) = find_mut(rows, &id) {
        *v = value
    } else {
        rows.push((id, value));
    }
}
pub fn canonical_lending_state(book: &LendingState) -> Result<V, E> {
    let map = |rows: &Rows| V::Map(rows.iter().map(|(k, v)| (s(k), v.clone())).collect());
    let mut fields = vec![
        ("savings".into(), map(&book.savings)),
        ("loans".into(), map(&book.loans)),
    ];
    if let Some(rows) = &book.terms {
        fields.push(("terms".into(), map(rows)));
    }
    if let Some(rows) = &book.facilities {
        fields.push(("facilities".into(), map(rows)));
    }
    Ok(V::Object(fields))
}
pub fn loan_clock(v: &V) -> Result<LendingCovenant, E> {
    Ok(LendingCovenant {
        kind: "loan".into(),
        token_id: number(v, "tokenId")? as u32,
        creditor_is_left: true,
        principal: big(v, "principalAmount")?,
        interest_bps: number(v, "interestBps")?,
        opened_at: number(v, "openedAt")?,
        accrued_at: number(v, "accruedAt")?,
        accrued_interest: big(v, "accruedInterest")?,
        interest_remainder: big(v, "interestRemainder")?,
        term_ms: number(v, "termMs")?,
        late_ms: number(v, "lateMs")?,
    })
}
pub fn close_amount(v: &V, time: u64, claim: Option<&LendingCovenant>) -> Result<BigInt, E> {
    if matches!(text(v, "status")?, "closed" | "disputed") {
        return Ok(0.into());
    }
    if text(v, "termId")? == "demand" {
        return claim
            .map(|c| c.exit(time))
            .ok_or_else(|| err("LENDING_DEMAND_ACCOUNT_MISSING"));
    }
    let at = if text(v, "status")? == "queued" {
        number(v, "updatedAt")?
    } else {
        time
    };
    let principal = big(v, "principalAmount")?;
    Ok(&principal
        + if at >= number(v, "createdAt")? + number(v, "termMs")? {
            xln_rscore_engine::lending::interest(&principal, number(v, "interestBps")? as i64)
        } else {
            0.into()
        })
}
pub fn terms_key(v: &V) -> Result<String, E> {
    Ok(format!(
        "{}:{}:{}:{}",
        number(v, "chainId")?,
        text(v, "depositoryAddress")?,
        number(v, "tokenId")?,
        text(v, "termId")?
    ))
}
pub fn facility_key(v: &V) -> Result<String, E> {
    Ok(format!(
        "{}:{}:{}",
        text(v, "borrowerEntityId")?,
        number(v, "tokenId")?,
        text(v, "termId")?
    ))
}
