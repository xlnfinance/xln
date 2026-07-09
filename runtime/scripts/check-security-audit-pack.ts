#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
for (const name of [
  'security:contract-governance',
  'security:consensus-hanko',
  'gate:ci',
  'gate:release',
  'gate:mainnet-preflight',
  'gate:mainnet',
  'test:e2e:coverage',
  'test:rpc-settlement',
  'soak:quick',
  'soak:release',
  'prod:health',
]) {
  if (!scripts[name]) throw new Error(`package.json missing script: ${name}`);
}

const governanceScan = spawnSync('bun', ['runtime/scripts/check-contract-governance-scan.ts'], {
  stdio: 'inherit',
});
if (governanceScan.error) throw governanceScan.error;
if (governanceScan.status !== 0) {
  throw new Error(`contract governance scan failed with exit ${governanceScan.status ?? governanceScan.signal}`);
}

const consensusHankoScan = spawnSync('bun', ['runtime/scripts/check-consensus-hanko-scan.ts'], {
  stdio: 'inherit',
});
if (consensusHankoScan.error) throw consensusHankoScan.error;
if (consensusHankoScan.status !== 0) {
  throw new Error(`consensus hanko scan failed with exit ${consensusHankoScan.status ?? consensusHankoScan.signal}`);
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
  'bun run security:contract-governance',
  'bun run security:consensus-hanko',
  'bun run gate:ci',
  'bun run test:e2e:coverage',
  'bun run gate:release',
  'bun run gate:mainnet-preflight',
  'bun run gate:mainnet',
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
  'bun run gate:mainnet',
  'docs/security/external-audit-brief.md',
  'bun run prod:health',
  'direct same-chain and direct cross-j swaps are the executable swap surface',
]) {
  assertIncludes(mainnet, marker, mainnetPath);
}

const statusPath = 'docs/status.md';
const status = readText(statusPath);
for (const marker of [
  'bun run gate:mainnet',
  'one-hour mainnet-preflight soak',
]) {
  assertIncludes(status, marker, statusPath);
}

const todoPath = 'todo.md';
const todo = readText(todoPath);
for (const marker of [
  'bun run gate:mainnet',
  'External audit handoff',
]) {
  assertIncludes(todo, marker, todoPath);
}
for (const stale of [
  'bun runtime/scripts/run-mainnet-preflight-gate.ts --include-soak',
]) {
  assertNotIncludes(status, stale, statusPath);
  assertNotIncludes(todo, stale, todoPath);
  assertNotIncludes(mainnet, stale, mainnetPath);
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

const opsRunbookPath = 'docs/deployment/ops-runbook.md';
const opsRunbook = readText(opsRunbookPath);
for (const marker of [
  'bun run debug:disk',
  'Test runners clean old generated artifacts by default before new runs.',
  'XLN_KEEP_TEST_ARTIFACTS=1',
  'XLN_TEST_WORKSPACE_MAX_BYTES',
]) {
  assertIncludes(opsRunbook, marker, opsRunbookPath);
}

console.log('✅ security audit pack check passed');
