// Ad-hoc perf probe: does the granular-leaf expansion (66 → 208 members, recursive
// PathValue + conditional/mapped accessor types) regress lens check time?
// Measures COLD (first check, pays the memoized roster build) and WARM (repeat,
// roster cached) for both the T-gate and diagnostics on a closure-heavy program.
//
// Run: npx tsx src/__research__/leaf-scale-perf.ts
// Baseline: move src/prelude/builtins/{object-accessors,srfi1-list,ramda-collection,
//   srfi189-maybe-either,srfi128-comparators,srfi43-vector,conversions-ext,
//   string-symbol-ops,type-predicates,combinators}.d.ts out, re-run, diff.

import { getPreludeFiles } from "@inhuman.tools/arrival-internals-types-prelude";

import { createSchemeLanguageService } from "../language-service.js";

const leafCount = [...getPreludeFiles().keys()].filter((k) => k.startsWith("__leaf")).length;

// PURE-CLOSURE program (no dict/prop/path) — nested lambdas capturing outer
// bindings, only PRE-EXISTING basic ops. Isolates the member-COUNT effect (bigger
// merged interface) from the accessor-TYPE effect (recursive/conditional instantiation).
// Set ACCESSOR=1 to switch to the accessor-heavy variant.
const ACCESSOR = process.env.ACCESSOR === "1";

function pureClosure(n: number): string {
  const lines: string[] = [`(define base (list 1 2 3))`];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? "base" : `v${i - 1}`;
    if (i % 3 === 0) {
      lines.push(`(define (mk${i} a) (lambda (b) (lambda (c) (+ a b c (length ${prev})))))`);
    } else if (i % 3 === 1) {
      lines.push(`(define v${i} (map (lambda (x) (+ x (length ${prev}))) ${prev}))`);
    } else {
      lines.push(`(define v${i} (filter (lambda (x) (> x (car ${prev}))) ${prev}))`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function accessorHeavy(n: number): string {
  const lines: string[] = [
    `(define cfg (dict :host "h" :port 8080 :opts (dict :tls #t :retries 3)))`,
    `(define base (list 1 2 3))`,
  ];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? "base" : `v${i - 1}`;
    lines.push(
      i % 2 === 0
        ? `(define v${i} (map (lambda (x) (+ x (prop :port cfg))) ${prev}))`
        : `(define v${i} (filter (lambda (x) (> x (path (list :opts :retries) cfg))) ${prev}))`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// HUGE-JSON integration: a big nested dict (W top-level keys, some 3-deep) — the
// shape a "load this JSON config/dataset" program produces — then accessor reads
// (prop/path/get-in/pick) over it. Stresses Dict<Pairs> mapped-type instantiation
// AND PathValue recursion indexing a large object type per hop. Set HUGEJSON=<W>.
const HUGEJSON = process.env.HUGEJSON ? Number(process.env.HUGEJSON) : 0;

function hugeJson(width: number): string {
  // one big dict literal: `width` keys, every 5th nested two levels deep.
  const entries: string[] = [];
  for (let i = 0; i < width; i++) {
    entries.push(
      i % 5 === 0
        ? `:k${i} (dict :a${i} ${i} :b${i} (dict :c${i} "v${i}" :d${i} #t))`
        : i % 2 === 0
          ? `:k${i} ${i}`
          : `:k${i} "s${i}"`,
    );
  }
  const lines = [`(define data (dict ${entries.join(" ")}))`];
  // accessor reads scattered over the huge object — the per-site precise cost.
  for (let i = 0; i < width; i += 3) {
    if (i % 5 === 0) {
      lines.push(`(define r${i} (path (list :k${i} :b${i} :c${i}) data))`);
    } else {
      lines.push(`(define r${i} (prop :k${i} data))`);
    }
  }
  lines.push(`(define picked (pick (list :k0 :k3 :k6) data))`);
  return `${lines.join("\n")}\n`;
}

const closureHeavy = HUGEJSON > 0 ? hugeJson : ACCESSOR ? accessorHeavy : pureClosure;
const SIZES = HUGEJSON > 0 ? [50, 150, 400] : [10, 50, 150];
const POOL = ["car", "cdr", "filter", "map", "list", "cons", "length", "append", "base"];

function median(xs: number[]): number {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

for (const n of SIZES) {
  const prog = closureHeavy(n);
  const slot = `${prog}(map `;
  // FRESH service => COLD: first call pays the memoized roster (probe tuple over all members).
  const cold = createSchemeLanguageService();
  let t = performance.now();
  cold.getTypeValidCandidates(slot, slot.length, POOL);
  const coldT = performance.now() - t;
  t = performance.now();
  cold.getSemanticDiagnostics(prog);
  const coldD = performance.now() - t;

  // WARM: same service, repeat (roster cached, only program re-checked).
  const wT: number[] = [];
  const wD: number[] = [];
  for (let r = 0; r < 7; r++) {
    t = performance.now();
    cold.getTypeValidCandidates(slot, slot.length, POOL);
    wT.push(performance.now() - t);
    t = performance.now();
    cold.getSemanticDiagnostics(prog);
    wD.push(performance.now() - t);
  }
  console.log(
    `n=${String(n).padStart(3)} | leaves=${leafCount} | ` +
      `COLD Tgate=${coldT.toFixed(1)}ms diag=${coldD.toFixed(1)}ms | ` +
      `WARM Tgate=${median(wT).toFixed(1)}ms diag=${median(wD).toFixed(1)}ms`,
  );
}
