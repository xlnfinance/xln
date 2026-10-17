# Let the orchestrator finish its owned shutdown

Base main: `77c81b9786ce818769df6c5925c119be0a878e76`.
The real public testnet runtime used for these drills is clean
`33260898b968f1b6c70ea0b702048f1997598466`, on scoped Bun 1.4.0.
Only its PM2 supervision configuration changes during the experiment.

The prior normal restart emitted MM `quiesce.post_failed`. Actual PM2 metadata showed
`treekill=true`, no process kill timeout, and no daemon override of the installed
1,600ms default. Installed PM2 source confirms that tree killing signals children as
well as their parent. This races the orchestrator's explicit child quiesce requests.
The current normal shutdown budget is HTTP drain5s + child quiesce5s + pause150ms +
two20s child termination deadlines =50,150ms. Parallel custody termination takes at
most two5s deadlines, so it does not enlarge that current bound.

Both canonical deployment branches now start xln-server with `--no-treekill` and
`--kill-timeout 60000`. PM2 signals the orchestrator; the existing orchestrator then
quiesces and terminates its exact children. Existing parent-liveness watches remain
unchanged for hubs, MM and the two custody processes. No financial, storage, signing,
worker, RPC-policy or contract implementation changes. The ordinary verification
budget remains60s; the PM2 service shutdown grace is not a test timeout exception.

## Before and after

- The real PM2 policy assertion failed in1.047s before the fix. It then passed in
  1.416s, verifying parent-only signalling, adequate grace and all7 former runtime
  process IDs gone. Installed PM2 applies the two configuration fields before the
  restart's stop operation; the exact service environment and other settings were
  verified unchanged. Unrelated PM2 owners and protected seed/key files were unchanged.
- Real ordinary restart passed in40.497s. Quiesce refusal/failure, forced child kill,
  shutdown-failure, NAPI fatal, Bun crash and panic markers were all zero. Exact
  historical Runtime frame hashes/state hashes and Account states, plus current
  financial roots/balances/credit, matched for H1/H2/H3 in6.862/4.328/17.105s.
- A separate fault drill sent SIGKILL only to the exact birth-verified orchestrator
  PID. PM2 and the existing canonical child recovery paths restored readiness in
  42.426s. All7 old process identities disappeared; unrelated processes and protected
  files were unchanged. NAPI/crash/panic/shutdown-failure markers were zero.
- After that fault, H1/H2/H3 comparisons passed in6.105/4.746/16.639s. Each drill
  preserved23 Account views; the one new custody credit-policy frame per hub links
  the previous frame and leaves the financial root unchanged. Views include paired
  hub Accounts and are not counts of unique economic operations.
- Existing quiesce/checkpoint and process-lifecycle suites passed30/30 with115
  assertions in1.130s and0.321s. These are related L1 evidence, separate from the
  actual managed Linux fault/recovery drills. Final exact-source operator health
  passed0.853s:3 hubs, self relay,1 tower,0 open incidents.

PM2 saved the two settings after the drills. Its original dump and environment are
preserved privately outside source; neither their content nor raw databases are in
this evidence archive. No stores were reset, no existing format was restored, and no
incident records were cleared. The most recent stopped current-format backups remain
preserved on both hosts from the preceding pinned-runtime drill.

The deployed runtime source remains33260898b; this source change makes the validated
settings canonical for subsequent deployments. The whole host-wide deployment command
was not executed. Unchanged browser evidence is public HTTPS8/8 with real Account
workers from the preceding pinned-runtime slice. There is no new browser/runtime bundle.

These bounded comparisons do not replace ordered-outbox replay, loaded in-flight
crash testing, the required uninterrupted soak, or public Sepolia financial/dispute
proofs. Public reserve broadcast403 still awaits the owner RPC-policy decision.
Aggregate release/full-browser gates, compatible rollback and MacBook catch-up remain
open. Commands, exits, durations and repeatable bounded procedures are in the archive.
