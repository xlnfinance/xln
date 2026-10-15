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
