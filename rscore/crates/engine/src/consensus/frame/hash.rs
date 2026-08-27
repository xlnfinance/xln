//! The signed account frame: what a proposer commits and what its peer acks.
//!
//! Parity target: `computeCanonicalAccountFrameHash`
//! (core/account/consensus/frame/hash.ts). Three entries under the
//! `account.frame` namespace — the transition header, the canonical
//! transactions, and the account state root — combined by the same flat
//! integrity root the account state itself uses. Financial deltas live only in
//! `AccountState`; the state root commits them without duplicating them in
//! every frame.

use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, JS_MAX_SAFE_INTEGER, compute_flat_integrity_root,
};

use crate::{
    AccountTx, DeliveryMode, HTLC_OPAQUE_CIPHERTEXT_VERSION, HtlcDeliveryMode, HtlcResolveOutcome,
    StateError, TokenId,
};

const ACCOUNT_FRAME_NAMESPACE: &str = "account.frame";
/// The first frame of an account chains to this literal, not to a hash.
pub const GENESIS_PREV_FRAME_HASH: &str = "genesis";

/// FX-1 (proofs/fixes.md D2): the `RebalancePolicy.policyVersion` protocol
/// range is `0..=MAX_POLICY_VERSION` — JavaScript's largest exact integer,
/// `Number.MAX_SAFE_INTEGER`. The bound is normative in `docs/fints.md` and
/// shared with TypeScript (`MAX_POLICY_VERSION` in
/// core/account/tx/admission-policy.ts): above it a TS `number` silently
/// rounds while hashing, and the engines diverge on one frame hash. Admission
/// refuses such a version before the mempool; the hash layer refuses it again
/// as an admission-bug tripwire.
pub const MAX_POLICY_VERSION: u64 = JS_MAX_SAFE_INTEGER;

/// A frame as it is hashed and signed. `state_hash` is the result of hashing
/// the other fields, so it is never part of its own preimage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountFrame {
    pub height: u64,
    pub timestamp: u64,
    pub j_height: u64,
    /// The frame's transactions, in frame order. Their canonical `{type,data}`
    /// form is derived when the frame is hashed, never carried separately.
    pub txs: Vec<crate::AccountTx>,
    pub prev_frame_hash: String,
    pub account_state_root: [u8; 32],
}

fn number(value: u64) -> Result<CanonicalValue, StateError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| StateError::AccountStateRoot(error.to_string()))
}

fn number_u32(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

impl AccountFrame {
    /// The frame's `stateHash`: what the proposer signs and the peer verifies.
    pub fn hash(&self) -> Result<[u8; 32], StateError> {
        let transition = CanonicalValue::Object(vec![
            ("height".into(), number(self.height)?),
            ("timestamp".into(), number(self.timestamp)?),
            ("jHeight".into(), number(self.j_height)?),
            (
                "prevFrameHash".into(),
                CanonicalValue::String(self.prev_frame_hash.clone()),
            ),
        ]);
        let mut transactions = Vec::with_capacity(self.txs.len());
        for tx in &self.txs {
            transactions.push(canonical_tx_value(tx)?);
        }
        let entries = vec![
            ("transition".to_string(), transition),
            (
                "transactions".to_string(),
                CanonicalValue::Array(transactions),
            ),
            (
                "accountStateRoot".to_string(),
                CanonicalValue::String(crate::state::identity::render_hex(
                    &self.account_state_root,
                )),
            ),
        ];
        compute_flat_integrity_root(ACCOUNT_FRAME_NAMESPACE, &entries)
            .map_err(|error| StateError::AccountStateRoot(error.to_string()))
    }
}

/// Canonical `{type, data}` of one transaction, the form the frame hash
/// commits.
///
/// Parity target: `canonicalAccountTxForFrameHash` in the same TypeScript
/// file, which hashes `tx.data` as the runtime built it. Optional fields are
/// omitted, never encoded as null: TypeScript drops `undefined` object entries
/// before hashing. A transaction the engine does not model natively is an
/// error, never a silently different hash.
pub fn canonical_tx_value(tx: &AccountTx) -> Result<CanonicalValue, StateError> {
    let (kind, data) = match tx {
        AccountTx::JEventClaim(tx) => {
            let events_hash = crate::canonical_events_hash(&tx.events)?;
            let mut fields = vec![
                (
                    "version".to_string(),
                    text("xln:account-j-event-claim-frame:v1"),
                ),
                ("jHeight".to_string(), number(tx.j_height)?),
                (
                    "jBlockHash".to_string(),
                    text(&crate::state::identity::render_hex(&tx.j_block_hash)),
                ),
                (
                    "eventsHash".to_string(),
                    text(&crate::state::identity::render_hex(&events_hash)),
                ),
                (
                    "events".to_string(),
                    CanonicalValue::Array(
                        tx.events
                            .iter()
                            .map(crate::j_claims::canonical_event_value)
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ),
            ];
            push_optional(
                &mut fields,
                "leftProof",
                tx.left_proof
                    .as_ref()
                    .map(crate::j_claims::canonical_proof_value)
                    .transpose()?,
            );
            push_optional(
                &mut fields,
                "rightProof",
                tx.right_proof
                    .as_ref()
                    .map(crate::j_claims::canonical_proof_value)
                    .transpose()?,
            );
            ("j_event_claim", fields)
        }
        AccountTx::DirectPayment {
            token_id,
            amount,
            route,
            description,
            from_entity_id,
            to_entity_id,
            delivery_mode,
            trusted_gateway_entity_id,
        } => {
            let mut fields = vec![
                ("tokenId".to_string(), token(*token_id)),
                ("amount".to_string(), big(amount)),
                (
                    "route".to_string(),
                    CanonicalValue::Array(route.iter().map(|hop| text(hop)).collect()),
                ),
            ];
            push_optional(&mut fields, "description", description.as_deref().map(text));
            fields.push(("fromEntityId".to_string(), text(from_entity_id)));
            fields.push(("toEntityId".to_string(), text(to_entity_id)));
            fields.push((
                "deliveryMode".to_string(),
                text(match delivery_mode {
                    DeliveryMode::Direct => "direct",
                    DeliveryMode::Trusted => "trusted",
                }),
            ));
            push_optional(
                &mut fields,
                "trustedGatewayEntityId",
                trusted_gateway_entity_id.as_deref().map(text),
            );
            ("direct_payment", fields)
        }
        AccountTx::HtlcLock(lock) => {
            let mut fields = vec![
                ("lockId".to_string(), text(&lock.lock_id)),
                ("hashlock".to_string(), text(lock.hashlock.as_str())),
                ("timelock".to_string(), big(&lock.timelock)),
                (
                    "revealBeforeHeight".to_string(),
                    number(lock.reveal_before_height)?,
                ),
                ("amount".to_string(), big(&lock.amount)),
                ("tokenId".to_string(), token(lock.token_id)),
            ];
            push_optional(
                &mut fields,
                "deliveryMode",
                lock.delivery_mode.map(|mode| {
                    text(match mode {
                        HtlcDeliveryMode::Instant => "instant",
                        HtlcDeliveryMode::Async => "async",
                    })
                }),
            );
            push_optional(
                &mut fields,
                "envelope",
                lock.envelope.as_ref().map(|envelope| {
                    CanonicalValue::Object(vec![
                        ("version".to_string(), text(HTLC_OPAQUE_CIPHERTEXT_VERSION)),
                        ("ciphertext".to_string(), text(envelope.ciphertext())),
                    ])
                }),
            );
            ("htlc_lock", fields)
        }
        AccountTx::HtlcResolve(resolve) => {
            let mut fields = vec![("lockId".to_string(), text(&resolve.lock_id))];
            match &resolve.outcome {
                HtlcResolveOutcome::Secret { secret } => {
                    fields.push(("outcome".to_string(), text("secret")));
                    fields.push(("secret".to_string(), text(secret)));
                }
                HtlcResolveOutcome::Error { reason } => {
                    fields.push(("outcome".to_string(), text("error")));
                    push_optional(&mut fields, "reason", reason.as_deref().map(text));
                }
            }
            ("htlc_resolve", fields)
        }
        AccountTx::SetCreditLimit { token_id, amount } => (
            "set_credit_limit",
            vec![
                ("tokenId".to_string(), token(*token_id)),
                ("amount".to_string(), big(amount)),
            ],
        ),
        AccountTx::AddDelta { token_id } => {
            ("add_delta", vec![("tokenId".to_string(), token(*token_id))])
        }
        AccountTx::RebalancePolicy {
            token_id,
            policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
        } => {
            // FX-1: admission already refuses an out-of-range version, so
            // reaching here with one is an admission bug. Refuse to hash it
            // with the same typed error instead of the generic unsafe-integer
            // wrapping, so both directions name the exact violation.
            if *policy_version > MAX_POLICY_VERSION {
                return Err(StateError::PolicyVersionOutOfRange {
                    version: *policy_version,
                    maximum: MAX_POLICY_VERSION,
                });
            }
            (
                "rebalance_policy",
                vec![
                    ("tokenId".to_string(), number_u32(*token_id)),
                    ("policyVersion".to_string(), number(*policy_version)?),
                    ("baseFee".to_string(), big(base_fee)),
                    ("liquidityFeeBps".to_string(), big(liquidity_fee_bps)),
                    ("gasFee".to_string(), big(gas_fee)),
                ],
            )
        }
        AccountTx::SwapOffer {
            offer_id,
            give_token_id,
            give_token_decimals,
            give_amount,
            want_token_id,
            want_token_decimals,
            want_amount,
            max_fee,
            min_net_receive,
            time_in_force,
            price_ticks,
        } => {
            let mut fields = vec![
                ("offerId".to_string(), text(offer_id)),
                ("giveTokenId".to_string(), number_u32(*give_token_id)),
                (
                    "giveTokenDecimals".to_string(),
                    number_u32(*give_token_decimals),
                ),
                ("giveAmount".to_string(), big(give_amount)),
                ("wantTokenId".to_string(), number_u32(*want_token_id)),
                (
                    "wantTokenDecimals".to_string(),
                    number_u32(*want_token_decimals),
                ),
                ("wantAmount".to_string(), big(want_amount)),
                ("maxFee".to_string(), big(max_fee)),
                ("minNetReceive".to_string(), big(min_net_receive)),
            ];
            push_optional(
                &mut fields,
                "timeInForce",
                time_in_force.map(|value| number_u32(u32::from(value))),
            );
            push_optional(&mut fields, "priceTicks", price_ticks.as_ref().map(big));
            ("swap_offer", fields)
        }
        AccountTx::SwapResolve {
            offer_id,
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            comment,
            fee_token_id,
            fee_amount,
            execution_give_amount,
            execution_want_amount,
            resting_give_token_id,
            resting_want_token_id,
            resting_price_ticks,
            resting_give_amount,
            resting_want_amount,
            resting_quantized_give,
            resting_quantized_want,
        } => {
            let mut fields = vec![
                ("offerId".to_string(), text(offer_id)),
                ("fillRatio".to_string(), number_u32(*fill_ratio)),
            ];
            push_optional(
                &mut fields,
                "fillNumerator",
                fill_numerator.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "fillDenominator",
                fill_denominator.as_ref().map(big),
            );
            // TypeScript declares this field required and hashes whatever it
            // holds, including `false`. Omitting the false case produced a
            // frame hash TypeScript could not reproduce for every partial fill
            // that keeps an offer open — which is most of them.
            fields.push((
                "cancelRemainder".to_string(),
                CanonicalValue::Bool(*cancel_remainder),
            ));
            push_optional(
                &mut fields,
                "comment",
                comment.as_ref().map(|value| text(value)),
            );
            push_optional(
                &mut fields,
                "restingGiveTokenId",
                resting_give_token_id.map(number_u32),
            );
            push_optional(
                &mut fields,
                "restingWantTokenId",
                resting_want_token_id.map(number_u32),
            );
            push_optional(&mut fields, "feeTokenId", fee_token_id.map(number_u32));
            push_optional(&mut fields, "feeAmount", fee_amount.as_ref().map(big));
            push_optional(
                &mut fields,
                "executionGiveAmount",
                execution_give_amount.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "executionWantAmount",
                execution_want_amount.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "restingPriceTicks",
                resting_price_ticks.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "restingGiveAmount",
                resting_give_amount.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "restingWantAmount",
                resting_want_amount.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "restingQuantizedGive",
                resting_quantized_give.as_ref().map(big),
            );
            push_optional(
                &mut fields,
                "restingQuantizedWant",
                resting_quantized_want.as_ref().map(big),
            );
            ("swap_resolve", fields)
        }
        AccountTx::SwapCancelRequest { offer_id } => (
            "swap_cancel_request",
            vec![("offerId".to_string(), text(offer_id))],
        ),
        other => {
            return Err(StateError::UnsupportedFrameTx(unsupported_kind(other)));
        }
    };
    Ok(CanonicalValue::Object(vec![
        ("type".to_string(), text(kind)),
        ("data".to_string(), CanonicalValue::Object(data)),
    ]))
}

fn text(value: &str) -> CanonicalValue {
    CanonicalValue::String(value.to_string())
}

fn big(value: &num_bigint::BigInt) -> CanonicalValue {
    CanonicalValue::BigInt(value.clone())
}

fn token(value: TokenId) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u16(value.get()))
}

fn push_optional(
    fields: &mut Vec<(String, CanonicalValue)>,
    key: &str,
    value: Option<CanonicalValue>,
) {
    if let Some(value) = value {
        fields.push((key.to_string(), value));
    }
}

/// The transaction kinds the engine leaves to TypeScript, named the way the
/// wire names them so a rejection points at the right handler.
/// The digest of one transaction's canonical form — what the frame hash
/// commits for it, on its own. A caller comparing two engines names a
/// transaction by this rather than by its position in a queue.
pub fn canonical_tx_digest(tx: &AccountTx) -> Result<[u8; 32], StateError> {
    use sha2::{Digest, Sha256};
    let encoded = xln_rscore_protocol::encode_account_state_value(&canonical_tx_value(tx)?)
        .map_err(|error| StateError::AccountStateRoot(error.to_string()))?;
    Ok(Sha256::digest(&encoded).into())
}

/// Whether this transaction can be hashed into a frame at all.
///
/// A queued transaction the frame hash cannot express would wedge the account
/// permanently: every proposal and every leaf digest would fail on it, and
/// nothing removes it. Admission refuses it instead.
pub fn is_frame_hashable(tx: &AccountTx) -> bool {
    !matches!(
        tx,
        AccountTx::LendingFund { .. }
            | AccountTx::LendingBorrowRequest { .. }
            | AccountTx::LendingRepay { .. }
            | AccountTx::LendingCredit { .. }
            | AccountTx::LendingCloseRequest { .. }
            | AccountTx::LendingClosePayout { .. }
            | AccountTx::ReserveToCollateral { .. }
    )
}

pub fn unsupported_kind(tx: &AccountTx) -> &'static str {
    match tx {
        AccountTx::LendingFund { .. } => "lending_fund",
        AccountTx::LendingBorrowRequest { .. } => "lending_borrow_request",
        AccountTx::LendingRepay { .. } => "lending_repay",
        AccountTx::LendingCredit { .. } => "lending_credit",
        AccountTx::LendingCloseRequest { .. } => "lending_close_request",
        AccountTx::LendingClosePayout { .. } => "lending_close_payout",
        AccountTx::ReserveToCollateral { .. } => "reserve_to_collateral",
        _ => "unknown",
    }
}

/// Big-endian helper for callers that hold a hex account state root.
pub fn parse_root_hex(value: &str) -> Option<[u8; 32]> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.len() != 64 {
        return None;
    }
    let mut out = [0_u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;

    use super::*;
    use crate::{
        AccountTx, DeliveryMode, HtlcDeliveryMode, HtlcResolveOutcome, OpaqueHtlcCiphertext,
        TokenId,
    };

    /// Vector produced by `computeFrameHash`
    /// (core/account/consensus/frame/hash.ts) over the same frame.
    #[test]
    fn matches_typescript_frame_hash_vector() {
        let token = TokenId::new(1).expect("token");
        let tx = AccountTx::DirectPayment {
            token_id: token,
            amount: BigInt::from(5),
            route: vec![format!("0x{}", "aa".repeat(32))],
            description: Some("frame-vector".into()),
            from_entity_id: format!("0x{}", "bb".repeat(32)),
            to_entity_id: format!("0x{}", "aa".repeat(32)),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        };
        let frame = AccountFrame {
            height: 1,
            timestamp: 1_700_000_000_000,
            j_height: 7,
            txs: vec![tx],
            prev_frame_hash: GENESIS_PREV_FRAME_HASH.into(),
            account_state_root: parse_root_hex(&format!("0x{}", "cd".repeat(32)))
                .expect("state root"),
        };
        assert_eq!(
            hex::encode(frame.hash().expect("frame hash")),
            "6c9289826dc97a35ad952eed931b31a30c37d4f8267cf8e3bc498a42889f9d1c",
        );
    }

    fn frame_for(tx: AccountTx) -> AccountFrame {
        AccountFrame {
            height: 3,
            timestamp: 1_700_000_000_000,
            j_height: 7,
            txs: vec![tx],
            prev_frame_hash: format!("0x{}", "11".repeat(32)),
            account_state_root: parse_root_hex(&format!("0x{}", "cd".repeat(32))).expect("root"),
        }
    }

    fn lock_id() -> String {
        format!("0x{}", "ab".repeat(32))
    }

    fn offer_id() -> String {
        format!("0x{}", "a1".repeat(32))
    }

    fn rebalance_policy() -> AccountTx {
        AccountTx::RebalancePolicy {
            token_id: 7,
            policy_version: 9_007_199_254_740_991,
            base_fee: BigInt::parse_bytes(b"123456789012345678901234567890", 10).expect("base fee"),
            liquidity_fee_bps: BigInt::from(375),
            gas_fee: BigInt::from(999_999_999_999_999_999_u64),
        }
    }

    fn htlc_lock(
        delivery_mode: Option<HtlcDeliveryMode>,
        envelope: Option<OpaqueHtlcCiphertext>,
    ) -> AccountTx {
        AccountTx::HtlcLock(crate::HtlcLockTx {
            lock_id: lock_id(),
            hashlock: crate::HtlcHashlock::parse(&format!("0x{}", "cd".repeat(32)))
                .expect("hashlock"),
            timelock: BigInt::from(1_700_000_600_000_u64),
            reveal_before_height: 42,
            amount: BigInt::from(2000),
            token_id: TokenId::new(1).expect("token"),
            delivery_mode,
            envelope,
        })
    }

    fn swap_offer(full: bool) -> AccountTx {
        AccountTx::SwapOffer {
            offer_id: offer_id(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(1000),
            want_token_id: 2,
            want_token_decimals: 18,
            want_amount: BigInt::from(2000),
            max_fee: BigInt::from(if full { 5 } else { 0 }),
            min_net_receive: BigInt::from(if full { 1900 } else { 0 }),
            time_in_force: if full { Some(1) } else { None },
            price_ticks: if full {
                Some(BigInt::from(12345))
            } else {
                None
            },
        }
    }

    fn swap_resolve(full: bool) -> AccountTx {
        let value = |amount: i64| {
            if full {
                Some(BigInt::from(amount))
            } else {
                None
            }
        };
        AccountTx::SwapResolve {
            offer_id: offer_id(),
            fill_ratio: if full { 5000 } else { 10_000 },
            fill_numerator: value(1),
            fill_denominator: value(2),
            cancel_remainder: full,
            comment: None,
            fee_token_id: if full { Some(2) } else { None },
            fee_amount: value(3),
            execution_give_amount: value(500),
            execution_want_amount: value(1000),
            resting_give_token_id: None,
            resting_want_token_id: None,
            resting_price_ticks: value(999),
            resting_give_amount: value(500),
            resting_want_amount: value(1000),
            resting_quantized_give: value(500),
            resting_quantized_want: value(1000),
        }
    }

    /// What a matcher actually writes for a partial fill that keeps the offer
    /// open: the cancel flag present and false, its own comment, and the
    /// book's view of the remainder including both token ids. Every one of
    /// those is hashed by TypeScript.
    fn swap_resolve_partial_fill() -> AccountTx {
        AccountTx::SwapResolve {
            offer_id: offer_id(),
            fill_ratio: 3_333,
            fill_numerator: Some(BigInt::from(1)),
            fill_denominator: Some(BigInt::from(3)),
            cancel_remainder: false,
            comment: Some("book:partial".to_string()),
            fee_token_id: Some(2),
            fee_amount: Some(BigInt::from(1)),
            execution_give_amount: Some(BigInt::from(333_333)),
            execution_want_amount: Some(BigInt::from(666_666)),
            resting_give_token_id: Some(1),
            resting_want_token_id: Some(2),
            resting_price_ticks: Some(BigInt::from(20_000)),
            resting_give_amount: Some(BigInt::from(666_667)),
            resting_want_amount: Some(BigInt::from(1_333_334)),
            resting_quantized_give: Some(BigInt::from(666_667)),
            resting_quantized_want: Some(BigInt::from(1_333_334)),
        }
    }

    /// Produced directly by TypeScript's
    /// `canonicalAccountTxForFrameHash`, `encodeAccountStateValue`, and
    /// `computeFrameHash`. This pins both numeric domains: safe-integer
    /// token/version fields are canonical numbers, while all three fee fields
    /// remain arbitrary-precision BigInts.
    #[test]
    fn matches_typescript_rebalance_policy_bytes_and_hashes() {
        let tx = rebalance_policy();
        let encoded = xln_rscore_protocol::encode_account_state_value(
            &canonical_tx_value(&tx).expect("canonical transaction"),
        )
        .expect("canonical bytes");
        assert_eq!(
            hex::encode(encoded),
            concat!(
                "f8c7866f626a656374f89f8464617461f898866f626a656374df8762617365",
                "466565d686626967696e74008d018ee90ff6c373e0ee4e3f0ad2d986676173",
                "466565d186626967696e7400880de0b6b3a763ffffdc8f6c6971756964697479",
                "466565427073cb86626967696e7400820177e78d706f6c69637956657273696f",
                "6ed8866e756d6265729039303037313939323534373430393931d187746f6b65",
                "6e4964c8866e756d62657237de8474797065d886737472696e6790726562616c",
                "616e63655f706f6c696379",
            ),
        );
        assert_eq!(
            hex::encode(canonical_tx_digest(&tx).expect("transaction digest")),
            "9e88d241bd1890ebce28e487ee3ca49af92cf384b728751d0878b8078f5c47f1",
        );
        assert_eq!(
            hex::encode(frame_for(tx).hash().expect("frame hash")),
            "d64ffd2886e9cc43322db974d00140d8f13462f713ada377eefdf2540be16e34",
        );
    }

    /// Vectors produced by `computeFrameHash` over one-transaction frames
    /// (scratchpad/txvec.ts), one per transaction kind the engine hashes
    /// natively. A renamed or dropped field changes the hash here first.
    #[test]
    fn matches_typescript_vectors_for_every_native_transaction() {
        let ciphertext =
            OpaqueHtlcCiphertext::parse(HTLC_OPAQUE_CIPHERTEXT_VERSION, &base64_of(&[7_u8; 80]))
                .expect("envelope");
        let cases: Vec<(&str, AccountTx)> = vec![
            (
                "3864234d2613ea949680ec0e8c3ed5adc8b3bea48ef63f18dd655114c00e77f3",
                htlc_lock(Some(HtlcDeliveryMode::Instant), Some(ciphertext)),
            ),
            (
                "d230b30b9607bf377c0c5da20552091f7e43d9c3f921153eca0c5b5071e2ce42",
                htlc_lock(None, None),
            ),
            (
                "3ac865fcd515331ed15af6d39b2134ae5090b525c72614f65e0dd95db4da3910",
                AccountTx::HtlcResolve(crate::HtlcResolveTx {
                    lock_id: lock_id(),
                    outcome: HtlcResolveOutcome::Secret {
                        secret: format!("0x{}", "01".repeat(32)),
                    },
                }),
            ),
            (
                "cbac6ffd9433f5f75e56e3b05ccfe7dca2ac4c233fa950214267e2deb68abaed",
                AccountTx::HtlcResolve(crate::HtlcResolveTx {
                    lock_id: lock_id(),
                    outcome: HtlcResolveOutcome::Error {
                        reason: Some("expired".to_string()),
                    },
                }),
            ),
            (
                "d4f553b16093772ef3ff16869daf16943ad1b3612266ac6f946f0172430c223c",
                AccountTx::HtlcResolve(crate::HtlcResolveTx {
                    lock_id: lock_id(),
                    outcome: HtlcResolveOutcome::Error { reason: None },
                }),
            ),
            (
                "aec5e87ddeb82be486d2418a76815880df0124e2be7c5583248f9f14f86613e6",
                AccountTx::SetCreditLimit {
                    token_id: TokenId::new(2).expect("token"),
                    amount: BigInt::from(500),
                },
            ),
            (
                "d6f58ecfd2e757ef758e0c03791c273edbdd307c020ff7708e3f046c1eca82fd",
                AccountTx::AddDelta {
                    token_id: TokenId::new(3).expect("token"),
                },
            ),
            (
                "d64ffd2886e9cc43322db974d00140d8f13462f713ada377eefdf2540be16e34",
                rebalance_policy(),
            ),
            (
                "ba6c16150799e34d7f4020a789ffbd483631896c94ca2474e65d445d1bc55e24",
                swap_offer(true),
            ),
            (
                "03c31aaae209964d4139201202a5657e81876943857a8ec82b8cd98fc1d5cee7",
                swap_offer(false),
            ),
            (
                "fd1ec22d1ff0b7e459d49a1fde41005b6c5d0016451b55adc479202fa2ecdcd4",
                swap_resolve(true),
            ),
            (
                // `cancelRemainder: false` is hashed, not omitted. The old
                // vector here reproduced a TypeScript object that simply did
                // not carry the field, which real traffic always does.
                "5bdf0a99946a59fef974e27b322622c888f355c89cc832613449eed01bb8f08f",
                swap_resolve(false),
            ),
            (
                "efc691408f6df868fe04a1a9e324a6e28568effa1ef5ab8b4666f035301b7b52",
                swap_resolve_partial_fill(),
            ),
            (
                "52db07f275bb2354c5e679eab2ba610a0906b5c932a6f53f22a267c7c56a65e6",
                AccountTx::SwapCancelRequest {
                    offer_id: offer_id(),
                },
            ),
        ];
        for (expected, tx) in cases {
            let described = format!("{tx:?}");
            assert_eq!(
                hex::encode(frame_for(tx).hash().expect("frame hash")),
                expected,
                "frame hash for {described}",
            );
        }
    }

    /// Base64 the way TypeScript writes it, so the envelope round-trips.
    fn base64_of(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A transaction the engine does not model natively must fail loudly: a
    /// frame hash computed from a guessed shape would be silently wrong.
    #[test]
    fn refuses_to_hash_a_transaction_it_does_not_model() {
        let tx = AccountTx::ReserveToCollateral {
            token_id: TokenId::new(1).expect("token"),
            collateral: "1".to_string(),
            ondelta: "0".to_string(),
            side: crate::ReserveSide::Receiving,
            block_number: 1,
            transaction_hash: format!("0x{}", "ee".repeat(32)),
        };
        assert_eq!(
            frame_for(tx).hash().expect_err("unsupported"),
            StateError::UnsupportedFrameTx("reserve_to_collateral"),
        );
    }
}
