# Hosted wallet financial boundary

Base main8235ffb621f0cc19d29795b901345b1fd4baf098; public application still exact
f3a14e6528415c7c98da7865eb6492becb8c1c61. The source change is one test navigation:
`page.goto('./')` respects the configured wallet base instead of discarding `/ui/`.
No financial implementation or RPC permission changed.

Before: the real public production-wallet test opened the landing page and failed
at gate-stack after25.323s. After: it entered React and actually funded gas/100USDC
reserve, exposing the next boundary after38.780s: `eth_sendRawTransaction` receives403
from the deliberate shared read-only RPC allowlist. The100USDC move into Account
therefore did not commit. This test is RED on the public host; no assertions skipped.

The exact unchanged financial test passes1/1 on the canonical local production
artifact/real RPC stand37.722s, including reserve-to-Account,25USDC payment/fee,
receipt and identity/balance reload. Hosted-base routing is fixed; public broadcast
policy remains an explicit owner decision because the latest authorization excludes
changes to access/security protections. An unapplied proposed diff is preserved in
the command archive. No unsafe-proxy flag or alternate fallback was enabled.

Independent public offchain UI evidence: actual100USDC receipt followed by25USDC
payment toH2, quoted sender25,000,025 units/fee25, committed Paid receipt and hashlock,
and displayed75.00USDC after reload;29.894s, zero page/console/HTTP errors. The
production UI exposes rounded balances, so this does not claim an atomic post-payment
balance proof. It also does not replace the blocked reserve test.

An earlier independent offchain attempt timed out48.789s at navigation after reload,
without console errors. Its root cause is UNKNOWN; the instrumented repeat passed.
That failure is retained, not waived by the later pass. Raw browser traces remain
outside source because wallet import traces can contain disposable test mnemonics.
Only non-secret command outputs and financial summaries are published here.

No mainnet activation, real funds, TPS, full release or uninterrupted soak claim.
