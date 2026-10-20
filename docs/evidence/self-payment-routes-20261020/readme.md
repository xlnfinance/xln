# Self-payment route discovery

The full AHB browser scenario reached a funded `A -> H1 -> H2 -> A` cycle, but Pay offered no quote. The canonical HTLC envelope already permits this route; the pathfinder rejected every query whose source and destination matched.

The pathfinder now allows the final return to the source after at least two unique intermediates. Intermediate repeats, zero-hop payments and same-Account round trips remain forbidden. Exact forwarding fees, each Account's capacity, the selected funding Account and the bounded search remain unchanged.

Captured live-profile regressions first failed and now pass with the existing routing suites: 20 tests, 63 assertions. The full React browser scenario passed forward, reverse and second payments, overspend rejection, real self-pay resolution, and both wallets' reload recovery. It no longer exits early in FAST mode. Its expected overspend warning is matched by exact endpoints and must actually occur; unexpected browser issues still fail the strict gate.

[proof.json](proof.json) pins source hashes and retained red/green evidence. This is focused private EVM evidence. Final financial certification on one immutable SHA, full suites, release, soak and public deployment remain outstanding.
