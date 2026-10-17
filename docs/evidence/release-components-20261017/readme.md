# Current release component evidence

Candidate: `3c093db9098824efe2ce613dd4d75bcd26e3363a`.
Production source stayed unchanged throughout these commands. The initial browser,
build and epoch-rotation commands ran on a clean tree; later commands had only the
CURRENT reflection in `docs/night-work-plan.md` modified. These are component
results, not a clean aggregate release or mainnet-readiness claim.

[Results and exact commands](results.json) bind all 19 commands to full log hashes.
[Original command logs](command-logs.tar.gz) retain all exits, including three
timeouts. No thresholds, assertion counts, scenario sizes or time limits changed.

| Boundary | Actual result |
|---|---|
| React onboarding and ownership, separately | 1/1 each; 29.078 s and 37.204 s |
| React production build and artifact browser | 2.865 s; 1/1 in 37.878 s |
| H1/H2/H3/MM storage epoch rotation and subsequent WAL | 29.118 s; all four verified |
| Multi-sig determinism | Two identical 169-frame runs; 13.382 s |
| Five remaining oracle scenarios | Five matching run pairs; 34.922 s |
| Real WebSocket relay/direct payment | Settled; 5.677 s |
| RPC system scenarios | 4/4; 16.396 s |
| Storage 10k acceptance benchmark | 1.298 s; original memory/read/write bounds retained |
| Mainnet deterministic money/health policy tests | 61/61; 20,769 assertions; 0.694 s |
| H2 process replacement browser | 1/1; 33.951 s; strict browser health |
| Existing rapid-fire/cross-J/MM scenarios, separately | 8.030 s / 10.187 s / 25.145 s |
| Existing Foundation release Hanko | Version 0.1.31 signature verified; 0.181 s |

H2 is killed only inside the isolated production stand. The test requires health
to become non-ready, a durable incident, a new PID with increased restart count,
the same Entity, and exact restored book depth. This is current-format crash
recovery evidence, not public deployment or rollback evidence. The Foundation
signature check verifies its existing catalog entry, not a new attestation of this
candidate. Cross-J's existing scenario reached its asserted cancellation outcome;
it is not claimed as a completed cross-chain trade. Rapid-fire is not HLT TPS.

## Open gates

- Aggregate determinism timed out at 60.095 s during multi-sig. Its separate
  unfinished scenarios passed; this does not convert the aggregate exit to green.
- All-scenarios ran 16/19 successfully before timeout at 60.034 s; the remaining
  three passed separately. The aggregate remains red.
- Full strict browser E2E enumerated 144 targets but timed out at 60.856 s before
  test results. Full browser coverage is not established by this run.
- Earlier complete React payment/dispute/recovery groups also remain timeout-red.
  The request to allow the five existing React groups their 240-second budgets
  is unanswered; no exception was used.
- Public Sepolia/operator/rollback evidence, the required uninterrupted one-hour
  soak, the final reproducible operator package, and MacBook catch-up remain open.

All timed-out owned groups were confirmed stopped and the capacity-one stand free
before subsequent heavy commands. Local data and browser artifacts remain under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`. Public-node inspection
was read-only: obsolete private-Anvil data has not been reset or deployed over.
