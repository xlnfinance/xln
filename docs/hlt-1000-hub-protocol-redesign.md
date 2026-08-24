# Protocol redesign for 1000 payments/s per hub (2026-08-24)

**Status:** design for owner review — no code. Consensus-semantics territory:
nothing here ships without explicit owner approval and frozen-core review.
**Context:** `hlt-throughput-report-2026-08-22.md`,
`hlt-dead-zone-probe-2026-08-23.md`,
`hlt-apply-phase-optimization-2026-08-24.md`.

## 1. Goal and budget

1000 payments/s sustained through ONE hub, TS/Bun stack, no Rust core.

```
budget:   ≤ 1.0 ms effective wall cost per payment
today:    ~2.8 ms marginal CPU + toll structure + dead zone (~35% of wall)
after scheduling/pipelining/speculation (L1-L3): ~600-650/s ceiling
gap:      the marginal per-payment CONSENSUS cost itself must fall ~2x
```

L1-L3 (adaptive gate, stage pipelining, speculative apply) are assumed and
independent; this doc covers only the protocol layer (L4b).

## 2. Why the current protocol is expensive per payment (measured)

Per payment, hub-side:

| Cost | Size | Root cause |
|---|---|---|
| 2 frame crossings (propose + ACK commit) | 2× per-frame toll share | lockstep: one `pendingFrame` per account |
| ~3.5 signs + 2.4 recovers | ~0.3 ms | per-account-frame bilateral signatures |
| ~18 keccak + ~25 canonical.encode | ~1.0 ms | per-tx hashing/encoding in frame + roots |
| transition logic + GC | ~0.7 ms | state machine proper |

The lockstep also creates the dead-zone feedback loop: at burst start every
account needs its second crossing before its next payment can propose, so
frames stay thin exactly when the queue is deepest.

Reference: `.archive/2024_src/app/Channel.ts` already used cumulative flush
semantics (`sentTransitions` window + one global signature over the encoded
state + subchannel proofs) — pipelining is a return to the original design
intuition, hardened.

## 3. Redesign pillars

### P1 — Sliding-window frames per account (the core change)

Allow up to W pending frames per account instead of one.

- Frames stay hash-chained: each frame commits to `prevFrameHash` +
  pre-state hash, so the evidence chain is unbroken regardless of how many
  are in flight.
- **Cumulative ACK**: `ack(height=h)` confirms every frame ≤ h (TCP
  semantics). One ACK drains the window — this alone collapses the dead-zone
  ACK burst ~W:1.
- Collision/rollback generalizes: on divergence, discard the window tail
  from the first conflicting height (today's `collision.ts` discards the
  single pending frame; the logic extends to a suffix).
- Dispute compatibility: every frame in the window is independently signed
  and verifiable evidence; the on-chain path only ever needs the highest
  committed frame + its proof (same as today).

Effect: 2 crossings → ~1+1/W per payment; lockstep stall removed.

### P2 — Manifest-level bilateral signing

Per-account-frame signing is the crypto term that cannot be batch-verified
away because each frame is per-counterparty evidence. But the entity layer
already signs manifests of hashes (`hashesToSign`, hanko witness). P2 asks:

> Can the hub's outbound account frames for one entity frame be committed
> to in ONE signature over a Merkleized manifest, where each counterparty
> can extract their account's frame + inclusion path as full evidence?

If yes: ~3.5 signs/payment → ~1/entity-frame (amortized to ~0). Validate
against `core/entity/consensus/input/hanko-witness.ts` and the dispute
transformer's evidence requirements BEFORE designing further — if any
dispute path needs a bare per-account signature, P2 dies there.

### P3 — Speculative apply during forced idle (protocol-neutral)

Hub idles ~5% CPU while ACK-bound. Pre-apply queued `accountInput`s into a
candidate overlay while waiting; ACK commit becomes verify+publish. Turns
the dead zone into lookahead. No consensus change: speculation is discarded
on any mismatch, deterministic by construction (same inputs, same result).

### P4 — ACK coalescing at ingress (P1 prerequisite, shippable alone)

Cumulative ACKs without a window: a daemon that observes heights h..h+k
commits sends one ACK for h+k. Legal today only if the ACK handler treats
height as "all ≤ h committed" — verify that contract first (dead-zone task,
direction 1).

## 4. Invariants that must survive

1. **Evidence completeness**: every committed account transition remains
   attributable to a counterparty signature, extractable for disputes.
2. **Determinism**: `(replica, input) → (replica', outputs)` unchanged;
   window size W is a config constant, never timing-derived.
3. **Replay**: WAL replay from any committed frame reconstructs identical
   state, including mid-window frames.
4. **Frozen core**: frame/state hash formats change → frozen-core review.

## 5. Budget after redesign

```
per payment:  crossings 2 → ~1.1        (P1+P4)
              signs 3.5 → ~0.1          (P2, if viable)
              hashing/encode 1.0 → ~0.6 (memo/dirty-path, existing levers)
              logic+GC 0.7 → 0.7        (unchanged)
              ─────────────────
              ~1.5 ms CPU, but crossings/waits now overlap (P1+P3)
              → effective wall ≤ 1ms at full pipeline → 1000/s reachable
```

## 6. Risks

| Risk | Mitigation |
|---|---|
| P2 breaks dispute evidence | kill P2 at the hanko-witness validation step if so |
| Window rollback bugs = financial corruption | W=2 first; adversarial collision tests before W>2 |
| Speculation mismatch storms | counter + hard fallback to synchronous path |
| Scope creep | each P ships behind its own flag, defaults off |

## 7. Rollout (each step independently revertable)

1. **P4** cumulative ACK contract check + coalescing — days, low risk
2. **P3** speculative apply behind `XLN_HUB_SPECULATIVE_APPLY=1` — L3 slot
3. **P1** sliding window W=2 behind flag, adversarial collision suite first
4. **P2** only after hanko-witness validation — or never

Acceptance: 1000/s on the standard probe (500u, 30 s), all gates green,
dispute evidence extracted and verified from a mid-window frame.
