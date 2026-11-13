# 01: Define and deliver Stack Manager application integration separately

Type: implementation
Completed: no
Status: needs-info
Category: enhancement
Blocked by: None
Created: 2026-11-13

## What to build

This deferred follow-up owns further Stack Manager application integration:
the TS/Rust HTTP callers, their application lifecycle and any wallet UI work.
The standalone Hardhat task remains the shared deployment implementation.
This record creates no requirement to keep, expand or remove either HTTP
adapter before the owner defines the intended application behavior.

It is outside the current CLI recovery scope and is not a blocker of tickets
04–07. The existing Rust request-envelope adjustment has its own small
pre-commit verification task; it is not evidence that this feature is complete.

## Information needed before implementation

- Which backend entry points and operator/user-facing actions must be supported?
- What HTTP request, authorization, status, cancellation and interrupted-session behavior is required?
- Is wallet UI delivery required, and what are its owning browser acceptance flows?

The owner must settle these requirements before this ticket becomes
`ready-for-agent`. No new HTTP/UI implementation starts from this deferred
record alone.

## Acceptance constraints for the eventual specification

- Reuse the standalone task and canonical Ignition executor; application callers do not own another financial implementation or transaction journal.
- Preserve coherent request/authority boundaries across the selected backends and private worker, with their own Rust/TS/HTTP checks.
- Define any UI acceptance explicitly and apply the broader verification scope when application behavior is changed.
- Keep public deployment, signing and release activation subject to their existing authority and evidence gates.

## References

- [Standalone CLI recovery boundary](../../ignition-stack-migration/spec.md#cli-recovery-boundary-owner-decision-2026-11-13)
- [Minimal existing Rust adapter verification](../../ignition-stack-migration/issues/09-minimal-rust-http-adapter-verification.md)
- [Deployment design](../../../docs/deployment/ignition-stack-design.md)
