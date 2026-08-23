use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDomain, AccountIdentity, AccountReplica, AccountState, Delta, DepositoryAddress,
    EntityId, TokenId, WatchSeed,
};

pub fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("literal entity")
}

pub fn entity_text(byte: u8) -> String {
    entity(byte).to_string()
}

pub fn token(value: u32) -> TokenId {
    TokenId::new(value).expect("literal token")
}

pub fn delta(
    token_id: TokenId,
    collateral: i64,
    ondelta: i64,
    offdelta: i64,
    left_credit: i64,
    right_credit: i64,
) -> Delta {
    Delta::new(
        token_id,
        collateral.into(),
        ondelta.into(),
        offdelta.into(),
        left_credit.into(),
        right_credit.into(),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("literal delta")
}

pub fn replica(
    owner: EntityId,
    left: EntityId,
    right: EntityId,
    deltas: Vec<Delta>,
) -> AccountReplica {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("literal depository"),
    )
    .expect("literal domain");
    let watch_seed =
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("literal watch seed");
    let identity =
        AccountIdentity::new(domain, left, right, watch_seed).expect("canonical parties");
    let state = AccountState::new(identity, deltas).expect("literal state");
    AccountReplica::new(owner, state).expect("party owner")
}

pub fn root_hex(replica: &AccountReplica) -> String {
    hex::encode(replica.state().deltas_root())
}
