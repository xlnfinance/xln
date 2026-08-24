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
    hello_with_authority(id, AbiValue::Nil)
}

/// The same Hello, with the authority config a session that owns its accounts
/// sends: `(seed, signerId)`.
pub fn hello_authority(id: u64, seed: &str, signer_id: &str) -> Envelope {
    hello_with_authority(
        id,
        tuple(vec![
            AbiValue::Text(seed.into()),
            AbiValue::Text(signer_id.into()),
        ]),
    )
}

fn hello_with_authority(id: u64, authority: AbiValue) -> Envelope {
    request(
        id,
        OpTag::Hello,
        vec![
            AbiValue::Integer(i128::from(crate::PROCESS_ABI_VERSION)),
            AbiValue::Integer(20),
            // Market policy: WETH(2, 18) based against USDC(1, 6).
            tuple(vec![
                tuple(vec![
                    tuple(vec![
                        AbiValue::Integer(1),
                        AbiValue::Integer(6),
                        AbiValue::Integer(1),
                    ]),
                    tuple(vec![
                        AbiValue::Integer(2),
                        AbiValue::Integer(18),
                        AbiValue::Integer(0),
                    ]),
                ]),
                tuple(vec![tuple(vec![
                    AbiValue::Integer(2),
                    AbiValue::Integer(1),
                    AbiValue::Integer(1),
                ])]),
            ]),
            authority,
        ],
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

pub fn account_with_id(id_byte: u8, locks: Vec<AbiValue>) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(entity_bytes(id_byte).to_vec()),
        AbiValue::Bytes(entity_bytes(1).to_vec()),
        AbiValue::Bytes(entity_bytes(1).to_vec()),
        AbiValue::Bytes(entity_bytes(id_byte).to_vec()),
        AbiValue::Integer(31_337),
        AbiValue::Bytes(vec![0x88; 20]),
        AbiValue::Bytes(vec![0x99; 32]),
        tuple(vec![AbiValue::Integer(10), AbiValue::Integer(20)]),
        tuple(vec![delta()]),
        tuple(locks),
        tuple(vec![AbiValue::Integer(0), AbiValue::Integer(0)]),
        tuple(vec![
            AbiValue::Bytes(vec![0_u8; 32]),
            // Swap offers and rebalance fee registers are owned by the engine,
            // so the seed ships their rows instead of a carried root.
            tuple(Vec::new()),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            tuple(Vec::new()),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
        ]),
        // No replica shell: this fixture exercises the financial engine, so
        // the leaf stays the payment-profile state root.
        AbiValue::Nil,
    ])
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
        tuple(vec![AbiValue::Integer(0), AbiValue::Integer(0)]),
        tuple(vec![
            AbiValue::Bytes(vec![0_u8; 32]),
            // Swap offers and rebalance fee registers are owned by the engine,
            // so the seed ships their rows instead of a carried root.
            tuple(Vec::new()),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            tuple(Vec::new()),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
        ]),
        // No replica shell: this fixture exercises the financial engine, so
        // the leaf stays the payment-profile state root.
        AbiValue::Nil,
    ])
}

/// Collateral plus credit both ways, so either side can pay.
fn funded_delta() -> AbiValue {
    tuple(vec![
        AbiValue::Integer(1),
        AbiValue::Text("1000000".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("500000".into()),
        AbiValue::Text("500000".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
        AbiValue::Text("0".into()),
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
            AbiValue::Integer(50),
        ]),
        tx,
        AbiValue::Nil,
        AbiValue::Nil,
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
            AbiValue::Integer(1),
        ]),
        tx,
        // No replica shell and no authority: these fixtures drive the session
        // directly rather than mirroring a signed peer input.
        AbiValue::Nil,
        AbiValue::Nil,
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

// Owner is entity(1) and the pair is (1, 2), so the account id must be the
// counterparty entity id — the decoder enforces that binding.
fn account_id() -> [u8; 32] {
    entity_bytes(2)
}

pub fn fixture_account_id() -> [u8; 32] {
    account_id()
}

/// keccak256("xln.account-j-claim.empty.v1") — the genesis accumulator root.
/// Pinned here rather than recomputed so the fixture does not silently follow
/// a change to the engine's domain string.
fn empty_j_claim_root() -> [u8; 32] {
    xln_rscore_engine::JClaimAccumulator::default().root
}

/// The lazy entity a signer id defines under this seed — the only owner an
/// authoritative session can sign for.
pub fn authority_entity(seed: &str, signer_id: &str) -> [u8; 32] {
    *xln_rscore_engine::SigningIdentity::lazy_from_seed(
        seed,
        signer_id,
        1,
        1,
        xln_rscore_engine::BoardDelays::default(),
    )
    .expect("identity")
    .entity_id()
}

/// One account between two lazy entities, seeded with a funded delta.
pub fn authority_account(owner: [u8; 32], counterparty: [u8; 32]) -> AbiValue {
    let (left, right) = if owner <= counterparty {
        (owner, counterparty)
    } else {
        (counterparty, owner)
    };
    tuple(vec![
        AbiValue::Bytes(counterparty.to_vec()),
        AbiValue::Bytes(owner.to_vec()),
        AbiValue::Bytes(left.to_vec()),
        AbiValue::Bytes(right.to_vec()),
        AbiValue::Integer(31_337),
        AbiValue::Bytes(vec![0x88; 20]),
        AbiValue::Bytes(vec![0x99; 32]),
        tuple(vec![AbiValue::Integer(10), AbiValue::Integer(20)]),
        tuple(vec![funded_delta()]),
        tuple(Vec::new()),
        tuple(vec![AbiValue::Integer(0), AbiValue::Integer(0)]),
        tuple(vec![
            AbiValue::Bytes(vec![0_u8; 32]),
            tuple(Vec::new()),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            AbiValue::Bytes(vec![0_u8; 32]),
            tuple(Vec::new()),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
            tuple(vec![
                AbiValue::Bytes(empty_j_claim_root().to_vec()),
                AbiValue::Integer(0),
            ]),
        ]),
        AbiValue::Nil,
    ])
}

/// `RestoreCheckpoint` carrying accounts an authoritative session owns.
pub fn load_accounts(id: u64, revision: u64, accounts: Vec<AbiValue>) -> Envelope {
    request(
        id,
        OpTag::RestoreCheckpoint,
        vec![
            AbiValue::Text(crate::PROCESS_PROFILE.into()),
            AbiValue::Integer(i128::from(revision)),
            tuple(accounts),
        ],
    )
}

/// One runtime frame: admissions, arriving inputs, and whether to propose.
pub fn prepare_wave(
    id: u64,
    timestamp: u64,
    admissions: Vec<AbiValue>,
    inputs: Vec<AbiValue>,
    propose: bool,
) -> Envelope {
    request(
        id,
        OpTag::PrepareAccountWave,
        vec![
            AbiValue::Integer(i128::from(timestamp)),
            AbiValue::Integer(100),
            AbiValue::Integer(i128::from(timestamp)),
            AbiValue::Integer(100),
            AbiValue::Bool(propose),
            tuple(admissions),
            tuple(inputs),
        ],
    )
}

/// A direct payment queued for one account.
pub fn wave_payment(account_id: [u8; 32], from: [u8; 32], to: [u8; 32], amount: i128) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(account_id.to_vec()),
        tuple(vec![tuple(vec![
            AbiValue::Integer(0),
            AbiValue::Integer(1),
            AbiValue::Text(amount.to_string()),
            tuple(vec![AbiValue::Text(format!("0x{}", hex::encode(to)))]),
            AbiValue::Nil,
            AbiValue::Text(format!("0x{}", hex::encode(from))),
            AbiValue::Text(format!("0x{}", hex::encode(to))),
            AbiValue::Integer(0),
            AbiValue::Nil,
        ])]),
    ])
}

fn entity_bytes(suffix: u8) -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    bytes[31] = suffix;
    bytes
}

fn entity_hex(suffix: u8) -> String {
    format!("0x{}", hex::encode(entity_bytes(suffix)))
}
