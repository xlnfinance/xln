# Mainnet engineering principles

These are permanent constraints, not tasks. They do not belong in the active
TODO and cannot be “completed”.

- Keep one implementation, persisted format and version. Before mainnet there
  are no legacy paths, fallback readers/writers or parallel financial formulas.
- Keep RJEA pure and deterministic. Runtime enforces policy, WAL commit precedes
  dispatch, failures are loud, finance uses canonical bigint reducers and
  frozen-core changes require owner approval.
- Derive Runtime signers immediately from the seed. Entity threshold
  multisigners are the custody boundary; Runtime policy is not duplicated in an
  HSM.
- Recovery trust order is operator backups, watchtowers, then hubs. Peer state
  is neither authority nor an automatic dependency.
- Mainnet has no artificial deposit cap or hidden amount branch. Safety comes
  from invariant proofs, audits and explicit unsupported-software disclosure.
- Mutable compact binary storage paths are authoritative locations. Hashes are
  integrity checks, never content-addressed routes; values rebranch only when
  they exceed the typed physical size boundary.
- Completed work is removed from `todo.md`; immutable commits, tags and release
  evidence preserve history.
- Every external audit is verified against the current reachable code before
  action. Add only confirmed, still-open mainnet work to `todo.md`; reject false
  positives and do not re-add fixes already proven by tests and immutable
  commits.
