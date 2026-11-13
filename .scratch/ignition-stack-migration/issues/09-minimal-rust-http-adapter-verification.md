# 09: Verify the existing Rust Stack Manager request adapter before commit

Type: implementation
Completed: yes
Status: ready-for-human
Category: enhancement
Blocked by: None
Created: 2026-11-13
Updated: 2026-11-13

## What to build

Provide narrow verification evidence for the existing Rust HTTP adjustment to
the current private TS-worker contract. The adjustment already existed before
08: accept `{ request, execution }`, read the signer from `request`, and forward
the explicit deployment ID and new/resume intent to the same implementation.

This is a separate integration obligation before including these coupled
changes in a commit. It does not block CLI recovery tickets 04–07 or establish
that the standalone CLI needs a Rust daemon.

## Acceptance criteria

- [x] Record the exact candidate/diff and confirm which Rust and private-worker changes form the coupled request boundary. Preserve existing work and previous evidence.
- [x] Compile the affected Rust process crate with its existing toolchain/dependencies and record the exact command and result. A compilation failure is retained as evidence, not hidden by excluding the file.
- [x] Focused tests exercise the production Rust envelope validation and worker-input construction. Valid new/resume intent and signer sourcing agree with the actual TS-worker contract; incomplete, unknown or retired flat input is rejected with the owning error.
- [x] Keep admin authorization and Runtime-owned signer authority. Private key material stays on private IPC rather than HTTP responses, argv or logs. Use fixture credentials only.
- [x] Verify the Rust-to-worker boundary with owning checks that perform no public deployment or transfer. No mock financial executor, new deployment engine or invented compatibility reader is introduced.
- [x] Preserve one coherent request contract when preparing a commit. Dropping only the Rust adjustment while keeping an incompatible worker change does not count as isolation.
- [x] Retain commands, counts, source identity, coverage limits and remaining unrun checks. The green deployment profile alone is not presented as Rust HTTP verification.

## Scope and verification

Keep this to the existing HTTP adapter and affected process-crate build. A
whole Rust-engine migration, parity campaign, new HTTP capability, UI work or
real deployment is outside this task. Any newly discovered need beyond that
boundary is reported before expanding the work.

The owner selected this task on 2026-11-13. Its implementation authorizes no
commit, push, source reset or deletion.

## Verification

Verified on MacBook-Pro-5.local under the existing owner exceptions, on dirty
`testnets_deploy`, HEAD `019d45beb5954e77fe806d643845f6a4dca4fa82`. No dependency,
manifest, lockfile, TS-worker, UI, Solidity or unrelated source change belongs
to this task. The Rust route now calls its extracted production envelope/input
helpers and the same private-worker runner; accepted/rejected behavior and
Runtime custody authority are unchanged.

| Check | Result |
| --- | --- |
| Process crate `cargo check` and `cargo build --bin xlnrs --locked --offline` | Passed |
| `cargo test --lib ... runtime_http::stack_manager::tests` | 7 passed, 0 failed/ignored |
| Existing dual-J genesis and Runtime signer-custody test | 1 passed; owned signers resolve and foreign signer rejects |
| `bun test core/__tests__/orchestrator/stack-manager-routing.test.ts` | 2 passed, 10 assertions |
| Owning `rustfmt --check` and `git diff --check` | Passed |
| Fresh `bun run check:deployment` | 6/6; 274 Hardhat, 64 Foundry, 40 Bun / 497 assertions |

All execution used the capacity-one stand lock. Rust tests invoke the real Bun
worker nine times through the production process runner. A non-serving local
TCP listener observes zero RPC connections for missing resume identity, invalid
execution/request fields, injected request keys and new-mode signer/Foundation
mismatches. Unit vectors also cover exact outer fields, nested signer selection
and unchanged new/resume forwarding. No financial executor or RPC response is
mocked. The production Runtime-custody fixture supplies the separate authority
check; a hand-supplied worker fixture key is not treated as proof of custody.

The initial binary-test filter matched zero tests and is not counted as semantic
evidence; the correct library target ran the seven tests above. Three existing
warnings in `entity-kernel` remain unchanged. No unrelated Rust cleanup was made.

Exact commands and owned source hashes are in the compact
[verification result](../../../docs/evidence/rust-deployment-adapter-20261113/result.json).
The [fresh deployment profile](../../../docs/evidence/deployment-check/2026-11-13T13-39-00.382Z-7188/result.json)
records its own source/artifact hashes and logs. These are new results; deleted
historical artifacts were not restored.

After the successful profile, its completed local fixture directories were
removed in accordance with the owner's cleanup preference. The two compact
result records and profile logs remain; raw local financial receipts and
compiler snapshots are not retained. This is test verification, not a retained
public deployment/recovery archive.

Commit preparation reproduced `ENOENT` when two tests assumed the evidence
parent directory already existed. Both test entry points now create that
directory before `mkdtemp`. Starting with the parent absent, the focused fresh
test passed 1/1 (39 assertions), the two resume tests passed 2/2 (83 assertions),
and the refreshed deployment profile passed 6/6 with the same suite counts.
Production deployment behavior and the Rust source verified above are unchanged.

The full Rust parity suite, full HTTP/UI/browser integration, repository-wide
check, public networks and recovery matrices 04–07 were not run for this task.
This verifies the existing caller boundary; it does not establish public
deployment or whole-product release readiness. No commit, push or public send
was performed.

## References

- [CLI recovery boundary](../spec.md#cli-recovery-boundary-owner-decision-2026-11-13)
- [Deferred application integration](../../stack-manager-http-integration/issues/01-deferred-http-ui-integration.md)
- [Existing Rust adapter](../../../rscore/crates/process/src/http/stack_manager.rs)
- [Private TS worker](../../../core/api/server/control/stack-manager/native-worker.ts)
