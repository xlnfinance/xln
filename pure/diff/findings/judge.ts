// A walk's diff lines, judged against the known findings of its area and seed. Nothing is hidden: a line no site expects stays red,
// and a site whose expected line never appeared is red as well, so a fix has to delete the entry that covered it.
// A line is known only when it equals an expected line exactly, and each expected line covers one line: a second breach of the same
// shape, or the same breach twice, is red.
import type { Area } from "../draws/areas.ts";
import type { Expected, KnownFinding, Site } from "./known.ts";

export type WalkArea = Area | "model";
export type Judged = Readonly<{
  /** Lines nothing registered expects: red. */
  unknown: readonly string[];
  /** Lines a registered site expects, each with the finding that owns it: printed, not red. */
  known: readonly string[];
  /** One line per expected text that did not appear: red, because the finding stopped reproducing. */
  stale: readonly string[];
}>;

type Claim = Readonly<{ expected: Expected; finding: KnownFinding }>;
/** What is left to claim, and what the lines seen so far came to. */
type Pass = Readonly<{ open: readonly Claim[]; unknown: readonly string[]; known: readonly string[] }>;

/** The sites registered for one walk. */
export const sitesOf = (findings: readonly KnownFinding[], area: WalkArea, seed: number): readonly (Site & { readonly finding: KnownFinding })[] =>
  findings.flatMap((finding) => finding.sites.filter((site) => site.area === area && site.seed === seed).map((site) => ({ ...site, finding })));

const seedText = (seed: number): string => `0x${seed.toString(16)}`;

/** A line takes the first open claim that equals it, so a claim covers one line. */
const take = (pass: Pass, line: string): Pass => {
  const claim = pass.open.find((c) => c.expected.line === line);
  return claim === undefined
    ? { ...pass, unknown: [...pass.unknown, line] }
    : { open: pass.open.filter((c) => c !== claim), unknown: pass.unknown, known: [...pass.known, `${claim.finding.id} (${claim.expected.property}): ${line}`] };
};

export const judge = (findings: readonly KnownFinding[], area: WalkArea, seed: number, lines: readonly string[]): Judged => {
  const claims = sitesOf(findings, area, seed).flatMap((site) => site.expects.map((expected): Claim => ({ expected, finding: site.finding })));
  const judged = lines.reduce<Pass>(take, { open: claims, unknown: [], known: [] });
  const stale = judged.open.map((claim) =>
    `KNOWN_FINDING_STALE ${claim.finding.id} on ${area} ${seedText(seed)}: ${claim.expected.property} line no longer appears exactly once; delete or re-register its entry in diff/findings/known.ts: ${claim.expected.line}`);
  return { unknown: judged.unknown, known: judged.known, stale };
};
