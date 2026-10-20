# Browser scope and declaration requirements

The full browser run on `7c88796501ed1b5a139302c512309fc619704686` stopped
at **6 PASS, 1 FAIL, 151 not run, 0 skips**. Its failing Accounts Manage load
case expected the old Svelte wallet context switcher after `/app` had entered
React. React is the sole wallet under the current release scope.

The existing Observer can attach remote runtimes, but has no supported public
control to create the embedded local identity required by this old controller.
Its Wallet action opens React; the two interfaces use separate vault metadata.
No old reader, injected profile, hidden panel or restored wallet was added.
The unavailable UI-only browser contract is explicitly retired. The current
catalog has **157 active cases and 1 historical unresolved retired failure**.
Retirement is not a PASS. The original failure and later experiment are archived;
the current ledger failure remains byte-preserved by retirement and broad checks.

| Retired assertion                          | What it actually established                    | Continuing ownership / limit                                                |
| ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Configure tab and panel visibility         | Old Svelte navigation                           | No corresponding React product control                                      |
| Defaults, ranges and optional lane toggles | Widget values and copy                          | HLT CLI owns explicit workload configuration; no widget equivalence claimed |
| Start/Stop and disabled controls           | UI state                                        | Old test never proved cessation, settlement, drain or restart               |
| Progress and Attempted > 0                 | Scheduling/display activity                     | Existing controller scheduler L1 retained                                   |
| Skipped > 0                                | In-flight or capacity pressure, undistinguished | In-flight L1 retained; live exhausted capacity not proved                   |
| Submitted/Failed visible, STP nonnegative  | Metric rendering                                | Existing canonical STP/orderbook and HLT authority tests retained           |
| Three responsive screenshots               | Old panel layout bounds                         | Not financial completion or throughput proof                                |

A route-only experiment exposed another actual defect before UI navigation:
brace counting stopped at a multiline test's options object and disabled the
required market maker. Discovery now reads the complete TypeScript call at the
Playwright-reported declaration. A real, formatted Observer test covers both
MM/custody requirements, and adjacent cases prove requirements do not spill over.
The root catalog comparison found no change to the other 157 cases or requirements.

Broad E2E checks retain historical failures for removed source files without
recording a pass. Every existing source still blocks, including `ui/tests`,
`frontend/tests`, renamed test titles and cases excluded by a requested filter.
Malformed targets and unexpected filesystem errors remain loud. All three E2E
entry points use this rule. A read-only review found a two-read race; the final
assertion consumes the same decoded ledger snapshot used for classification.

Validation on the captured patch: **12/12 QA regressions, 33 assertions**;
**94/94 retained controller/HLT/orderbook units, 1554 assertions**; actual
Observer browser **1/1, 137.470 seconds, 0 skips/flaky and 0 console/network/HTTP
issues**. The Observer test's assertions are unchanged; its declaration is formatted
to exercise the reproduced parser defect. No financial runtime or public product
behavior changed. These focused checks do not certify the full browser suite,
release, soak, live load, public native TRON or mainnet.

[Proof, source hashes and private archive bindings](proof.json) preserve the exact
commands and limitations. Current `bun run check` and committed publication
remain separate gates, with committed-SHA verification stored by the normal hook.
