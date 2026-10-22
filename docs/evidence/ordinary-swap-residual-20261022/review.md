# Ordinary Swap residual corrections

A partial GTC execution can encode the maximum uint16 fill ratio while exact
execution amounts still leave a tradable remainder. Account settlement previously
closed that offer and released its remaining hold. Full closure now follows exact
remaining give amount, while explicit cancellation still follows its existing
counterparty authority. The regression preserves the exact offer and held amount
for a 99,999/100,000-lot execution; IOC/FOK and exact-full checks remain unchanged.

Resuming a crossed book previously retained the unquantized taker remainder.
Account settlement already releases residual dust at the taker's own limit price.
New admission and resumed matching now use the same exact-quote lot quantization.
Regression vectors cover both a retained 10,000-lot order and a zero-lot removal,
including unchanged source overlays and retained order priority.

Both findings were independently reproduced from the existing Opus review.
The original broad E2E run was cancelled after the first confirmed amount defect;
its preserved artifacts do not establish a full-suite pass. No timeout, financial
assertion, test selection or signing rule was weakened.

Focused verification: 75 tests, zero failures, 331 assertions. The canonical
production Swap scenario recorded 76 accepted Runtime WAL frames and replayed the
same recording with one and four workers to the identical final root. See
`verification.json` for the tested file hashes, commands and immutable Studio
receipts. Other audit findings and all final release gates remain open.
