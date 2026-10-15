# Local wallet walkthrough — 2026-10-14

Target requested by the owner: `http://localhost:8081/app`.
Starting source: `0b4b8da30` (clean main before this walkthrough).
This URL serves the Svelte wallet in `frontend/`, not the React release wallet.
The owner explicitly requested fixes on this local surface. No release scope,
password policy, encryption or financial behavior was changed.

## Confirmed bugs and repeat results

| Bug | Reproduction and expected behavior | Fix and repeat result |
| --- | --- | --- |
| Password setup ignores the selected light scheme | Select Light, Mnemonic, Generate 24-word seed, Continue. The screen unexpectedly becomes dark. | Pass the existing scheme to the password form and use the existing theme tokens. Repeated in light and dark; text and fields retain readable contrasting colors. |
| Password setup has no return action | Continue with a generated seed. There is no way to return to choose another creation method without reloading. | Back uses the existing reset path, clears the unsaved derivation and pending continuation, and returns to the creation choices. Repeated twice; seed field is empty and Continue is disabled. Cancellation remains disabled during password persistence. |

The first theme patch exposed a second part of the same bug: global form styles
still forced dark input backgrounds. Reusing the existing `--theme-input-*`
variables corrected the fields as well; no global style override was added.

Before/after screenshots:
- [Light selection previously opened a dark form](evidence/user-walkthrough-20261014/light-password-before.png).
- [Corrected light form and Back action](evidence/user-walkthrough-20261014/light-password-after.png).
- [Corrected dark form](evidence/user-walkthrough-20261014/dark-password-after.png).

## Verification and limits

- Actual UI actions: switch creation method, expand advanced controls, generate
  disposable seeds, continue, return, select both schemes and reload. Light
  selection persists across reload. No captured browser warnings/errors.
- Existing onboarding/password tests: 6 pass, 0 fail, 17 assertions. They check
  the existing creation surface and encryption behavior, not authenticated journeys.
- Full source checking exposed four unused type exports from the earlier batch
  split. Removed only the unused barrel exports and made `JBatchStatus` private
  to its owner. No runtime implementation or type shape changed.
- Full `bun run check` passed after that cleanup: 38 source gates plus frontend
  validation/build and React types. Source phase: 25.412 seconds. The focused
  and full-check logs are retained in
  [verification.tar.gz](evidence/user-walkthrough-20261014/verification.tar.gz).

Authenticated journeys remain **unverified**: funding, payment, receive, swap,
balances, Account management, dispute/exit, backup/recovery, activity and settings.
Browser-tool policy requires manual entry/submission of a new local password.
The owner declined that handoff; do not bypass authentication, populate browser
storage, or report these journeys as passed. No password was entered, no wallet
was funded, and no financial transaction was sent. No more questions were asked.

Next executable UI step requires an already-open test wallet. The task is partial;
this report does not claim perfect behavior or mainnet acceptance.

## Payment-status read race — 2026-10-15

Owner report: `STORAGE_DIRECT_HISTORICAL_READ_FORBIDDEN`, requested Entity
state 101, materialized state 201, checkpoint 1. Starting source: `69f3dd47a`.
This error is a failed receipt read; it does not establish payment failure.

The Svelte View bypassed RAdapter only in embedded mode and called the storage
journal reader directly once per height. Repair can select a materialized replay
base that the unblocked frame writer replaces before restoration. The remote
and React receipt paths already hold the RAdapter committed-read lease.

Removed the 23-line embedded bypass and wired the existing frame-receipts
reader into the embedded adapter. Both modes now use one bounded receipt query
under the existing lease. Storage guards, payment execution and persisted data
are unchanged; no transfer was repeated.

Verification:
- 21 tests passed, 94 assertions: activity/recovery and terminal-monitor suites.
- Extended the existing real LevelDB concurrency regression: lost receipt view,
  historical replay, queued checkpoint writer, exact returned events, then
  successful writer completion and a readable next receipt.
- `bun run check` passed (38 source gates, Svelte validation/build, React types).
- Local Vite page reloaded without captured console errors. The available
  browser tab is at wallet creation, so the owner's authenticated payment and
  its balance remain unverified. Do not interpret this as a live payment pass.

NEXT: read the original payment receipt in the existing unlocked wallet after
loading this fix; do not submit the payment again.

## One-click network testing — 2026-10-15

Owner explicitly requested removing password/seed ceremony from network testing.
Starting source: `0fb738a68`. Local `/app` now starts with **Open test wallet**;
manual BrainVault and mnemonic entry remain available under the secondary action.
This is a change to the requested local Svelte surface, not a second release wallet.

Removed the disposable BrainVault password generator. A new test identity uses
256 bits of cryptographic entropy and the existing Runtime creation path, with
the existing encrypted device-key storage and a non-expiring local unlock lease.
No shared password, plaintext seed storage, alternate runtime or financial logic
was added. Existing password-protected wallets still require their own secret.
Test creation and bootstrap/reopen reject jurisdictions other than the local
Anvil pair (31337/31338) and Ethereum Sepolia (11155111). Clearing browser data or
explicitly locking a test wallet can make it unavailable without its recovery seed;
the entry screen explicitly describes disposable, browser-local storage.

The first reload exposed a second UI gate: `/app` required a password record even
when the device key had successfully restored the test identity. Corrected that
gate for `loginType=demo` only; a missing seed still requires unlocking.

Browser observations on the final working candidate:
- One click opened a new wallet without a credential field or seed confirmation.
- Reload reopened the same Entity `0x94dbb2b187fd368c5f69cdc3a2f36976de777fbc493446305a6452443117db9d`.
- The local Reserve faucet credited 100 test USDC. Another reload retained the
  same Entity and 100 USDC reserve. Available-to-pay remained zero: reserve has
  not yet been allocated to an Account.
- Assets, Pay, Receive and Swap forms opened. Empty Pay submission remained
  disabled. No payment or swap was submitted, and no original payment was repeated.
- Personal-wallet entry, mnemonic tab, Back to test network and Back to wallet
  worked; the funded wallet remained selected. Seed security details are collapsed.
- No captured browser console errors on the reload.

Verification: 17 focused tests, 64 assertions, zero failures; complete
`bun run check` passed, including all 38 source gates, frontend checks/build and
React types. These were development-candidate runs, not clean-SHA release evidence.
[Checks](evidence/user-walkthrough-20261014/quick-entry/verification.tar.gz),
[entry](evidence/user-walkthrough-20261014/quick-entry/entry.png),
[funded wallet after reload](evidence/user-walkthrough-20261014/quick-entry/reopened-funded-wallet.png).

The original Chrome wallet was located but remains password-locked; its original
payment is still unverified. Recovery UI now omits random-secret/new-seed generation
when restoring an existing wallet, and a failed password submission restores input
focus; those two recovery changes have compilation coverage, not a completed live
recovery proof in this pass.

Method correction: distinguish a saved-wallet recovery journey from disposable
network testing. Prove create → reload → same identity → funded reload before
expanding the test list. Do not mistake opening a form for completing its operation.
Next: connect the new test wallet to H1 and exercise Account funding and receipts;
never resend the owner's original payment.
