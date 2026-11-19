# 01: Create a headless user and fund the source Account with one USDC

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: None (can start immediately)

**What to build:** a reproducible browserless scenario creates a dedicated user
vault, starts the canonical TypeScript Runtime, deposits exactly one USDC and
funds the user's bilateral source Account with its Hub. The operator can verify
the external debit and committed Account collateral through real contract
operations and authenticated jurisdiction observations.

## Acceptance criteria

- [x] Use the existing wallet's identity derivation: one dedicated vault, one
  user Runtime and distinct per-jurisdiction signers and lazy Entities. Establish
  the source Account through production admission and authenticated transport.
- [x] Run against a real-node local fixture with deployed contracts and a
  six-decimal ERC20. Reuse canonical Runtime commands, J adapters, signing,
  batching and storage; keep the financial path browserless and TypeScript.
- [x] Configure required user-to-Hub credit explicitly. Do not silently grant
  the wallet's 10,000-token default or increase credit automatically.
- [x] Approve only as required, deposit exactly 1_000_000 source atomic units
  from the external wallet and move them from reserve to the source Account
  through the canonical J batch. Reconcile the exact external debit, reserve
  movements and Account collateral credit from receipts and committed state.
- [x] Require authenticated J observation and bilateral Account commitment,
  with matching evidence and drained ACKs. A submitted transaction, reserve
  receipt alone or local H0 Account row cannot satisfy Account funding.
- [x] Demonstrate the complete slice with real signatures and production
  WAL/outbox ordering. Runtime debug funding, direct state mutation,
  impersonation and alternative financial formulas cannot establish success.
- [x] Report the first failing production boundary, known transaction identities
  and available balances accurately. Fix an observed divergence in its owning
  path and retain the smallest meaningful regression plus focused verification.
- [x] Keep signing secrets and credential-bearing RPC values out of arguments,
  logs and evidence. The scenario runs on the owner-authorized current computer
  under the repository's execution, stand and verification policies.

## Boundary

This ticket proves local production-equivalent source funding. Public financial
execution belongs to ticket 06. Frontend work and Solidity changes remain
outside the PoC.

## Verification evidence

The complete owning scenario passed on the owner-authorized current computer
in 15.6 seconds under the stand lock: exact one-USDC debit, zero final reserve,
one-USDC outgoing collateral, three successful receipts and matching bilateral
Account height 4/state hash with no pending frames or mempool work. Native
fees reconcile exactly for both the user and the existing local R2C sponsor.

The final executable candidate passed the applicable full check: 3 short gates,
38 source gates and 10 soundcheck gates; frozen-core and runtime types passed.
The runnable operator guide and retained local report identify the command,
raw receipts, balance blocks, source hashes and dirty base SHA. This is local
source-funding implementation evidence, not public Cross-J or clean-release
acceptance. No frontend, Solidity or financial-transition changes were needed.

Owner decision 2026-11-16 disabled mandatory three-AI/Claude/Z.ai review in the
repository policy. No external models were dispatched.
