/**
 * Payload tiering: ring layer + read-side evidence envelope.
 * Storage tiers `do`/`pending`/`r2`/`stub` are PayloadStore's; this owns `ring`
 * above them.
 *
 *   ring --flush(fits)--> do --evict--> stub
 *   ring --flush(oversize)--> pending --settle settled--> r2 --evict--> stub
 *                            pending --settle failed----------------> stub
 *   ring --evict (pre-flush)----------------------------------------> stub
 *
 * Tiers only move toward stub — no un-evict/un-flush (tier honesty).
 *
 * EvidenceTier arms this module owns: `recorded` (value present at any storage
 * tier) and `stub` (value evicted, lineage intact). `replayed`/`replayed-cached`
 * are replay-memo's supersession, never claimed here.
 */
import type { PayloadHash } from "./ids.js";
import type { Payload, PayloadStore, PayloadTier, EvidenceTier, RetentionClass } from "./interfaces.js";
import type { TierGate } from "../../membrane/egress-proxy.js";

/** Ring bookkeeping until flush; stubbed = pre-flush force-evict (no un-evict). */
interface RingSlot {
  readonly value: unknown;
  readonly stampIds: readonly number[];
  readonly retention: RetentionClass;
  stubbed: boolean;
}

/** Storage → evidence arm. Exhaustive so new PayloadTier fails compile. */
export function evidenceTierOf(storageTier: PayloadTier): EvidenceTier {
  switch (storageTier) {
    case "ring":
    case "do":
    case "pending":
    case "r2":
      return "recorded";
    case "stub":
      return "stub";
    default: {
      const exhaustive: never = storageTier;
      throw new Error(`evidenceTierOf: unhandled PayloadTier ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface PayloadEvidenceEnvelope {
  readonly tier: EvidenceTier;
  readonly storageTier: PayloadTier;
  readonly value: unknown | undefined;
  readonly stampIds: readonly number[];
  readonly retention: RetentionClass;
}

/** Unknown ring hash — never fabricate residency. */
export class PayloadNotRingResident extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadTierMachine: hash ${JSON.stringify(hash)} is not ring-resident`);
    this.name = "PayloadNotRingResident";
  }
}

/** Ring owner over PayloadStore (do/pending/r2/stub). */
export class PayloadTierMachine {
  private readonly ring = new Map<PayloadHash, RingSlot>();

  constructor(private readonly store: PayloadStore) {}

  /** Hot, not yet durable. After flush, store is truth — do not re-ringPut. */
  ringPut(hash: PayloadHash, payload: Payload): void {
    this.ring.set(hash, {
      value: payload.value,
      stampIds: payload.stampIds,
      retention: payload.retention ?? "standard",
      stubbed: false,
    });
  }

  /** Ring → PayloadStore.put; ring drops hash. Stubbed/missing → not resident. */
  async flush(hash: PayloadHash): Promise<void> {
    const slot = this.ring.get(hash);
    if (slot === undefined || slot.stubbed) throw new PayloadNotRingResident(hash);
    await this.store.put(hash, { value: slot.value, stampIds: slot.stampIds, retention: slot.retention });
    this.ring.delete(hash);
  }

  async settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void> {
    await this.store.settle(hash, outcome);
  }

  /** Evict any tier; ring degrades locally. Value dropped, stamps retained. */
  async evict(hash: PayloadHash): Promise<void> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) {
      slot.stubbed = true;
      return;
    }
    await this.store.evict(hash);
  }

  async currentTier(hash: PayloadHash): Promise<PayloadTier> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) return slot.stubbed ? "stub" : "ring";
    return (await this.store.get(hash)).tier;
  }

  async read(hash: PayloadHash): Promise<PayloadEvidenceEnvelope> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) {
      const storageTier: PayloadTier = slot.stubbed ? "stub" : "ring";
      return {
        tier: evidenceTierOf(storageTier),
        storageTier,
        value: slot.stubbed ? undefined : slot.value,
        stampIds: slot.stampIds,
        retention: slot.retention,
      };
    }
    const rec = await this.store.get(hash);
    return {
      tier: evidenceTierOf(rec.tier),
      storageTier: rec.tier,
      value: rec.value,
      stampIds: rec.stampIds,
      retention: rec.retention,
    };
  }

  /** Async pre-pass for sync TierGate; unknown hashes absent (not fabricated). */
  async snapshot(hashes: readonly PayloadHash[]): Promise<ReadonlyMap<PayloadHash, PayloadEvidenceEnvelope>> {
    const out = new Map<PayloadHash, PayloadEvidenceEnvelope>();
    for (const hash of hashes) {
      try {
        out.set(hash, await this.read(hash));
      } catch {}
    }
    return out;
  }
}

/**
 * Egress-proxy TierGate from snapshot + key→hash. Untracked keys pass through;
 * stub blocks with machine-readable stub value (hash + stamps, no value).
 */
export function tierGateFromSnapshot(
  keyToHash: (key: string) => PayloadHash | undefined,
  snapshot: ReadonlyMap<PayloadHash, PayloadEvidenceEnvelope>,
): TierGate {
  return {
    allows(key: string): boolean {
      const hash = keyToHash(key);
      if (hash === undefined) return true;
      const entry = snapshot.get(hash);
      return entry === undefined || entry.tier !== "stub";
    },
    stubbedValue(key: string): unknown {
      const hash = keyToHash(key);
      const entry = hash === undefined ? undefined : snapshot.get(hash);
      return { "provenance/tier": "stub" as const, payloadHash: hash, stampIds: entry?.stampIds ?? [] };
    },
  };
}
