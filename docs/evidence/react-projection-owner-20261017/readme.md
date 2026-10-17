# Observer cannot evict the React Runtime owner

Base main: `9b098e190c6c2a7af22284f91bf371be6841b273`.
The existing root browser case failed28.354s while waiting for a Runtime lease
immediately after `/app`. That entry now opens React's locked wallet; ownership
requires successful password authentication. The old test also navigated between
wallet and `/address` as if both belonged to the retired Svelte wallet shell.

The case now imports through the real React wallet UI and reads its current typed
adapter inspection. Same-document Manage/Home navigation preserves the wallet's
Entity and Runtime. A separate `/address` observer must show its directory heading
and `LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB`, including after an explicit Refresh.
The scenario/observer `locktest` routes remain; no wallet fallback was restored.

The next actual run failed26.023s because the deployed observer intentionally omits
its development adapter surface. The original optional-chain assertion had treated
absence of that surface as evidence of disconnection. It is replaced by actual
browser authority and transport observations: one exclusive `xln-active-runtime`
Web Lock with the identical client ID, unchanged connected wallet Runtime, no
observer ownership marker, no observer relay connection and no observer worker.
The original1.5s observation interval remains after Refresh. A missing Web Lock
snapshot is a loud test failure. No mock, fake connection, conditional skip or
production implementation change was introduced.

The actual revised browser case passed1/1 in28.724s; every strict browser-health
counter was zero. `proof.json` records the real before/after lock and Runtime IDs.
Owned-file strict TypeScript initially caught an optional Web Lock snapshot field;
explicit validation fixed it, yielding0 diagnostics in4.504s. Formatting is limited
to the changed helper and case. The original directory-heading assertion remains.

Related unchanged browser cases on the clean base passed: storage writer
serialization/stale-writer fencing1/1,29.779s, and observer/scenario tab takeover
1/1,17.121s. These are separate bounded cases, not a full-suite result. The already
published React authenticated takeover/drain proof remains unchanged.

Exact commands/exits, failed and successful run manifests are archived here.
Final check, clean committed browser and installed verifier/publication results
are recorded under the existing autonomous job's `evidence/projection-owner-*`
and `projection-owner/clean-head/` artifacts. No financial formula, contract,
WAL format, crypto, runtime build or production route changes. Aggregate release,
full strict browser, public Sepolia, backend rollback and uninterrupted soak
requirements remain open.
