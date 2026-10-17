# Pending collateral batch preserves a three-payment tail

The existing named eight-faucet case passed in28.877s, but actually performed seven faucets and did not hold mining. That baseline did not establish its claimed pending-batch boundary.

The strengthened case disables local Anvil automining, triggers one committed request after exactly five100USDC faucets, and waits for the actual signed pending R2C transaction. Three more real faucets must each increase accepted Account capacity by exactly100USDC without changing the requested amount or collateral. The pending transaction, hash and nonce must remain identical. Explicit mining then produces one successful receipt and one Hanko batch log; settlement follows the original durable request.

The first strengthened run failed in28.474s: its test reader reported zero risk instead of300USDC. The actual React Home already displayed the correct300USDC risk and499.85USDC secured balance. Both test readers subtracted collateral from deriveDelta.outPeerCredit a second time. They now consume that canonical derived value directly. No production financial, UI, storage or contract implementation changed.

The corrected real browser passes1/1 in40.792s with zero console, page, HTTP or network issues. Exact final values: eight faucets, one request,499850000 atomic units collateral,300000000 uncollateralized exposure and799850000 capacity after the committed150000 fee. The proof records the actual pending batch, receipt, three tail states and settlement. Owned strict types pass with zero diagnostics in4.724s; exact request amount/fee strings are validated before BigInt conversion. The unchanged admission/finality regressions previously passed14/14 with64 assertions on this production source.

All verification holds the canonical capacity-one stand and60s process limit. results.json preserves precommit commands/exits; final check, clean-SHA browser and installed verifier results are linked by the external rebalance-tail publication artifact. This proves one local pending-batch scenario, not all rebalance cases, public-chain readiness, uninterrupted soak or full parity.
