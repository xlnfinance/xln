// greeting — banner (quote default, wordmark opt-in) + ONE fetch-style identity line.
import { describe, expect, it } from "vitest";

import { bannerLines, greetingLines, identityLine, resolveBanner } from "../greeting.js";
import { QUOTES, pickQuote, wrapText } from "../quotes.js";
import { stripAnsi } from "./ansi-strip.js";

const FACTS = { version: "0.1.0", capabilityCount: 0, lens: "sugarcoat" as const };

describe("identityLine", () => {
  it("names version, capability count, and lens mode — the fetch-style facts", () => {
    const line = stripAnsi(identityLine(FACTS, "none"));
    expect(line).toBe("arrival 0.1.0 — no capabilities armed · sugarcoat lens · ,lens to flip, ? for help");
  });

  it("pluralizes capability count and reflects the scheme lens", () => {
    const one = stripAnsi(identityLine({ version: "0.1.0", capabilityCount: 1, lens: "scheme" }, "none"));
    expect(one).toContain("1 capability armed");
    expect(one).toContain("scheme lens");

    const many = stripAnsi(identityLine({ version: "0.1.0", capabilityCount: 3, lens: "scheme" }, "none"));
    expect(many).toContain("3 capabilities armed");
  });
});

describe("resolveBanner", () => {
  it("defaults to quote", () => {
    expect(resolveBanner({})).toBe("quote");
  });
  it("flag beats env", () => {
    expect(resolveBanner({ ARRIVAL_BANNER: "wordmark" }, "off")).toBe("off");
  });
  it("accepts quote | wordmark | off (and aliases)", () => {
    expect(resolveBanner({ ARRIVAL_BANNER: "wordmark" })).toBe("wordmark");
    expect(resolveBanner({ ARRIVAL_BANNER: "logo" })).toBe("wordmark");
    expect(resolveBanner({ ARRIVAL_BANNER: "none" })).toBe("off");
    expect(resolveBanner({ ARRIVAL_BANNER: "off" })).toBe("off");
  });
  it("unknown value is a teaching error", () => {
    expect(() => resolveBanner({ ARRIVAL_BANNER: "rainbow" })).toThrow(/quote \| wordmark \| off/);
  });
});

describe("pickQuote / wrapText", () => {
  it("the pool is the closed list", () => {
    expect(QUOTES.length).toBe(25);
  });
  it("rng pins the pick (tests / tape)", () => {
    expect(pickQuote(() => 0)).toBe(QUOTES[0]);
    expect(pickQuote(() => 0.999)).toBe(QUOTES[QUOTES.length - 1]);
  });
  it("wraps on word boundaries", () => {
    expect(wrapText("All information looks like noise until you break the code.", 20)).toEqual([
      "All information",
      "looks like noise",
      "until you break the",
      "code.",
    ]);
  });
});

describe("greetingLines", () => {
  it("off is just the identity line", () => {
    const lines = greetingLines(FACTS, "none", { kind: "off" });
    expect(lines).toEqual(["arrival 0.1.0 — no capabilities armed · sugarcoat lens · ,lens to flip, ? for help"]);
  });

  it("quote is wrapped shibboleth + blank + identity — not a wordmark", () => {
    const quote = QUOTES[17]!; // "All information looks like noise…"
    const lines = greetingLines(FACTS, "none", { kind: "quote", quote, width: 72 });
    expect(lines[0]).toBe(quote);
    expect(lines.at(-1)).toContain("arrival 0.1.0");
    expect(lines.join("\n")).not.toContain("████");
  });

  it("wordmark is the six-row block art + identity", () => {
    const lines = greetingLines(FACTS, "none", { kind: "wordmark" });
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("████");
    expect(stripAnsi(lines[7] ?? "")).toContain("arrival 0.1.0");
  });
});

describe("bannerLines", () => {
  it("off is empty", () => {
    expect(bannerLines({ kind: "off" }, "none")).toEqual([]);
  });
});
