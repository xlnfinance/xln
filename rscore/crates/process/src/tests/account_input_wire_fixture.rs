use xln_rscore_abi::{AbiValue, BodyTuple};

pub(super) fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

fn dispute(hanko: AbiValue, hash: u8, proof_body_hash: u8, nonce: u64, left: bool) -> AbiValue {
    tuple(vec![
        hanko,
        AbiValue::Bytes(vec![hash; 32]),
        AbiValue::Bytes(vec![proof_body_hash; 32]),
        AbiValue::Integer(i128::from(nonce)),
        AbiValue::Bool(left),
    ])
}

pub(super) fn proposal() -> AbiValue {
    tuple(vec![
        tuple(vec![
            AbiValue::Integer(41),
            AbiValue::Integer(1_700_000_000_123),
            AbiValue::Integer(51),
            tuple(Vec::new()),
            AbiValue::Text("prev-41".into()),
            AbiValue::Bytes(vec![0x55; 32]),
            AbiValue::Bytes(vec![0x66; 32]),
        ]),
        AbiValue::Bytes(vec![0x77, 0x78]),
        dispute(AbiValue::Bytes(vec![0x88]), 0x89, 0x8a, 61, false),
    ])
}

pub(super) fn ack() -> AbiValue {
    tuple(vec![
        AbiValue::Integer(42),
        AbiValue::Bytes(vec![0xbb; 32]),
        AbiValue::Nil,
        dispute(AbiValue::Nil, 0xcc, 0xcd, 62, true),
    ])
}

pub(super) fn peer_row(kind: AbiValue) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(7),
        AbiValue::Bytes(vec![0x11; 32]),
        tuple(vec![
            AbiValue::Bytes(vec![0x11; 32]),
            AbiValue::Bytes(vec![0x22; 32]),
            tuple(vec![
                AbiValue::Integer(31_337),
                AbiValue::Bytes(vec![0x33; 20]),
            ]),
            tuple(vec![AbiValue::Integer(17), AbiValue::Integer(29)]),
            AbiValue::Bytes(vec![0x44; 32]),
            kind,
        ]),
        AbiValue::Nil,
        tuple(vec![AbiValue::Nil, AbiValue::Nil]),
    ])
}

pub(super) fn ack_frame_row() -> AbiValue {
    peer_row(tuple(vec![AbiValue::Integer(0), ack(), proposal()]))
}

pub(super) fn at<'a>(value: &'a AbiValue, path: &[usize]) -> &'a AbiValue {
    path.iter().fold(value, |value, index| {
        let AbiValue::Tuple(fields) = value else {
            panic!("tuple expected at {path:?}")
        };
        &fields.fields()[*index]
    })
}

pub(super) fn replace_at(value: &AbiValue, path: &[usize], replacement: AbiValue) -> AbiValue {
    if path.is_empty() {
        return replacement;
    }
    let AbiValue::Tuple(fields) = value else {
        panic!("tuple expected at {path:?}")
    };
    let mut fields = fields.fields().to_vec();
    fields[path[0]] = replace_at(&fields[path[0]], &path[1..], replacement);
    tuple(fields)
}

pub(super) fn append_at(value: &AbiValue, path: &[usize]) -> AbiValue {
    let AbiValue::Tuple(fields) = at(value, path) else {
        panic!("tuple expected at {path:?}")
    };
    let mut appended = fields.fields().to_vec();
    appended.push(AbiValue::Nil);
    replace_at(value, path, tuple(appended))
}

pub(super) fn remove_last_at(value: &AbiValue, path: &[usize]) -> AbiValue {
    let AbiValue::Tuple(fields) = at(value, path) else {
        panic!("tuple expected at {path:?}")
    };
    let mut shortened = fields.fields().to_vec();
    shortened.pop().expect("nonempty canonical tuple");
    replace_at(value, path, tuple(shortened))
}

pub(super) fn width_at(value: &AbiValue, path: &[usize], width: usize) -> AbiValue {
    replace_at(value, path, AbiValue::Bytes(vec![0xee; width]))
}
