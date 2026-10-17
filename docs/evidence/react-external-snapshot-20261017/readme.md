# Current external wallet snapshot

The canonical root direct-transfer browser first failed at retired Svelte creation controls. Porting the unchanged financial purpose to React exposed a real defect: Assets showed 20 USDC while Move showed zero and disabled the transfer. The shared snapshot depended on Runtime frame height, but an external ERC20 receipt does not require a Runtime frame.

Assets, Home and Move now share the existing Shell-owned current chain snapshot. Reads run sequentially, three seconds after the previous read completes, with coalesced explicit faucet/refresh requests. Entity changes cancel stale publications. The separate Assets reader and cached-state fallback in Move/Home are removed. This is ephemeral UI state; no durable field, financial transition, storage schema, contract or recovery rule changed.

The real browser transferred exactly 1 USDC: Alice 20 -> 19, Bob 0 -> 1. Both screens updated; authenticated reload preserved those balances. Reserve and allowance stayed zero and the J batch stayed empty. Runtime height remained 11 before, after and after reload. See proof.json.

Validation before final clean-SHA publication:

- Direct transfer: 1/1, strict browser health, 45.526 seconds.
- Existing canonical reserve withdrawal: 1/1, 32.782 seconds; exact reserve/external conservation retained.
- Existing deposit/direct transfer: 1/1, 34.899 seconds; exact allowance and balances retained.
- Existing remote Runtime browser: 1/1, strict browser health, 25.512 seconds.
- Full unweakened check: 38 source gates plus 3 top gates, 27.197 seconds.
- Related move guards: 9/9, 27 assertions. Owned test types: zero diagnostics. UI types passed.

results.json preserves commands, actual failures and exits. The first helper import failed because root and UI have distinct Playwright instances; the shared helper now imports types only and receives the caller's assertion object. A root-runner attempt at a UI-owned test returned no tests, then the actual canonical production UI stand exercised it. These failures are not passes or skipped gates. Final check, committed browser and verifier evidence are linked by the external publication record under /Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/. Raw stand secrets and browser profiles are not committed.

This does not prove public Sepolia financial flows, aggregate release coverage, rollback or uninterrupted soak. The deployed public source has not changed.
