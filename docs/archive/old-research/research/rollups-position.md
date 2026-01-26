# Rollups vs XLN – Position Summary

## Core claims (XLN perspective)
- Global atomic composability is a “solution in search of a problem”; most finance has always been bilateral/asynchronous (Sumerian ledgers, Medici letters, SWIFT/Visa).
- Rollups depend on third-party data availability (DA); future data existence cannot be proven. If blobs or archivers disappear, exits can stall. The only sure DA is each user holding their own witnesses/proofs.
- XLN keeps all state local to the account participants; users always have the data they need. No DA reliance, no sequencer dependency.
- Transformers + hashlocks provide programmable, composable flows across a mesh of accounts; async “physics” over synchronous global state.
- J-machine can still provide ordered/global settlement for exceptional cases; A-machine handles 99% of sub-$1M traffic with bilateral rails.
- Path-finding/liquidity are solvable (Dijkstra + hubs/seed nodes), inbound-capacity issues (Lightning) addressed via RCPAN, programmable interactions, and Hanko DAOs.
- Target throughput: 1B+ TPS via massive parallelism; no global DA bottleneck.

## Analogies & positioning
- CeFi works with bilateral ledgers because unicast is “mathematical perfection”; rollbacks/netting are enforcement, not the reason for the topology. XLN replaces that enforcement with proofs/disputes.
- Rollups = “global SQL transaction”; XLN = mesh/local interactions aligned with physics (no global simultaneity).
- Shared global menus/prices (rollups) vs peer/dark quotes (XLN). Flash loans/global bundles framed as MEV/hack tooling, not user necessity.

## Critique of rollups (from discussion)
- DA risk is unsolved: no way to prove future retention; drills can’t guarantee future availability. Without per-user witnesses, exits rely on archivers/sequencers.
- “Verifier dilemma”: you can’t prove honest watchers exist (sybilable). Fraud/validity proofs require someone to act.
- Global atomicity benefits (flash bundles, same-block liquidations/arbs) serve MEV/hacks/dev convenience more than end users; most real-world flows are async.
- If users must hold their own proofs, blobs become redundant; publishing DA becomes wasteful while still not guaranteeing future availability.

## XLN advantages (claimed)
- Sovereignty/local availability: users hold their own proofs; no third-party DA.
- Parallelism: independent accounts enable very high TPS without shared DA throughput limits.
- Composability via transformers/hashlocks: mesh-based, programmable, private/dark liquidity, rather than global AMM-style sync.
- J-machine retained for rare global settlement; bilateral layer for the vast majority of flows.

## “GPT doubts” (open questions/counterpoints)
- Global synchronous use cases: liquidations/auctions/arbs that rely on atomic bundles need clear async equivalents; can transformers/hashlocks + J-machine cover all without added risk/latency?
- Persistence/backup: XLN’s guarantee hinges on flawless client-side proof retention (multi-device/backup). What’s the enforced UX/backup story to prevent loss?
- Routing/liquidity reliability: hubs must stay solvent/online; incentives/penalties for failed paths/timeouts need to be specified and proven.
- Security hardening: current Depository auth/dispute gaps must be fixed (caller checks, counterparty sigs, dispute hash/timeout binding, batch token I/O). testMode must be off by default.
- Performance: 1B+ TPS is aspirational—needs end-to-end benchmarks (routing, disputes, failures) to substantiate.

