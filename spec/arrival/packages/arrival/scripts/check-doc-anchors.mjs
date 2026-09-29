#!/usr/bin/env node
/**
 * Doc-anchor guard for arrival's `docs/` tree.
 *
 * The docs use a small set of stable ID ledgers (`P#` PRINCIPLES, `R#` RULINGS,
 * `F#` test-suite-architecture) that code comments and sibling docs cite by ID.
 * Filenames also carry a register signal: SHOUT-cased docs mint an ID series or
 * are a declared canon; kebab-cased docs only cite. This script keeps those
 * invariants honest so a rename or a renumber cannot silently break a citation.
 *
 * Peer of the repo's `check:pinned-versions` guard — self-contained (node
 * built-ins only), grep/glob-level, no browser, runnable from the package.
 *
 * Gates (exit 1 on failure):
 *   1. Dangling-ID    — every P#/R#/F# cite in src TS comments + docs .md files
 *                       resolves to a minting heading in its ledger.
 *   2. Dead links     — every intra-package .md link/mention in doc prose
 *                       resolves to an existing file.
 *   3. ID uniqueness  — no two headings in a ledger mint the same number.
 *   4. Register lint  — SHOUT docs mint an ID series or are an allowlisted
 *                       canon; kebab docs mint no `## X# —` ledger heading.
 *
 * Doc-structure rationale: scratchpad docs-structure-research §3 (CI-able
 * anti-rot checks) + docs/README.md (register legend).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const DOCS = join(PKG_ROOT, "docs");
const SRC = join(PKG_ROOT, "src");

// ── Ledgers: file + the regex that MINTS an ID heading in it ──────────────
// PRINCIPLES mints `**P0.`; RULINGS mints `## R1 —`; test-suite mints `**F1 —`.
const LEDGERS = {
  P: { file: join(DOCS, "PRINCIPLES.md"), mint: /(?:^|\n)\*\*P(\d+)\./g, label: "PRINCIPLES.md" },
  R: { file: join(DOCS, "RULINGS.md"), mint: /(?:^|\n)## R(\d+) —/g, label: "RULINGS.md" },
  F: {
    file: join(DOCS, "test-suite-architecture.md"),
    mint: /(?:^|\n)\*\*F(\d+) —/g,
    label: "test-suite-architecture.md",
  },
};

// SHOUT docs allowed to exist without minting an ID series (declared canon/ledger/hub).
const REGISTER_ALLOWLIST = new Set(["PRINCIPLES", "RULINGS", "PROVENANCE", "GLOSSARY", "README"]);

const errors = [];

// ── fs walk ───────────────────────────────────────────────────────────────
function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const rel = (p) => p.slice(PKG_ROOT.length + 1);

// ── Parse ledgers: defined-ID set + uniqueness (check 3) ────────────────────
const defined = { P: new Set(), R: new Set(), F: new Set() };
for (const [letter, { file, mint, label }] of Object.entries(LEDGERS)) {
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  for (const m of text.matchAll(mint)) {
    const n = Number(m[1]);
    if (seen.has(n)) errors.push(`[uniqueness] ${label}: duplicate minting heading for ${letter}${n}`);
    seen.add(n);
    defined[letter].add(n);
  }
  if (defined[letter].size === 0)
    errors.push(`[uniqueness] ${label}: no ${letter}# minting headings found — parser or file drift`);
}

// ── Citation detection (check 1) ────────────────────────────────────────────
// Conservative: a bare P#/R#/F# token counts as a CITE only when its line carries
// a ledger signal, or the token is markdown-bold, or it sits in a slash-run
// (P10/P11, R1/R8). This skips local `Rn` numbers, R7RS/SRFI, version strings.
const SIGNAL = /RULINGS|PRINCIPLES|PROVENANCE|test-suite-architecture|\bprinciple\b|\bruling\b|\blaw\b/i;

function citationsIn(text) {
  const found = []; // { letter, num }
  for (const line of text.split("\n")) {
    const push = (letter, num) => found.push({ letter, num: Number(num) });
    // bold cites: **R2**, **P4**, **F3**
    for (const m of line.matchAll(/\*\*([PRF])(\d+)\*\*/g)) push(m[1], m[2]);
    // slash-runs: P10/P11, R1/R8 (each token is a cite)
    for (const m of line.matchAll(/\b[PRF]\d+(?:\/[PRF]\d+)+\b/g))
      for (const tok of m[0].match(/[PRF]\d+/g)) push(tok[0], tok.slice(1));
    // signal-line bare tokens
    if (SIGNAL.test(line)) for (const m of line.matchAll(/\b([PRF])(\d+)\b/g)) push(m[1], m[2]);
  }
  return found;
}

// TS comment extractor — scan only comments, never code identifiers.
function commentsOf(tsText) {
  let out = "";
  for (const m of tsText.matchAll(/\/\*[\s\S]*?\*\//g)) out += m[0] + "\n";
  for (const m of tsText.matchAll(/\/\/[^\n]*/g)) out += m[0] + "\n";
  return out;
}

function checkCites(sourceLabel, cites) {
  for (const { letter, num } of cites) {
    if (!defined[letter].has(num)) {
      errors.push(`[dangling-id] ${sourceLabel}: cite ${letter}${num} resolves to no ${LEDGERS[letter].label} heading`);
    }
  }
}

// docs/*.md (top-level only, per check-1 scope)
for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
  checkCites(`docs/${f}`, citationsIn(readFileSync(join(DOCS, f), "utf8")));
}
// src/**/*.ts comments
if (existsSync(SRC)) {
  for (const f of walk(SRC, ".ts")) {
    checkCites(rel(f), citationsIn(commentsOf(readFileSync(f, "utf8"))));
  }
}

// ── Dead-link detection (check 2) — doc prose only, intra-package ──────────
// Metavariable placeholders in the README register legend — not real files.
const REF_IGNORE = new Set(["SHOUT.md", "kebab-case.md"]);
// Every .md basename anywhere under docs/ — a bare mention resolves if such a doc exists.
const docBasenames = new Set(walk(DOCS, ".md").map((p) => basename(p)));

// Collect .md references: markdown-link targets and bare/prefixed path mentions.
// The lookbehind stops a cross-package suffix (`sift/docs/x.md`) from matching its
// `docs/x.md` tail — only a full, package-rooted path or a bare name is captured.
function mdRefsIn(text) {
  const refs = new Set();
  for (const m of text.matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) refs.add(m[1]);
  for (const m of text.matchAll(/(?<![\w/.-])((?:\.\.?\/|docs\/|reference\/)?[\w-]+\.md)\b/g)) refs.add(m[1]);
  return refs;
}

function inScopeRef(p) {
  if (/^[a-z]+:\/\//i.test(p)) return false; // URL scheme
  const seg0 = p.split("/")[0];
  // cross-package: has a slash and its first segment is not a docs-internal dir or relative
  if (p.includes("/") && !["docs", "reference", ".", ".."].includes(seg0)) return false;
  return true;
}

function resolvesRef(fromDir, p) {
  // a bare mention resolves if a doc of that basename exists anywhere under docs/
  if (docBasenames.has(basename(p))) return true;
  const candidates = [resolve(fromDir, p), resolve(DOCS, p), resolve(PKG_ROOT, p), resolve(DOCS, basename(p))];
  for (const c of candidates) {
    if (!c.startsWith(PKG_ROOT)) continue; // escapes the package → out of scope (cross-package link)
    if (existsSync(c)) return true;
  }
  // if EVERY candidate escaped the package, treat as out-of-scope (not a dead-link failure)
  return candidates.every((c) => !c.startsWith(PKG_ROOT)) ? true : false;
}

const allDocs = walk(DOCS, ".md");
for (const f of allDocs) {
  const dir = dirname(f);
  const text = readFileSync(f, "utf8");
  for (const p of mdRefsIn(text)) {
    if (REF_IGNORE.has(p) || !inScopeRef(p)) continue;
    if (!resolvesRef(dir, p)) errors.push(`[dead-link] ${rel(f)}: reference "${p}" resolves to no existing file`);
  }
}

// ── Register lint (check 4) ─────────────────────────────────────────────────
const ID_MINTING_HEADING = /(?:^|\n)## [A-Z]\d+ —/; // a `## X# —` ledger heading
for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
  const stem = f.replace(/\.md$/, "");
  const isShout = /^[A-Z0-9]+$/.test(stem);
  const text = readFileSync(join(DOCS, f), "utf8");
  const mintsID =
    /(?:^|\n)## [PRF]\d+ —/.test(text) || /(?:^|\n)\*\*[PRF]\d+[.—]/.test(text) || /(?:^|\n)\*\*[PRF]\d+ —/.test(text);
  if (isShout) {
    if (!REGISTER_ALLOWLIST.has(stem) && !mintsID)
      errors.push(`[register] ${f}: SHOUT-cased but mints no ID series and is not an allowlisted canon`);
  } else {
    // kebab: must NOT mint a `## X# —` ledger heading (BG-series is `**BGn —` body text, allowed)
    if (ID_MINTING_HEADING.test(text))
      errors.push(`[register] ${f}: kebab-cased but contains a "## X# —" ID-minting heading`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (errors.length === 0) {
  console.log(`\n✓ doc-anchors: all ledger cites resolve, links are live, IDs unique, register clean.`);
  process.exit(0);
}

console.error(`\n✗ ${errors.length} doc-anchor error${errors.length === 1 ? "" : "s"}:\n`);
for (const e of errors) console.error(`  ${e}`);
console.error(`\nSee docs/README.md (register legend) and docs/RULINGS.md / PRINCIPLES.md for the ID ledgers.`);
process.exit(1);
