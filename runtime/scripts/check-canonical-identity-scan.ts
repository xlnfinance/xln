#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import {
  getJReplicaByJurisdictionRef,
  getJurisdictionIdentityRef,
  sameJurisdictionIdentity,
} from '../jurisdiction/jurisdiction-runtime';
import type { Env, JReplica } from '../types';

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) throw new Error(`${path} contains forbidden text: ${needle}`);
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const makeJurisdiction = (name: string, chainId: number, depositoryByte: string) => ({
  name,
  chainId,
  depositoryAddress: address(depositoryByte),
  entityProviderAddress: address('ee'),
});

const canonical = makeJurisdiction('Testnet', 31337, '11');
const relabeled = { ...canonical, name: 'Renamed Local Chain' };
const conflicting = makeJurisdiction('Testnet', 31338, '22');
const canonicalRef = getJurisdictionIdentityRef(canonical);

requireCondition(canonicalRef === `stack:31337:${address('11')}`, `unexpected canonical ref: ${canonicalRef}`);
requireCondition(sameJurisdictionIdentity(canonical, relabeled), 'same stack identity must survive display relabeling');
requireCondition(!sameJurisdictionIdentity(canonical, conflicting), 'different stack identity must not match');
requireCondition(!sameJurisdictionIdentity({ name: 'Testnet' }, { name: 'testnet' }), 'name-only jurisdiction objects must not match');

const env = {
  jReplicas: new Map<string, JReplica>([
    ['collision', {
      name: canonicalRef,
      chainId: 31338,
      depositoryAddress: address('22'),
    } as JReplica],
    ['canonical', {
      name: 'Canonical',
      chainId: 31337,
      depositoryAddress: address('11'),
    } as JReplica],
  ]),
} as Env;

requireCondition(getJReplicaByJurisdictionRef(env, canonicalRef)?.name === 'Canonical', 'stack ref lookup picked wrong replica');
requireCondition(getJReplicaByJurisdictionRef(env, 'Canonical') === undefined, 'stack ref lookup accepted display name');

for (const [path, markers] of [
  ['runtime/jurisdiction/jurisdiction-runtime.ts', [
    'export const sameJurisdictionIdentity = (left: unknown, right: unknown): boolean => {',
    'return Boolean(leftRef && rightRef && leftRef === rightRef);',
    'if (!isJurisdictionStackRef(raw)) return undefined;',
    'const replica = isJurisdictionStackRef(configuredName)',
    '? getJReplicaByJurisdictionRef(env, configuredName)',
    ': getJReplicaByName(env, configuredName);',
  ]],
  ['runtime/j-height.ts', [
    'const getJReplicaByJurisdictionNameOrRef =',
    'return isJurisdictionStackRef(raw)',
    '? getJReplicaByJurisdictionRef(env, raw)',
    ': getJReplicaByName(env, raw);',
  ]],
  ['runtime/orchestrator/hub-node.ts', [
    'const sameJurisdictionRef = (left: unknown, right: unknown): boolean => {',
    'return Boolean(leftRef && rightRef && leftRef === rightRef);',
    'DEBUG_RESERVE_JURISDICTION_REF_INVALID',
    'resolveJReplicaForJurisdictionIdentity(env, jurisdiction.jurisdictionRef)',
    'if (!sameJurisdictionRef(peerJurisdiction, jurisdiction)) return null;',
  ]],
  ['runtime/orchestrator/mm-node.ts', [
    'const sameJurisdiction = (',
    'return Boolean(left.jurisdictionRef && right.jurisdictionRef && left.jurisdictionRef === right.jurisdictionRef);',
    'compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef)',
  ]],
  ['runtime/orchestrator/mesh-jurisdictions.ts', [
    'const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));',
    'entries.find(isPrimaryJurisdiction)',
  ]],
  ['runtime/server/jurisdictions.ts', [
    'const displayName = normalizeJurisdictionDisplayName(previous[\'name\']) || targetKey;',
    'name: displayName',
    'selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpc])',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

for (const [path, forbidden] of [
  ['runtime/jurisdiction/jurisdiction-runtime.ts', [
    'if (!isJurisdictionStackRef(raw)) return getJReplicaByName(env, raw);',
    'sameJurisdictionIdentityOrNameOnlyFallback',
  ]],
  ['runtime/orchestrator/hub-node.ts', [
    'sameJurisdictionIdentityOrNameOnlyFallback',
    'sameJurisdictionRefOrNameFallback',
    "normalized === 'arrakis'",
    "normalized === 'wakanda'",
  ]],
  ['runtime/orchestrator/mm-node.ts', [
    'sameJurisdictionIdentityOrNameOnlyFallback',
    'sameJurisdictionRefOrNameFallback',
  ]],
  ['runtime/orchestrator/mesh-jurisdictions.ts', [
    "map['arrakis']",
  ]],
  ['runtime/server/jurisdictions.ts', [
    "jurisdictions['arrakis']",
    'arrakisDisplayName',
    'existingArrakis',
    "name: 'Testnet'",
  ]],
] as const) {
  const text = readText(path);
  for (const marker of forbidden) assertNotIncludes(text, marker, path);
}

for (const [path, markers] of [
  ['runtime/__tests__/multi-jurisdiction-entity.test.ts', [
    'jurisdiction identity uses stack refs before display names',
    "expect(getJReplicaByJurisdictionRef(env, 'Canonical')).toBeUndefined();",
  ]],
  ['runtime/__tests__/prod-startup-wiring.test.ts', [
    "expect(hubNode).not.toContain(\"normalized === 'arrakis'\");",
    "expect(mmNode).not.toContain('sameJurisdictionIdentityOrNameOnlyFallback');",
    "expect(reserveBootstrap).not.toContain('sameJurisdictionRefOrNameFallback');",
  ]],
  ['runtime/__tests__/server-jurisdictions.test.ts', [
    'preserves its configured display name',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const auditDocPath = 'docs/security/canonical-identity-scan.md';
const auditDoc = readText(auditDocPath);
for (const marker of [
  '# Canonical Identity Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:canonical-identity',
  'Jurisdiction refs are `stack:<chainId>:<depository>`',
  'Display names are cosmetic',
  'Non-stack strings no longer resolve through `getJReplicaByJurisdictionRef()`',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('canonical identity scan check passed');
