use std::collections::BTreeMap;

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, encode_canonical_consensus_bytes,
};

use crate::EntityKernelError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWalletBalanceRecord {
    pub token_address: [u8; 20],
    pub token_id: Option<u64>,
    pub balance: BigInt,
    pub j_height: u64,
    pub transaction_hash: Option<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWalletAllowanceRecord {
    pub token_address: [u8; 20],
    pub spender: [u8; 20],
    pub allowance: BigInt,
    pub j_height: u64,
    pub transaction_hash: Option<[u8; 32]>,
}

#[derive(Clone)]
pub struct ExternalWalletState {
    /// Key is `owner[20] || token[20]`.
    balances: PersistentRadixMap<ExternalWalletBalanceRecord>,
    /// Key is `owner[20] || token[20] || spender[20]`.
    allowances: PersistentRadixMap<ExternalWalletAllowanceRecord>,
}

impl std::fmt::Debug for ExternalWalletState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalWalletState")
            .field("balances", &self.balances.iter().collect::<Vec<_>>())
            .field("allowances", &self.allowances.iter().collect::<Vec<_>>())
            .finish()
    }
}

impl PartialEq for ExternalWalletState {
    fn eq(&self, other: &Self) -> bool {
        self.balances.len() == other.balances.len()
            && self.balances.iter().eq(other.balances.iter())
            && self.allowances.len() == other.allowances.len()
            && self.allowances.iter().eq(other.allowances.iter())
    }
}

impl Eq for ExternalWalletState {}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: format!("EXTERNAL_WALLET:{}", detail.into()),
    }
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(value: u64, field: &str) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| invalid(format!("{field}_UNSAFE:{value}")))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::from("0x"), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn balance_key(owner: &[u8; 20], token: &[u8; 20]) -> Vec<u8> {
    let mut key = Vec::with_capacity(40);
    key.extend_from_slice(owner);
    key.extend_from_slice(token);
    key
}

fn allowance_key(owner: &[u8; 20], token: &[u8; 20], spender: &[u8; 20]) -> Vec<u8> {
    let mut key = Vec::with_capacity(60);
    key.extend_from_slice(owner);
    key.extend_from_slice(token);
    key.extend_from_slice(spender);
    key
}

fn balance_value(value: &ExternalWalletBalanceRecord) -> Result<CanonicalValue, EntityKernelError> {
    let mut fields = vec![("tokenAddress".into(), text(hex(&value.token_address)))];
    if let Some(token_id) = value.token_id {
        fields.push(("tokenId".into(), number(token_id, "TOKEN_ID")?));
    }
    fields.extend([
        (
            "balance".into(),
            CanonicalValue::BigInt(value.balance.clone()),
        ),
        ("jHeight".into(), number(value.j_height, "J_HEIGHT")?),
    ]);
    if let Some(hash) = value.transaction_hash {
        fields.push(("transactionHash".into(), text(hex(&hash))));
    }
    Ok(CanonicalValue::Object(fields))
}

fn allowance_value(
    value: &ExternalWalletAllowanceRecord,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut fields = vec![
        ("tokenAddress".into(), text(hex(&value.token_address))),
        ("spender".into(), text(hex(&value.spender))),
        (
            "allowance".into(),
            CanonicalValue::BigInt(value.allowance.clone()),
        ),
        ("jHeight".into(), number(value.j_height, "J_HEIGHT")?),
    ];
    if let Some(hash) = value.transaction_hash {
        fields.push(("transactionHash".into(), text(hex(&hash))));
    }
    Ok(CanonicalValue::Object(fields))
}

fn digest(value: &CanonicalValue) -> Result<[u8; 32], EntityKernelError> {
    let bytes = encode_canonical_consensus_bytes(value)
        .map_err(|error| invalid(format!("ENCODING:{error}")))?;
    Ok(Sha256::digest(bytes).into())
}

impl ExternalWalletState {
    pub fn empty() -> Self {
        Self {
            balances: PersistentRadixMap::empty(),
            allowances: PersistentRadixMap::empty(),
        }
    }

    pub fn put_balance(
        &mut self,
        owner: [u8; 20],
        record: ExternalWalletBalanceRecord,
    ) -> Result<(), EntityKernelError> {
        let value = balance_value(&record)?;
        self.balances = self
            .balances
            .updated(
                balance_key(&owner, &record.token_address),
                record,
                digest(&value)?,
            )
            .map_err(|error| invalid(error.to_string()))?;
        Ok(())
    }

    pub fn put_allowance(
        &mut self,
        owner: [u8; 20],
        record: ExternalWalletAllowanceRecord,
    ) -> Result<(), EntityKernelError> {
        let value = allowance_value(&record)?;
        self.allowances = self
            .allowances
            .updated(
                allowance_key(&owner, &record.token_address, &record.spender),
                record,
                digest(&value)?,
            )
            .map_err(|error| invalid(error.to_string()))?;
        Ok(())
    }

    pub fn balance(
        &self,
        owner: &[u8; 20],
        token: &[u8; 20],
    ) -> Option<&ExternalWalletBalanceRecord> {
        self.balances.get(&balance_key(owner, token))
    }

    pub fn allowance(
        &self,
        owner: &[u8; 20],
        token: &[u8; 20],
        spender: &[u8; 20],
    ) -> Option<&ExternalWalletAllowanceRecord> {
        self.allowances.get(&allowance_key(owner, token, spender))
    }

    pub fn balances(&self) -> impl Iterator<Item = ([u8; 20], &ExternalWalletBalanceRecord)> {
        self.balances.iter().map(|(key, value)| {
            let owner: [u8; 20] = key[..20].try_into().expect("validated wallet key");
            (owner, value)
        })
    }

    pub fn allowances(&self) -> impl Iterator<Item = ([u8; 20], &ExternalWalletAllowanceRecord)> {
        self.allowances.iter().map(|(key, value)| {
            let owner: [u8; 20] = key[..20].try_into().expect("validated wallet key");
            (owner, value)
        })
    }
}

pub fn canonical_external_wallet(
    state: &ExternalWalletState,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut balances = BTreeMap::<[u8; 20], Vec<([u8; 20], CanonicalValue)>>::new();
    for (owner, value) in state.balances() {
        balances
            .entry(owner)
            .or_default()
            .push((value.token_address, balance_value(value)?));
    }
    let mut allowances = BTreeMap::<[u8; 20], Vec<(String, CanonicalValue)>>::new();
    for (owner, value) in state.allowances() {
        allowances.entry(owner).or_default().push((
            format!("{}:{}", hex(&value.token_address), hex(&value.spender)),
            allowance_value(value)?,
        ));
    }
    Ok(CanonicalValue::Object(vec![
        (
            "balances".into(),
            CanonicalValue::Map(
                balances
                    .into_iter()
                    .map(|(owner, mut rows)| {
                        rows.sort_by_key(|(token, _)| *token);
                        (
                            text(hex(&owner)),
                            CanonicalValue::Map(
                                rows.into_iter()
                                    .map(|(token, value)| (text(hex(&token)), value))
                                    .collect(),
                            ),
                        )
                    })
                    .collect(),
            ),
        ),
        (
            "allowances".into(),
            CanonicalValue::Map(
                allowances
                    .into_iter()
                    .map(|(owner, mut rows)| {
                        rows.sort_by(|left, right| left.0.cmp(&right.0));
                        (
                            text(hex(&owner)),
                            CanonicalValue::Map(
                                rows.into_iter()
                                    .map(|(key, value)| (text(key), value))
                                    .collect(),
                            ),
                        )
                    })
                    .collect(),
            ),
        ),
    ]))
}

fn fields<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(format!("OBJECT:{path}"))),
    }
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
    path: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn string(value: &CanonicalValue, path: &str) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(format!("TEXT:{path}"))),
    }
}

fn uint(value: &CanonicalValue, path: &str) -> Result<u64, EntityKernelError> {
    match value {
        CanonicalValue::Number(value) => value
            .as_str()
            .parse()
            .map_err(|_| invalid(format!("UNSIGNED:{path}"))),
        _ => Err(invalid(format!("UNSIGNED:{path}"))),
    }
}

fn bigint(value: &CanonicalValue, path: &str) -> Result<BigInt, EntityKernelError> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(format!("BIGINT:{path}"))),
    }
}

fn fixed<const N: usize>(value: &CanonicalValue, path: &str) -> Result<[u8; N], EntityKernelError> {
    let text = string(value, path)?;
    let body = text
        .strip_prefix("0x")
        .filter(|body| body.len() == N * 2)
        .ok_or_else(|| invalid(format!("HEX:{path}")))?;
    let bytes = (0..N)
        .map(|index| u8::from_str_radix(&body[index * 2..index * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid(format!("HEX:{path}")))?;
    if text != hex(&bytes) {
        return Err(invalid(format!("HEX_CANONICAL:{path}")));
    }
    bytes.try_into().map_err(|_| invalid(format!("HEX:{path}")))
}

pub fn decode_canonical_external_wallet(
    value: &CanonicalValue,
) -> Result<ExternalWalletState, EntityKernelError> {
    let root = fields(value, "externalWallet")?;
    if root.len() != 2 {
        return Err(invalid("FIELDS:externalWallet"));
    }
    let CanonicalValue::Map(balance_owners) = field(root, "balances", "externalWallet")? else {
        return Err(invalid("MAP:externalWallet.balances"));
    };
    let CanonicalValue::Map(allowance_owners) = field(root, "allowances", "externalWallet")? else {
        return Err(invalid("MAP:externalWallet.allowances"));
    };
    let mut state = ExternalWalletState::empty();
    for (owner_value, rows) in balance_owners {
        let owner = fixed::<20>(owner_value, "balances.owner")?;
        let CanonicalValue::Map(rows) = rows else {
            return Err(invalid("MAP:externalWallet.balances.owner"));
        };
        for (token_key, record) in rows {
            let token_key = fixed::<20>(token_key, "balances.tokenKey")?;
            let record = fields(record, "balances.record")?;
            let token_address = fixed::<20>(
                field(record, "tokenAddress", "balances.record")?,
                "balances.tokenAddress",
            )?;
            if token_address != token_key {
                return Err(invalid("BALANCE_TOKEN_KEY_MISMATCH"));
            }
            let token_id = record
                .iter()
                .find_map(|(key, value)| (key == "tokenId").then_some(value))
                .map(|value| uint(value, "balances.tokenId"))
                .transpose()?;
            let transaction_hash = record
                .iter()
                .find_map(|(key, value)| (key == "transactionHash").then_some(value))
                .map(|value| fixed::<32>(value, "balances.transactionHash"))
                .transpose()?;
            state.put_balance(
                owner,
                ExternalWalletBalanceRecord {
                    token_address,
                    token_id,
                    balance: bigint(
                        field(record, "balance", "balances.record")?,
                        "balances.balance",
                    )?,
                    j_height: uint(
                        field(record, "jHeight", "balances.record")?,
                        "balances.jHeight",
                    )?,
                    transaction_hash,
                },
            )?;
        }
    }
    for (owner_value, rows) in allowance_owners {
        let owner = fixed::<20>(owner_value, "allowances.owner")?;
        let CanonicalValue::Map(rows) = rows else {
            return Err(invalid("MAP:externalWallet.allowances.owner"));
        };
        for (composite_key, record) in rows {
            let composite_key = string(composite_key, "allowances.key")?;
            let record = fields(record, "allowances.record")?;
            let token_address = fixed::<20>(
                field(record, "tokenAddress", "allowances.record")?,
                "allowances.tokenAddress",
            )?;
            let spender = fixed::<20>(
                field(record, "spender", "allowances.record")?,
                "allowances.spender",
            )?;
            if composite_key != format!("{}:{}", hex(&token_address), hex(&spender)) {
                return Err(invalid("ALLOWANCE_KEY_MISMATCH"));
            }
            let transaction_hash = record
                .iter()
                .find_map(|(key, value)| (key == "transactionHash").then_some(value))
                .map(|value| fixed::<32>(value, "allowances.transactionHash"))
                .transpose()?;
            state.put_allowance(
                owner,
                ExternalWalletAllowanceRecord {
                    token_address,
                    spender,
                    allowance: bigint(
                        field(record, "allowance", "allowances.record")?,
                        "allowances.allowance",
                    )?,
                    j_height: uint(
                        field(record, "jHeight", "allowances.record")?,
                        "allowances.jHeight",
                    )?,
                    transaction_hash,
                },
            )?;
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_roundtrip_preserves_radix_wallet_records() {
        let owner = [0x11; 20];
        let token = [0x22; 20];
        let spender = [0x33; 20];
        let mut state = ExternalWalletState::empty();
        state
            .put_balance(
                owner,
                ExternalWalletBalanceRecord {
                    token_address: token,
                    token_id: Some(7),
                    balance: BigInt::from(2500),
                    j_height: 91,
                    transaction_hash: Some([0x44; 32]),
                },
            )
            .expect("balance");
        state
            .put_allowance(
                owner,
                ExternalWalletAllowanceRecord {
                    token_address: token,
                    spender,
                    allowance: BigInt::from(900),
                    j_height: 92,
                    transaction_hash: None,
                },
            )
            .expect("allowance");
        let canonical = canonical_external_wallet(&state).expect("canonical");
        let restored = decode_canonical_external_wallet(&canonical).expect("restore");
        assert_eq!(restored, state);
        assert_eq!(restored.balances().count(), 1);
        assert_eq!(restored.allowances().count(), 1);
    }
}
