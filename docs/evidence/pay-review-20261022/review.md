# Pay review verification — 2026-10-22

Base source: `8eabe6419102a236edb169f1bebe89a498c82bc6`.
Claude Opus 5.5 reviewed one immutable Pay packet through the existing Studio
Claude Max subscription, with source tools and MCP disabled. The CLI returned
`error_max_budget_usd` at a self-imposed estimate cap. Its completed assistant
answer was recovered from that exact session and independently checked. This is
not a successful four-packet audit or final release approval. Reported USD
1.551391 is a list-price estimate, not an invoice; no paid API was authorized.

## Independently verified findings

- F1, confirmed subset: decoded inbound HTLC zero/negative amount or timelock,
  or zero reveal height, reached prepared-context validation as unattributed
  errors. `core/paybook/materialize-context.ts` now validates the binding at the
  exact AccountInput boundary, using the existing checks extracted from
  `core/paybook/prepared-context-validation.ts`. Only input validation is wrapped;
  cryptographic and storage failures retain fail-stop semantics. Regression
  vectors assert exact input identity, deterministic invalid-ciphertext rejection,
  and consensus certification of an honest sibling after the malformed input.
- F3, confirmed: equal raw originating payments were rejected after the per-input
  attribution boundary. `core/paybook/payment-admission.ts` now detects the later
  duplicate inside that boundary. The signed atomic command regression verifies
  rejection, nonce reuse by the valid replacement, exact sender/recipient money,
  persisted accepted inputs and checkpoint/WAL recovery. Prepared-entry sorting
  and financial output ordering are unchanged. Removing the old loop removes
  three non-null assertions; the static debt allowance is tightened from 613
  to 610, with its canonical count hash updated.
- F2, refuted at the actual wire boundary: the proposed uppercase hashlock
  already fails `validateHtlcLock` in `core/account/tx-validation/special.ts`.
  The existing uppercase decoder regression passed without a production change.
- F4, reported exploit refuted: the relay does invoke its hook for stale profiles,
  but `core/api/server/index.ts` delegates to gossip admission. `installProfile`
  in `core/network/p2p/gossip/index.ts` retains the newer timestamp. The route
  signature in `core/entity/profile/profile-signing.ts` covers runtime identity
  and freshness, and is verified even on certification-cache hits. An independent
  real-signature probe retained timestamp 200 after replaying 100 and rejected
  modified runtime identity as `runtime_signature_invalid`. No speculative patch.

## Evidence and limits

`verification.json` records exact commands, receipt/log hashes and per-run source
hashes. The final focused run passed 20 tests, 89 assertions, zero failures in
31.44 seconds under the one-stand lock. The F3 signed recovery regression passed;
F1 consensus eviction is covered, but no claim is made of a dedicated F1 hostile
WAL replay. Private logs and stores remain outside public Git.

These are diagnostic receipts on the stated base plus working changes. The new
committed candidate still requires the mandatory complete final financial,
unit/test/check, full158, release34, uninterrupted60min, public chain and UI gates.
The other three Opus packets and review of the stabilized fixes remain outstanding.
