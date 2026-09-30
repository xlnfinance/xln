import { describe, expect, test } from "bun:test";
// Each registered site off the model walk is walked here, so a finding that stops reproducing turns `bun test` red (the model sites are walked by
// runtime/model.test.ts on its default seeds). A walk that reproduces its finding prints KNOWN lines and no DIFF; a stale entry prints DIFF.
import { KNOWN_FINDINGS } from "./known.ts";

const SITES = KNOWN_FINDINGS.flatMap((finding) =>
  finding.sites.filter((site) => site.area !== "model").map((site) => ({ finding, site })));

describe("known findings: every registered walk still reproduces exactly what it expects", () => {
  SITES.forEach(({ finding, site }) => {
    test(`${finding.id} on ${site.area} 0x${site.seed.toString(16)}: only KNOWN lines, no stale entry`, () => {
      const run = Bun.spawnSync([process.execPath, `${import.meta.dir}/../walk.ts`, "--area", site.area, "--seed", `0x${site.seed.toString(16)}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const lines = run.stdout.toString().split("\n");
      expect(lines.filter((line) => line.startsWith("  DIFF "))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("  KNOWN ")).length).toBeGreaterThanOrEqual(site.expects.length);
      expect(run.exitCode).toBe(0);
    }, 900_000);
  });
});
