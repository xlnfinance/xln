# Tower recovery payment receipt boundary

The current production-stand browser test restored the same funded Account proofs and canonical Runtime root, rejected overwrite of an existing store, reopened the restored wallet, and committed its next payment. Its final evidence query then failed with `RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=17:through=17`.

The failure was an inclusive-range error in the test. A portable checkpoint deliberately marks activity through its materialized baseline unavailable; older Runtime activity is not Account authority and must not be fabricated. The new payment is admitted after the captured pre-payment height. The test now requests receipts starting at that height plus one, as the existing lending, multihop and restart receipt checks already do. The receipt API, production monitor, checkpoint format and WAL recovery remain unchanged.

Before: `react-tower-component-efe0b8d8a`, exit1 in43.415s on source HEADefe0b8d8a (only the CURRENT plan was dirty). After: `react-tower-current-boundary-1`, exit0 in43.748s,1 passed/0 skipped. Both runs use `XLN_HLT_ENGINE=ts`, the canonical `prod:smoke:local` stand, real local contracts, relay, hubs, encrypted tower backup and browser. Original Account/root,100USDC recovered balance, overwrite rejection, exact1USDC payment, quoted debit, actual fee and final Account balance assertions remain.

The focused production storage tests are `core/__tests__/storage/history/runtime-activity-view.test.ts` and `core/__tests__/storage/recovery/storage-restore-import-policy.test.ts`. They require loud rejection at an unavailable floor and verify subsequent WAL activity repair and current restore behavior. No new reader, compatibility format, durable field, fake receipt or financial implementation is introduced.

Reproduce with a fresh owned data directory:

```sh
bun run stand:status
XLN_HLT_ENGINE=ts \
XLN_LOCAL_PROD_SMOKE_DIR=/tmp/xln-tower-receipt-proof \
XLN_LOCAL_PROD_SMOKE_WALLET_TESTS=e2e-tower-restore.spec.ts \
bun run stand:run --reason tower-receipt-proof --timeout-ms 60000 -- bun run prod:smoke:local
```

Full logs, original failed store/artifacts, corrected browser report, focused L1, final check and clean committed browser/publication evidence live under `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` with the `react-tower-*` names. Exact final SHA/tree and remote publication belong to the handoff/result JSON, not an assumption from a completed turn.

Related current React observations: admission1/1 in32.842s; reserve1/1 in52.384s; offline protection1/1 in41.364s. Payment group timed out60.993s after4/5 cases, dispute group timed out60.375s after both P4/P5 browser cases passed, and recovery group timed out60.989s after file recovery and sovereignty passed. Those aggregate commands remain red. The explicit request to use the five existing React groups' canonical240s budgets is pending owner authorization; ordinary checks remain60s. No full release, public-chain, uninterrupted soak, TPS or mainnet readiness claim.
