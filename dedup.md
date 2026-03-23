# Dedup Backlog

Snapshot after commit `e25567a0`.

Metrics:
- `runtime`: `67,912` code lines
- `runtime/jadapter`: `4,295` code lines
- `runtime + frontend/src + jurisdictions + tests + custody`: `525,030` code lines
- Priority rule: reduce business logic and duplicate paths, not comments or formatting

Top 100 simplification targets:

1. `runtime/runtime.ts` — split runtime loop orchestration from bootstrapping and exports.
2. `runtime/runtime.ts` — isolate `process/apply/persist/dispatch` pipeline into one narrow module.
3. `runtime/runtime.ts` — remove remaining BrowserVM registry plumbing from core runtime flow.
4. `runtime/server.ts` — split API routes, runtime admin actions, and debug endpoints into separate modules.
5. `runtime/server.ts` — move custody-specific handlers out of runtime server.
6. `runtime/entity-consensus.ts` — extract single-signer path into its own helper file.
7. `runtime/entity-consensus.ts` — extract multi-signer proposer flow into its own helper file.
8. `runtime/entity-consensus.ts` — extract commit-time hanko attachment into one helper.
9. `runtime/entity-consensus.ts` — collapse repeated output attachment loops for account and batch outputs.
10. `runtime/account-consensus.ts` — split proposer commit, receiver commit, and ACK handling into separate modules.
11. `runtime/account-consensus.ts` — centralize dispute-hanko verification instead of repeating it in multiple branches.
12. `runtime/account-consensus.ts` — centralize frame-history append logic behind one canonical frame clone helper.
13. `runtime/entity-tx/apply.ts` — reduce giant tx-type switch by moving branch tables into handler registry.
14. `runtime/entity-tx/apply.ts` — move event emission collection out of handler switch scaffolding.
15. `runtime/entity-tx/handlers/account.ts` — split HTLC resolve, direct payment, and swap-side delta logic.
16. `runtime/entity-tx/handlers/account.ts` — centralize disputed-account gate instead of inline repeated checks.
17. `runtime/entity-tx/handlers/settle.ts` — split workspace mutation, approval, execute, and auto-approve paths.
18. `runtime/entity-tx/handlers/settle.ts` — unify post-settlement dispute-proof refresh logic.
19. `runtime/entity-tx/handlers/dispute.ts` — split disputeStart and disputeFinalize into separate files.
20. `runtime/entity-tx/handlers/dispute.ts` — move proof-body canonicalization helpers to shared proof module.
21. `runtime/entity-tx/handlers/dispute.ts` — centralize on-chain account read and stale-local-dispute cleanup.
22. `runtime/entity-tx/handlers/dispute.ts` — centralize current J-height lookup through one imported helper only.
23. `runtime/entity-tx/handlers/htlc-payment.ts` — split route preparation from lock creation and envelope prep.
24. `runtime/entity-tx/handlers/htlc-payment.ts` — move prepared-deadline validation into a shared HTLC utility.
25. `runtime/entity-tx/j-events.ts` — split per-event handlers into smaller files by event family.
26. `runtime/entity-tx/j-events.ts` — extract dispute event application into `j-events-dispute.ts`.
27. `runtime/entity-tx/j-events.ts` — extract reserve event application into `j-events-reserve.ts`.
28. `runtime/entity-tx/j-events.ts` — extract settlement event application into `j-events-settlement.ts`.
29. `runtime/entity-crontab.ts` — split periodic tasks and one-shot hooks into separate modules.
30. `runtime/entity-crontab.ts` — extract dispute hook logic from rebalance and HTLC hook logic.
31. `runtime/wal/replay.ts` — split frame replay loop from validation and debug/read helpers.
32. `runtime/wal/runtime.ts` — split persistence API from DB-open/close plumbing.
33. `runtime/wal/snapshot.ts` — separate env snapshot building from BrowserVM state inclusion.
34. `runtime/wal/state-restore.ts` — separate pure restore from infra rehydration glue.
35. `runtime/wal/hash.ts` — centralize hash-input normalization with zero ad hoc field deletions outside this file.
36. `runtime/state-helpers.ts` — split entity clone helpers, account clone helpers, and display/helpers.
37. `runtime/state-helpers.ts` — replace ad hoc manual clone branches with smaller canonical clone functions.
38. `runtime/j-batch.ts` — split encoding/hash/signing helpers from batch-mutation helpers.
39. `runtime/j-batch.ts` — move submit-to-contract glue out, keep only batch structure logic.
40. `runtime/j-batch.ts` — centralize batch op dedupe rules per op type instead of scattered checks.
41. `runtime/jadapter/rpc.ts` — extract shared batch submit flow into helper shared with BrowserVM adapter.
42. `runtime/jadapter/rpc.ts` — extract watcher poll loop into `rpc-watcher.ts`.
43. `runtime/jadapter/rpc.ts` — extract token allowance/deposit helpers into `rpc-erc20.ts`.
44. `runtime/jadapter/rpc.ts` — extract debug/mint/testnet-only helpers into `rpc-dev.ts`.
45. `runtime/jadapter/browservm.ts` — extract batch submit flow shared with rpc adapter.
46. `runtime/jadapter/browservm.ts` — extract token transfer/approve helpers into `browservm-erc20.ts`.
47. `runtime/jadapter/browservm.ts` — extract watcher glue into `browservm-watcher.ts`.
48. `runtime/jadapter/browservm-provider.ts` — split deployment, ERC20 ops, and batch processing into separate files.
49. `runtime/jadapter/browservm-provider.ts` — move test/demo-only token bootstrap into a separate module.
50. `runtime/jadapter/helpers.ts` — keep only canonical adapter-shared helpers; move debug/noise elsewhere.
51. `runtime/jadapter/runtime-api.ts` — dedupe manual batch signing with `runtime/hanko/batch.ts`.
52. `runtime/jadapter/runtime-api.ts` — reduce thin wrappers that only re-export `jadapter` calls.
53. `runtime/jadapter/index.ts` — keep factory only; move BrowserVM registry state elsewhere if still needed.
54. `runtime/jadapter/types.ts` — remove legacy/dead adapter methods and tighten surface to required production calls only.
55. `runtime/jadapter/jurisdiction.ts` — merge or delete if it only proxies `jurisdiction-config` and adapter connect.
56. `runtime/jadapter/browservm-registry.ts` — delete once runtime/browser no longer store BrowserVM instance directly.
57. `runtime/runtime-infra.ts` — centralize all infra-only objects here and forbid them in state handlers.
58. `runtime/account-crypto.ts` — split signer derivation, cache, and browser storage concerns.
59. `runtime/networking/p2p.ts` — split transport, profile propagation, and debug event paths.
60. `runtime/networking/profile-signing.ts` — centralize profile hash building and hanko verification with other signing modules.
61. `runtime/relay-router.ts` — split websocket transport from pending-message persistence.
62. `runtime/relay-store.ts` — merge tiny helpers or make it the only relay persistence layer.
63. `runtime/entity-factory.ts` — split entity-id encoding from on-chain registration helpers.
64. `runtime/jurisdiction-loader.ts` — merge with `jurisdiction-config` or split cleanly by responsibility.
65. `runtime/jurisdiction-factory.ts` — remove direct BrowserVM knowledge once `jadapter` fully owns backend construction.
66. `runtime/types.ts` — split runtime, entity, account, batch, event, and adapter types into separate files.
67. `runtime/types.ts` — move BrowserVM-only comments and deprecated fields out of core type file.
68. `runtime/types.ts` — remove deprecated `env.browserVM` once registry migration is complete.
69. `runtime/xln-api.ts` — shrink to public surface only; stop mirroring internal helpers and legacy names.
70. `frontend/src/lib/components/Entity/EntityPanelTabs.svelte` — split Move, account tab content, and shared pickers.
71. `frontend/src/lib/components/Entity/EntityPanelTabs.svelte` — delete legacy asset tabs after Move fully replaces them.
72. `frontend/src/lib/components/Entity/SwapPanel.svelte` — split price form, order summary, and submit/review dialog.
73. `frontend/src/lib/components/Trading/OrderbookPanel.svelte` — isolate rendering from tick/price conversion helpers.
74. `frontend/src/lib/stores/vaultStore.ts` — split runtime lifecycle from UI actions and panel convenience methods.
75. `frontend/src/lib/view/core/TimeMachine.svelte` — hide BrowserVM restore specifics behind one `jadapter`-level time travel abstraction.
76. `frontend/src/lib/view/panels/ArchitectPanel.svelte` — move mint/R2R demo actions into shared dev utilities.
77. `frontend/src/lib/stores/*` — merge tiny one-purpose stores that only proxy another store.
78. `frontend/src/lib/config/networks.ts` and `evmNetworks.ts` — merge duplicated network metadata sources.
79. `tests/e2e-rebalance-bar.spec.ts` — split into smaller flows by feature instead of monolithic mega-test.
80. `tests/e2e-swap.spec.ts` — split route setup, orderbook assertions, and dispute/swap lifecycle helpers.
81. `tests/e2e-dispute.spec.ts` — split unilateral, timeout, and reopen flows into separate specs.
82. `tests/e2e-runtime-persistence.spec.ts` — centralize repeated persistence assertions in shared helpers.
83. `tests/e2e-ahb-payment.spec.ts` — extract shared mesh/bootstrap/assert helpers into test utils.
84. `tests/utils/e2e-connect.ts` — centralize connection nudges and runtime-online polling with one contract.
85. `tests/utils/*` — dedupe repeated wait-for-balance, open-runtime, and selector helpers.
86. `runtime/scenarios/helpers.ts` — split sync/drain/converge helpers from formatting and strict-mode helpers.
87. `runtime/scenarios/ahb.ts` — split by phase; it is too large to maintain as one file.
88. `runtime/scenarios/lock-ahb.ts` — split hostage/dispute/timeouts into separate scenario modules.
89. `runtime/scenarios/rebalance.ts` — split funding/bootstrap from assertion logic.
90. `runtime/scenarios/dispute-lifecycle.ts` — merge repeated process/sync/converge loops into one helper.
91. `runtime/scenarios/boot.ts` — centralize signer/runtime/bootstrap setup used by all scenarios and e2e harnesses.
92. `runtime/scenarios/executor.ts` — split scenario graph loading from runtime execution.
93. `jurisdictions/contracts/Depository.sol` — split admin/dev-only helpers from production batch path.
94. `jurisdictions/contracts/Depository.sol` — move reserve op internals into dedicated library.
95. `jurisdictions/contracts/EntityProvider.sol` — split name transfer, board validation, and hanko verification concerns.
96. `jurisdictions/contracts/Account.sol` — separate settlement math from dispute proof checks if possible.
97. `jurisdictions/typechain-types/*` and `frontend/static/contracts/*` — treat as generated artifacts and exclude from dedup work.
98. `jurisdictions/ignition/deployments/*` — generated JSON dominates global `scc`; exclude from code-size dashboards.
99. `frontend/build/*` and `frontend/static/llms*.txt` — generated/search-noise files should be excluded from grep and maintenance metrics.
100. Repo-wide — add one lightweight code-size report that tracks `Code` only for hand-written folders: `runtime`, `frontend/src`, `jurisdictions/contracts`, `tests`, `custody`.
