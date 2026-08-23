use xln_rscore_abi::{
    AbiValue, BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
};

fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

pub fn request(id: u64, op_tag: OpTag, payload: Vec<AbiValue>) -> Envelope {
    Envelope {
        binding: binding(),
        identity: EngineIdentity {
            engine_generation: [0x42; 8],
            runtime_id: [0x11; 20],
            session_id: [0x22; 16],
            request_id: id.to_be_bytes(),
        },
        op_tag,
        message_kind: MessageKind::Request,
        body: BodyTuple::from_array([tuple(payload)]),
    }
}

fn binding() -> ProtocolBinding {
    crate::PAYMENT_PROFILE_BINDING
}

pub fn hello(id: u64) -> Envelope {
    request(
        id,
        OpTag::Hello,
        vec![AbiValue::Integer(1), AbiValue::Integer(20)],
    )
}

pub fn load(id: u64, revision: u64, locks: Vec<AbiValue>) -> Envelope {
    load_profile(id, crate::PROCESS_PROFILE, revision, locks)
}

pub fn load_profile(id: u64, profile: &str, revision: u64, locks: Vec<AbiValue>) -> Envelope {
    request(
        id,
        OpTag::RestoreCheckpoint,
        vec![
            AbiValue::Text(profile.into()),
            AbiValue::Integer(i128::from(revision)),
            tuple(vec![account(locks)]),
        ],
    )
}

fn account(locks: Vec<AbiValue>) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(account_id().to_vec()),
        AbiValue::Bytes(entity_bytes(1).to_vec()),
        AbiValue::Bytes(entity_bytes(1).to_vec()),
        AbiValue::Bytes(entity_bytes(2).to_vec()),
        AbiValue::Integer(31_337),
        AbiValue::Bytes(vec![0x88; 20]),
        AbiValue::Bytes(vec![0x99; 32]),
        tuple(vec![AbiValue::Integer(10), AbiValue::Integer(20)]),
        tuple(vec![delta()]),
        tuple(locks),
    ])
}

fn delta() -> AbiValue {
    tuple(vec![
        AbiValue::Integer(1),
        AbiValue::Text("1000000".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
    ])
}

pub fn committed_lock() -> AbiValue {
    tuple(vec![
        AbiValue::Text(format!("0x{}", "ab".repeat(32))),
        AbiValue::Bytes(vec![0xcd; 32]),
        AbiValue::Text("2000".into()),
        AbiValue::Integer(50),
        AbiValue::Text("1".into()),
        AbiValue::Integer(1),
        AbiValue::Integer(0),
        AbiValue::Integer(7),
        AbiValue::Integer(1000),
        AbiValue::Nil,
    ])
}

pub fn prepare(id: u64, amount: i64) -> Envelope {
    let tx = tuple(vec![
        AbiValue::Integer(0),
        AbiValue::Integer(1),
        AbiValue::Text(amount.to_string()),
        tuple(vec![AbiValue::Text(entity_hex(1))]),
        AbiValue::Text("process-payment".into()),
        AbiValue::Text(entity_hex(2)),
        AbiValue::Text(entity_hex(1)),
        AbiValue::Integer(0),
        AbiValue::Nil,
    ]);
    let job = tuple(vec![
        AbiValue::Integer(0),
        AbiValue::Bytes(account_id().to_vec()),
        AbiValue::Integer(1),
        tuple(vec![
            AbiValue::Integer(1000),
            AbiValue::Integer(1000),
            AbiValue::Integer(50),
            AbiValue::Integer(0),
        ]),
        tx,
    ]);
    request(id, OpTag::ExecuteWave, vec![tuple(vec![job])])
}

pub fn prepare_htlc_lifecycle(id: u64) -> Envelope {
    let lock_id = format!("0x{}", "ab".repeat(32));
    let secret = vec![1_u8; 32];
    let hashlock = hex::decode("cebc8882fecbec7fb80d2cf4b312bec018884c2d66667c67a90508214bd8bafc")
        .expect("literal hashlock");
    let lock = tuple(vec![
        AbiValue::Integer(1),
        AbiValue::Text(lock_id.clone()),
        AbiValue::Bytes(hashlock),
        AbiValue::Text("2000".into()),
        AbiValue::Integer(50),
        AbiValue::Text("3".into()),
        AbiValue::Integer(1),
        AbiValue::Nil,
        AbiValue::Nil,
    ]);
    let resolve = tuple(vec![
        AbiValue::Integer(2),
        AbiValue::Text(lock_id),
        AbiValue::Integer(0),
        AbiValue::Bytes(secret),
    ]);
    request(
        id,
        OpTag::ExecuteWave,
        vec![tuple(vec![job(0, 1, lock), job(1, 0, resolve)])],
    )
}

fn job(input_index: u32, proposer: i128, tx: AbiValue) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(i128::from(input_index)),
        AbiValue::Bytes(account_id().to_vec()),
        AbiValue::Integer(proposer),
        tuple(vec![
            AbiValue::Integer(1000),
            AbiValue::Integer(1000),
            AbiValue::Integer(1),
            AbiValue::Integer(0),
        ]),
        tx,
    ])
}

pub fn candidate_command(id: u64, op_tag: OpTag, prepare_id: u64) -> Envelope {
    request(
        id,
        op_tag,
        vec![AbiValue::Bytes(prepare_id.to_be_bytes().to_vec())],
    )
}

pub fn shutdown(id: u64) -> Envelope {
    request(id, OpTag::Shutdown, Vec::new())
}

fn account_id() -> [u8; 32] {
    [0x44; 32]
}

fn entity_bytes(suffix: u8) -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    bytes[31] = suffix;
    bytes
}

fn entity_hex(suffix: u8) -> String {
    format!("0x{}", hex::encode(entity_bytes(suffix)))
}
