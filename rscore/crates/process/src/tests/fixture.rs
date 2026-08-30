use xln_rscore_abi::{
    AbiValue, BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
};

fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

pub fn request(id: u64, op_tag: OpTag, payload: Vec<AbiValue>) -> Envelope {
    Envelope {
        binding: ProtocolBinding {
            protocol_version: crate::PAYMENT_PROFILE_BINDING.protocol_version,
            storage_schema_version: crate::PAYMENT_PROFILE_BINDING.storage_schema_version,
            protocol_fingerprint: crate::PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        },
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

pub fn hello(id: u64) -> Envelope {
    hello_with_authority(id, AbiValue::Nil)
}

pub fn hello_authority(id: u64, seed: &str, signer_id: &str) -> Envelope {
    let private_key =
        xln_rscore_engine::derive_signer_key(seed, signer_id).expect("fixture signer key");
    hello_with_authority(
        id,
        tuple(vec![
            AbiValue::Bytes(private_key.to_vec()),
            AbiValue::Text(signer_id.to_string()),
        ]),
    )
}

fn hello_with_authority(id: u64, authority: AbiValue) -> Envelope {
    request(
        id,
        OpTag::Hello,
        vec![
            AbiValue::Integer(i128::from(crate::PROCESS_ABI_VERSION)),
            AbiValue::Integer(8),
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

pub fn load_accounts(id: u64, revision: u64) -> Envelope {
    request(
        id,
        OpTag::BootstrapAccounts,
        vec![
            AbiValue::Text(crate::PROCESS_PROFILE.to_string()),
            AbiValue::Integer(i128::from(revision)),
            tuple(Vec::new()),
            AbiValue::Bool(false),
        ],
    )
}

pub fn shutdown(id: u64) -> Envelope {
    request(id, OpTag::Shutdown, Vec::new())
}
