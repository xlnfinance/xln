use ethabi::ethereum_types::U256;
use num_bigint::BigInt;
use sha3::{Digest, Keccak256};

use super::submission::{depository_batch_hash, process_batch_calldata};
use super::*;

fn word(byte: u8) -> Word {
    [byte; 32]
}
fn address(byte: u8) -> Address {
    [byte; 20]
}

#[test]
fn empty_batch_matches_typescript_and_roundtrips() {
    let encoded = encode_j_batch(&JBatch::default()).expect("encode");
    assert_eq!(encoded.len(), 800);
    assert_eq!(
        hex::encode(Keccak256::digest(&encoded)),
        "8e9add77c9216e8c8a5b29b7bb72662fe986f8ec672f618b366a2e1c2cef7a32"
    );
    assert_eq!(decode_j_batch(&encoded).expect("decode"), JBatch::default());
}

#[test]
fn operation_sections_match_the_typescript_batch_vector() {
    let mut batch = JBatch::default();
    batch.flashloans.push(Flashloan {
        token_id: 2.into(),
        amount: 3.into(),
    });
    batch.reserve_to_reserve.push(ReserveToReserve {
        receiving_entity: word(0x11),
        token_id: 4.into(),
        amount: 5.into(),
    });
    batch.reserve_to_collateral.push(ReserveToCollateral {
        token_id: 6.into(),
        receiving_entity: word(0x22),
        pairs: vec![EntityAmount {
            entity: word(0x33),
            amount: 7.into(),
        }],
    });
    batch.collateral_to_reserve.push(CollateralToReserve {
        counterparty: word(0x44),
        token_id: 8.into(),
        amount: 9.into(),
        nonce: 10.into(),
        sig: vec![0xaa, 0xbb],
    });
    batch.settlements.push(Settlement {
        left_entity: word(0x55),
        right_entity: word(0x66),
        diffs: vec![SettlementDiff {
            token_id: 11.into(),
            left_diff: BigInt::from(-12),
            right_diff: BigInt::from(13),
            collateral_diff: BigInt::from(-14),
            ondelta_diff: BigInt::from(15),
        }],
        forgive_debts_in_token_ids: vec![16.into()],
        sig: vec![0xcc],
        nonce: 17.into(),
    });
    batch
        .external_token_to_reserve
        .push(ExternalTokenToReserve {
            entity: word(0x77),
            contract_address: address(0x88),
            external_token_id: 18.into(),
            token_type: 1,
            internal_token_id: 19.into(),
            amount: 20.into(),
        });
    batch
        .reserve_to_external_token
        .push(ReserveToExternalToken {
            receiving_entity: word(0x99),
            token_id: 21.into(),
            amount: 22.into(),
        });
    batch.reveal_secrets.push(SecretReveal {
        transformer: address(0xaa),
        secret: word(0xbb),
    });
    batch
        .hash_ladder_registrations
        .push(HashLadderRegistration {
            counterparty_entity: word(0xcc),
            target_role: true,
            full_hash: word(0xdd),
            partial_root: word(0xee),
            witness: HashLadderWitness {
                fill_ratio: 123,
                full_secret: word(0xff),
                reveals: [word(1), word(2), word(3), word(4)],
            },
        });
    let encoded = encode_j_batch(&batch).expect("encode");
    assert_eq!(encoded.len(), 2_656);
    assert_eq!(
        hex::encode(Keccak256::digest(&encoded)),
        "d1bb6c003a0345b076877be7ad56447cc6e7ecafa23ae9885a545cbfbf7fa9ad"
    );
    assert_eq!(decode_j_batch(&encoded).expect("decode"), batch);
}

#[test]
fn domain_calldata_and_eip1559_signing_match_ethers() {
    let encoded = encode_j_batch(&JBatch::default()).expect("encode");
    let depository = address(0x12);
    let batch_hash = depository_batch_hash(31_337, &depository, &encoded, 23.into());
    assert_eq!(
        hex::encode(batch_hash),
        "3768b8bba4b93e67fbda2f7d3ecb94a7e9fa2bcc4cbf61393d530f93068e7d64"
    );
    let calldata = process_batch_calldata(&encoded, &[0xaa, 0xbb], 23.into());
    assert_eq!(calldata.len(), 996);
    assert_eq!(
        hex::encode(Keccak256::digest(&calldata)),
        "b09859498bf8cfb89f2391d3dd003a5b7e0b7e4233addc9316cda90bf6f4d51f"
    );
    assert_eq!(
        decode_process_batch_calldata(&calldata).expect("decode").0,
        encoded
    );
    let signed = Eip1559Transaction {
        chain_id: 31_337,
        nonce: 7,
        max_priority_fee_per_gas: U256::from(1_000_000_000_u64),
        max_fee_per_gas: U256::from(3_000_000_000_u64),
        gas_limit: U256::from(500_000_u64),
        to: depository,
        value: U256::zero(),
        data: calldata,
    }
    .sign(&word(1))
    .expect("sign");
    assert_eq!(
        hex::encode(signed.hash),
        "58e600bb1c9c6cab210366c01830aa1ff50370f1ce3ec532d30efcc3edbc2d79"
    );
}
