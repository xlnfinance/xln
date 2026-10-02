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
  ledgerRebase: {
    id: "ledger-rebase", kind: "missing", layer: "Entity",
    piece: "After a finalized dispute the Entity learns the new epoch (j_epoch) and that the dispute is over, but nothing rebases the Account: its ledger still says offdelta and collateral as they were, its frame counter is not reset to the new epoch's base, and the settlement fold into ondelta is not there.",
    supplier: "the cut thread: settlement fold and epoch rebase, after multi-hop",
    landed: () => mentions("entity", /rebased|rebaseLedger/) || mentions("account", /rebased|rebaseLedger/),
  },
  disputeWithClause: {
    id: "dispute-with-clause", kind: "missing", layer: "Runtime",
    piece: "Forced dispute with an open clause in the signed proof (HTLC pending when the counterparty goes quiet): the proof body carries one transformer clause per open hold (pure/account/proof/body.ts), but no Runtime duty starts the dispute or holds a lock a signed proof carries (R-SIGNED-IS-LIVE).",
    supplier: "the A4b Runtime duties slice after #97 (pure/runtime/dispute.ts)",
    landed: () => has("runtime/dispute.ts"),
  },
} as const satisfies Record<string, Gap>;

export type GapKey = keyof typeof GAPS;
