# React mirrored debt evidence

The existing sovereign-Hub debt browser scenario failed before financial work
at removed Svelte runtime controls (40.483s). Its next old helper failed at the
removed context selector (46.424s). After connecting the current React wallet,
the old reader silently returned Account height0 from absent `window.isolatedEnv`
after a real payment (31.410s).

The test now uses the current React importer, explicit created identity, current
Runtime adapter views and current dispute/Assets controls. Missing owners fail
loudly. Unused legacy readers, alternate delta reconstruction and old UI helpers
are deleted:1331 lines become336. No production financial code, contract,
checkpoint/WAL format, frozen hash or normal wallet policy changed.

## Real financial result

- The final strict mesh browser passes1/1 in35.897s; all browser console/page,
  HTTP and network issue counters are zero. A prior complete run passed38.154s.
- Sovereign H3 grants a real committed1000USDC credit limit, then Alice pays
  exactly150USDC on that credit. Both committed Account owners expose the same
  canonical delta; pending Account work is empty.
- Alice has zero collateral and zero token reserve. Only transaction gas is
  obtained from a faucet. Preparing the dispute creates the canonical unsigned
  draft with observedOnChain=false, timeout0 and no sent batch. Broadcasting
  produces one successful start receipt and exact next Entity batch nonce.
- The React importer already opens H1 with its normal86400+3600-second windows.
  That silently defeated the old test's requested5+5-second opening configuration.
  This scenario opens a fresh H3 Account and requires both owners to have actually
  committed5+5 before payment. Receipt windows must equal those signed values.
  No existing Account's windows or production defaults are shortened.
- The isolated runner owns its private chain and advances it to the actual signed
  deadline, as the original scenario did. Automatic finalization closes the Account
  on both owners. One150USDC `DebtCreated` event shares the successful transaction
  with the unique matching `DisputeFinalized`; nonce, block/transaction hash,
  final proof hash, token and debt index are recorded.
- Alice has exactly one outgoing open debt; H3 has exactly one incoming open debt.
  debtId, created/remaining150USDC and paid0 agree. Alice's reserve and collateral
  remain0. Assets renders “You owe”,150.00 and USDC. One more real chain block
  and repeated committed reads preserve the same single debt on both owners.
- Focused current debt recovery/FIFO suite5/5,60 assertions,0.893s: restores active
  aggregates, rejects stale J replay, maintains FIFO and bounded activity history,
  and resumes one aggregate after persistence. This is not a whole Runtime crash
  recovery or TPS claim. Owned test strict types:0 diagnostics,4.875s.

[Exact balances, signed windows and receipts](proof.json),
[commands/exits/log hashes](results.json). Full immutable original source,
failed/pass traces and screenshots are under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/debt-ledger/`.
Clean-SHA browser, check and verified push are recorded by
`debt-ledger-publication.json` in that autonomy artifact root.

## Preserved failures and limits

The port also exposed an incorrect test API URL (21.415s), an incorrect null-draft
expectation (26.206s), and waiting for a Home-only broadcast button while still on
Account (60.833s timeout). The exact timed-out group was cleaned up before another
stand. A subsequent43.609s failure exposed the25-hour H1 configuration, which is
retained as evidence; the test now proves its explicitly signed fixture. Four
new reader-type diagnostics were repaired using the actual public view types.
No failure was hidden with a fallback reader, longer ordinary budget, skip,
production policy change or manual state mutation.

The full integrated release/browser gates, public Sepolia/operator/compatible
rollback evidence, uninterrupted one-hour soak and MacBook synchronization remain
open. This is private-chain financial evidence, not mainnet/TPS/parity readiness.
