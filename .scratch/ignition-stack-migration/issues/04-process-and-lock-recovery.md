# 04: Standalone task process, lock and lost-session recovery

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: 08
Created: 2026-11-12
Updated: 2026-11-13

## What to build

An operator can diagnose a lost native Hardhat execution session and invoke the same deployment safely without racing a live task, launcher descendant or competing writer. Standalone ownership is independent of any catalog or Stack Manager process.

## Acceptance criteria

- [x] Capacity-one stand execution remains mandatory for verification; no lock-disable path, new scheduler or independent background stand is introduced.
- [x] Protect deployment identity and the local signer/chain transaction lane for the whole operation. The same attempt cannot evade ownership through another parameter file or output location, and different IDs cannot compete for the same local sender nonce lane.
- [x] Closing or losing a calling session does not itself declare the actual Hardhat task dead. Track its owning process/group and relevant descendants sufficiently to distinguish live, interrupted and completed work.
- [x] A dead-owner diagnostic is reported as interrupted only after checking actual owning processes/groups. PID absence alone, a stale report or deletion of the journal cannot establish safe stale-lock recovery.
- [x] A live task left after launcher loss prevents a competing invocation; fully terminated ownership permits canonical stale-lock recovery while retaining original invocation evidence.
- [x] On interruption or timeout, terminate the exact owned process group and descendants before another measurement or send. Preserve unrelated processes, credentials, stores and job evidence.
- [x] Real local process/concurrency scenarios cross the native task interface. Losing invocations send zero transactions and cannot emit a successful result; resumed valid ownership uses the same native journal.
- [x] No catalog access is needed to lock or recover standalone deployment. Catalog locks remain solely with separate admission consumers; no abandoned-attempt import, journal wipe, reset or weaker authority check is introduced.
- [x] Acceptance exercises the native CLI/launcher and its actual execution owners. Rust HTTP-server, TS HTTP-controller and wallet-session lifecycles are outside this ticket; existing related adapter changes remain intact.

## Scope and verification

Build on the standalone fresh/basic-resume task in 08. Exercise its actual Hardhat process model instead of requiring the retired Bun-parent/Hardhat-child arrangement. Use owned local Anvil nodes and canonical stand execution. One implementer owns shared orchestration changes at a time.

Apply the [CLI recovery boundary](../spec.md#cli-recovery-boundary-owner-decision-2026-11-13).
Use `check:deployment` and owning process tests. The separate Rust adapter
verification is a pre-commit obligation only when including its coupled API
changes; it does not block implementing or validating this ticket.

## References

- [Standalone deployment specification](../spec.md)
- [08: Standalone Hardhat task](08-standalone-hardhat-stack-deployment.md)

## Comments

2026-11-12: Original intent was process/lock safety around the prior Stack Manager placement. Updated for the owner's standalone task decision; the catalog is no longer an execution resource. No new deployment daemon is required.

## Recorded verification

The final same-candidate `bun run check:deployment` passed 6/6 gates:
274 Hardhat tests, 64 Foundry checks and 93 Bun tests / 3,505 assertions.
HEAD was `696f6f0ac67003dfffbd5625376f2e3f60256274`, dirty, on the
owner-approved MacBook M5 / `testnets_deploy`. At verification time, 552 source
and 181 artifact hashes matched the checked candidate.

Owner decision 2026-11-14: generated local evidence files are excluded from these
commits. This note records measured results; historical case details cannot be
reconstructed from it. Runnable tests and verification commands remain. Future
active/public deployment evidence requirements are unchanged. No public
deployment or whole-product acceptance is claimed.
