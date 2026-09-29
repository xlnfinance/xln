/**
 * `EvalTrace.toolNameFor` — the ordinal→tool-name read (custdev CORE-3).
 *
 * `deepProvenance` yields numeric invocation ids (`[1]`, `[5]`), and before this API the
 * ids were dead ends: no exported query answered "which tool produced this value?" by
 * name (`invocationFor` keys on TASK objects, not ids — it returns undefined for an
 * ordinal). This pins the whole documented path, over the public surface only:
 * source verb → exec with tap → deepProvenance → toolNameFor.
 */
import { describe, expect, it } from "vitest";

import { deepProvenance } from "../deep-provenance.js";
import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";
import { EvalTrace } from "../trace.js";

const weather = EnvCapability.define("test/weather", {
  symbols: (symbol, z) => ({
    "forecast-for": symbol.rosetta`forecast-for: the current forecast for a city`(
      { input: [z.string], output: [z.string], provenance: "source" },
      async (city) => `cloudy in ${city}`,
    ),
    "scan-output": symbol.rosetta`scan-output: the scanner's verdict line`(
      { input: [], output: [z.string], provenance: "source" },
      async () => "evil.exe",
    ),
  }),
});

describe("EvalTrace.toolNameFor — deepProvenance ordinals resolve to verb names", () => {
  it("a single source crossing: the ordinal names the verb", async () => {
    const trace = new EvalTrace();
    const {
      values: [line],
    } = await execState(`(string-append "today: " (forecast-for "berlin"))`, {
      capabilities: [weather],
      tap: trace,
    });
    expect(toJS(line)).toBe("today: cloudy in berlin");
    const ids = [...deepProvenance(line)];
    expect(ids).toHaveLength(1);
    expect(trace.toolNameFor(ids[0]!)).toBe("forecast-for");
  });

  it("unioned origins: each ordinal resolves to its own verb", async () => {
    const trace = new EvalTrace();
    const {
      values: [line],
    } = await execState(`(string-append (forecast-for "berlin") " / " (scan-output))`, {
      capabilities: [weather],
      tap: trace,
    });
    const names = [...deepProvenance(line)].map((id) => trace.toolNameFor(id)).toSorted();
    expect(names).toEqual(["forecast-for", "scan-output"]);
  });

  it("an id the trace never minted is undefined, never a throw", () => {
    const trace = new EvalTrace();
    expect(trace.toolNameFor(999)).toBeUndefined();
    expect(trace.invocationById(999)).toBeUndefined();
  });
});
