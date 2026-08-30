use num_bigint::BigInt;
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityTxKind, LocalEntityFinancialTx, decode_local_entity_tx,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

fn entity(byte: &str) -> String {
    format!("0x{}", byte.repeat(32))
}

fn number(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn decode(kind: EntityTxKind, data: CanonicalValue) -> LocalEntityFinancialTx {
    let tx = CanonicalEntityTx::from_frame_projection(kind, data).expect("canonical tx");
    let Some(xln_rscore_entity_kernel::LocalEntityTx::Financial(tx)) =
        decode_local_entity_tx(&tx).expect("decode")
    else {
        panic!("financial tx")
    };
    tx
}

#[test]
fn all_four_typescript_entity_lending_shapes_decode_exactly() {
    let hub = CanonicalValue::String(entity("10"));
    assert!(matches!(
        decode(
            EntityTxKind::LendingOffer,
            object(vec![
                ("positionId", CanonicalValue::String("lend-1111111111111111".into())),
                ("hubEntityId", hub.clone()),
                ("tokenId", number(1)),
                ("amount", CanonicalValue::BigInt(BigInt::from(10_000))),
                ("termId", CanonicalValue::String("1d".into())),
                ("interestBps", number(100)),
            ]),
        ),
        LocalEntityFinancialTx::LendingOffer(tx)
            if tx.position_id == "lend-1111111111111111"
                && tx.token_id.get() == 1
                && tx.amount == BigInt::from(10_000)
                && tx.interest_bps == 100
    ));
    assert!(matches!(
        decode(
            EntityTxKind::LendingBorrow,
            object(vec![
                ("requestId", CanonicalValue::String("borrow-2222222222222222".into())),
                ("hubEntityId", hub.clone()),
                ("tokenId", number(1)),
                ("amount", CanonicalValue::BigInt(BigInt::from(2_500))),
                ("termId", CanonicalValue::String("1d".into())),
            ]),
        ),
        LocalEntityFinancialTx::LendingBorrow(tx)
            if tx.request_id == "borrow-2222222222222222"
                && tx.max_interest_bps == 10_000
    ));
    assert!(matches!(
        decode(
            EntityTxKind::LendingRepay,
            object(vec![
                ("hubEntityId", hub.clone()),
                ("loanId", CanonicalValue::String("loan-0327fd9035d42518".into())),
                ("tokenId", number(1)),
                ("amount", CanonicalValue::BigInt(BigInt::from(2_525))),
            ]),
        ),
        LocalEntityFinancialTx::LendingRepay(tx)
            if tx.loan_id == "loan-0327fd9035d42518" && tx.amount == BigInt::from(2_525)
    ));
    assert!(matches!(
        decode(
            EntityTxKind::LendingClosePosition,
            object(vec![
                ("hubEntityId", hub),
                ("positionId", CanonicalValue::String("lend-1111111111111111".into())),
            ]),
        ),
        LocalEntityFinancialTx::LendingClosePosition(tx)
            if tx.position_id == "lend-1111111111111111"
    ));
}

#[test]
fn lending_wire_rejects_extra_fields_and_out_of_range_interest() {
    let invalid = object(vec![
        (
            "positionId",
            CanonicalValue::String("lend-1111111111111111".into()),
        ),
        ("hubEntityId", CanonicalValue::String(entity("10"))),
        ("tokenId", number(1)),
        ("amount", CanonicalValue::BigInt(BigInt::from(1))),
        ("termId", CanonicalValue::String("1d".into())),
        ("interestBps", number(10_001)),
    ]);
    let tx = CanonicalEntityTx::from_frame_projection(EntityTxKind::LendingOffer, invalid)
        .expect("canonical tx");
    assert!(decode_local_entity_tx(&tx).is_err());
}
