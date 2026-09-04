use ethabi::ethereum_types::U256;
use num_bigint::BigInt;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use xln_rscore_crypto::address_of_private_key;
use xln_rscore_entity_kernel::j_batch::JBatchFeeOverrides;
use xln_rscore_entity_kernel::{
    EntityProviderActionIntent, EntityProviderActionPayload, hash_entity_provider_action,
};
use xln_rscore_hanko::{
    claims::BoardAuthorityValidator, compact_hanko_for_chain, verify_canonical_hanko,
};

use crate::j_watcher::JsonRpc;

use super::transaction::Eip1559Transaction;
use super::{Address, JSubmitError, SealedJBatch, Word, encode_j_batch};

const DOMAIN_TEXT: &[u8] = b"XLN_DEPOSITORY_HANKO_V1";
const PROCESS_BATCH_SIGNATURE: &[u8] = b"processBatch(bytes,bytes,uint256)";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JSubmitConfig {
    pub chain_id: u64,
    pub depository_address: Address,
    pub operator_private_key: Word,
    pub max_fee_per_gas: U256,
    pub gas_headroom_bps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessedBatchEvidence {
    pub entity_id: Word,
    pub batch_hash: Word,
    pub entity_nonce: U256,
    pub transaction_hash: Word,
    pub block_number: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JSubmitOutcome {
    Authenticated(ProcessedBatchEvidence),
    Broadcast {
        transaction_hash: Word,
        transaction_nonce: u64,
    },
    MinedAwaitingAuthentication {
        transaction_hash: Word,
        block_number: u64,
    },
    AwaitingAuthenticatedEvidence,
}

pub struct ControlBoardProposal<'a> {
    pub entity_provider: Address,
    pub shareholder_entity_id: &'a Word,
    pub target_entity_id: &'a Word,
    pub new_board_hash: &'a Word,
    pub target_board_epoch: u64,
    pub action_nonce: U256,
    pub proposal_hash: &'a Word,
    pub supporter_hankos: &'a [(&'a Word, &'a [u8])],
    pub signer_key: &'a Word,
    pub board_authority: Option<BoardAuthorityValidator<'a>>,
}

pub struct JSubmitter<'a> {
    rpc: &'a dyn JsonRpc,
    config: JSubmitConfig,
}

fn rpc_error(error: impl ToString) -> JSubmitError {
    JSubmitError::Rpc(error.to_string())
}
fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn quantity(value: &Value, field: &'static str) -> Result<U256, JSubmitError> {
    let text = value.as_str().ok_or(JSubmitError::Transaction(field))?;
    let raw = text
        .strip_prefix("0x")
        .ok_or(JSubmitError::Transaction(field))?;
    if raw.is_empty() {
        return Err(JSubmitError::Transaction(field));
    }
    U256::from_str_radix(raw, 16).map_err(|_| JSubmitError::Transaction(field))
}

fn u64_quantity(value: &Value, field: &'static str) -> Result<u64, JSubmitError> {
    let value = quantity(value, field)?;
    if value > U256::from(u64::MAX) {
        return Err(JSubmitError::Transaction(field));
    }
    Ok(value.low_u64())
}

fn word(value: &Value, field: &'static str) -> Result<Word, JSubmitError> {
    let text = value.as_str().ok_or(JSubmitError::Transaction(field))?;
    let decoded = hex::decode(
        text.strip_prefix("0x")
            .ok_or(JSubmitError::Transaction(field))?,
    )
    .map_err(|_| JSubmitError::Transaction(field))?;
    decoded
        .try_into()
        .map_err(|_| JSubmitError::Transaction(field))
}

pub fn depository_batch_hash(
    chain_id: u64,
    address: &Address,
    encoded: &[u8],
    nonce: U256,
) -> Word {
    let domain: Word = Keccak256::digest(DOMAIN_TEXT).into();
    let mut nonce_word = [0_u8; 32];
    nonce.to_big_endian(&mut nonce_word);
    let mut chain_word = [0_u8; 32];
    U256::from(chain_id).to_big_endian(&mut chain_word);
    let mut hasher = Keccak256::new();
    hasher.update(domain);
    hasher.update(chain_word);
    hasher.update(address);
    hasher.update(encoded);
    hasher.update(nonce_word);
    hasher.finalize().into()
}

pub fn process_batch_calldata(encoded: &[u8], hanko: &[u8], nonce: U256) -> Vec<u8> {
    let mut calldata = Vec::new();
    calldata.extend_from_slice(&Keccak256::digest(PROCESS_BATCH_SIGNATURE)[..4]);
    calldata.extend_from_slice(&ethabi::encode(&[
        ethabi::Token::Bytes(encoded.to_vec()),
        ethabi::Token::Bytes(hanko.to_vec()),
        ethabi::Token::Uint(nonce),
    ]));
    calldata
}

impl<'a> JSubmitter<'a> {
    pub fn new(rpc: &'a dyn JsonRpc, config: JSubmitConfig) -> Result<Self, JSubmitError> {
        if config.chain_id == 0
            || config.gas_headroom_bps < 10_000
            || config.max_fee_per_gas.is_zero()
        {
            return Err(JSubmitError::Transaction("config"));
        }
        address_of_private_key(&config.operator_private_key)
            .ok_or(JSubmitError::Transaction("operator-key"))?;
        Ok(Self { rpc, config })
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, JSubmitError> {
        self.rpc.call(method, params).map_err(rpc_error)
    }

    fn entity_nonce(&self, entity_id: &Word) -> Result<U256, JSubmitError> {
        let selector = Keccak256::digest(b"entityNonces(bytes32)");
        let mut data = Vec::with_capacity(36);
        data.extend_from_slice(&selector[..4]);
        data.extend_from_slice(entity_id);
        quantity(
            &self.call(
                "eth_call",
                json!([{
            "to": hex(&self.config.depository_address), "data": hex(&data)
        }, "latest"]),
            )?,
            "entity-nonce",
        )
    }

    fn transaction_nonce(&self, operator: &Address) -> Result<u64, JSubmitError> {
        let address = hex(operator);
        let latest = u64_quantity(
            &self.call("eth_getTransactionCount", json!([address, "latest"]))?,
            "tx-nonce",
        )?;
        let pending = u64_quantity(
            &self.call("eth_getTransactionCount", json!([hex(operator), "pending"]))?,
            "tx-nonce",
        )?;
        Ok(latest.max(pending))
    }

    fn fees(&self, overrides: Option<&JBatchFeeOverrides>) -> Result<(U256, U256), JSubmitError> {
        let block = self.call("eth_getBlockByNumber", json!(["latest", false]))?;
        let base = quantity(
            block
                .get("baseFeePerGas")
                .ok_or(JSubmitError::Transaction("base-fee"))?,
            "base-fee",
        )?;
        let mut priority = quantity(
            &self.call("eth_maxPriorityFeePerGas", json!([]))?,
            "priority-fee",
        )?
        .min(self.config.max_fee_per_gas);
        let mut max = base
            .checked_mul(U256::from(2_u8))
            .and_then(|v| v.checked_add(priority))
            .ok_or(JSubmitError::Transaction("fee-overflow"))?
            .min(self.config.max_fee_per_gas);
        if let Some(overrides) = overrides {
            if let Some(value) = overrides.max_fee_per_gas_wei.as_deref() {
                max = U256::from_dec_str(value)
                    .map_err(|_| JSubmitError::Transaction("max-fee-override"))?;
            }
            if let Some(value) = overrides.max_priority_fee_per_gas_wei.as_deref() {
                priority = U256::from_dec_str(value)
                    .map_err(|_| JSubmitError::Transaction("priority-fee-override"))?;
            }
            if let Some(bump) = overrides.gas_bump_bps.filter(|value| *value > 0) {
                let factor = U256::from(
                    10_000_u32
                        .checked_add(bump)
                        .ok_or(JSubmitError::Transaction("fee-bump-overflow"))?,
                );
                let rounded = U256::from(9_999_u32);
                max = max
                    .checked_mul(factor)
                    .and_then(|value| value.checked_add(rounded))
                    .map(|value| value / U256::from(10_000_u32))
                    .ok_or(JSubmitError::Transaction("max-fee-bump-overflow"))?;
                priority = priority
                    .checked_mul(factor)
                    .and_then(|value| value.checked_add(rounded))
                    .map(|value| value / U256::from(10_000_u32))
                    .ok_or(JSubmitError::Transaction("priority-fee-bump-overflow"))?;
            }
        }
        if priority > max {
            return Err(JSubmitError::Transaction("priority-above-max"));
        }
        Ok((priority, max))
    }

    fn gas_limit_to(
        &self,
        operator: &Address,
        to: &Address,
        calldata: &[u8],
    ) -> Result<U256, JSubmitError> {
        let request = json!({
            "from": hex(operator), "to": hex(to), "data": hex(calldata), "value": "0x0"
        });
        self.call("eth_call", json!([request.clone(), "latest"]))?;
        let estimated = quantity(
            &self.call("eth_estimateGas", json!([request]))?,
            "gas-limit",
        )?;
        estimated
            .checked_mul(U256::from(self.config.gas_headroom_bps))
            .and_then(|v| v.checked_add(U256::from(9_999_u32)))
            .map(|v| v / U256::from(10_000_u32))
            .ok_or(JSubmitError::Transaction("gas-overflow"))
    }

    fn submit_calldata(
        &self,
        to: Address,
        calldata: Vec<u8>,
        signer_key: &Word,
        fee_overrides: Option<&JBatchFeeOverrides>,
    ) -> Result<JSubmitOutcome, JSubmitError> {
        let operator =
            address_of_private_key(signer_key).ok_or(JSubmitError::Transaction("operator-key"))?;
        if quantity(
            &self.call("eth_getBalance", json!([hex(&operator), "latest"]))?,
            "operator-balance",
        )?
        .is_zero()
        {
            return Err(JSubmitError::Transaction("operator-unfunded"));
        }
        let gas_limit = self.gas_limit_to(&operator, &to, &calldata)?;
        let (max_priority_fee_per_gas, max_fee_per_gas) = self.fees(fee_overrides)?;
        let transaction = Eip1559Transaction {
            chain_id: self.config.chain_id,
            nonce: self.transaction_nonce(&operator)?,
            max_priority_fee_per_gas,
            max_fee_per_gas,
            gas_limit,
            to,
            value: U256::zero(),
            data: calldata,
        }
        .sign(signer_key)?;
        let returned = word(
            &self.call("eth_sendRawTransaction", json!([hex(&transaction.raw)]))?,
            "transaction-hash",
        )?;
        if returned != transaction.hash {
            return Err(JSubmitError::Transaction("transaction-hash-mismatch"));
        }
        let broadcast = JSubmitOutcome::Broadcast {
            transaction_hash: transaction.hash,
            transaction_nonce: transaction.nonce,
        };
        Ok(self
            .receipt_status(&transaction.hash, &[])?
            .unwrap_or(broadcast))
    }

    /// Exact TS `mint` maintenance operation. Depository exposes this only on
    /// the two canonical local-dev chains; production reserve funding remains
    /// a normal token/deposit flow and cannot enter through this method.
    pub fn submit_mint_reserves(
        &self,
        entity_id: &Word,
        token_id: u64,
        amount: &BigInt,
    ) -> Result<JSubmitOutcome, JSubmitError> {
        if !matches!(self.config.chain_id, 31_337 | 31_338) {
            return Err(JSubmitError::Transaction("mint-non-dev-chain"));
        }
        let (_, magnitude) = amount.to_bytes_be();
        if amount.sign() != num_bigint::Sign::Plus || magnitude.len() > 32 {
            return Err(JSubmitError::Transaction("mint-amount"));
        }
        let value = U256::from_big_endian(&magnitude);
        if value.is_zero() {
            return Err(JSubmitError::Transaction("mint-amount"));
        }
        let mut calldata = Vec::new();
        calldata
            .extend_from_slice(&Keccak256::digest(b"mintToReserve(bytes32,uint256,uint256)")[..4]);
        calldata.extend_from_slice(&ethabi::encode(&[
            ethabi::Token::FixedBytes(entity_id.to_vec()),
            ethabi::Token::Uint(U256::from(token_id)),
            ethabi::Token::Uint(value),
        ]));
        self.submit_calldata(
            self.config.depository_address,
            calldata,
            &self.config.operator_private_key,
            None,
        )
    }

    pub fn submit_control_board_proposal(
        &self,
        proposal: ControlBoardProposal<'_>,
    ) -> Result<JSubmitOutcome, JSubmitError> {
        let ControlBoardProposal {
            entity_provider,
            shareholder_entity_id,
            target_entity_id,
            new_board_hash,
            target_board_epoch,
            action_nonce,
            proposal_hash,
            supporter_hankos,
            signer_key,
            board_authority,
        } = proposal;
        let domain: Word = Keccak256::digest(b"XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V1").into();
        let encoded = ethabi::encode(&[
            ethabi::Token::FixedBytes(domain.to_vec()),
            ethabi::Token::Uint(U256::from(self.config.chain_id)),
            ethabi::Token::Address(entity_provider.into()),
            ethabi::Token::FixedBytes(target_entity_id.to_vec()),
            ethabi::Token::Uint(U256::from(target_board_epoch)),
            ethabi::Token::FixedBytes(new_board_hash.to_vec()),
            ethabi::Token::Uint(U256::one()),
            ethabi::Token::Uint(action_nonce),
        ]);
        let computed: Word = Keccak256::digest(&encoded).into();
        if &computed != proposal_hash || supporter_hankos.is_empty() {
            return Err(JSubmitError::Transaction("governance-proposal-hash"));
        }
        for (supporter, hanko) in supporter_hankos {
            verify_canonical_hanko(hanko, proposal_hash, Some(supporter), board_authority)
                .map_err(|reason| JSubmitError::Hanko(reason.to_string()))?;
        }
        let selector = Keccak256::digest(b"boardActionNonces(bytes32)");
        let mut nonce_call = Vec::with_capacity(36);
        nonce_call.extend_from_slice(&selector[..4]);
        nonce_call.extend_from_slice(target_entity_id);
        let chain_nonce = quantity(
            &self.call(
                "eth_call",
                json!([{"to":hex(&entity_provider),"data":hex(&nonce_call)},"latest"]),
            )?,
            "governance-chain-nonce",
        )?;
        if chain_nonce >= action_nonce {
            let proposed = self.entity_provider_board_hashes(&entity_provider, target_entity_id)?;
            if chain_nonce == action_nonce
                && (proposed.0 == *new_board_hash || proposed.1 == *new_board_hash)
            {
                return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
            }
            return Err(JSubmitError::Transaction("governance-nonce-consumed"));
        }
        if chain_nonce.checked_add(U256::one()) != Some(action_nonce) {
            return Err(JSubmitError::Transaction("governance-nonce-gap"));
        }
        let mut calldata = Vec::new();
        calldata.extend_from_slice(
            &Keccak256::digest(b"proposeBoard(bytes32,bytes32,uint8,bytes[])")[..4],
        );
        calldata.extend_from_slice(&ethabi::encode(&[
            ethabi::Token::FixedBytes(target_entity_id.to_vec()),
            ethabi::Token::FixedBytes(new_board_hash.to_vec()),
            ethabi::Token::Uint(U256::one()),
            ethabi::Token::Array(
                supporter_hankos
                    .iter()
                    .map(|(_, hanko)| ethabi::Token::Bytes(hanko.to_vec()))
                    .collect(),
            ),
        ]));
        let _ = shareholder_entity_id;
        self.submit_calldata(entity_provider, calldata, signer_key, None)
    }

    pub fn submit_activate_board(
        &self,
        entity_provider: Address,
        target_entity_id: &Word,
        signer_key: &Word,
    ) -> Result<JSubmitOutcome, JSubmitError> {
        let (proposed, _) =
            self.entity_provider_board_hashes(&entity_provider, target_entity_id)?;
        if proposed == [0; 32] {
            return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
        }
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&Keccak256::digest(b"activateBoard(bytes32)")[..4]);
        calldata.extend_from_slice(target_entity_id);
        self.submit_calldata(entity_provider, calldata, signer_key, None)
    }

    fn entity_provider_board_hashes(
        &self,
        entity_provider: &Address,
        entity_id: &Word,
    ) -> Result<(Word, Word), JSubmitError> {
        let selector = Keccak256::digest(b"entities(bytes32)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector[..4]);
        calldata.extend_from_slice(entity_id);
        let raw = self.call(
            "eth_call",
            json!([{"to":hex(entity_provider),"data":hex(&calldata)},"latest"]),
        )?;
        let bytes = hex::decode(
            raw.as_str()
                .and_then(|value| value.strip_prefix("0x"))
                .ok_or(JSubmitError::Transaction("governance-entity"))?,
        )
        .map_err(|_| JSubmitError::Transaction("governance-entity"))?;
        if bytes.len() < 128 {
            return Err(JSubmitError::Transaction("governance-entity"));
        }
        let mut current = [0; 32];
        current.copy_from_slice(&bytes[..32]);
        let mut proposed = [0; 32];
        proposed.copy_from_slice(&bytes[96..128]);
        Ok((proposed, current))
    }

    pub fn submit_entity_provider_action(
        &self,
        intent: &EntityProviderActionIntent,
        hanko: &[u8],
        signer_key: &Word,
        board_authority: Option<BoardAuthorityValidator<'_>>,
    ) -> Result<JSubmitOutcome, JSubmitError> {
        if intent.chain_id != U256::from(self.config.chain_id) {
            return Err(JSubmitError::Transaction("provider-chain-id"));
        }
        let computed = hash_entity_provider_action(intent);
        if computed != intent.action_hash {
            return Err(JSubmitError::Transaction("provider-action-hash"));
        }
        let entity_id: Word = intent
            .entity_id
            .strip_prefix("0x")
            .and_then(|raw| hex::decode(raw).ok())
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(JSubmitError::Transaction("provider-entity-id"))?;
        verify_canonical_hanko(
            hanko,
            &intent.action_hash,
            Some(&entity_id),
            board_authority,
        )
        .map_err(|reason| JSubmitError::Hanko(reason.to_string()))?;
        let selector = Keccak256::digest(b"entityActionNonces(bytes32)");
        let mut nonce_call = Vec::with_capacity(36);
        nonce_call.extend_from_slice(&selector[..4]);
        nonce_call.extend_from_slice(&entity_id);
        let onchain_nonce = quantity(
            &self.call(
                "eth_call",
                json!([{
            "to":hex(&intent.entity_provider_address), "data":hex(&nonce_call)
        }, "latest"]),
            )?,
            "provider-action-nonce",
        )?;
        if onchain_nonce >= intent.action_nonce {
            return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
        }
        if onchain_nonce.checked_add(U256::one()) != Some(intent.action_nonce) {
            return Err(JSubmitError::Transaction("provider-action-nonce-gap"));
        }
        let (signature, tokens) = match &intent.payload {
            EntityProviderActionPayload::Transfer {
                to,
                token_id,
                amount,
            } => (
                b"entityTransferTokens(uint256,address,uint256,uint256,bytes)".as_slice(),
                vec![
                    ethabi::Token::Uint(intent.entity_number),
                    ethabi::Token::Address((*to).into()),
                    ethabi::Token::Uint(*token_id),
                    ethabi::Token::Uint(*amount),
                    ethabi::Token::Bytes(hanko.to_vec()),
                ],
            ),
            EntityProviderActionPayload::ReleaseControlShares {
                recipient,
                control_amount,
                dividend_amount,
                purpose,
            } => (
                b"releaseControlShares(uint256,address,uint256,uint256,string,bytes)".as_slice(),
                vec![
                    ethabi::Token::Uint(intent.entity_number),
                    ethabi::Token::Address((*recipient).into()),
                    ethabi::Token::Uint(*control_amount),
                    ethabi::Token::Uint(*dividend_amount),
                    ethabi::Token::String(purpose.clone()),
                    ethabi::Token::Bytes(hanko.to_vec()),
                ],
            ),
            EntityProviderActionPayload::Cancel {
                cancelled_action_hash,
                cancelled_action_kind,
            } => (
                b"cancelEntityProviderAction(uint256,bytes32,uint8,bytes)".as_slice(),
                vec![
                    ethabi::Token::Uint(intent.entity_number),
                    ethabi::Token::FixedBytes(cancelled_action_hash.to_vec()),
                    ethabi::Token::Uint(U256::from(*cancelled_action_kind)),
                    ethabi::Token::Bytes(hanko.to_vec()),
                ],
            ),
        };
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&Keccak256::digest(signature)[..4]);
        calldata.extend_from_slice(&ethabi::encode(&tokens));
        self.submit_calldata(intent.entity_provider_address, calldata, signer_key, None)
    }

    pub fn submit(
        &self,
        sealed: &SealedJBatch,
        fee_overrides: Option<&JBatchFeeOverrides>,
        external_signer_private_key: Option<&Word>,
        board_authority: Option<BoardAuthorityValidator<'_>>,
        authenticated: &[ProcessedBatchEvidence],
    ) -> Result<JSubmitOutcome, JSubmitError> {
        let encoded = encode_j_batch(&sealed.batch)?;
        let batch_hash = depository_batch_hash(
            self.config.chain_id,
            &self.config.depository_address,
            &encoded,
            sealed.nonce,
        );
        if let Some(evidence) = authenticated.iter().find(|event| {
            event.entity_id == sealed.entity_id
                && event.batch_hash == batch_hash
                && event.entity_nonce == sealed.nonce
        }) {
            return Ok(JSubmitOutcome::Authenticated(evidence.clone()));
        }
        verify_canonical_hanko(
            &sealed.hanko,
            &batch_hash,
            Some(&sealed.entity_id),
            board_authority,
        )
        .map_err(|error| JSubmitError::Hanko(error.to_string()))?;
        // Consensus and durable state retain one full proof envelope. Match
        // TypeScript by applying the optional 65-byte shortcut only at RPC.
        let chain_hanko = compact_hanko_for_chain(&sealed.hanko, &batch_hash)
            .map_err(|error| JSubmitError::Hanko(error.to_string()))?;
        let onchain_nonce = self.entity_nonce(&sealed.entity_id)?;
        if onchain_nonce >= sealed.nonce {
            return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
        }
        if onchain_nonce.checked_add(U256::one()) != Some(sealed.nonce) {
            return Err(JSubmitError::Transaction("entity-nonce-gap"));
        }
        let requires_external_signer = !sealed.batch.external_token_to_reserve.is_empty();
        let submitter_key = if requires_external_signer {
            external_signer_private_key.ok_or(JSubmitError::Transaction("external-signer-key"))?
        } else {
            &self.config.operator_private_key
        };
        let operator = address_of_private_key(submitter_key)
            .ok_or(JSubmitError::Transaction("operator-key"))?;
        if requires_external_signer && operator != sealed.signer_id {
            return Err(JSubmitError::Transaction("external-signer-mismatch"));
        }
        if quantity(
            &self.call("eth_getBalance", json!([hex(&operator), "latest"]))?,
            "operator-balance",
        )?
        .is_zero()
        {
            return Err(JSubmitError::Transaction("operator-unfunded"));
        }
        let calldata = process_batch_calldata(&encoded, &chain_hanko, sealed.nonce);
        let gas_limit = self.gas_limit_to(&operator, &self.config.depository_address, &calldata)?;
        let (max_priority_fee_per_gas, max_fee_per_gas) = self.fees(fee_overrides)?;
        let transaction = Eip1559Transaction {
            chain_id: self.config.chain_id,
            nonce: self.transaction_nonce(&operator)?,
            max_priority_fee_per_gas,
            max_fee_per_gas,
            gas_limit,
            to: self.config.depository_address,
            value: U256::zero(),
            data: calldata,
        }
        .sign(submitter_key)?;
        let returned = word(
            &self.call("eth_sendRawTransaction", json!([hex(&transaction.raw)]))?,
            "transaction-hash",
        )?;
        if returned != transaction.hash {
            return Err(JSubmitError::Transaction("transaction-hash-mismatch"));
        }
        let broadcast = JSubmitOutcome::Broadcast {
            transaction_hash: transaction.hash,
            transaction_nonce: transaction.nonce,
        };
        Ok(self
            .receipt_status(&transaction.hash, authenticated)?
            .unwrap_or(broadcast))
    }

    pub fn receipt_status(
        &self,
        transaction_hash: &Word,
        authenticated: &[ProcessedBatchEvidence],
    ) -> Result<Option<JSubmitOutcome>, JSubmitError> {
        if let Some(evidence) = authenticated
            .iter()
            .find(|event| &event.transaction_hash == transaction_hash)
        {
            return Ok(Some(JSubmitOutcome::Authenticated(evidence.clone())));
        }
        let receipt = self.call("eth_getTransactionReceipt", json!([hex(transaction_hash)]))?;
        if receipt.is_null() {
            return Ok(None);
        }
        let status = quantity(
            receipt
                .get("status")
                .ok_or(JSubmitError::Transaction("receipt-status"))?,
            "receipt-status",
        )?;
        if status.is_zero() {
            return Err(JSubmitError::Transaction("receipt-reverted"));
        }
        let block_number = u64_quantity(
            receipt
                .get("blockNumber")
                .ok_or(JSubmitError::Transaction("receipt-block"))?,
            "receipt-block",
        )?;
        Ok(Some(JSubmitOutcome::MinedAwaitingAuthentication {
            transaction_hash: *transaction_hash,
            block_number,
        }))
    }
}
