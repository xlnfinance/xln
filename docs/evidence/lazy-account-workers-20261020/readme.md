# Empty Account worker startup

The seven ordinary browser scenarios following the market-maker phase reproduced
`HUB_BOOTSTRAP_DRAIN_TIMEOUT:hub-config` with serialized resets. The failed hubs
had already committed their configuration. Their configuration frame spent
6.33–6.87 seconds creating Account workers for empty shards, within a total
9.36–9.54 seconds. The following authenticated J work still had to drain inside
the existing 10-second budget.

The coordinator now retains the canonical empty root and complete frame lifecycle
without allocating an isolate for an empty shard. It captures initialization
bytes immediately. Before that shard's first actual request, the worker performs
the existing initialization and must return zero Accounts and no populated
subroots. Nonempty shards initialize eagerly. A failed initialization poisons the
coordinator; roots, ordered effects, rollback and Hanko checks remain intact.
The actual request bytes are also captured before awaiting initialization.

Evidence in [proof.json](proof.json):

- The new empty-frame → real outbound genesis regression failed 3/3 before the
  change and passed 3/3 for W1/W4/W8 afterwards, with exact sequential roots and
  effects.
- The owning parity suite passed 33/33 with 183 assertions, including inbound
  genesis, books, rollback, fail-stop and rejection of a corrupt initialization
  whose caller-owned map was subsequently changed.
- The original seven-case browser cohort passed 7/7 with zero browser health
  issues in two runs (333.73 and 295.33 seconds including setup/build). Cross wrong-side selection, one-click setup, TRON
  sibling rebalance, full/reverse/partial fills and the offline-route case ran.
- Runtime types and frozen-core checks passed. Only changed regions were
  formatted; all five formatted files produced identical Bun transpilation.
  Initialization selection then moved into its owning client to retain the
  unchanged 100-line function limit; 33/33 parity and all seven browser cases
  were rerun on that final extraction.

Both cohorts retained seven lanes, one concurrent reset and the 10-second hub
drain deadline. Queue order and OS load differ, so the measurements establish
the expensive phase and the successful owning boundary, not a throughput result.
No authenticated history, financial assertion or initialization error was skipped.

This is focused candidate evidence. Full immutable-SHA financial, browser, release,
soak and public deployment checks remain required. Private fixtures do not certify
public Nile, Ethereum USDT or mainnet deployment and signing authority.
