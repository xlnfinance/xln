//! Canonical Entity-state policy used by every live and replayed Entity frame.

use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_engine::{SwapMarketPolicy, SwapToken};
use xln_rscore_entity_kernel::{
    DeterministicContext, PairPolicy, canonical_pair_orientation, canonical_pair_policy,
    canonical_token_decimals, is_canonical_liquid_token,
};
use xln_rscore_protocol::CanonicalValue;

use crate::RuntimeEntityState;

use super::EntityContextJsonError;

fn pair_tokens(pair: &str) -> Result<(u32, u32), EntityContextJsonError> {
    let Some((left, right)) = pair.split_once('/') else {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "pairId.{pair}"
        )));
    };
    let left = left
        .parse::<u32>()
        .map_err(|_| EntityContextJsonError::InvalidValue(format!("pairId.{pair}")))?;
    let right = right
        .parse::<u32>()
        .map_err(|_| EntityContextJsonError::InvalidValue(format!("pairId.{pair}")))?;
    if left == 0 || right == 0 || left >= right {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "pairId.{pair}"
        )));
    }
    Ok((left, right))
}

/// The Rust Runtime owns the same protocol registry that TypeScript installs
/// in Account authority Hello. Keep the table in this one module so Entity
/// context projection and Account swap quantization cannot drift apart.
pub fn canonical_swap_market_policy() -> SwapMarketPolicy {
    let tokens = (1..=5)
        .map(|token_id| SwapToken {
            token_id,
            decimals: canonical_token_decimals(token_id).unwrap_or_default(),
            liquid: is_canonical_liquid_token(token_id),
        })
        .collect::<Vec<_>>();
    let mut steps = Vec::new();
    for left in 1..=5 {
        for right in 1..=5 {
            if left != right {
                steps.push(((left, right), 1));
            }
        }
    }
    SwapMarketPolicy::new(tokens, steps)
}

fn canonical_field<'a>(
    value: &'a CanonicalValue,
    field: &str,
) -> Result<&'a CanonicalValue, EntityContextJsonError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(EntityContextJsonError::InvalidType(
            "state.core.hubRebalanceConfig".into(),
        ));
    };
    fields
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
        .ok_or_else(|| EntityContextJsonError::MissingField(format!("hubRebalanceConfig.{field}")))
}

/// Replace only policy fields with values derived from the current committed
/// Entity state. Per-frame prepared/originated HTLC entries remain bound to
/// the authenticated Entity context that supplied them.
pub(crate) fn apply_entity_state_policy(
    context: &mut DeterministicContext,
    state: &RuntimeEntityState,
    jurisdiction: Option<&CanonicalValue>,
) -> Result<(), EntityContextJsonError> {
    let swap_taker_fee_bps = match state.entity.hub_rebalance_config.as_ref() {
        Some(config) => {
            let CanonicalValue::Number(value) = canonical_field(config, "swapTakerFeeBps")? else {
                return Err(EntityContextJsonError::InvalidType(
                    "hubRebalanceConfig.swapTakerFeeBps".into(),
                ));
            };
            value
                .as_str()
                .parse::<u16>()
                .ok()
                .filter(|fee| *fee <= 10_000)
                .ok_or_else(|| {
                    EntityContextJsonError::InvalidValue(
                        "hubRebalanceConfig.swapTakerFeeBps".into(),
                    )
                })?
        }
        None => 0,
    };
    let minimum_trade_size = state.entity.orderbook_metadata.as_ref().map_or_else(
        || BigInt::from(0),
        |metadata| metadata.hub_profile.min_trade_size.clone(),
    );
    let pair_policies = state
        .entity
        .orderbook
        .as_ref()
        .map(|orderbook| {
            orderbook
                .pair_dimensions
                .iter()
                // Only the same-J matcher consumes this table. Cross-J derives
                // its policy from the authenticated route and asset dimensions.
                .filter(|(pair, _)| !pair.starts_with("cross:"))
                .map(|(pair, dimensions)| {
                    let (left, right) = pair_tokens(pair)?;
                    let (base, quote) = canonical_pair_orientation(left, right);
                    let (policy, _) = canonical_pair_policy(base, quote, *dimensions);
                    Ok((pair.clone(), policy))
                })
                .collect::<Result<BTreeMap<String, PairPolicy>, EntityContextJsonError>>()
        })
        .transpose()?
        .unwrap_or_default();

    let jurisdiction_id = match jurisdiction {
        Some(CanonicalValue::Object(fields)) => match fields
            .iter()
            .find_map(|(name, value)| (name == "name").then_some(value))
        {
            Some(CanonicalValue::String(name)) if !name.is_empty() => Some(name.clone()),
            Some(_) => {
                return Err(EntityContextJsonError::InvalidType(
                    "entity.config.jurisdiction.name".into(),
                ));
            }
            None => None,
        },
        Some(_) => {
            return Err(EntityContextJsonError::InvalidType(
                "entity.config.jurisdiction".into(),
            ));
        }
        None => None,
    };

    context.block_time_ms = xln_rscore_entity_kernel::payment_block_time_ms(jurisdiction);
    context.minimum_trade_size = minimum_trade_size;
    context.swap_taker_fee_bps = swap_taker_fee_bps;
    context.jurisdiction_id = jurisdiction_id;
    context.pair_policies = pair_policies;
    Ok(())
}

#[cfg(test)]
mod tests {
    use xln_rscore_entity_kernel::{
        DeterministicContext, EntityStateSlice, OrderbookState, PairDimensions,
    };
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

    use super::{apply_entity_state_policy, canonical_swap_market_policy};
    use crate::RuntimeEntityState;

    #[test]
    fn canonical_swap_market_digest_matches_typescript_registry() {
        assert_eq!(
            hex::encode(canonical_swap_market_policy().digest()),
            "5930755c012ffea403a64757a44e8e8696231ecbb9392213c9409feabb546f94",
        );
    }

    #[test]
    fn cross_j_r6_h44_cross_book_does_not_enter_same_j_policy_projection() {
        let cross_pair = "cross:stack:31337:0xa513e6e4b8f2a923d98304ec87f64353c4d5c853:1/stack:31338:0xa513e6e4b8f2a923d98304ec87f64353c4d5c853:1";
        let mut book = OrderbookState::empty(100);
        book.pair_dimensions.insert(
            cross_pair.into(),
            PairDimensions {
                base_token_decimals: 6,
                quote_token_decimals: 6,
            },
        );
        book.pair_dimensions.insert(
            "1/2".into(),
            PairDimensions {
                base_token_decimals: 18,
                quote_token_decimals: 6,
            },
        );
        let mut entity = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 0);
        entity.orderbook = Some(book);
        let mut state = RuntimeEntityState {
            accounts_root: [0; 32],
            entity,
        };
        let mut context = DeterministicContext::hlt_default();
        apply_entity_state_policy(&mut context, &state, None).expect("mixed book domains");
        assert_eq!(context.pair_policies.len(), 1);
        assert!(context.pair_policies.contains_key("1/2"));
        assert!(!context.pair_policies.contains_key(cross_pair));
        // A malformed same-J pair remains a loud error; only the separately
        // owned Cross-J policy domain is excluded from this projection.
        state
            .entity
            .orderbook
            .as_mut()
            .unwrap()
            .pair_dimensions
            .insert(
                "not-a-pair".into(),
                PairDimensions {
                    base_token_decimals: 6,
                    quote_token_decimals: 6,
                },
            );
        assert!(apply_entity_state_policy(&mut context, &state, None).is_err());
    }

    #[test]
    fn committed_entity_state_replaces_stale_checkpoint_policy() {
        let mut entity = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 0);
        entity.hub_rebalance_config = Some(CanonicalValue::Object(vec![(
            "swapTakerFeeBps".into(),
            CanonicalValue::Number(CanonicalNumber::from_u16(37)),
        )]));
        let state = RuntimeEntityState {
            accounts_root: [0; 32],
            entity,
        };
        let jurisdiction = CanonicalValue::Object(vec![(
            "name".into(),
            CanonicalValue::String("Testnet".into()),
        )]);
        let mut context = DeterministicContext::hlt_default();

        apply_entity_state_policy(&mut context, &state, Some(&jurisdiction)).expect("state policy");

        assert_eq!(context.swap_taker_fee_bps, 37);
        assert_eq!(context.jurisdiction_id.as_deref(), Some("Testnet"));
        assert!(context.pair_policies.is_empty());
    }
}
