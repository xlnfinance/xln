#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

const readText = (path: string): string =>
  readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) {
    throw new Error(`${path} is missing required text: ${needle}`);
  }
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) {
    throw new Error(`${path} contains stale forbidden text: ${needle}`);
  }
};

const packageJson = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> };
const scripts = packageJson.scripts ?? {};
for (const name of ['gate:ci', 'gate:release', 'test:e2e:coverage', 'test:rpc-settlement', 'soak:quick', 'soak:release', 'prod:health']) {
  if (!scripts[name]) throw new Error(`package.json missing script: ${name}`);
}

const auditBriefPath = 'docs/security/external-audit-brief.md';
const auditBrief = readText(auditBriefPath);
for (const heading of [
  '# XLN External Security Audit Brief',
  '## Scope',
  '## Main Invariants',
  '## Required Commands',
  '## High-Risk Files',
  '## Known Non-Goals',
  '## Auditor Deliverables',
]) {
  assertIncludes(auditBrief, heading, auditBriefPath);
}
for (const command of [
  'bun run gate:ci',
  'bun run test:e2e:coverage',
  'bun run gate:release',
  'bun run test:rpc-settlement',
  'bun run soak:release',
  'bun run prod:health',
]) {
  assertIncludes(auditBrief, command, auditBriefPath);
}
for (const marker of [
  'Hub lending pools',
  'User-facing Lending coverage',
  'Multihop is a manual route recommendation only',
]) {
  assertIncludes(auditBrief, marker, auditBriefPath);
}

const mainnetPath = 'docs/mainnet.md';
const mainnet = readText(mainnetPath);
for (const marker of [
  'bun run test:e2e:coverage',
  'bun run test:rpc-settlement',
  'bun run soak:release',
  'docs/security/external-audit-brief.md',
  'bun run prod:health',
  'direct same-chain and direct cross-j swaps are the executable swap surface',
]) {
  assertIncludes(mainnet, marker, mainnetPath);
}

const gptContextPath = 'scripts/debug/gpt.cjs';
const gptContext = readText(gptContextPath);
for (const marker of [
  'src/lib/components/Entity/LendingPanel.svelte',
  'runtime/__tests__/lending.test.ts',
  'tests/e2e-lending.spec.ts',
  'Multihop execution is intentionally deferred',
]) {
  assertIncludes(gptContext, marker, gptContextPath);
}
for (const stale of [
  'routed-swap-execution.ts',
  'RoutedRouteControls.svelte',
  'tests/unit/routed-swap-planner.test.ts',
]) {
  assertNotIncludes(gptContext, stale, gptContextPath);
}

const flowCoveragePath = 'docs/testnet-flow-coverage.md';
const flowCoverage = readText(flowCoveragePath);
for (const marker of [
  '## Pay',
  '## Same-Account Swap',
  '## Cross-J Swap',
  'bun run test:e2e:coverage',
  'bun run test:e2e:core',
]) {
  assertIncludes(flowCoverage, marker, flowCoveragePath);
}

console.log('✅ security audit pack check passed');
