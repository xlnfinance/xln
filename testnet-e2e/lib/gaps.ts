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
    piece: "Landed (R-LEDGER-REBASE, pure/entity/frame.ts `rebasing`): after an epoch move the Entity restarts the Account's offdelta from zero, forgets the peer's signature over a head of the voided epoch, and a finalized dispute zeroes collateral and ondelta. No step stands in for it any more; the entry stays so the tripwire tests have a piece that has landed.",
    supplier: "the builder thread: S10 rebase, after the dispute through the node",
    landed: () => mentions("entity", /rebased|rebaseLedger/) || mentions("account", /rebased|rebaseLedger/),
  },
  disputeWithClause: {
    id: "dispute-with-clause", kind: "missing", layer: "Runtime",
    piece: "Forced dispute with an open clause in the signed proof. The body carries one transformer clause per open hold (pure/account/proof/body.ts). R-HOLD-DISSOLVE, the register row, is what drops the hold when the chain finalizes. This probe reads that row and the dispute-clause step.",
    supplier: "R-HOLD-DISSOLVE (pure/rules/register/R-HOLD-DISSOLVE.json) and the dispute-clause step",
    landed: () => {
      const row = join(REPO, "pure/rules/register/R-HOLD-DISSOLVE.json");
      const step = join(REPO, "testnet-e2e/steps.ts");
      if (!existsSync(row) || !existsSync(step)) return false;
      const source = readFileSync(step, "utf8");
      const at = source.indexOf('id: "dispute-clause"');
      const end = source.indexOf('id: "rebase"', at);
      if (at < 0 || end < 0) return false;
      const body = source.slice(at, end);
      return body.includes("R-HOLD-DISSOLVE") && !body.includes("new Blocked");
    },
  },
} as const satisfies Record<string, Gap>;

export type GapKey = keyof typeof GAPS;
