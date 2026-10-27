//! Canonical payment planning shared by runtime onion creation and Entity forwarding.

pub fn payment_deadline_window(
    asynchronous: bool,
    hops: u64,
    block_time_ms: u64,
) -> Option<(u64, u64)> {
    if block_time_ms == 0 {
        return None;
    }
    let minimum = hops
        .checked_mul(10_000)?
        .checked_add(xln_rscore_engine::HTLC_ENFORCEMENT_RESERVE_MS + 10_000)?;
    let ms = if asynchronous { 86_400_000 } else { 120_000 }.max(minimum);
    Some((ms, ms.div_ceil(block_time_ms)))
}

pub fn payment_reveal_height_delta_blocks(block_time_ms: u64) -> Option<u64> {
    (block_time_ms > 0)
        .then(|| xln_rscore_engine::HTLC_ENFORCEMENT_RESERVE_MS.div_ceil(block_time_ms))
}

/// Read only the owning Entity's committed jurisdiction; absent cadence cannot
/// be guessed from a chain id or replaced by an EVM planning constant.
pub fn payment_block_time_ms(
    jurisdiction: Option<&xln_rscore_protocol::CanonicalValue>,
) -> Option<u64> {
    use xln_rscore_protocol::CanonicalValue;
    let CanonicalValue::Object(fields) = jurisdiction? else {
        return None;
    };
    let CanonicalValue::Number(ms) = &fields.iter().find(|(key, _)| key == "blockTimeMs")?.1 else {
        return None;
    };
    ms.as_str()
        .parse::<u64>()
        .ok()
        .filter(|ms| *ms > 0 && *ms <= 9_007_199_254_740_991)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixpay_5_tron_24h_and_hop_reserve_use_three_second_blocks() {
        let (ms, blocks) = payment_deadline_window(true, 3, 3000).unwrap();
        assert!(blocks * 3000 >= ms);
        assert!(payment_reveal_height_delta_blocks(3000).unwrap() * 3000 >= 30_000);
    }
    #[test]
    fn fixpay_7_ten_to_one_hundred_hops_leave_recipient_enforcement_and_transit() {
        for hops in [10, 11, 100] {
            let (ms, _) = payment_deadline_window(false, hops, 3000).unwrap();
            assert!(ms - (hops - 1) * 10_000 > 30_000);
        }
    }
}
