//! Transient signed projections carried with their exact Runtime commit.
use crate::signed_profile::{ProfileTransportIdentity, signed_entity_profile};
use crate::signed_profile_accounts::{account_ids, project_account};
use crate::transport::InboundSessionTable;
use crate::{RuntimeApplyResult, RuntimeEntityKey, RuntimeReplica};
use num_bigint::BigInt;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct LocalProfilePublication {
    pub identity: ProfileTransportIdentity,
    pub fees: BTreeMap<RuntimeEntityKey, (u32, BigInt)>,
    pub sessions: InboundSessionTable,
    pub signed: BTreeMap<RuntimeEntityKey, Value>,
}
pub(super) type CommittedProfiles = (InboundSessionTable, Vec<Value>);
impl LocalProfilePublication {
    pub fn project(
        &mut self,
        replica: &mut RuntimeReplica,
        keys: Vec<RuntimeEntityKey>,
    ) -> Result<CommittedProfiles, String> {
        let mut profiles = Vec::with_capacity(keys.len());
        for key in keys {
            let state = replica
                .state
                .e_replicas
                .get(&key)
                .ok_or("LOCAL_PROFILE_STATE_MISSING")?;
            let live = replica
                .e_replicas
                .get_mut(&key)
                .ok_or("LOCAL_PROFILE_REPLICA_MISSING")?;
            let (ppm, base) = match self.fees.get(&key) {
                Some(fees) => fees.clone(),
                None if !state.entity.profile.is_hub => (1, BigInt::from(0)),
                None => return Err("LOCAL_PROFILE_HUB_POLICY_MISSING".into()),
            };
            let rows = live
                .accounts
                .read_account_views(account_ids(state)?, project_account)
                .map_err(|e| e.to_string())?;
            let previous = self.signed.get(&key);
            let timestamp = match previous {
                Some(profile) => profile["lastUpdated"]
                    .as_u64()
                    .ok_or("LOCAL_PROFILE_TIMESTAMP")?
                    .checked_add(1)
                    .ok_or("LOCAL_PROFILE_TIMESTAMP_OVERFLOW")?
                    .max(replica.state.timestamp),
                None => replica.state.timestamp.max(1),
            };
            let profile =
                signed_entity_profile(state, live, timestamp, &self.identity, ppm, &base, rows)?;
            // Match TS getLocalProfiles: unchanged descriptor and route reuse the exact
            // signed row; changed projections advance a transient public clock even
            // when two committed Runtime frames share the same financial timestamp.
            if let Some(previous) = previous.filter(|old| same_route(old, &profile)) {
                profiles.push(previous.clone());
            } else {
                self.signed.insert(key, profile.clone());
                profiles.push(profile);
            }
        }
        Ok((self.sessions.clone(), profiles))
    }
    pub fn changed(
        &mut self,
        applied: &mut RuntimeApplyResult,
    ) -> Result<CommittedProfiles, String> {
        let mut seen = BTreeSet::new();
        let mut keys = Vec::new();
        for entity in applied.outputs.touches.entity_ids.iter().chain(
            applied
                .outputs
                .touches
                .accounts
                .iter()
                .map(|row| &row.entity_id),
        ) {
            if !seen.insert(entity.clone()) {
                continue;
            }
            let id: [u8; 32] =
                hex::decode(entity.strip_prefix("0x").ok_or("LOCAL_PROFILE_ENTITY_ID")?)
                    .map_err(|e| e.to_string())?
                    .try_into()
                    .map_err(|_| "LOCAL_PROFILE_ENTITY_WIDTH")?;
            // Keyed latest-state lookup, never a full owner scan on a live tick.
            let start = RuntimeEntityKey {
                entity_id: id,
                signer_id: String::new(),
            };
            let mut owners = applied
                .replica
                .state
                .e_replicas
                .range(start..)
                .take_while(|(key, _)| key.entity_id == id);
            let key = owners
                .next()
                .ok_or("LOCAL_PROFILE_OWNER_MISSING")?
                .0
                .clone();
            if owners.next().is_some() {
                return Err("LOCAL_PROFILE_OWNER_AMBIGUOUS".into());
            }
            keys.push(key);
        }
        self.project(&mut applied.replica, keys)
    }
}

fn same_route(left: &Value, right: &Value) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    for value in [&mut left, &mut right] {
        let fields = value.as_object_mut().expect("signed profile object");
        fields.remove("lastUpdated");
        fields.remove("runtimeSignature");
    }
    left == right
}
