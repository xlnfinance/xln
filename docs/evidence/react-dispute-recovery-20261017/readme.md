# React dispute and recovery gate

Baseline: `5bdc9cc93c2fdc352aa3a7c6ad53d9bdf311560c`. The required root dispute lifecycle stopped in a retired Svelte creation selector before exercising money (35.905 seconds). Its next retired reads and selectors were reproduced separately. No production financial code was changed.

The same two named resilience tests now use the public React wallet importer, exact imported signer/Entity identity, existing Account admission, current read-only diagnostics, and React dispute/batch controls. Obsolete uncalled settlement helpers, old globals, alternate hub/API readers and the test's sent-batch clearing action are deleted. There is no compatibility wallet or recovery reader.

The lifecycle proves a real signed 100 USDC claim against an H2 with sufficient liquid reserve, a UI-initiated dispute, signed 5+5 second response windows, observed on-chain start and automatic deadline finalization. It requires exact reserve growth from 0 to 100,000,000 base units, current local reserve agreement, two observed batch events, closed Account financial controls disabled, password-unlock of the same Runtime/Entity, and identical receipt IDs after current checkpoint/WAL restoration. React retains closed Accounts as readable evidence; an absent obsolete CSS selector is no longer accepted as proof of closure. The isolated chain clock is advanced to the signed deadline; the real Runtime scheduler still performs finalization. This is local testnet evidence, not public-chain/mainnet or uninterrupted-soak evidence.

Measured intermediate results:

- Lifecycle and reload: 1/1, 41.532 seconds.
- Exact-money extension: 1/1, 41.514 seconds; claim=100000000, reserveBefore=0, reserveAfter=100000000.
- Focused current dispute-state/activity-history regressions: 20/20, 108 assertions, 0.953 seconds. Strict diagnostics for the owned test using the current UI compiler options: 0 errors, 4.798 seconds.
- Separate UI Sign & Broadcast: 1/1, 27.625 seconds, including current disputed/closed Account and disabled financial controls.
- Two intermediate runs hit the 60-second stand limit while obsolete UI expectations were being replaced. They are failures, preserved with their logs; their exact owned processes ended and the stand was free before the next run.

Reproduction (one test per capacity-one stand; ordinary budget 60 seconds):

```sh
bun run stand:status
bun run stand:run --reason dispute-lifecycle --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e-dispute.spec.ts::entity workspace dispute lifecycle returns reserve'
```

For the second test replace the title with `entity settle workspace Sign & Broadcast submits dispute batch`. The historical test titles remain stable for gate selection and failure history; the current control is React Home's batch broadcast.

Durable command logs, exact exit/duration JSON, original red boundaries, current build/runtime/worker identities, final clean-candidate browser evidence and source manifest are in `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`, named `dispute-*`. The final checked commit and clean-source verification are recorded in that folder's `handoff.json` and Git's `xln-verification/<SHA>/` evidence. Mandatory full `bun run check` and the installed pre-push verifier remain unchanged. No Rust, contract, frozen-core, financial mutation or schema implementation changes belong to this slice. Full integrated release, public topology/chain, rollback, uninterrupted soak and MacBook catch-up remain separate open criteria.
