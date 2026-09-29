/**
 * Static + runtime scoring for language-guide custdev cells.
 * Classifiers are intentional regex floors — good enough to steer the guide.
 */
import { createHash } from "node:crypto";

export type Invite =
  | "dict"
  | "keyword-access"
  | "thread"
  | "get-in"
  | "assoc-in"
  | "filter"
  | "map"
  | "reduce"
  | "str"
  | "join"
  | "group-by"
  | "frequencies"
  | "cond";

export type CellScore = {
  preferred: string[];
  tolerated: string[];
  oddities: string[];
  underuse: boolean;
  invite_hit: boolean;
};

const ODDITY_PATTERNS: Array<[string, RegExp]> = [
  ["set!", /\bset!\b/],
  ["set-car!", /\bset-car!\b/],
  ["set-cdr!", /\bset-cdr!\b/],
  ["vector-set!", /\bvector-set!\b/],
  ["string-set!", /\bstring-set!\b/],
  ["call/cc", /\bcall\/cc\b|\bcall-with-current-continuation\b/],
  ["dynamic-wind", /\bdynamic-wind\b/],
  ["values", /\bvalues\b|\bcall-with-values\b|\blet-values\b|\bdefine-values\b/],
  ["println", /\bprintln\b/],
  ["print", /(?<![a-z-])print(?![a-z-])/],
  ["display", /\bdisplay\b/],
  ["write", /(?<![a-z-])write(?![a-z-])/],
  ["newline", /\bnewline\b/],
  ["load", /(?<![a-z-\/])load(?![a-z-])/],
  ["eval", /(?<![a-z-])eval(?![a-z-])/],
  ["open-input-file", /\bopen-input-file\b|\bwith-output-to-file\b|\bread-line\b/],
  ["hash-ref", /\bmake-hash\b|\bhash-ref\b|\bhash-set!\b|\bgethash\b/],
  ["defun", /\bdefun\b|\bsetf\b/],
  // named-let `loop` is valid Scheme — do not flag. CL `loop` macro is rare in agent output.
  ["nreverse", /\bnreverse\b/],
  ["for/list", /\bfor\/list\b|\bfor\/fold\b/],
  ["delay", /\bdelay\b|\bforce\b|\bparameterize\b|\bcase-lambda\b/],
  ["define-library", /\bdefine-library\b|\bimport\b|\binclude\b/],
  ["list-commas", /\(\s*list\b[^)]*,/],
  ["curly-infix", /\{[^{}]*\s[+\-*/]\s[^{}]*\}/],
  ["sugarcoat-method", /\.\w+\s*\{|\.\w+\s*\(/],
  ["sugarcoat-sub", /\w\[\d+\]|\w\[:\w+\]/],
];

const TOLERATED_PATTERNS: Array<[string, RegExp]> = [
  ["mapcar", /\bmapcar\b/],
  ["remove-if", /\bremove-if\b|\bremove-if-not\b/],
  ["nth", /(?<![a-z-])nth(?![a-z-])/],
  ["rest", /(?<![a-z-])rest(?![a-z-])/],
  ["empty?", /\bempty\?/],
  ["comp", /(?<![a-z-])comp(?![a-z-])/],
  ["flow", /(?<![a-z-])flow(?![a-z-])/],
  ["~>", /~>>?|~>/],
  ["assoc-ref", /\bassoc-ref\b/],
  ["true-false", /(?<![a-z:#-])true(?![a-z-])|(?<![a-z:#-])false(?![a-z-])/],
  ["suffix-key", /\{[^}]*\b[a-zA-Z_][\w-]*:\s/],
  ["hash-colon", /#:[a-zA-Z_]/],
];

const PREFERRED_PATTERNS: Array<[string, RegExp]> = [
  ["dict", /\(dict\b|\{:/],
  ["keyword-access", /\(:[a-zA-Z*][\w*!?\-+.$%&=<>:/]*\b|\(@\s/],
  ["thread", /\(->>\b|\(->\b/],
  ["get-in", /\bget-in\b/],
  ["assoc-in", /\bassoc-in\b|\bupdate-in\b/],
  ["filter", /\bfilter\b/],
  ["map", /(?<![a-z-])map(?![a-z-])/],
  ["reduce", /\breduce\b/],
  ["str", /(?<![a-z-])str(?![a-z-])/],
  ["join", /(?<![a-z-])join(?![a-z-])/],
  ["group-by", /\bgroup-by\b/],
  ["frequencies", /\bfrequencies\b/],
  ["cond", /\bcond\b/],
];

/** Strip ;-to-EOL comments so prose like "return values" does not trip oddity scans. */
function stripComments(src: string): string {
  return src.replace(/;.*$/gm, "");
}

function hits(src: string, patterns: Array<[string, RegExp]>): string[] {
  const out: string[] = [];
  const body = stripComments(src);
  for (const [name, re] of patterns) {
    if (re.test(body)) out.push(name);
  }
  return out;
}

export function scoreProgram(program: string, invite: Invite[], inviteAny: boolean, passedOracle: boolean): CellScore {
  const preferred = hits(program, PREFERRED_PATTERNS);
  const tolerated = hits(program, TOLERATED_PATTERNS);
  const oddities = hits(program, ODDITY_PATTERNS);

  const inviteHits = invite.filter((i) => preferred.includes(i));
  const invite_hit = inviteAny ? inviteHits.length > 0 : invite.every((i) => preferred.includes(i));
  // Underuse only meaningful when the program basically worked.
  const underuse = passedOracle && invite.length > 0 && !invite_hit;

  return { preferred, tolerated, oddities, underuse, invite_hit };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  // nil / null / undefined collapse for agent oracles
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a !== typeof b) {
    // number vs string coercion never — fail
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // strip leading : on keys for keyword-vs-string drift
    const norm = (o: Record<string, unknown>) => {
      const m: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        m[k.startsWith(":") ? k.slice(1) : k] = v;
      }
      return m;
    };
    const an = norm(ao);
    const bn = norm(bo);
    const keys = new Set([...Object.keys(an), ...Object.keys(bn)]);
    for (const k of keys) {
      if (!deepEqual(an[k], bn[k])) return false;
    }
    return true;
  }
  return false;
}

export function extractSchemeFence(text: string): string | null {
  const m = text.match(/```(?:scheme|scm|lisp|racket)?\s*\n([\s\S]*?)```/i);
  if (m) return m[1]!.trim();
  // bare program fallback: first paren form through end
  const i = text.indexOf("(");
  if (i >= 0) return text.slice(i).trim();
  return null;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export function summarize(
  cells: Array<{
    model: string;
    task: string;
    exec_ok: boolean;
    oracle_ok: boolean;
    underuse: boolean;
    invite_hit: boolean;
    oddities: string[];
  }>,
) {
  const n = cells.length || 1;
  const exec_pass = cells.filter((c) => c.exec_ok).length / n;
  const oracle_pass = cells.filter((c) => c.oracle_ok).length / n;
  const oddity_rate = cells.filter((c) => c.oddities.length > 0).length / n;
  const invite_hit =
    cells.filter((c) => c.oracle_ok).length === 0
      ? 0
      : cells.filter((c) => c.oracle_ok && c.invite_hit).length / cells.filter((c) => c.oracle_ok).length;

  // Cross-model families: same task + same oddity name on ≥2 models
  const oddMap = new Map<string, Set<string>>();
  const underMap = new Map<string, Set<string>>();
  for (const c of cells) {
    for (const o of c.oddities) {
      const k = `${c.task}::${o}`;
      if (!oddMap.has(k)) oddMap.set(k, new Set());
      oddMap.get(k)!.add(c.model);
    }
    if (c.underuse) {
      const k = c.task;
      if (!underMap.has(k)) underMap.set(k, new Set());
      underMap.get(k)!.add(c.model);
    }
  }
  const cross_model_oddity_families = [...oddMap.entries()]
    .filter(([, ms]) => ms.size >= 2)
    .map(([k, ms]) => ({ key: k, models: [...ms] }));
  const cross_model_underuse_families = [...underMap.entries()]
    .filter(([, ms]) => ms.size >= 2)
    .map(([k, ms]) => ({ task: k, models: [...ms] }));

  return {
    exec_pass,
    oracle_pass,
    oddity_rate,
    invite_hit,
    cross_model_oddity_families,
    cross_model_underuse_families,
  };
}

export function acceptanceGate(
  summary: ReturnType<typeof summarize>,
  guidelinesLines: number,
  guidelinesBytes: number,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (guidelinesLines > 90) failures.push(`lines ${guidelinesLines} > 90`);
  if (guidelinesBytes > 3500) failures.push(`bytes ${guidelinesBytes} > 3500`);
  if (summary.exec_pass < 0.8) failures.push(`exec_pass ${summary.exec_pass.toFixed(2)} < 0.80`);
  if (summary.oracle_pass < 0.7) failures.push(`oracle_pass ${summary.oracle_pass.toFixed(2)} < 0.70`);
  if (summary.oddity_rate > 0.1) failures.push(`oddity_rate ${summary.oddity_rate.toFixed(2)} > 0.10`);
  if (summary.invite_hit < 0.6) failures.push(`invite_hit ${summary.invite_hit.toFixed(2)} < 0.60`);
  if (summary.cross_model_oddity_families.length > 0) {
    failures.push(`cross-model oddity families: ${summary.cross_model_oddity_families.map((f) => f.key).join(", ")}`);
  }
  return { ok: failures.length === 0, failures };
}
