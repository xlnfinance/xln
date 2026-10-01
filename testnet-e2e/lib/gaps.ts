// What is missing, by name. A gap is a piece of the rewrite a step needs that main does not have, or a stand-in this
// harness uses for it. Each gap carries a probe that looks at main: when the supplier has landed, the step that still
// lists the gap fails loudly ("replace the stand-in"), so the skeleton cannot go quietly stale.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..");
const PURE = join(REPO, "pure");

export type GapKind = "missing" | "scaffold";

export type Gap = Readonly<{
  id: string;
  kind: GapKind;
  layer: string;
  piece: string;
  supplier: string;
  landed: () => boolean;
}>;

const has = (path: string): boolean => existsSync(join(PURE, path));

const sourcesUnder = (dir: string): readonly string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });

const mentions = (dir: string, pattern: RegExp): boolean =>
  sourcesUnder(join(PURE, dir)).some((file) => pattern.test(readFileSync(file, "utf8")));

export const GAPS = {
  entityRuntime: {
    id: "entity-runtime", kind: "missing", layer: "Entity + Runtime",
    piece: "Entity frame (arrivals, hooks, commands, proposals), Runtime tick and WAL: pure/entity/, pure/runtime/ (EntityState, EntityInput, Runtime.apply). Main has the Account replicas only, so the harness drives them directly.",
    supplier: "cut stack #93, #94, #96, #99, #100, #106 (Entity and Runtime cut)",
    landed: () => has("entity/model.ts") && has("runtime/tick.ts"),
  },
  jBatchBuilder: {
    id: "j-batch-builder", kind: "scaffold", layer: "J",
    piece: "J batch builder: JAction (deposit, reveal, counter, c2r, settle) to Batch to a signed processBatch call, with the Entity's batch nonce. The harness builds each Batch by hand from pure/chain/batch encoders and signs it itself.",
    supplier: "J batch planner slice (not started; the cut thread owns it, takes R-FUNDED from #62)",
    landed: () => has("j/plan.ts") || has("chain/batch/plan.ts") || has("chain/plan.ts"),
  },
  jEvents: {
    id: "j-events", kind: "scaffold", layer: "J",
    piece: "J watcher: chain logs to JEvent (j_epoch, j_dispute, j_dispute_over, j_op_lapsed) and a finalized J height for the Runtime. The harness reads _collaterals/_accounts directly and copies a deposit into both Account ledgers by hand.",
    supplier: "Host / J watcher (not started); Entity side of it is chain facts in #99",
    landed: () => has("host/watch.ts") || has("j/watch.ts") || has("chain/watch.ts"),
  },
  signedFrames: {
    id: "signed-frames", kind: "missing", layer: "Account",
    piece: "Signed frames: a committed frame is named by the digest of the dispute-proof message of its state (R-FRAME-HASH-SIGNED), and both sides hold the other's signature. Main names frames by provisionalFrameHash, so no frame is signed during pay or HTLC; the harness signs the proof of the final state itself.",
    supplier: "#97 (A4b: pure/account/proof/signing.ts, messages.ts)",
    landed: () => has("account/proof/signing.ts"),
  },
  proofBody: {
    id: "proof-body", kind: "scaffold", layer: "Account",
    piece: "Ledger to ProofBody (offdeltas, token ids, one transformer clause per open hold, J deadline to timestamp). The harness builds the body for a ledger with no open hold only.",
    supplier: "#97 (pure/account/proof/body.ts, deadline.ts); R-DEADLINE-TIMESTAMP is open in contracts-decisions",
    landed: () => has("account/proof/body.ts"),
  },
  htlcRoute: {
    id: "htlc-route", kind: "scaffold", layer: "Entity",
    piece: "HTLC forwarding: on an incoming lock, open the next hop with a shorter deadline; on a resolve, pass the secret upstream; hold duty while a signed proof carries the lock (R-SIGNED-IS-LIVE). The harness walks the route by hand, hop by hop.",
    supplier: "no owner yet: the cut stack's htlc tests lock and resolve across one Account only (Review B of #113); hold duty is the A4b Runtime slice after #97",
    landed: () => has("runtime/htlc/route.ts") || has("entity/route.ts"),
  },
  onChainReveal: {
    id: "on-chain-reveal", kind: "missing", layer: "Runtime",
    piece: "Payee's on-chain reveal when its resolve is unacked near the deadline (R-HTLC-CLOCK c), as a revealSecrets batch op. Not exercised: every resolve here is acked.",
    supplier: "#96 (cut slice 3a: chain actions and the payee's on-chain reveal)",
    // #96 puts the decision in pure/entity/frame.ts (revealOnChainDue, a `reveal` JAction); pure/runtime/chain.ts never exists in the stack.
    landed: () => mentions("entity", /revealOnChainDue/),
  },
  swapTx: {
    id: "swap-tx", kind: "missing", layer: "Account",
    piece: "Swap inside an Account: AccountTx has pay, set_credit, lock, resolve, cancel, expire and nothing for swap offer, partial fill or cancel; the clause shape the ledger keeps for an open offer does not exist, so no proof body can carry a swap clause (R-SWAP-CLAUSE-WITH-FILL).",
    supplier: "#111 (kernel thread swap step, on top of #97); spec: plan/swap-onchain.md",
    // The word "swap" is already in pure/account/proof/body.ts (`swaps: []`) at #97, so look for the tx itself.
    landed: () => mentions("account", /Tagged<"(swap|offer)"/),
  },
  disputeWithClause: {
    id: "dispute-with-clause", kind: "missing", layer: "Account + Runtime",
    piece: "Forced dispute with an open clause in the signed proof (HTLC pending when the counterparty goes quiet): needs the proof body with transformer clauses, the J-deadline-to-timestamp map and the Runtime's dispute duties.",
    supplier: "#97 (proof body) then the A4b Runtime duties slice",
    landed: () => has("account/proof/body.ts") && has("runtime/dispute.ts"),
  },
  disputeRebase: {
    id: "dispute-rebase", kind: "missing", layer: "Entity",
    piece: "After a dispute finalizes, the Account's ledger must be rebased from the J event (collateral paid out, epoch advanced, frames reset). Main has no event-to-Account path; the harness only checks the chain's payout against the ledger as it stood.",
    supplier: "#99 (chain facts, dispute watch) plus the J batch planner",
    landed: () => has("entity/chain.ts"),
  },
  hostTransport: {
    id: "host-transport", kind: "missing", layer: "Host",
    piece: "Transport and durability: peers find each other (peer table, Q-T-4), messages travel between Runtimes, the WAL is written before outputs leave. The harness hands messages across in memory.",
    supplier: "transport spec #65 merged (T0); no code yet",
    landed: () => has("host/transport.ts"),
  },
  hubMatching: {
    id: "hub-matching", kind: "missing", layer: "Hub",
    piece: "Hub matching engine wired to Account state: pure/market has the book and the settlement model, but nothing turns a matched pair into swap txs in two Accounts.",
    supplier: "hub matching thread (#92, #101 merged; wiring waits for the swap clause shape)",
    landed: () => mentions("market", /swap_fill|swapFill/),
  },
} as const satisfies Record<string, Gap>;

export type GapKey = keyof typeof GAPS;
