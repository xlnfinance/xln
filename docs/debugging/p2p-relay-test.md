# P2P Relay Test Notes

## Scope
Notes for the multi-runtime relay scenario (`runtime/scenarios/p2p-relay.ts` and `runtime/scenarios/p2p-node.ts`).

## Credit Limit Semantics
- `extendCredit` writes credit to the **counterparty side** of the account.
- For a local account:
  - If **we are left**, our inbound credit is `leftCreditLimit`, and our own extension is `rightCreditLimit`.
  - If **we are right**, our inbound credit is `rightCreditLimit`, and our own extension is `leftCreditLimit`.
- When waiting for hub -> client credit, check our side.
- When waiting for client -> hub credit, check the opposite side (own extension) after ACK.

## Test Ordering (Avoid False Failures)
1) Wait for gossip profiles (runtimeId + public key) before openAccount.
2) Wait for account creation and ACK (no pendingFrame).
3) Wait for hub -> client credit to appear on **our side**.
4) Submit client -> hub credit, then wait for **own credit** to appear (opposite side).
5) Only then run capacity checks using `deriveDelta`.

Symptoms of wrong ordering:
- `leftCreditLimit=500000...` and `rightCreditLimit=0` while waiting for "own credit".
- `hubCreditLimit=0` in capacity check right after client extendCredit.

## Left/Right Determination
Use `account.proofHeader.fromEntity/toEntity` when available.
Fallback to `isLeft(entityId, counterpartyId)` only if proofHeader is missing.

## Local Test DBs
Use `db-tmp/` in repo root for temp DBs; keep it ignored in `.gitignore`.

## Environment Note
Some sandboxed environments block local socket bind (EPERM). Run p2p-relay locally for a real end-to-end check.
