# 03: Resume and idempotent completion

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 02
Created: 2026-11-12

## What to build

An operator resumes an interrupted Stack Deployment using its existing identity, candidate and journal. Already-mined operations are recognized, the canonical listing retains its original authority, and a completed attempt returns the same verified result without spending again, including after a crash during final catalog publication.

## Acceptance criteria

- [x] A resume requires existing valid attempt identity and native Ignition evidence. Missing, abandoned or mismatched state fails before spending; no retry allocates a new identity or silently starts fresh.
- [x] Through the production Stack Manager on real local Anvil, SIGKILL after operation four has mined but before receipt observation resumes to eleven successful intended operations without repeating any creation.
- [x] The equivalent operation-eleven cut resumes with zero new transactions, identical Hanko bytes/action hash, one token listing and Foundation nonce one, even when current on-chain Foundation nonce is already one.
- [x] Select the base or full graph from journal-derived successful creations; never omit a listing Future that has started. Only Ignition controls transaction completion/resubmission; audit exports are not a second scheduler.
- [x] Reproduce the selected recovery cases with a nonzero initial EOA nonce and different deployment addresses, demonstrating that recovery is not tied to default local CREATE predictions.
- [x] A completed rerun re-verifies and returns the same stack without sending. Missing manifest or interrupted result output is reconstructible from the sealed identity, journal and current receipts.
- [x] A crash after atomic catalog publication but before final completion resumes successfully for the identical attempt/result; a conflicting existing entry is rejected without overwrite. Preserve unrelated entries and existing publication authority.
- [x] Cover cuts between base completion, Hanko construction and full-graph execution, and between verification, manifest creation and catalog completion. The real catalog remains absent until verification succeeds at the selected depth.
- [x] Preserve per-invocation outcome and evidence for the original interruption and resume; failure is reported explicitly rather than as an unexplained indefinitely running result.

## Scope and verification

Use real process termination and the same local node/journal across restart. The resolved throwaway prototype is prior evidence, not a substitute for these production-seam scenarios. No automatic wipe, Fresh Stack Deployment or public attempt recovery belongs here.

## References

- [Migration spec](../spec.md)
- [02: Fresh Stack Deployment](02-fresh-stack-deployment.md)

## Comments

2026-11-12: Owner-approved slice; begins after ticket 02 is complete.

2026-11-12: All nine functional criteria completed on real local Anvil through
the production seam. Historical result: the owner deleted its local artifacts
and criterion/case map on 2026-11-13. The completed status and counts below
remain historical; fresh owning checks are required before the next deployment
or completion claim.
Final scoped patch SHA256:
`11737c2248c24e285b775171d00eab07266ec2f2c4e6280336fd908322b9d05b`.
HEAD/main remains `019d45beb5954e77fe806d643845f6a4dca4fa82`, dirty
`testnets_deploy`; owner-authorized MacBook execution, no commit or public
transaction. Recovery/fresh group: 22/22, 229 assertions; post-serializer
targeted group: 7/7, 78 assertions. Four runtime/type/vocabulary/folder-width
gates and the unchanged ESLint ratchet passed. Actual operation-four and
operation-eleven SIGKILL cases finish with eleven deployment transactions,
initial EOA nonces 1/4 and no duplicate creation/listing. Completed resumes
send zero new transactions. Independent internal Standards/Spec reviews and
the final raw-evidence check found no remaining material mismatch.
All 181 protected paths and 21 unowned baseline source files are unchanged.
`bun run check` was executed and remains red on unchanged validation test URL
examples at lines 137–138 and the existing `DockRoot.svelte:474` error;
cancelled gates and cleanup diagnostics were recorded in the deleted artifacts. This is implementation
slice completion, not release acceptance. Tickets 04–07 and public deployment
remain unstarted by this slice; no UI repair was made.
