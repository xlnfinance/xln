// The table of known findings may only shrink. A site is named `<finding>@<area>:<seed>`; baseline.json maps each site allowed to exist to
// the number of lines it may expect. The table may not hold a site the baseline lacks or expect more lines there than the baseline allows,
// and the baseline may not hold a site, or a line count, that the base commit's baseline lacked.
// An entry is one finding: its id is unique, its rule is a live row of the register (or an og bug with a reason), it has an owner and sites.
import type { KnownFinding } from "./known.ts";

export type Problem =
  | Readonly<{ _tag: "SiteNotInBaseline"; site: string }>
  | Readonly<{ _tag: "SiteGrew"; site: string; lines: number; allowed: number }>
  | Readonly<{ _tag: "BaselineGrew"; site: string }>
  | Readonly<{ _tag: "DuplicateSite"; site: string }>
  | Readonly<{ _tag: "UnknownRule"; id: string; rule: string }>
  | Readonly<{ _tag: "EmptyEntry"; id: string; detail: string }>;

/** Allowed lines per site id. */
export type Baseline = Readonly<Record<string, number>>;

const siteId = (finding: KnownFinding, site: KnownFinding["sites"][number]): string => `${finding.id}@${site.area}:0x${site.seed.toString(16)}`;

/** Every site of the table with the number of lines it expects; a repeated id repeats here. */
export const siteLines = (findings: readonly KnownFinding[]): readonly (readonly [string, number])[] =>
  findings.flatMap((finding) => finding.sites.map((site) => [siteId(finding, site), site.expects.length] as const));

export const siteIds = (findings: readonly KnownFinding[]): readonly string[] => siteLines(findings).map(([id]) => id);

/** One site (and so one finding, since a site id names its finding) may be written once: a second copy would add expectations unseen. */
export const duplicates = (findings: readonly KnownFinding[]): readonly Problem[] =>
  siteIds(findings).filter((id, i, all) => all.indexOf(id) !== i).map((site): Problem => ({ _tag: "DuplicateSite", site }));

/** A rule basis names a row of the register that is not retired; a finding with no row is a rule nobody owns. */
export const unknownRules = (findings: readonly KnownFinding[], liveRules: readonly string[]): readonly Problem[] =>
  findings.flatMap((finding): readonly Problem[] =>
    finding.basis._tag === "rule" && !liveRules.includes(finding.basis.id)
      ? [{ _tag: "UnknownRule", id: finding.id, rule: finding.basis.id }]
      : []);

/** An entry that names no owner, no rule or og bug, or nothing to expect cannot be judged or retired. */
export const emptyEntries = (findings: readonly KnownFinding[]): readonly Problem[] =>
  findings.flatMap((finding): readonly Problem[] => {
    const noOwner = finding.owner.trim() === "" ? [{ _tag: "EmptyEntry", id: finding.id, detail: "no owner" } as const] : [];
    const noBasis = (finding.basis._tag === "rule" ? finding.basis.id : finding.basis.why).trim() === ""
      ? [{ _tag: "EmptyEntry", id: finding.id, detail: "no rule id or og-bug reason" } as const]
      : [];
    const noSites = finding.sites.length === 0 ? [{ _tag: "EmptyEntry", id: finding.id, detail: "no site" } as const] : [];
    const noExpects = finding.sites.some((site) => site.expects.length === 0)
      ? [{ _tag: "EmptyEntry", id: finding.id, detail: "a site expects nothing" } as const]
      : [];
    const blankLine = finding.sites.some((site) => site.expects.some((expected) => expected.line.trim() === ""))
      ? [{ _tag: "EmptyEntry", id: finding.id, detail: "an expected line is blank" } as const]
      : [];
    return [...noOwner, ...noBasis, ...noSites, ...noExpects, ...blankLine];
  });

/** `base` is the baseline at the merge base, or undefined when that commit has none (the commit that introduces it). */
export const ratchet = (
  findings: readonly KnownFinding[],
  liveRules: readonly string[],
  baseline: Baseline,
  base: Baseline | undefined,
): readonly Problem[] => [
  ...emptyEntries(findings),
  ...duplicates(findings),
  ...unknownRules(findings, liveRules),
  ...siteLines(findings).flatMap(([site, lines]): readonly Problem[] => {
    const allowed = baseline[site];
    return allowed === undefined ? [{ _tag: "SiteNotInBaseline", site }] : lines > allowed ? [{ _tag: "SiteGrew", site, lines, allowed }] : [];
  }),
  ...(base === undefined
    ? []
    : Object.entries(baseline).filter(([site, lines]) => (base[site] ?? -1) < lines).map(([site]): Problem => ({ _tag: "BaselineGrew", site }))),
];
