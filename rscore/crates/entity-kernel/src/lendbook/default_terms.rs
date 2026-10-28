use super::state::{err, n, obj, s};
use crate::{CanonicalEntityTx, EntityKernelError, EntityTxKind};
use xln_rscore_engine::{
    AccountDomain, LendingTermId,
    lending::{MAX_CLOCK, YEAR_MS, term_ms},
};

/// Bootstrap emits authenticated governance commands; defaults never grant a facility.
pub fn build_default_bank_terms_txs(
    domain: &AccountDomain,
    tokens: &[u64],
    now: u64,
) -> Result<Vec<CanonicalEntityTx>, EntityKernelError> {
    if now == 0 || now > MAX_CLOCK {
        return Err(err(format!("DEFAULT_BANK_TERMS_CLOCK_INVALID:{now}")));
    }
    let expires = xln_rscore_protocol::CanonicalValue::Number(
        xln_rscore_protocol::CanonicalNumber::parse_js_canonical(&format!(
            "{:.0}",
            now as f64 + YEAR_MS as f64
        ))
        .map_err(|e| err(e.to_string()))?,
    );
    let mut out = Vec::new();
    for token in tokens {
        for (term, saving, loan) in [
            (LendingTermId::Demand, 300, 0),
            (LendingTermId::OneHour, 0, 1),
            (LendingTermId::OneDay, 1, 2),
            (LendingTermId::OneMonth, 30, 60),
        ] {
            out.push(
                CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::LendingSetTerms,
                    obj(vec![
                        ("chainId", n(domain.chain_id())),
                        (
                            "depositoryAddress",
                            s(format!(
                                "0x{}",
                                hex::encode(domain.depository_address().bytes())
                            )),
                        ),
                        ("tokenId", n(*token)),
                        ("termId", s(term.wire_name())),
                        ("savingsInterestBps", n(saving)),
                        ("loanInterestBps", n(loan)),
                        (
                            "loanLateMs",
                            n(if term == LendingTermId::Demand {
                                0
                            } else {
                                term_ms(term)
                            }),
                        ),
                        ("expiresAt", expires.clone()),
                    ]),
                )
                .map_err(|e| err(e.to_string()))?,
            );
        }
    }
    Ok(out)
}
