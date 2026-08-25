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
/// sends: `(privateKey, signerId)`. The fixture derives the key from a seed
/// the way the runtime does, because the tests still name signers by label.
pub fn hello_authority(id: u64, seed: &str, signer_id: &str) -> Envelope {
    hello_authority_key(id, authority_key(seed, signer_id), signer_id)
}

/// Authority Hello with an exact key, including invalid-key boundary tests.
pub fn hello_authority_key(id: u64, private_key: [u8; 32], signer_id: &str) -> Envelope {
    hello_with_authority(
        id,
        tuple(vec![
            AbiValue::Bytes(private_key.to_vec()),
            AbiValue::Text(signer_id.into()),
        ]),
    )
}

/// The key a runtime would derive for this signer label.
pub fn authority_key(seed: &str, signer_id: &str) -> [u8; 32] {
    xln_rscore_engine::derive_signer_key(seed, signer_id).expect("signer key")
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
        OpTag::BootstrapAccounts,
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
        // No consensus state either: the account starts at genesis, and it
        // builds no recovery proof of its own.
        AbiValue::Nil,
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
        // No consensus state either: the account starts at genesis, and it
        // builds no recovery proof of its own.
        AbiValue::Nil,
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

pub fn candidate_command(id: u64, op_tag: OpTag, candidate_token: [u8; 32]) -> Envelope {
    request(id, op_tag, vec![AbiValue::Bytes(candidate_token.to_vec())])
}

pub fn get_checkpoint_changes(id: u64, candidate_token: [u8; 32]) -> Envelope {
    request(
        id,
        OpTag::GetCheckpointChanges,
        vec![AbiValue::Bytes(candidate_token.to_vec())],
    )
}

pub fn commit_checkpoint(id: u64, token: AbiValue) -> Envelope {
    request(id, OpTag::CommitCheckpoint, vec![token])
}

pub fn restore_exact(id: u64, token: AbiValue, accounts: Vec<AbiValue>) -> Envelope {
    request(id, OpTag::RestoreExact, vec![token, tuple(accounts)])
}

/// Build the exact durable rows old authority tests need without reopening the
/// production Bootstrap import path. Production authority Bootstrap is empty
/// revision zero only; every nonempty/revisioned start is RestoreExact.
pub fn restore_authority_accounts(
    id: u64,
    seed: &str,
    signer_id: &str,
    accounts: Vec<AbiValue>,
) -> Envelope {
    restore_authority_accounts_with_rows(id, seed, signer_id, accounts).0
}

pub fn restore_authority_accounts_with_rows(
    id: u64,
    seed: &str,
    signer_id: &str,
    accounts: Vec<AbiValue>,
) -> (Envelope, Vec<AbiValue>) {
    use xln_rscore_batch::{EngineGeneration, StatefulConsensusEngine};
    use xln_rscore_engine::{SwapMarketPolicy, SwapToken};

    let seeds = accounts
        .iter()
        .map(crate::wire_decode::decode_seed_account)
        .collect::<Result<Vec<_>, _>>()
        .expect("authority restore seeds");
    let engine = StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        20,
        0,
        authority_key(seed, signer_id),
        signer_id.to_string(),
        std::sync::Arc::new(SwapMarketPolicy::new(
            vec![
                SwapToken {
                    token_id: 1,
                    decimals: 6,
                    liquid: true,
                },
                SwapToken {
                    token_id: 2,
                    decimals: 18,
                    liquid: false,
                },
            ],
            vec![((2, 1), 1)],
        )),
        seeds,
    )
    .expect("authority restore engine");
    let checkpoint = engine.checkpoint_changes().expect("authority checkpoint");
    let incremental_rows = checkpoint
        .accounts
        .iter()
        .map(crate::checkpoint_wire::account_rows)
        .collect::<Result<Vec<_>, _>>()
        .expect("authority checkpoint rows");
    let rows: Vec<AbiValue> = incremental_rows
        .iter()
        .map(crate::tests::materialize_restore_row)
        .collect();
    (
        restore_exact(
            id,
            crate::checkpoint_wire::token(&checkpoint.restore_token()),
            rows.clone(),
        ),
        rows,
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
    *xln_rscore_engine::SigningIdentity::lazy_from_key(
        authority_key(seed, signer_id),
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
    authority_account_with(
        owner,
        counterparty,
        vec![funded_delta()],
        AbiValue::Nil,
        AbiValue::Nil,
    )
}

/// The exact seed WaveOp::Create accepts: financial genesis, empty mempool,
/// no consensus snapshot and a jurisdiction DeltaTransformer.
pub fn authority_genesis_account(owner: [u8; 32], counterparty: [u8; 32]) -> AbiValue {
    authority_account_with(
        owner,
        counterparty,
        Vec::new(),
        authority_genesis_envelope(owner, counterparty),
        AbiValue::Bytes(vec![0x77; 20]),
    )
}

fn authority_account_with(
    owner: [u8; 32],
    counterparty: [u8; 32],
    deltas: Vec<AbiValue>,
    envelope: AbiValue,
    delta_transformer: AbiValue,
) -> AbiValue {
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
        tuple(deltas),
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
        envelope,
        AbiValue::Nil,
        delta_transformer,
    ])
}

fn authority_genesis_envelope(owner: [u8; 32], counterparty: [u8; 32]) -> AbiValue {
    use xln_rscore_engine::{AccountEnvelope, CanonicalValue};

    let entity = |value: [u8; 32]| format!("0x{}", hex::encode(value));
    let zero_root = CanonicalValue::String(format!("0x{}", "00".repeat(32)));
    let envelope = AccountEnvelope::new(
        vec![
            (
                "status".to_string(),
                CanonicalValue::String("active".to_string()),
            ),
            ("currentHeight".to_string(), CanonicalValue::Number(0.0)),
            ("rollbackCount".to_string(), CanonicalValue::Number(0.0)),
            (
                "proofHeader".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "fromEntity".to_string(),
                        CanonicalValue::String(entity(owner)),
                    ),
                    (
                        "toEntity".to_string(),
                        CanonicalValue::String(entity(counterparty)),
                    ),
                    ("nextProofNonce".to_string(), CanonicalValue::Number(1.0)),
                ]),
            ),
            (
                "currentFrameHash".to_string(),
                CanonicalValue::String(String::new()),
            ),
            ("pendingWithdrawals".to_string(), zero_root.clone()),
            (
                "shadow".to_string(),
                CanonicalValue::Object(vec![(
                    "rebalance".to_string(),
                    CanonicalValue::Object(vec![
                        ("policyRoot".to_string(), zero_root.clone()),
                        ("submittedAtByTokenRoot".to_string(), zero_root),
                    ]),
                )]),
            ),
        ],
        Vec::new(),
    )
    .expect("canonical authority genesis envelope");
    crate::canonical::encode_envelope(&envelope)
}

/// `BootstrapAccounts` carrying accounts an authoritative session owns.
pub fn load_accounts(id: u64, revision: u64, accounts: Vec<AbiValue>) -> Envelope {
    request(
        id,
        OpTag::BootstrapAccounts,
        vec![
            AbiValue::Text(crate::PROCESS_PROFILE.into()),
            AbiValue::Integer(i128::from(revision)),
            tuple(accounts),
        ],
    )
}

/// One runtime frame for one owner Entity: what it queued, what arrived for
/// it, and whether it proposes. The wire carries a group per Entity, each with
/// its own clocks and its own ordered operations.
pub fn prepare_wave(
    id: u64,
    owner_entity_id: [u8; 32],
    timestamp: u64,
    admissions: Vec<AbiValue>,
    inputs: Vec<AbiValue>,
    propose: bool,
) -> Envelope {
    let ops = staged_wave_ops(admissions, inputs);
    prepare_wave_ops(id, owner_entity_id, timestamp, ops, propose)
}

pub fn staged_wave_ops(admissions: Vec<AbiValue>, inputs: Vec<AbiValue>) -> Vec<AbiValue> {
    let mut ops = Vec::new();
    for (operation_index, admission) in (0_u64..).zip(admissions) {
        let AbiValue::Tuple(fields) = admission else {
            panic!("an admission is [accountId, txs]")
        };
        let fields = fields.fields().to_vec();
        ops.push(tuple(vec![
            AbiValue::Integer(0),
            AbiValue::Integer(i128::from(operation_index)),
            fields[0].clone(),
            fields[1].clone(),
        ]));
    }
    let first_input_index = u64::try_from(ops.len()).expect("test wave operation count fits u64");
    for (operation_index, input) in (first_input_index..).zip(inputs) {
        let AbiValue::Tuple(fields) = input else {
            panic!("an input is [operationIndex, accountId, peerEnvelope]")
        };
        let mut fields = fields.fields().to_vec();
        fields[0] = AbiValue::Integer(i128::from(operation_index));
        ops.push(tuple(vec![AbiValue::Integer(1), tuple(fields)]));
    }
    ops
}

pub fn prepare_empty_wave(id: u64) -> Envelope {
    request(id, OpTag::PrepareAccountWave, vec![tuple(Vec::new())])
}

pub fn prepare_wave_ops(
    id: u64,
    owner_entity_id: [u8; 32],
    timestamp: u64,
    ops: Vec<AbiValue>,
    propose: bool,
) -> Envelope {
    request(
        id,
        OpTag::PrepareAccountWave,
        vec![tuple(vec![tuple(vec![
            AbiValue::Bytes(owner_entity_id.to_vec()),
            AbiValue::Integer(i128::from(timestamp)),
            AbiValue::Integer(100),
            AbiValue::Integer(i128::from(timestamp)),
            AbiValue::Integer(100),
            AbiValue::Bool(propose),
            tuple(ops),
        ])])],
    )
}

pub fn wave_create(operation_index: u64, seed: AbiValue) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(2),
        AbiValue::Integer(i128::from(operation_index)),
        seed,
    ])
}

pub fn wave_add_delta(operation_index: u64, account_id: [u8; 32], token_id: u32) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(0),
        AbiValue::Integer(i128::from(operation_index)),
        AbiValue::Bytes(account_id.to_vec()),
        tuple(vec![tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Integer(i128::from(token_id)),
        ])]),
    ])
}

pub fn apply_wave(
    id: u64,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    owner_entity_id: [u8; 32],
    ops: Vec<AbiValue>,
) -> Envelope {
    request(
        id,
        OpTag::ApplyAccountWave,
        vec![
            AbiValue::Bytes(candidate_token.to_vec()),
            AbiValue::Bytes(stage_key.to_vec()),
            tuple(vec![tuple(vec![
                AbiValue::Bytes(owner_entity_id.to_vec()),
                tuple(ops),
            ])]),
        ],
    )
}

pub fn propose_wave(
    id: u64,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    owner_entity_id: [u8; 32],
    account_ids: Vec<[u8; 32]>,
) -> Envelope {
    request(
        id,
        OpTag::ProposeAccountWave,
        vec![
            AbiValue::Bytes(candidate_token.to_vec()),
            AbiValue::Bytes(stage_key.to_vec()),
            tuple(vec![tuple(vec![
                AbiValue::Bytes(owner_entity_id.to_vec()),
                tuple(
                    account_ids
                        .into_iter()
                        .map(|account_id| AbiValue::Bytes(account_id.to_vec()))
                        .collect(),
                ),
            ])]),
        ],
    )
}

pub fn begin_entity(
    id: u64,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    expected_accepted_ordinal: u64,
    owner_entity_id: [u8; 32],
    timestamp: u64,
    propose: bool,
) -> Envelope {
    request(
        id,
        OpTag::BeginEntity,
        vec![
            AbiValue::Bytes(candidate_token.to_vec()),
            AbiValue::Bytes(stage_key.to_vec()),
            AbiValue::Integer(i128::from(expected_accepted_ordinal)),
            tuple(vec![
                AbiValue::Bytes(owner_entity_id.to_vec()),
                AbiValue::Integer(i128::from(timestamp)),
                AbiValue::Integer(100),
                AbiValue::Integer(i128::from(timestamp)),
                AbiValue::Integer(100),
                AbiValue::Bool(propose),
            ]),
        ],
    )
}

pub fn finalize_entity(
    id: u64,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    expected_accepted_ordinal: u64,
) -> Envelope {
    entity_stage_terminal(
        id,
        OpTag::FinalizeEntity,
        candidate_token,
        stage_key,
        expected_accepted_ordinal,
    )
}

pub fn discard_entity(
    id: u64,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    expected_accepted_ordinal: u64,
) -> Envelope {
    entity_stage_terminal(
        id,
        OpTag::DiscardEntity,
        candidate_token,
        stage_key,
        expected_accepted_ordinal,
    )
}

fn entity_stage_terminal(
    id: u64,
    op_tag: OpTag,
    candidate_token: [u8; 32],
    stage_key: [u8; 32],
    expected_accepted_ordinal: u64,
) -> Envelope {
    request(
        id,
        op_tag,
        vec![
            AbiValue::Bytes(candidate_token.to_vec()),
            AbiValue::Bytes(stage_key.to_vec()),
            AbiValue::Integer(i128::from(expected_accepted_ordinal)),
        ],
    )
}

pub fn seal_wave(id: u64, candidate_token: [u8; 32]) -> Envelope {
    request(
        id,
        OpTag::SealAccountWave,
        vec![AbiValue::Bytes(candidate_token.to_vec())],
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

pub fn wave_swap_offer(account_id: [u8; 32]) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(account_id.to_vec()),
        tuple(vec![tuple(vec![
            AbiValue::Integer(6),
            AbiValue::Text("checkpoint-offer".to_string()),
            AbiValue::Integer(1),
            AbiValue::Integer(6),
            AbiValue::Text("100000".to_string()),
            AbiValue::Integer(2),
            AbiValue::Integer(6),
            AbiValue::Text("200000".to_string()),
            AbiValue::Text("0".to_string()),
            AbiValue::Text("190000".to_string()),
            AbiValue::Nil,
            AbiValue::Nil,
        ])]),
    ])
}

pub fn wave_ack(
    operation_index: u64,
    account_id: [u8; 32],
    from: [u8; 32],
    to: [u8; 32],
    height: u64,
    frame_hash: [u8; 32],
    frame_hanko: Vec<u8>,
) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(i128::from(operation_index)),
        AbiValue::Bytes(account_id.to_vec()),
        tuple(vec![
            AbiValue::Bytes(from.to_vec()),
            AbiValue::Bytes(to.to_vec()),
            tuple(vec![
                AbiValue::Integer(31_337),
                AbiValue::Bytes(vec![0x88; 20]),
            ]),
            tuple(vec![AbiValue::Integer(10), AbiValue::Integer(20)]),
            AbiValue::Bytes(vec![0x99; 32]),
            tuple(vec![
                AbiValue::Integer(1),
                tuple(vec![
                    AbiValue::Integer(i128::from(height)),
                    AbiValue::Bytes(frame_hash.to_vec()),
                    AbiValue::Bytes(frame_hanko),
                    AbiValue::Nil,
                ]),
            ]),
        ]),
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
