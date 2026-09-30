// A walk's diff lines, judged against the known findings of its area and seed. Nothing is hidden: a line no site expects stays red,
// and a site whose expected line never appeared is red as well, so a fix has to delete the entry that covered it.
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

/** The sites registered for one walk. */
export const sitesOf = (findings: readonly KnownFinding[], area: WalkArea, seed: number): readonly (Site & { readonly finding: KnownFinding })[] =>
  findings.flatMap((finding) => finding.sites.filter((site) => site.area === area && site.seed === seed).map((site) => ({ ...site, finding })));

const seedText = (seed: number): string => `0x${seed.toString(16)}`;

export const judge = (findings: readonly KnownFinding[], area: WalkArea, seed: number, lines: readonly string[]): Judged => {
  const sites = sitesOf(findings, area, seed);
  const claims = sites.flatMap((site) => site.expects.map((expected) => ({ expected, finding: site.finding })));
  const claimedBy = (line: string): { readonly expected: Expected; readonly finding: KnownFinding } | undefined =>
    claims.find((claim) => claim.expected.signature.test(line));
  const known = lines.flatMap((line) => {
    const claim = claimedBy(line);
    return claim === undefined ? [] : [`${claim.finding.id} (${claim.expected.property}): ${line}`];
  });
  const stale = claims
    .filter((claim) => !lines.some((line) => claim.expected.signature.test(line)))
    .map((claim) => `KNOWN_FINDING_STALE ${claim.finding.id} on ${area} ${seedText(seed)}: ${claim.expected.property} ${claim.expected.signature} no longer appears; delete its entry from diff/findings/known.ts`);
  return { unknown: lines.filter((line) => claimedBy(line) === undefined), known, stale };
};
