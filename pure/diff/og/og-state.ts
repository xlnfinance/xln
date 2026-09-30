// The Entity's typed sections cross the og boundary here. og hands in its records (jBatchState, hubRebalanceConfig,
// lending, profile, reserves, ...), the rewrite holds typed sections, and the root commits og's records back. A test that seeds
// or compares og-named sections goes through these.
import {
  importJBatchState, ogJBatchOf, ogSections, withOgSections,
  type EntityCommitted, type EntityState, type JSubmission, type OgJBatchState, type QueuedBatch,
} from "../../xln.ts";
import { unwrap } from "../../xln_run.ts";

/** og buildGenesisReplica's profile, which the rewrite also reads a profile-less record as. */
export const ogGenesisProfile = (id: string, isHub = false): Record<string, unknown> =>
  ({ name: `Entity ${id.slice(-4)}`, isHub, avatar: "", bio: "", website: "" });
/** The committed sections under og's names. */
export const ogOf = (s: EntityState): EntityCommitted => ogSections(s);
/** The state with some og-named sections replaced; a section og cannot reach fails the test. */
export const withOg = (s: EntityState, patch: Record<string, unknown>): EntityState =>
  unwrap(withOgSections(s, { ...ogSections(s), ...patch } as EntityCommitted));
/** The state made a hub with this config, as og setHubConfig leaves it (a profile, when present, says so). */
export const asHub = (s: EntityState, config: unknown): EntityState => {
  const profile = ogSections(s)["profile"] as Record<string, unknown> | undefined;
  return withOg(s, { hubRebalanceConfig: config, ...(profile === undefined ? {} : { profile: { ...profile, isHub: true } }) });
};
/** The og jBatchState a rewrite state commits (absent while dormant). */
export const ogJb = (s: { readonly jBatch: JSubmission }): OgJBatchState | undefined => ogJBatchOf(s.jBatch);
/** og's record as the rewrite holds it; a record og cannot reach fails the test. */
export const jbOfOg = (og: unknown): JSubmission => unwrap(importJBatchState(og as OgJBatchState | undefined));
export const withOgJb = (s: EntityState, og: unknown): EntityState => ({ ...s, jBatch: jbOfOg(og) });
/** A sent batch as og consensus holds it: submit counters stay zero. */
export const ogSentBatch = (
  batch: unknown,
  batchHash: string,
  entityNonce: number,
  firstSubmittedAt = 0,
): OgJBatchState["sentBatch"] =>
  ({ batch: batch as QueuedBatch, batchHash, encodedBatch: "0x", entityNonce, firstSubmittedAt, lastSubmittedAt: 0, submitAttempts: 0 });
/**
 * The og record nearest a loosely built one that og consensus can reach: a sent batch carries og's fields with zero
 * submit counters and the status its failure implies, a zero nonce and an empty recovery list are absent, and an
 * emptied recovery batch is gone. Seeding both sides with it keeps a random generator honest.
 */
export const ogReach = <T>(loose: T): T => {
  if (loose === undefined) return loose;
  const { sentBatch, entityNonce, recoveryBatches, status, ...rest } = loose as Record<string, any>;
  const recovery = ((recoveryBatches ?? []) as QueuedBatch[]).filter((b) => Object.values(b).some((rows) => (rows as unknown[]).length > 0));
  const idle = status === "accumulating" ? "accumulating" : "empty";
  const sent = sentBatch === undefined ? {} : {
    sentBatch: { batchHash: `0x${"00".repeat(32)}`, encodedBatch: "0x", firstSubmittedAt: 0, ...sentBatch, lastSubmittedAt: 0, submitAttempts: 0 },
  };
  return {
    ...rest,
    status: sentBatch === undefined ? idle : sentBatch.terminalFailure === undefined ? "sent" : "failed",
    ...sent,
    ...(recovery.length === 0 ? {} : { recoveryBatches: recovery }),
    ...(entityNonce === undefined || entityNonce === 0 ? {} : { entityNonce }),
  } as T;
};
