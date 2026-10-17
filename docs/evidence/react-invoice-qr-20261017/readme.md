# React invoice QR payment

The existing root QR gate failed in 50.836 seconds at the retired Svelte Runtime dropdown, before payment. The test now uses the canonical React identity, Receive and Pay controls. No production UI, financial, contract or storage code changed.

Bob renders an actual 7 USDC invoice QR with the note `QR settle`. The test captures the displayed pixels and uploads that PNG through the payer's actual scanner. It requires the decoded recipient, amount and note, selects the real H1 route, and submits the signed payment.

The browser passes 1/1 in 28.871 seconds with zero console/page/network failures. Persisted matching initiation/finalization evidence records exactly 7,000,000 units delivered and 7,000,007 debited (7-unit fee). Both Account capacity changes are asserted exactly, with no pending frame or mempool work. This strengthens the old generic received-message check; no fake QR decoder or fabricated financial input is used.

Related current invoice URL/codec tests pass 3/3 with 20 assertions. Owned strict types initially rejected the optional named-hub result; explicit H1 validation fixes it, with zero diagnostics in 4.730 seconds. results.json retains actual commands, failures and exits. proof.json omits the already-revealed HTLC secret; raw local evidence is preserved outside source. Final committed browser and verifier records are linked from the external invoice-qr publication artifact.

Local-chain evidence only: no public Sepolia, aggregate release, full parity, rollback or uninterrupted soak claim.
