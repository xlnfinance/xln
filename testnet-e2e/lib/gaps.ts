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
  harnessSend: {
    id: "harness-send", kind: "scaffold", layer: "Host",
    piece: "Chain ops sent by the harness (`sendOps` in lib/chain.ts: queue in the J builder, simulate at the head, sign, send, read the events) instead of by a node's own submit path. A step that still calls it does what the Host's shell does for a deposit (S3) by hand: the reveal of a secret and the dispute start and finalize are ops the Runtime asks for or will ask for (reveal is a chain action of the Entity's WAL row; the dispute duty is the A4b slice), and their path through the node is that step's own work.",
    supplier: "the e2e builder: the step that sends the op through the node's submit path removes its call to sendOps",
    landed: () => !readFileSync(join(REPO, "testnet-e2e", "lib", "chain.ts"), "utf8").includes("export const sendOps"),
  },
  ledgerRebase: {
    id: "ledger-rebase", kind: "missing", layer: "Entity",
    piece: "After a finalized dispute the Entity learns the new epoch (j_epoch) and that the dispute is over, but nothing rebases the Account: its ledger still says offdelta and collateral as they were, its frame counter is not reset to the new epoch's base, and the settlement fold into ondelta is not there.",
    supplier: "the cut thread: settlement fold and epoch rebase, after multi-hop",
    landed: () => mentions("entity", /rebased|rebaseLedger/) || mentions("account", /rebased|rebaseLedger/),
  },
  entitySwapCommands: {
    id: "entity-swap-commands", kind: "missing", layer: "Entity",
    piece: "Swap inside an Account through a Runtime: AccountTx has offer, fill, retract and lapse (#111, pure/account/swap), but the Entity takes no command that queues them, so no swap offer, partial fill or cancel can go through a Runtime and nothing on the Account's frames is signed for one. The proof body carries the swap clause already; the chain side is plan/swap-onchain.md.",
    supplier: "kernel thread (swap on the Account, #111) then the cut thread (Entity commands offer, fill, retract)",
    landed: () => mentions("entity", /Tagged<"(offer|fill|retract)"/),
  },
  disputeWithClause: {
    id: "dispute-with-clause", kind: "missing", layer: "Runtime",
    piece: "Forced dispute with an open clause in the signed proof (HTLC pending when the counterparty goes quiet): the proof body carries one transformer clause per open hold (pure/account/proof/body.ts), but no Runtime duty starts the dispute or holds a lock a signed proof carries (R-SIGNED-IS-LIVE).",
    supplier: "the A4b Runtime duties slice after #97 (pure/runtime/dispute.ts)",
    landed: () => has("runtime/dispute.ts"),
  },
  hubMatching: {
    id: "hub-matching", kind: "missing", layer: "Hub",
    piece: "Hub matching engine wired to Account state: pure/market has the book and the settlement model, but nothing turns a matched pair into swap txs in two Accounts.",
    supplier: "hub matching thread (#92, #101 merged; wiring waits for the swap clause shape)",
    landed: () => mentions("market", /swap_fill|swapFill/),
  },
} as const satisfies Record<string, Gap>;

export type GapKey = keyof typeof GAPS;
