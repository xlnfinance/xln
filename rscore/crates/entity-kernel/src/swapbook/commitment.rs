use sha2::{Digest as _, Sha256};

use crate::EntityKernelError;

use super::BookState;

fn orderbook_error(code: impl Into<String>) -> EntityKernelError {
    EntityKernelError::orderbook(code)
}

fn framed(part: &[u8], output: &mut Vec<u8>) -> Result<(), EntityKernelError> {
    let length = u32::try_from(part.len()).map_err(|_| {
        orderbook_error(format!(
            "ORDERBOOK_COMMITMENT_PART_TOO_LARGE:{}",
            part.len()
        ))
    })?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(part);
    Ok(())
}

fn hex_checksum(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(34);
    output.push_str("0x");
    for byte in bytes.iter().take(16) {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

/// Exact `computeBookCommitmentHash` bytes from the TypeScript orderbook.
pub fn compute_book_commitment_hash(book: &BookState) -> Result<String, EntityKernelError> {
    let parts = [
        "xln.orderbook.book".to_string(),
        book.bucket_width_ticks.to_string(),
        book.max_orders.to_string(),
        book.stp_policy.to_string(),
        book.bid_pages.root_hash(),
        book.ask_pages.root_hash(),
        book.next_seq.to_string(),
        book.trade_count.to_string(),
        book.trade_qty_sum.to_string(),
        book.last_trade_price_ticks.to_string(),
        book.last_accepted_usd_ask_price_ticks.to_string(),
        book.event_hash.to_string(),
    ];
    let mut encoded = Vec::new();
    for part in &parts {
        framed(part.as_bytes(), &mut encoded)?;
    }
    Ok(hex_checksum(&Sha256::digest(encoded)))
}
