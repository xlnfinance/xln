# Runtime bridge reconstruction

Purpose: reconstruct the active xln runtime from code and executable evidence,
then determine exactly which cross-chain bridge capabilities are complete,
partial, unverified, or missing.

## Method

For every subsystem, record its responsibility, state, inputs, outputs,
authorization, replay protection, failure behavior, persistence, tests, and
bridge relevance.

Use these evidence levels consistently:

- `IMPLEMENTED`: an active code path exists.
- `TESTED`: focused assertions cover the path.
- `INTEGRATED`: the path is connected across subsystem boundaries.
- `E2E_PROVEN`: a multi-process or multi-chain test demonstrates it.
- `PRODUCTION_PROVEN`: deployment evidence demonstrates it under realistic operation.

## Reconstruction plan

1. **Inventory and vocabulary**
   Map active directories, entrypoints, types, codecs, hashes, domains, and nonces.
2. **Financial core**
   Reconstruct Account transactions and consensus: payments, HTLCs, pulls,
   swaps, holds, ACKs, disputes, and settlement proofs.
3. **Entity and cross-j orchestration**
   Trace Hanko creation, cross-j route states, orderbook receipts, fills,
   clears, claims, salvage, and timeout paths.
4. **Runtime and networking**
   Trace deterministic frames, persistence-before-side-effects, local/remote
   routing, signed discovery, direct WebSockets, relay delivery, encryption,
   retries, and topology enforcement.
5. **Jurisdiction and contracts**
   Trace J batches through Hanko authorization, RPC submission, Depository,
   DeltaTransformer, chain watchers, finality, and events folded back into state.
6. **Storage, recovery, and operations**
   Verify restart recovery, active-route restoration, Hanko/secret retention,
   watchtowers, relay failure, health gates, and deployed topology.
7. **Executable evidence and conclusions**
   Map every bridge invariant to tests, run the narrow-to-broad evidence ladder,
   produce the final architecture map, capability matrix, threat model, and
   confirmed gap register.

## Planned artifacts

- `architecture-map.md`: subsystem and end-to-end execution maps.
- `capability-matrix.md`: implementation and evidence status per capability.
- `findings.md`: stable findings with code and test evidence.
- `threat-model.md`: actors, assets, trust boundaries, and failure cases.
- `final-assessment.md`: bridge decision, blockers, and prioritized roadmap.
- `netting-experiment.md`: experiment design, implementation decisions, and findings.
- `test-evidence.md`: commands, results, blockers, and deployment evidence.

## Current progress

- Initial inventory and protocol vocabulary: complete by static reading.
- Account HTLC/pull/consensus slice: complete by static reading.
- Entity consensus and cross-j orchestration: complete by static reading.
- Runtime machine and networking authorization boundary: complete by static reading.
- Jurisdiction submission, contracts, watchers, and finality: complete by static reading.
- Storage, restart recovery, active-route restoration, and operations: complete by static reading.
- Final synthesis, threat model, and bridge readiness decision: complete.
- Netting experiment rebalance-control trace: complete by static reading.
- Executable evidence and deployment verification: intentionally deferred.
- Executable evidence: intentionally deferred.

Generated bindings, archived implementations, BrowserVM compatibility code,
and frontend presentation remain out of the primary reading path unless an
active production path references them.
