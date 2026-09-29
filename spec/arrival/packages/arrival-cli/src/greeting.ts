/**
 * The greeting: a configurable banner plus ONE fetch-style identity line.
 *
 * Default banner is a shibboleth quote (`quotes.ts`) — not a wordmark, not a
 * quote-of-the-day. `ARRIVAL_BANNER` / `--banner` selects `quote` | `wordmark` | `off`.
 * The identity line is always the facts (version · caps · lens).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickQuote, wrapText } from "./quotes.js";
import { colorMode, paint, type ColorMode } from "./tints.js";
import type { Lens } from "./lens.js";
import { wordmark } from "./wordmark.js";

export type BannerKind = "quote" | "wordmark" | "off";

export interface GreetingFacts {
  readonly version: string;
  readonly capabilityCount: number;
  readonly lens: Lens;
}

export interface BannerOpts {
  readonly kind?: BannerKind;
  /** Wrap width for the quote. Defaults to stdout columns, or 72. */
  readonly width?: number;
  /** Injected RNG for tests — `Math.random` at the session start otherwise. */
  readonly rng?: () => number;
  /** Pin a specific quote (theme-shot). Ignored unless kind is `quote`. */
  readonly quote?: string;
}

/** `dist/greeting.js` → `../package.json` — resolved at runtime, not baked in at build
 *  time, so the printed version never drifts from what's actually installed. */
export async function readOwnVersion(): Promise<string> {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function resolveBanner(env: NodeJS.ProcessEnv = process.env, flag?: string): BannerKind {
  const raw = flag ?? env.ARRIVAL_BANNER;
  if (raw === undefined || raw === "") return "quote";
  const v = raw.toLowerCase();
  if (v === "quote") return "quote";
  if (v === "wordmark" || v === "logo") return "wordmark";
  if (v === "off" || v === "none" || v === "0") return "off";
  throw new Error(`arrival: unknown banner ${JSON.stringify(raw)} — quote | wordmark | off`);
}

function defaultWidth(): number {
  return process.stdout.columns ?? 72;
}

/** Banner rows only — no identity line. Empty when `off`. Quote is voice (gutter). */
export function bannerLines(opts: BannerOpts = {}, mode: ColorMode = colorMode()): string[] {
  const kind = opts.kind ?? resolveBanner();
  if (kind === "off") return [];
  if (kind === "wordmark") return wordmark(mode);
  const quote = opts.quote ?? pickQuote(opts.rng);
  return wrapText(quote, opts.width ?? defaultWidth()).map((line) => paint(line, "gutter", mode));
}

/** The one fetch-style line: `arrival 0.1.0 — 2 capabilities armed · sugarcoat lens`. */
export function identityLine(facts: GreetingFacts, mode: ColorMode = colorMode()): string {
  const caps =
    facts.capabilityCount === 0
      ? "no capabilities armed"
      : `${facts.capabilityCount} capabilit${facts.capabilityCount === 1 ? "y" : "ies"} armed`;
  const lensLabel = facts.lens === "sugarcoat" ? "sugarcoat lens" : "scheme lens";
  return paint(`arrival ${facts.version} — ${caps} · ${lensLabel} · ,lens to flip, ? for help`, "gutter", mode);
}

/** Banner + identity. `banner: "off"` is just the identity line. */
export function greetingLines(facts: GreetingFacts, mode: ColorMode = colorMode(), banner: BannerOpts = {}): string[] {
  const top = bannerLines(banner, mode);
  const id = identityLine(facts, mode);
  return top.length === 0 ? [id] : [...top, "", id];
}
