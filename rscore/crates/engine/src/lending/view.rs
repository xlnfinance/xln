use super::*;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LendingAccountView {
    pub chain_id: u64,
    pub depository_address: String,
    pub j_nonce: u64,
    pub busy: bool,
    pub coupon_capacity: std::collections::BTreeMap<(u16, bool), BigInt>,
    pub claims: std::collections::BTreeMap<String, LendingCovenant>,
    pub intents: std::collections::BTreeMap<String, crate::LendingIntentKind>,
}
impl crate::AccountReplica {
    pub fn lending_view(&self) -> Result<LendingAccountView, StateError> {
        let d = self.state().identity().domain();
        Ok(LendingAccountView {
            chain_id: d.chain_id(),
            depository_address: format!("0x{}", hex::encode(d.depository_address().bytes())),
            j_nonce: self.state().j_nonce(),
            busy: false,
            coupon_capacity: crate::tx::lending_risk::risk(self)?
                .into_iter()
                .map(|(k, (_, _, capacity))| (k, capacity))
                .collect(),
            claims: self.state().lending_claims()?.into_iter().collect(),
            intents: self.state().lending_intent_entries()?.into_iter().collect(),
        })
    }
}
/// Read-only Account projection for the lending endpoint; no history reads.
pub fn project_lending_account(
    account: &crate::AccountConsensus,
) -> Result<CanonicalValue, StateError> {
    let state = account.replica().state();
    Ok(CanonicalValue::Object(vec![
        (
            "claims".into(),
            CanonicalValue::Map(
                state
                    .lending_claims()?
                    .into_iter()
                    .map(|(id, c)| (CanonicalValue::String(id), c.canonical()))
                    .collect(),
            ),
        ),
        (
            "intents".into(),
            CanonicalValue::Map(
                state
                    .lending_intent_entries()?
                    .into_iter()
                    .map(|(id, k)| {
                        (
                            CanonicalValue::String(id),
                            CanonicalValue::String(k.wire_name().into()),
                        )
                    })
                    .collect(),
            ),
        ),
    ]))
}
pub fn decode_lending_account_projection(
    value: &CanonicalValue,
) -> Result<LendingAccountView, StateError> {
    let fail = || StateError::AccountStateRoot("LENDING_ACCOUNT_PROJECTION".into());
    let CanonicalValue::Object(fields) = value else {
        return Err(fail());
    };
    let mut view = LendingAccountView::default();
    for (key, value) in fields {
        let CanonicalValue::Map(rows) = value else {
            return Err(fail());
        };
        for (id, v) in rows {
            let CanonicalValue::String(id) = id else {
                return Err(fail());
            };
            match key.as_str() {
                "claims" => {
                    view.claims.insert(id.clone(), LendingCovenant::decode(v)?);
                }
                "intents" => {
                    if v == &CanonicalValue::String("borrow".into()) {
                        view.intents
                            .insert(id.clone(), crate::LendingIntentKind::Borrow);
                    }
                }
                _ => return Err(fail()),
            }
        }
    }
    Ok(view)
}
