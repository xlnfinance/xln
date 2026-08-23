use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountExecutionContext, AccountReplica, AccountTx, AccountVerdict, HtlcHashlock, HtlcLockTx,
    SequentialAccountEngine, Side,
};

use crate::common::{delta, entity, replica, token};

pub const SECRET: &str = "0x0101010101010101010101010101010101010101010101010101010101010101";
pub const HASHLOCK: &str = "0xcebc8882fecbec7fb80d2cf4b312bec018884c2d66667c67a90508214bd8bafc";

pub fn execution_context(timestamp: u64, j_height: u64) -> AccountExecutionContext {
    AccountExecutionContext::new(1_000, timestamp, j_height, 7)
}

pub fn lock_tx(lock_id: &str, amount: BigInt) -> AccountTx {
    AccountTx::HtlcLock(HtlcLockTx {
        lock_id: lock_id.into(),
        hashlock: HtlcHashlock::parse(HASHLOCK).expect("literal hashlock"),
        timelock: 2_000.into(),
        reveal_before_height: 20,
        amount,
        token_id: token(1),
        delivery_mode: None,
        envelope: None,
    })
}

pub fn left_base(credit: i64) -> AccountReplica {
    replica(
        entity(0x11),
        entity(0x11),
        entity(0x22),
        vec![delta(token(1), 0, 0, 0, credit, 0)],
    )
}

pub fn right_base(credit: i64) -> AccountReplica {
    replica(
        entity(0x22),
        entity(0x11),
        entity(0x22),
        vec![delta(token(1), 0, 0, 0, 0, credit)],
    )
}

pub fn commit_lock(base: &AccountReplica, side: Side, lock_id: &str) -> AccountReplica {
    let transition = SequentialAccountEngine::apply_with_context(
        base,
        side,
        &lock_tx(lock_id, 10.into()),
        &execution_context(1_000, 10),
    )
    .expect("HTLC lock transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    transition.committed().expect("HTLC lock candidate")
}

pub fn hex32(value: [u8; 32]) -> String {
    hex::encode(value)
}
