// The table of known findings may only shrink. A site is named `<finding>@<area>:<seed>`; baseline.json lists the sites allowed to exist.
// The table may not hold a site the baseline lacks, and the baseline may not hold a site the base commit's baseline lacked.
import type { KnownFinding } from "./known.ts";

export type Problem =
  | Readonly<{ _tag: "SiteNotInBaseline"; site: string }>
  | Readonly<{ _tag: "BaselineGrew"; site: string }>
  | Readonly<{ _tag: "EmptyEntry"; id: string; detail: string }>;

export const siteIds = (findings: readonly KnownFinding[]): readonly string[] =>
  findings.flatMap((finding) => finding.sites.map((site) => `${finding.id}@${site.area}:0x${site.seed.toString(16)}`));

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
    return [...noOwner, ...noBasis, ...noSites, ...noExpects];
  });

/** `base` is the baseline at the merge base, or undefined when that commit has none (the commit that introduces it). */
export const ratchet = (
  findings: readonly KnownFinding[],
  baseline: readonly string[],
  base: readonly string[] | undefined,
): readonly Problem[] => [
  ...emptyEntries(findings),
  ...siteIds(findings).filter((site) => !baseline.includes(site)).map((site): Problem => ({ _tag: "SiteNotInBaseline", site })),
  ...(base === undefined ? [] : baseline.filter((site) => !base.includes(site)).map((site): Problem => ({ _tag: "BaselineGrew", site }))),
];
