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
  jDepositFacts: {
    id: "j-deposit-facts", kind: "missing", layer: "J + Entity",
    piece: "What the chain says about money, to the Entities: the watcher reads four events (epoch advanced, dispute started, countered, finalized) and none for a funding or a deposit, and no Account tx or JEvent sets an Account's collateral or ondelta. So a Runtime's Account holds collateral 0 after 100 USDT of collateral sits behind it, and every payment here runs on credit; the harness reads the chain and compares it with the ledger rule (pure/account/ledger deposit) instead.",
    supplier: "transport thread: J watcher deposit and collateral events (slice 2); the cut thread: the Entity side that turns them into the Account's collateral and ondelta",
    landed: () => mentions("entity", /j_deposit|j_collateral/) || mentions("j", /deposit_confirmed|collateral_funded/),
  },
  jActionOps: {
    id: "j-action-ops", kind: "scaffold", layer: "Host",
    piece: "The Host's `chain` effect to the J batch builder: a JAction (deposit, reveal, counter, c2r, settle) becomes a JOp, is queued, sealed and sent. The harness converts the two actions this run asks for (deposit to reserve_to_collateral, reveal to reveal_secret) by hand, and queues them itself.",
    supplier: "transport thread, Host shell: the `chain` effect handed to pure/j/batch (the J builder thread owns the queue)",
    landed: () => has("host/chain.ts") || has("host/shell/chain.ts"),
  },
  jLoop: {
    id: "j-loop", kind: "scaffold", layer: "Host",
    piece: "The J loop: fetch blocks and logs, answer the watcher's readings by block hash (EIP-1898), hand the Runtime the J events and then the height, and move the cursor only after a committed j_height row holds the height. pure/j/watch.ts is the core; the harness runs the loop in memory against anvil, at depth 1.",
    supplier: "transport thread: J loop in the Host shell (after the shell's file and socket pieces)",
    landed: () => mentions("host", /eth_getLogs|getLogs/),
  },
  hostShell: {
    id: "host-shell", kind: "scaffold", layer: "Host",
    piece: "The Host's shell: a disk that keeps rows before outputs leave, a link between peers, a peer table (Q-T-4), and the keys that sign (R-LINK-AUTH). The harness keeps rows in an array, the link is a list that loses nothing, and it signs the digest of a frame head with a party's key when the chain needs the signature.",
    supplier: "transport thread: file and socket shell in pure/host/shell/",
    landed: () => has("host/shell"),
  },
  ledgerRebase: {
    id: "ledger-rebase", kind: "missing", layer: "Entity",
    piece: "After a finalized dispute the Entity learns the new epoch (j_epoch) and that the dispute is over, but nothing rebases the Account: its ledger still says offdelta and collateral as they were, its frame counter is not reset to the new epoch's base, and the settlement fold into ondelta is not there.",
    supplier: "the cut thread: settlement fold and epoch rebase, after multi-hop",
    landed: () => mentions("entity", /rebased|rebaseLedger/) || mentions("account", /rebased|rebaseLedger/),
  },
  htlcRoute: {
    id: "htlc-route", kind: "scaffold", layer: "Entity",
    piece: "HTLC forwarding: on an incoming lock, open the next hop with a shorter deadline; on a resolve, pass the secret upstream; hold duty while a signed proof carries the lock (R-SIGNED-IS-LIVE). The harness decides each hop's lock and deadline and gives each resolve to the payee, hop by hop.",
    supplier: "the cut thread's multi-hop slice (the coordinator gave it that owner); hold duty is the A4b Runtime slice after #97",
    landed: () => has("runtime/htlc/route.ts") || has("entity/route.ts"),
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
