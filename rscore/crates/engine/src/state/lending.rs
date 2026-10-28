use super::*;
use crate::lending::LendingCovenant;
impl AccountState {
    pub fn lending_claim(&self, id: &str) -> Option<&LendingCovenant> {
        self.subcontracts.get(&text_key(id).ok()?)
    }
    pub fn lending_claims(&self) -> Result<Vec<(String, LendingCovenant)>, StateError> {
        self.subcontracts
            .iter()
            .map(|(k, v)| Ok((decode_raw_text_key(k)?, v.clone())))
            .collect()
    }
    pub fn subcontract_node_records(&self) -> Vec<PersistentNodeRecord<LendingCovenant>> {
        self.subcontracts.node_records()
    }
    pub fn subcontract_node_changes_since(
        &self,
        prior: &Self,
    ) -> PersistentNodeChanges<LendingCovenant> {
        self.subcontracts.node_changes_since(&prior.subcontracts)
    }
    pub fn restore_lending_claims(
        &mut self,
        entries: Vec<(String, LendingCovenant)>,
    ) -> Result<(), StateError> {
        let expected = self.carried.subcontracts_root;
        for (id, claim) in entries {
            if self.lending_claim(&id).is_some() {
                return Err(StateError::AccountStateRoot(
                    "LENDING_COVENANT_DUPLICATE".into(),
                ));
            }
            self.put_lending_claim(id, claim)?;
        }
        if self.subcontracts.root_hash() != expected {
            return Err(StateError::AccountStateRoot(
                "LENDING_COVENANT_ROOT_MISMATCH".into(),
            ));
        }
        self.validate_lending_bindings()?;
        Ok(())
    }
    pub(crate) fn put_lending_claim(
        &mut self,
        id: String,
        claim: LendingCovenant,
    ) -> Result<(), StateError> {
        claim.validate()?;
        let digest = canonical_digest(claim.canonical())?;
        self.subcontracts = self
            .subcontracts
            .updated(text_key(&id)?, claim, digest)
            .map_err(|e| StateError::PersistentMap(e.to_string()))?;
        self.carried.subcontracts_root = self.subcontracts.root_hash();
        Ok(())
    }
    pub(crate) fn remove_lending_claim(&mut self, id: &str) -> Result<(), StateError> {
        self.subcontracts = self
            .subcontracts
            .removed(&text_key(id)?)
            .map_err(|e| StateError::PersistentMap(e.to_string()))?;
        self.carried.subcontracts_root = self.subcontracts.root_hash();
        Ok(())
    }
    pub(crate) fn remove_intent(&mut self, id: &str) -> Result<(), StateError> {
        if let Some(map) = &self.lending_intents {
            self.lending_intents = Some(
                map.removed(&text_key(id)?)
                    .map_err(|e| StateError::PersistentMap(e.to_string()))?,
            );
        }
        Ok(())
    }
    pub fn validate_lending_bindings(&self) -> Result<(), StateError> {
        for (id, c) in self.lending_claims()? {
            let prefix = if c.kind == "loan" { "loan-" } else { "lend-" };
            if !id.strip_prefix(prefix).is_some_and(|s| {
                s.len() == 16
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) {
                return Err(StateError::AccountStateRoot("LENDING_COVENANT_ID".into()));
            }
            let (open, close) = if c.kind == "loan" {
                ("disburse", "repay")
            } else {
                ("fund", "payout")
            };
            if self
                .lending_intent(&format!("{open}:{id}"))
                .is_none_or(|v| v.wire_name() != open)
                || self.has_intent(&format!("{close}:{id}"))?
                || self.has_intent(&format!("dispute:{id}"))?
                || self.delta(crate::TokenId::new(c.token_id)?).is_none()
            {
                return Err(StateError::AccountStateRoot(format!(
                    "LENDING_COVENANT_BINDING:{id}"
                )));
            }
            if let Some(close) = self.lending_intent(&format!("close:{id}")) {
                if !(if c.kind == "demand" {
                    close == LendingIntentKind::CloseRequest
                } else {
                    matches!(
                        close,
                        LendingIntentKind::CloseEarly | LendingIntentKind::CloseMature
                    )
                }) {
                    return Err(StateError::AccountStateRoot(format!(
                        "LENDING_CLOSE_AUTHORIZATION_FORMAT_UNSUPPORTED:{id}"
                    )));
                }
            }
        }
        for (key, kind) in self.lending_intent_entries()? {
            if kind == LendingIntentKind::DisputeClose {
                let id = key
                    .strip_prefix("dispute:")
                    .filter(|id| {
                        id.strip_prefix("lend-")
                            .or_else(|| id.strip_prefix("loan-"))
                            .is_some_and(|v| {
                                v.len() == 16
                                    && v.bytes()
                                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                            })
                    })
                    .ok_or_else(|| {
                        StateError::AccountStateRoot(format!("LENDING_DISPUTE_RECEIPT_ID:{key}"))
                    })?;
                let (open, closed, receipt) = if id.starts_with("lend-") {
                    ("fund", "payout", LendingIntentKind::Fund)
                } else {
                    ("disburse", "repay", LendingIntentKind::Disburse)
                };
                if self.lending_intent(&format!("{open}:{id}")) != Some(receipt)
                    || self.has_intent(&format!("{closed}:{id}"))?
                    || self.lending_claim(id).is_some()
                {
                    return Err(StateError::AccountStateRoot(format!(
                        "LENDING_DISPUTE_RECEIPT_BINDING:{id}"
                    )));
                }
            }
            if matches!(kind, LendingIntentKind::Fund | LendingIntentKind::Disburse) {
                let id = key
                    .strip_prefix(&format!("{}:", kind.wire_name()))
                    .ok_or_else(|| StateError::AccountStateRoot("LENDING_INTENT_KEY".into()))?;
                let close = if kind == LendingIntentKind::Fund {
                    "payout"
                } else {
                    "repay"
                };
                if self.lending_claim(id).is_none()
                    && !self.has_intent(&format!("{close}:{id}"))?
                    && self.lending_intent(&format!("dispute:{id}"))
                        != Some(LendingIntentKind::DisputeClose)
                {
                    return Err(StateError::AccountStateRoot(format!(
                        "LENDING_UNSIGNED_CLAIM:{id}"
                    )));
                }
            }
        }
        Ok(())
    }
    pub fn lending_bodies_loaded(&self) -> bool {
        self.subcontracts.root_hash() == self.carried.subcontracts_root
    }
}
