# TODO

## Frontend Follow-Ups

1. `EntityPanelTabs` reserve-to-collateral currently deposits 100% of token reserve.
   File: `frontend/src/lib/components/Entity/EntityPanelTabs.svelte:817`
   Task: add partial-amount input + percent presets (25/50/75/100) and keep current one-click as a shortcut.

2. Standardize mutating UI paths on `enqueueEntityInputs` wrapper.
   Files: `PaymentForm/CreditForm/CollateralForm/SwapPanel/AccountPanel` still use direct `enqueueRuntimeInput`.
   Task: use one ingress API for consistent validation/logging and easier future auth hardening.

3. Improve decimal parser UX in settlement text input.
   File: `frontend/src/lib/components/Entity/SettlementPanel.svelte`
   Task: accept transient states like `.5`, `100.`, and normalize on submit.

4. Self-route behavior should be explicit.
   File: `frontend/src/lib/components/Entity/PaymentPanel.svelte:978`
   Task: default recipient selector to exclude self, add explicit "allow self-route" toggle.

5. `SettlementPanel` transfer still goes through direct on-chain `submitReserveToReserve`.
   Task: decide whether this should stay as direct chain call or be routed through entity-tx + quorum flow for consistency.


## Multisigner-First Plan

Goal: treat single-signer as `1-of-1` special case of full entity quorum, not a separate auth model.

1. Define one authorization envelope for all entity actions.
   - Include: `entityId`, action hash, quorum hanko, nonce/domain.
   - Remove semantics where `signerId` implies authorization.

2. Keep proposer as coordinator only.
   - Proposer can propose/collect/precommit.
   - Proposer alone must not authorize state-changing entity actions.

3. Make ingress verification quorum-aware.
   - Validate hanko against entity board + threshold for every action class (`openAccount`, `payment`, `settle`, `credit`, `collateral`, `dispute`, `j_broadcast`).
   - Reject proposer-only auth in non-demo paths.

4. Unify signing APIs around quorum primitives.
   - Replace single-signer helper usage in action paths with quorum signing/aggregation flow.
   - Keep single-signer convenience only as config-level threshold (`1-of-1`), not separate code path.

5. Tighten board-of-record for verification.
   - Prefer local replicated board config.
   - Explicitly define fallback rules for first-contact/gossip cases.
   - Ensure replay determinism and no implicit trust of stale metadata.

6. Migrate J-batch auth to strict entity quorum.
   - Ensure every batch submit path uses validated quorum hanko.
   - Remove implicit proposer signing assumptions in batch broadcast helpers.

7. Add tests for complex boards.
   - 1-of-1 parity tests (must keep current behavior).
   - 7-of-10 happy path.
   - insufficient quorum rejection.
   - circular board claim validation.
   - proposer compromise simulation (must fail without quorum).

