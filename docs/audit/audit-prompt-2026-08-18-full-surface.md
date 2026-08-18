# XLN full-surface re-audit prompt (2026-08-18)

Paste everything below the line into the auditor. Give it the repo at
`main` (`0d686c8ce` or later) — read-only, no code changes.

---

You are auditing **XLN**, an off-chain bilateral payment/settlement network
(TypeScript on Bun, Solidity L1). Audit the *current* code, not docs, not
memories, not prior audit reports. Every finding must cite `file:line` and be
reproducible from the tree. Do not repeat a prior audit's finding unless you
re-verified it against the current code (prior reports:
`docs/audit/audit-2026-06-16-deep-audit.md`, `docs/audit/audit-prompts-2026-07-02.md`,
`docs/audit/auditor-memo.md`; several of their items are already fixed).

## Architecture (read first)

- `AGENTS.md`, `docs/consensus-invariants.md`, `docs/architecture/`,
  `docs/audit-protocol.md`, `docs/mainnet-engineering-principles.md`.
- Trilayer cascade: **Runtime (R) → Entity (E) → Account (A)**, Jurisdiction (J)
  is the L1 view.
  - R: `core/runtime/` — `loop/` (single async loop, frame caps), `frame/`
    (process.ts, transaction.ts, lifecycle/ writer-lock/prepare/publish),
    `mempool/`, `admit/`, `command/` (adapter command frontier), `envelope/`
    (p2p lifecycle), `delivery/`, `recovery/`, `j-submit/`.
  - E: `core/entity/` — `consensus/` (input/consensus.ts, proposal/
    single-signer-frame.ts, infra-context.ts, frame/application.ts,
    validation.ts, state-root.ts, j-prefix/), `tx/handlers/`, `htlc/`,
    `profile/`, `command/`, `auth/`.
  - A: `core/account/` — `consensus/`, `commitment/state-root.ts`, `tx/`,
    `input/`, `htlc-deadline.ts`, `swap/`, `settlement/`, `dispute/`,
    `j-claims/`, `pull-registry-settlement.ts`, `crypto.ts`.
  - Signatures/governance: `core/hanko/` (signing.ts, claims.ts, batch.ts).
  - Canonical serialization / hashes: `core/protocol/serialization/`
    (canonical-consensus-value.ts), `core/protocol/state/`
    (persistent-radix-value-map.ts / -ops.ts), `core/protocol/hashes.ts`,
    `core/protocol/htlc/` (onion envelope, multi-recipient), `core/protocol/settlement/`.
- Storage / durability: `core/storage/` — `wal/` (snapshot.ts,
  runtime-machine-schema/), `index.ts` (buildStorageFrameRecordPlan, commit
  ordering: WAL is fsynced before dispatch; history-view + current writes are
  concurrent and unsynced), `history/history-view.ts`, `commit/`, `recovery/`,
  `fs-durability.ts`, `codec/binary-codec.ts`, `canonical-hash.ts`.
- Networking: `core/network/relay/` (router.ts, store.ts — gossip is
  **pull-only**: relay pushes nothing; clients pull by hubs set / ids+depth 1..3
  / routeTo / masked prefix pages / sinceSeq cursor), `core/network/p2p/`
  (p2p.ts, gossip/profile-batch.ts, gossip set 'hubs' vs 'default', profile
  heartbeats, ensureRoutes/ensureProfiles/fetchProfilesByPrefix),
  `core/api/runtime-adapter/` (server.ts: auth, capability/owner **command
  lanes**, per-lane command frontier + `recordRuntimeAdapterCommand` idempotency
  marker, pending commands, rate buckets; remote.ts: reconnect/backoff;
  security/auth.ts), `core/api/server/` (index.ts: HTTP/WS daemon,
  `/api/gossip/profile` on-demand lookups with per-entity 60 s throttle,
  batching, admission; network/rpc-ws.ts).
- Orchestration: `core/orchestrator/` — orchestrator.ts (relay + process
  supervisor), hub-node.ts, mm-node.ts + market-maker/, bootstrap/
  (contract-readiness.ts), replica-import/, mesh/, health/, proxy.ts,
  daemon-control.ts, process/, j-select/, prometheus.ts.
- Load harness (not production, but it drives the daemons): `core/scripts/operations/hlt/`.
- L1: `jurisdictions/contracts/` (Depository, Account, EntityProvider,
  HankoVerifier, DeltaTransformer, HashLadderRegistry) — Hardhat 3.

## Threat model

Adversaries: a malicious counterparty (user or hub) on a bilateral account; a
malicious relay; a malicious/mistaken RuntimeAdapter client holding a
capability token; a crashed/restarted process (durability); a byzantine
validator in a multi-signer entity; a peer that lies in gossip. Assets: reserves
and collateral on L1, off-chain balances/deltas, HTLC preimages/hashlocks,
signing keys, board governance.

## Audit dimensions (cover every one, say explicitly if clean)

1. **R→E→A cascade determinism.** Same inputs on both replicas → identical
   state roots and frame hashes. Look for: perspective-dependent effects
   (`isOurFrame` vs `byLeft`), Map iteration order, `Date.now()`/`Math.random()`
   inside apply paths, floating point, BigInt/Number mixing, non-canonical
   encodings feeding hashes, structuredClone vs in-place mutation of committed
   state (`prepareEntityTxState`, `mutableFrameState`), stale-state reads
   across a frame (`docs/consensus-invariants.md`).
2. **Bilateral account consensus.** PROPOSE/ACK ordering, height/nonce replay,
   left/right tie-breaks, rollback of a rejected frame, HTLC lock/resolve/expire
   and deadline math, swap matching, credit limits/holds/underflow guards,
   settlement/dispute proofs vs on-chain `processBatch`. Can either side steal
   or freeze funds, or force the other's runtime to halt?
3. **Entity consensus.** Single-signer shortcut vs multi-signer BFT
   (PROPOSE→PRECOMMIT→COMMIT); infra-context authority
   (`materializeEntityInfraContext`, `validateEntityInfraContext`,
   `assertEntityInfraContextAuthority`); j-prefix attestations/certificates;
   frame byte budgets; hanko threshold (EOA-only) verification off-chain vs
   `EntityProvider.sol`. Note recent memoization by object identity
   (`resolveEntityCommandBoard`, `canonicalProfile`, ECDSA signature/recover
   caches, HTLC X25519 checks) — can a cache return a stale/attacker-controlled
   result?
4. **Runtime frame lifecycle + WAL.** `stateMutationInFlight` /
   `acquireRuntimeCommittedRead` writer-lock; halt-and-reload semantics
   (`RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED`); crash between
   WAL fsync and unsynced history-view/current writes — is restore always from
   WAL, and are the unsynced views ever trusted as authority? Snapshot schema
   compatibility (`runtime-machine-schema`, frame caps persisted), mempool
   retention on halt, `applyEntityInputFrameCap`/`selectAtomicPrefix` (atomic
   cross-J cohorts must never split), replay contexts.
5. **RuntimeAdapter command path.** Auth (capability tokens, owner lanes,
   expiry), per-lane command frontier idempotency: can a re-sent command
   (same commandId/sequence) be applied twice — after reconnect, after token
   expiry, after `reconcilePendingCommand` deletes an expired pending entry,
   after a restart from WAL? Sequence gaps, `E_COMMAND_PENDING` loops,
   rate buckets, admission caps (`MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES`),
   what an attacker with one capability token can do to other lanes.
6. **Networking / gossip.** Relay: profile signature verification, seq
   monotonicity, snapshot identity, cursor semantics, prefix paging bounds,
   depth BFS bounds, routeTo pathfinder cost (DoS), admission per client,
   message size limits, decrypt paths (`ENVELOPE_DECRYPT_FAIL`), replay of
   envelopes, `hello_ack` cursor keyed by socket. P2P: profile heartbeats,
   topology-key announce gating, stale key caches, HTLC onion
   (`createOnionEnvelopes`, cleartext fallback when key missing — is that still
   possible?), next-hop-offline handling. Can a peer make a hub halt
   (`ACCOUNT_J_CLAIM_NODE_MISSING`, profile >10 KB leaf) or spend its CPU?
7. **Orchestration.** Process supervision, restart/reimport
   (`replica-import`, `RUNTIME_ADAPTER` import with `access=admin`), health
   endpoints truthfulness, port/proxy exposure, secrets in env/logs
   (`XLN_RADAPTER_AUTH_SEED`, runtime seeds, redaction), contract readiness
   (`RPC_CANONICAL_LIBRARY_BINDING_INCONSISTENT`, HH3 `project/` linkReferences
   prefix), MM bootstrap, custody service. What happens on partial failure —
   orphaned children, halted daemon still answering `/health`?
8. **L1 contracts vs off-chain expectations.** Dispute/settlement proof
   formats, hanko domain separation, batch replay, delta transformer bounds,
   library linking; does the artifact-immutables check actually pin bytecode?
9. **Simplification.** Duplicated logic (get-or-create delta, hold release,
   scenario helpers), dead paths, files >1500 lines that hide state-machine
   boundaries, invariants enforced only by comment.

## Output format

- Executive read: 5–10 lines, overall verdict, confidence %, what you did NOT
  read.
- Findings, ranked P0 → P3, each with: title, `file:line`, concrete failure
  scenario (inputs/state → wrong outcome), why current code allows it (quote
  ≤10 lines), fix sketch, and whether a test exists that should have caught it.
  P0 = fund loss / consensus divergence / remote halt; P1 = exploitable with
  one honest bug or one malicious peer; P2 = robustness/durability; P3 = hygiene.
- "Verified clean" list: dimensions/paths you checked and found sound, with
  the invariant you confirmed.
- Score /1000 with a one-line justification (prior external scores: 380–410 in
  Aug 2026 for the cross-J subset).
- No speculation: if you did not trace the path, say "not traced".
