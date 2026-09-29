/**
 * Semantic tints + syntax hex, one chalk choke-point for every SGR byte.
 *
 * Two axes, never mixed:
 *   • STATE tints (`paint`) — roles: pending / running / done / error / … Seeds are
 *     (chroma, hue, tier) from Delta's emphasis hues. Lightness is SOLVED against the
 *     canvas (ground tint + native fg brightness) with Nayatani H-K compensation.
 *   • TOKEN hex (`paintHex`, `DARCULA`) — symbols/comments/delimiters ARE the native
 *     ink; keyword/string/number keep Darcula hue, appeared against the paper.
 *
 * Depth ladder is capability, not policy: `colorMode` reads env (under-claim: a 16-color
 * term that gets 256 garbage is worse than a 256-color term that gets 16 hue-family
 * pins). `streamColorMode` is the policy wrapper (TTY / NO_COLOR / CLICOLOR_FORCE /
 * TERM=dumb) every process sink should call. Chalk owns the escape emission — this file
 * never writes `\x1b[38` itself.
 *
 * Native look on any terminal — their fg is the typeface, our hues are the
 * highlighter, the canvas is the paper:
 *   • OSC 10 is the ink (hue + chroma + perceptual lightness baseline).
 *   • OSC 11 is the paper (tint). Voice (gutter, comments, symbols) IS that ink,
 *     faded toward the paper. Signals are not unique-red RGB: they are the color
 *     that *reads* as the identity next to this paper (OKLab stain = inverse
 *     simultaneous contrast — "there's no red in this picture but you see red").
 *   • Fallback without a probe: COLORFGBG, then the dark reference (L=0.2).
 * Never paint a default cell background — unpainted bg is the terminal through.
 *
 * Not imported: `@inhuman.tools/quickdraw`. The H-K solver, env heuristics, and ANSI16
 * hue pins are the lessons; the TUI substrate is not. Color conversion is culori.
 */
// Named `Chalk` constructor — the default export is a process-env instance we
// cannot pin to a depth rung. Per-rung instances are the downsample contract.
// eslint-disable-next-line unicorn/import-style -- constructor is a named export
import { Chalk, type ChalkInstance } from "chalk";
import { clampChroma, converter, interpolate, oklab, oklch } from "culori";

import { probeCanvas, type OscRgb } from "./osc.js";

const toRgb = converter("rgb");

/** Delta's own hue degrees (factors-properties.css `--⚙️hue-emphasis-*` defaults) —
 *  copied, not invented: accent=211 (Apple's cognitive blue), success=142, danger=35,
 *  variant=285 (purple, "specialized contexts" — the wordmark's gradient far end);
 *  warning=57 (amber — the compensated-Darcula warning family). A neutral gray has
 *  no hue (chroma 0, hue irrelevant). */
export const HUE = {
  accent: 211,
  success: 142,
  danger: 35,
  variant: 285,
  warning: 57,
} as const;

/** Delta's chroma tiers (factors.css §"CHROMA TIERS"): primary (accent/warning/danger)
 *  pulls focus, tertiary (success/info) stays ambient/low-urgency. Neutral pending/
 *  skipped blocks get chroma 0 — Delta's own `Δemphasis-unset` posture. */
export const CHROMA = { primary: 0.15, tertiary: 0.08, neutral: 0 } as const;

export type ColorMode = "truecolor" | "256" | "16" | "none";

export type TintName =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "warning"
  | "skipped"
  | "accent"
  | "gutter"
  | "variant";

export type TintTier = "alarm" | "recede" | "differentiate";

/** Apparent-lightness contrast deltas per tier at the reference ground.
 *  Same calibration as quickdraw's salience solver: alarm is chroma-identity (not
 *  the lightest), recede is furniture, differentiate is the working signal. */
const TIER_DELTAS: Record<TintTier, number> = {
  alarm: 0.33,
  recede: 0.35,
  differentiate: 0.42,
};

/** Near-black ground the tier deltas were derived against. */
export const REFERENCE_GROUND = 0.2;

const AL_MIN = 0.03;
const AL_MAX = 0.97;
const MAX_DELTA = 0.65;

/** H-K chroma scale (≈ Fairchild–Pirrotta k; magnitude is Delta's budget). */
const HK_K = 0.14;

/**
 * Nayatani-1997 VAC hue weight — 3-harmonic Fourier fit in OKLCH hue degrees.
 * Coefficients: Delta foundation.css `--🧮hue-factor` / quickdraw `nayataniHueFactor`
 * (R²≈0.98 vs VAC q(θ)). Inherently ~[0.54, 0.92] — no clamp.
 */
const NAY_A0 = 0.779_11;
const NAY_COS = [0.080_91, 0.062_02, -0.014_15] as const;
const NAY_SIN = [-0.135_93, -0.003_65, 0.033_77] as const;

export function hueFactor(h: number): number {
  let v = NAY_A0;
  const rad = (h * Math.PI) / 180;
  for (let k = 1; k <= 3; k++) {
    const r = k * rad;
    v += NAY_COS[k - 1]! * Math.cos(r) + NAY_SIN[k - 1]! * Math.sin(r);
  }
  return v;
}

/** Amount of L to subtract so a chromatic color sits level with gray at the same AL. */
export function hkCompensation(c: number, h: number): number {
  return HK_K * Math.max(0, c) * hueFactor(h);
}

/** Perceived / apparent lightness — chromatic looks brighter than measured L. */
export function apparentLightness(l: number, c: number, h: number): number {
  return l + hkCompensation(c, h);
}

/** Nominal OKLCH L that lands (C, h) on a target apparent lightness. */
export function solveLightness(targetAl: number, c: number, h: number): number {
  return targetAl - hkCompensation(c, h);
}

function tierTarget(tier: TintTier, ground: number): number {
  const sign: 1 | -1 = ground < 0.5 ? 1 : -1;
  const headroom = sign === 1 ? AL_MAX - ground : ground - AL_MIN;
  const scale = Math.min(1, Math.max(0, headroom / MAX_DELTA));
  return ground + sign * TIER_DELTAS[tier] * scale;
}

/**
 * When OSC 10 reported a usable fg, tiers are mixes along ground→fg apparent
 * lightness (the native text brightness). Recede sits about halfway; differentiate
 * almost at the ink; alarm near the ink (chroma carries the identity).
 */
const TIER_MIX: Record<TintTier, number> = {
  recede: 0.42,
  differentiate: 0.92,
  alarm: 0.85,
};

/**
 * Inverse simultaneous contrast. The visual system subtracts the surround, so
 * we ADD the paper's OKLab (a, b) to the identity. The RGB is not unique-red;
 * against this paper it reads as the identity. 0 = no stain (achromatic paper
 * is a no-op anyway).
 */
const PAPER_STAIN = 0.5;

/** Contrast JND — fg that doesn't clear this from ground is ignored as a probe lie;
 *  solved ink that lands inside it is pushed out (contrast floor). */
const FG_JND = 0.07;

/** Seeds: hue carries identity, tier carries importance. L is solved, not stored. */
const TINT_SEED: Record<TintName, { readonly c: number; readonly h: number; readonly tier: TintTier }> = {
  pending: { c: CHROMA.neutral, h: 0, tier: "recede" },
  skipped: { c: CHROMA.neutral, h: 0, tier: "recede" },
  gutter: { c: CHROMA.neutral, h: 0, tier: "recede" },
  running: { c: CHROMA.primary, h: HUE.accent, tier: "differentiate" },
  accent: { c: CHROMA.primary, h: HUE.accent, tier: "differentiate" },
  done: { c: CHROMA.tertiary, h: HUE.success, tier: "differentiate" },
  error: { c: CHROMA.primary, h: HUE.danger, tier: "alarm" },
  warning: { c: CHROMA.primary, h: HUE.warning, tier: "differentiate" },
  variant: { c: CHROMA.tertiary, h: HUE.variant, tier: "differentiate" },
};

/**
 * Hue-preserving ANSI16 pins for STATE tints. Nearest-RGB quantization collapses
 * error→yellow (hue 35 sits between red and yellow); a pin table keeps category.
 * Loud (bright 8–15) on dark ground, soft (0–7) on light — polarity from ground L.
 */
const ANSI16_PIN: Record<"dark" | "light", Record<TintName, (c: ChalkInstance) => ChalkInstance>> = {
  dark: {
    pending: (c) => c.gray,
    skipped: (c) => c.gray,
    gutter: (c) => c.gray,
    running: (c) => c.cyanBright,
    accent: (c) => c.cyanBright,
    done: (c) => c.greenBright,
    error: (c) => c.redBright,
    warning: (c) => c.yellowBright,
    variant: (c) => c.magentaBright,
  },
  light: {
    pending: (c) => c.gray,
    skipped: (c) => c.gray,
    gutter: (c) => c.gray,
    running: (c) => c.cyan,
    accent: (c) => c.blue,
    done: (c) => c.green,
    error: (c) => c.red,
    warning: (c) => c.yellow,
    variant: (c) => c.magenta,
  },
};

export type Oklch = { l: number; c: number; h: number };

export type ThemeCanvas = {
  readonly ground: Oklch;
  /** Native default fg. Absent → fall back to signed deltas from ground L. */
  readonly fg?: Oklch;
};

export const REFERENCE_CANVAS: ThemeCanvas = { ground: { l: REFERENCE_GROUND, c: 0, h: 0 } };

let canvas: ThemeCanvas = REFERENCE_CANVAS;

function clampL(l: number): number {
  return Math.min(AL_MAX, Math.max(AL_MIN, l));
}

function rgb8ToOklch(rgb: OscRgb): Oklch | undefined {
  const o = oklch({ mode: "rgb", r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 });
  if (!o || o.l === undefined) return undefined;
  return { l: o.l, c: o.c ?? 0, h: o.h ?? 0 };
}

/** Fg is usable only when it contrasts with ground and sits on the opposite side of it. */
function usableFg(ground: Oklch, fg: Oklch | undefined): Oklch | undefined {
  if (fg === undefined) return undefined;
  const gAl = apparentLightness(ground.l, ground.c, ground.h);
  const fAl = apparentLightness(fg.l, fg.c, fg.h);
  if (Math.abs(fAl - gAl) < FG_JND) return undefined;
  if (ground.l < 0.5 ? fAl <= gAl : fAl >= gAl) return undefined;
  return fg;
}

/** OKLCH L currently solving the palette. Tests that mutate the canvas must restore. */
export function themeGround(): number {
  return canvas.ground.l;
}

export function themeCanvas(): ThemeCanvas {
  return canvas;
}

/** Retune against an achromatic ground L (tests). Clears any probed fg. */
export function setThemeGround(l: number): void {
  canvas = { ground: { l: clampL(l), c: 0, h: 0 } };
}

export function setThemeCanvas(next: ThemeCanvas): void {
  canvas = {
    ground: { l: clampL(next.ground.l), c: Math.max(0, next.ground.c), h: next.ground.h },
    fg: next.fg === undefined ? undefined : { l: clampL(next.fg.l), c: Math.max(0, next.fg.c), h: next.fg.h },
  };
}

/** Fold an OSC 10/11 probe into the canvas. Missing sides keep the reference. */
export function attuneFromProbe(probe: { bg?: OscRgb; fg?: OscRgb }): void {
  const ground = probe.bg === undefined ? REFERENCE_CANVAS.ground : (rgb8ToOklch(probe.bg) ?? REFERENCE_CANVAS.ground);
  const fg = probe.fg === undefined ? undefined : rgb8ToOklch(probe.fg);
  canvas = { ground: { ...ground, l: clampL(ground.l) }, fg: usableFg(ground, fg) };
}

function clamp8(channel: number | undefined): number {
  return Math.max(0, Math.min(255, Math.round((channel ?? 0) * 255)));
}

/** OKLCH → 0–255 sRGB via culori. Out-of-gamut channels clip (our chroma budget stays inside). */
export function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const rgb = toRgb({ mode: "oklch", l, c: Math.max(0, c), h: hDeg });
  if (!rgb) throw new Error(`oklch→srgb failed for oklch(${l}, ${c}, ${hDeg})`);
  return [clamp8(rgb.r), clamp8(rgb.g), clamp8(rgb.b)];
}

/** Raw OKLCH → sRGB. Callers that already have L (or tests of the projection) use this. */
export function tintRgb(l: number, c: number, hDeg: number): [number, number, number] {
  return oklchToSrgb(l, c, hDeg);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function asOklch(o: { l?: number; c?: number; h?: number }, fallback: Oklch): Oklch {
  return { l: o.l ?? fallback.l, c: o.c ?? fallback.c, h: o.h ?? fallback.h };
}

function targetAl(tier: TintTier, theme: ThemeCanvas): number {
  const g = theme.ground;
  const gAl = apparentLightness(g.l, g.c, g.h);
  if (theme.fg === undefined) return tierTarget(tier, g.l);
  const fAl = apparentLightness(theme.fg.l, theme.fg.c, theme.fg.h);
  return mix(gAl, fAl, TIER_MIX[tier]);
}

function contrastFloor(color: Oklch, theme: ThemeCanvas): Oklch {
  const al = apparentLightness(color.l, color.c, color.h);
  const gAl = apparentLightness(theme.ground.l, theme.ground.c, theme.ground.h);
  if (Math.abs(al - gAl) >= FG_JND) return color;
  const towardFg =
    theme.fg === undefined
      ? theme.ground.l < 0.5
        ? 1
        : -1
      : Math.sign(apparentLightness(theme.fg.l, theme.fg.c, theme.fg.h) - gAl) || 1;
  return { ...color, l: solveLightness(gAl + towardFg * FG_JND, color.c, color.h) };
}

function emitOklch(color: Oklch): [number, number, number] {
  const clamped = clampChroma({ mode: "oklch", l: color.l, c: Math.max(0, color.c), h: color.h }, "oklch");
  const o = clamped && "l" in clamped ? asOklch(clamped, color) : { ...color, c: Math.max(0, color.c) };
  return oklchToSrgb(o.l, o.c, o.h);
}

/**
 * Voice = their ink faded toward the paper. Without an fg sample, recede is the
 * paper itself at recede AL (a tinted dim, not a foreign gray).
 */
function voiceOklch(tier: TintTier, theme: ThemeCanvas): Oklch {
  const g = theme.ground;
  if (theme.fg === undefined) {
    const c = g.c * 0.5;
    return contrastFloor({ l: solveLightness(targetAl(tier, theme), c, g.h), c, h: g.h }, theme);
  }
  const p = interpolate(
    [
      { mode: "oklch", l: g.l, c: g.c, h: g.h },
      { mode: "oklch", l: theme.fg.l, c: theme.fg.c, h: theme.fg.h },
    ],
    "oklch",
  )(TIER_MIX[tier]);
  const mixed = asOklch(p ?? {}, theme.fg);
  return contrastFloor({ l: solveLightness(targetAl(tier, theme), mixed.c, mixed.h), c: mixed.c, h: mixed.h }, theme);
}

/**
 * Signal appearance: identity (c, h) stained with the paper's OKLab chroma so
 * the visual system, subtracting the surround, sees the identity. The emitted
 * RGB is "what is red next to this bg", not unique-red.
 */
function appearOklch(c: number, hDeg: number, tier: TintTier, theme: ThemeCanvas): Oklch {
  const target = targetAl(tier, theme);
  const l0 = solveLightness(target, c, hDeg);
  const id = oklab({ mode: "oklch", l: l0, c: Math.max(0, c), h: hDeg });
  const paper = oklab({ mode: "oklch", l: theme.ground.l, c: theme.ground.c, h: theme.ground.h });
  if (!id || !paper) return contrastFloor({ l: l0, c: Math.max(0, c), h: hDeg }, theme);
  const stained = oklch({
    mode: "oklab",
    l: id.l,
    a: (id.a ?? 0) + PAPER_STAIN * (paper.a ?? 0),
    b: (id.b ?? 0) + PAPER_STAIN * (paper.b ?? 0),
  });
  const o = stained ? asOklch(stained, { l: l0, c, h: hDeg }) : { l: l0, c: Math.max(0, c), h: hDeg };
  return contrastFloor(o, theme);
}

/** Recede with no identity chroma → voice (their ink). Else the identity, as seen on this paper. */
export function solveRgb(
  c: number,
  hDeg: number,
  tier: TintTier,
  theme: ThemeCanvas = canvas,
): [number, number, number] {
  const o = tier === "recede" && c === 0 ? voiceOklch(tier, theme) : appearOklch(c, hDeg, tier, theme);
  return emitOklch(o);
}

/**
 * Depth from env. NO_COLOR (any value, including "") wins — https://no-color.org.
 * Under-claim: missing COLORTERM is NOT a 256 promise; `TERM=*256color*` is.
 * `force` pins a mode for tests / tape-recording regardless of the host TTY.
 */
export function colorMode(env: NodeJS.ProcessEnv = process.env, force?: ColorMode): ColorMode {
  if (force !== undefined) return force;
  if (env.NO_COLOR !== undefined) return "none";
  if (env.TERM === "dumb") return "none";

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";

  const term = env.TERM ?? "";
  if (/truecolor|direct/i.test(term)) return "truecolor";
  if (/256color/i.test(term)) return "256";

  if (env.TERM_PROGRAM === "iTerm.app") return "truecolor";
  if (env.WT_SESSION) return "truecolor";

  // xterm / screen / tmux / rxvt / vt100, Apple Terminal, and unknown: 16.
  // Over-claiming 256 on a 16-color term produces garbage; under-claiming 16 on a
  // 256-color term still lands in the right hue family via the pin table / chalk.
  return "16";
}

/** `CLICOLOR_FORCE` present and not `"0"` — the "color through a pipe anyway" override. */
function colorForced(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLICOLOR_FORCE;
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * Policy + capability for one stream. Precedence (highest first): NO_COLOR off →
 * not-a-TTY (unless CLICOLOR_FORCE) off → TERM=dumb (unless CLICOLOR_FORCE) off →
 * {@link colorMode}. CLICOLOR_FORCE on a dumb TERM emits the 16-color rung rather
 * than inventing truecolor.
 */
export function streamColorMode(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR !== undefined) return "none";
  const forced = colorForced(env);
  if (!isTTY && !forced) return "none";
  if (env.TERM === "dumb" && !forced) return "none";
  if (env.TERM === "dumb") return "16";
  return colorMode(env);
}

/** Classic xterm 0–15 — COLORFGBG fallback when OSC is silent. */
const ANSI16_RGB: readonly OscRgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

/** `COLORFGBG=fg;bg` as ANSI 0–15 indices. Missing/out-of-range → empty. */
export function canvasFromColorFgBg(env: NodeJS.ProcessEnv = process.env): { bg?: OscRgb; fg?: OscRgb } {
  const raw = env.COLORFGBG;
  if (raw === undefined || raw === "") return {};
  const m = /^(\d{1,2});(\d{1,2})$/.exec(raw);
  if (!m) return {};
  const fgI = Number(m[1]);
  const bgI = Number(m[2]);
  return {
    fg: fgI >= 0 && fgI <= 15 ? ANSI16_RGB[fgI] : undefined,
    bg: bgI >= 0 && bgI <= 15 ? ANSI16_RGB[bgI] : undefined,
  };
}

/** Probe OSC 10+11 when this stream can color; COLORFGBG fills any silent side. */
export async function attuneTerminal(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (streamColorMode(process.stdout.isTTY === true, env) === "none") return;
  const probed = await probeCanvas();
  const fallback = canvasFromColorFgBg(env);
  attuneFromProbe({ bg: probed.bg ?? fallback.bg, fg: probed.fg ?? fallback.fg });
}

/** One chalk instance per capability rung. `level: 0` short-circuits to the raw text. */
const CHALK: Record<ColorMode, ChalkInstance> = {
  none: new Chalk({ level: 0 }),
  "16": new Chalk({ level: 1 }),
  "256": new Chalk({ level: 2 }),
  truecolor: new Chalk({ level: 3 }),
};

function polarity(ground: number): "dark" | "light" {
  return ground < 0.5 ? "dark" : "light";
}

/** Render `text` through `tint`, honoring `mode` (defaults to the live terminal's). */
export function paint(text: string, tint: TintName, mode: ColorMode = colorMode()): string {
  if (mode === "none") return text;
  if (mode === "16") return ANSI16_PIN[polarity(canvas.ground.l)][tint](CHALK["16"])(text);
  const seed = TINT_SEED[tint];
  const [r, g, b] = solveRgb(seed.c, seed.h, seed.tier);
  return CHALK[mode].rgb(r, g, b)(text);
}

/**
 * The repo's compensated-Darcula TOKEN palette — copied from
 * `commons/packages/editor-theme/src/theme-darcula.ts` (the source of truth; re-sync if it
 * changes). Used by BOTH the code highlighter (`highlight.ts`) and the value colorizer
 * (`sexpr-color.ts`) so the input line, the settled-block source, and the output value all
 * share ONE palette — a `:keyword` is the same purple everywhere, a number the same blue.
 * (The semantic STATE tints above — the ✓/▸/✗ glyph, the dim gutter — are a separate axis.)
 */
export const DARCULA = {
  keyword: "#bb6b25", // define/lambda/if/cond/… — one orange for all structural keywords
  symbol: "#a9b5c1", // plain identifiers (variableName/name)
  string: "#728e60", // strings + char literals
  number: "#5b89ad", // numbers
  constant: "#5b89ad", // #t/#f/nil — darcula colors these as numbers (blue)
  property: "#9673a7", // :keyword / propertyName
  comment: "#717171",
  delimiter: "#717171", // parens/brackets/braces
  heading: "#b4b4b4", // markdown heading/strong (bold)
} as const;

/** Voice tokens: their ink. Chromatic tokens: identity hue as seen on this paper. */
const VOICE_TIER: Record<string, TintTier> = {
  [DARCULA.symbol]: "differentiate",
  [DARCULA.heading]: "differentiate",
  [DARCULA.comment]: "recede", // delimiter shares this hex
};

/**
 * Syntax: voice hexes are the native ink (comment recede, symbol = their fg);
 * the rest keep Darcula hue/chroma but appear() against the paper.
 */
export function paintHex(text: string, hex: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return text;
  const voiceTier = VOICE_TIER[hex];
  if (voiceTier !== undefined) {
    const [r, g, b] = emitOklch(voiceOklch(voiceTier, canvas));
    return CHALK[mode].rgb(r, g, b)(text);
  }
  const o = oklch(hex);
  if (!o || o.l === undefined) return CHALK[mode].hex(hex)(text);
  const [r, g, b] = emitOklch(appearOklch(o.c ?? 0, o.h ?? 0, "differentiate", canvas));
  return CHALK[mode].rgb(r, g, b)(text);
}

/** Paint `text` an already-solved sRGB triple — the wordmark's per-cell gradient. */
export function paintRgb(text: string, r: number, g: number, b: number, mode: ColorMode = colorMode()): string {
  return mode === "none" ? text : CHALK[mode].rgb(r, g, b)(text);
}

/** SGR attributes through the same chalk instance — markdown bold/italic. */
export function paintAttr(text: string, attr: "bold" | "italic" | "dim", mode: ColorMode = colorMode()): string {
  return mode === "none" ? text : CHALK[mode][attr](text);
}
