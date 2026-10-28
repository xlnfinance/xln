use super::HashLadderRegistration;
use ethabi::{Token, ethereum_types::U256};
use sha3::{Digest, Keccak256};

fn registration_token(value: &HashLadderRegistration) -> Token {
    Token::Tuple(vec![
        Token::FixedBytes(value.counterparty_entity.to_vec()),
        Token::Bool(value.target_role),
        Token::FixedBytes(value.full_hash.to_vec()),
        Token::FixedBytes(value.partial_root.to_vec()),
        Token::Tuple(vec![
            Token::Uint(U256::from(value.witness.fill_ratio)),
            Token::FixedBytes(value.witness.full_secret.to_vec()),
            Token::FixedArray(
                value
                    .witness
                    .reveals
                    .iter()
                    .map(|v| Token::FixedBytes(v.to_vec()))
                    .collect(),
            ),
        ]),
    ])
}

pub fn hash_target_reveal(
    chain_id: u64,
    depository: [u8; 20],
    beneficiary: [u8; 32],
    value: &HashLadderRegistration,
) -> [u8; 32] {
    Keccak256::digest(ethabi::encode(&[
        Token::FixedBytes(Keccak256::digest(b"XLN_TARGET_HASH_LADDER_REVEAL").to_vec()),
        Token::Uint(U256::from(chain_id)),
        Token::Address(depository.into()),
        Token::FixedBytes(beneficiary.to_vec()),
        registration_token(value),
    ]))
    .into()
}

pub fn target_reveal_calldata(
    beneficiary: [u8; 32],
    value: &HashLadderRegistration,
    hanko: &[u8],
) -> Vec<u8> {
    let mut bytes = Keccak256::digest(b"registerTargetHashLadderReveal(bytes32,(bytes32,bool,bytes32,bytes32,(uint16,bytes32,bytes32[4])),bytes)")[..4].to_vec();
    bytes.extend(ethabi::encode(&[
        Token::FixedBytes(beneficiary.to_vec()),
        registration_token(value),
        Token::Bytes(hanko.to_vec()),
    ]));
    bytes
}
