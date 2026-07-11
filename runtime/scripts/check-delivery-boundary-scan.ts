#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  classifyUndeliveredDelivery,
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  isDeliveryDelivered,
  isDeliveryResult,
  shouldRetryDelivery,
} from '../delivery-result';
import {
  classifyRelayDeliveryEvent,
  isRelaySendResultFailure,
} from '../relay-store';

const repoRoot = process.cwd();

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) throw new Error(`${path} contains forbidden text: ${needle}`);
};

const assertNotMatches = (text: string, pattern: RegExp, path: string, label: string): void => {
  if (pattern.test(text)) throw new Error(`${path} contains forbidden pattern: ${label}`);
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const assertDelivery = (
  delivery: unknown,
  expected: {
    outcome: string;
    code: string;
    retryable: boolean;
    fatal: boolean;
    terminal: boolean;
  },
): void => {
  requireCondition(isDeliveryResult(delivery), `invalid delivery result: ${JSON.stringify(delivery)}`);
  requireCondition(delivery.outcome === expected.outcome, `outcome mismatch: ${delivery.outcome} !== ${expected.outcome}`);
  requireCondition(delivery.code === expected.code, `code mismatch: ${delivery.code} !== ${expected.code}`);
  requireCondition(delivery.retryable === expected.retryable, `retryable mismatch for ${delivery.code}`);
  requireCondition(delivery.fatal === expected.fatal, `fatal mismatch for ${delivery.code}`);
  requireCondition(delivery.terminal === expected.terminal, `terminal mismatch for ${delivery.code}`);
};

const delivered = deliveryAccepted('DELIVERY_ACCEPTED');
assertDelivery(delivered, {
  outcome: 'delivered',
  code: 'DELIVERY_ACCEPTED',
  retryable: false,
  fatal: false,
  terminal: true,
});
requireCondition(isDeliveryDelivered(delivered), 'accepted delivery must be delivered');
requireCondition(shouldRetryDelivery(delivered) === false, 'accepted delivery must not retry');

const deferred = deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' });
assertDelivery(deferred, {
  outcome: 'deferred',
  code: 'ROUTE_DIRECT_MISS_FALLBACK',
  retryable: true,
  fatal: false,
  terminal: false,
});
requireCondition(shouldRetryDelivery(deferred) === true, 'deferred delivery must retry');

const terminalFailure = deliveryFailure({
  category: 'Contradiction',
  code: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
});
assertDelivery(terminalFailure, {
  outcome: 'failed',
  code: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
  retryable: false,
  fatal: true,
  terminal: true,
});

requireCondition(classifyUndeliveredDelivery(deferred, {
  retry: 'DELIVERY_RETRY',
  terminal: 'DELIVERY_DROP',
}).retry === true, 'deferred disposition must retry');
requireCondition(classifyUndeliveredDelivery(terminalFailure, {
  retry: 'DELIVERY_RETRY',
  terminal: 'DELIVERY_DROP',
}).retry === false, 'terminal disposition must drop');

requireCondition(isRelaySendResultFailure(false), 'relay send false must fail');
requireCondition(isRelaySendResultFailure(-1), 'relay negative send must fail');
requireCondition(!isRelaySendResultFailure(true), 'relay send true must pass');
requireCondition(!isRelaySendResultFailure(0), 'relay send 0 must pass');
requireCondition(!isRelaySendResultFailure(undefined), 'relay send void must pass');

assertDelivery(classifyRelayDeliveryEvent({ status: 'queued' }), {
  outcome: 'queued',
  code: 'DELIVERY_QUEUED',
  retryable: true,
  fatal: false,
  terminal: false,
});
assertDelivery(classifyRelayDeliveryEvent({
  status: 'rejected',
  reason: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
}), {
  outcome: 'failed',
  code: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
  retryable: true,
  fatal: false,
  terminal: false,
});
assertDelivery(classifyRelayDeliveryEvent({
  status: 'local-delivery-failed',
  reason: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
}), {
  outcome: 'failed',
  code: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
  retryable: false,
  fatal: true,
  terminal: true,
});

const collectRuntimeSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const relPath = relative(repoRoot, fullPath);
    if (
      relPath.includes('/__tests__/') ||
      relPath.includes('/scenarios/') ||
      relPath.includes('/scripts/')
    ) {
      return [];
    }
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return collectRuntimeSourceFiles(fullPath);
    return fullPath.endsWith('.ts') ? [fullPath] : [];
  });

const runtimeSources = collectRuntimeSourceFiles(join(repoRoot, 'runtime'));

const rawEntityInputSendAllowedFiles = new Set([
  'runtime/networking/p2p.ts',
  'runtime/networking/ws-client.ts',
]);
const deliveryDecisionAllowedFiles = new Set([
  'runtime/delivery-result.ts',
]);

for (const file of runtimeSources) {
  const relPath = relative(repoRoot, file);
  const source = readText(file);
  if (!rawEntityInputSendAllowedFiles.has(relPath)) {
    assertNotMatches(source, /\bsendEntityInputRaw\s*\(|['"]sendEntityInputRaw['"]/, relPath, 'raw entity input websocket send');
  }
  if (!deliveryDecisionAllowedFiles.has(relPath)) {
    assertNotMatches(
      source,
      /\bdelivery\.(?:retryable|fatal|terminal)\b|\bdelivery\[['"](?:retryable|fatal|terminal)['"]\]/,
      relPath,
      'raw delivery retry/fatal/terminal decision',
    );
    assertNotMatches(
      source,
      /\.outcome\s*(?:===|!==|==|!=)\s*['"](?:delivered|queued|deferred|failed)['"]|['"](?:delivered|queued|deferred|failed)['"]\s*(?:===|!==|==|!=)[^\n]*\.outcome/,
      relPath,
      'raw delivery outcome decision',
    );
  }
}

for (const [path, markers] of [
  ['runtime/delivery-result.ts', [
    "export type DeliveryOutcome = 'delivered' | 'queued' | 'deferred' | 'failed';",
    'export type DeliveryResult = {',
    'export const requireDeliveryResult',
    'export const isDeliveryDelivered',
    'export const shouldRetryDelivery',
    'export const requireDeliveryDelivered',
    'export const classifyUndeliveredDelivery',
    'export const deliveryFailure',
  ]],
  ['runtime/runtime-output-routing.ts', [
    'enqueueEntityInputDelivery(targetRuntimeId: string, input: DeliverableEntityInput, ingressTimestamp?: number): DeliveryResult;',
    'export type RuntimeEntityInputRoutingResult = {',
    'delivery: DeliveryResult;',
    'export const buildPendingNetworkOutputs',
    'export const rescheduleDeferredOutputs',
    'NETWORK_OUTBOX_CAPACITY_EXCEEDED',
    'requireDeliveryResult(',
    'requireDeliveryDelivered(',
    'isDeliveryDelivered(directDelivery)',
    'shouldRetryDelivery(p2pDelivery)',
  ]],
  ['runtime/networking/p2p.ts', [
    'enqueueEntityInputDelivery(targetRuntimeId: string, input: RoutedEntityInput, ingressTimestamp?: number): EntityInputDeliveryResult',
    'sendEntityInputRaw',
    "delivery.code === 'P2P_NO_PUBKEY'",
    'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
    'Durable retry ownership belongs to the runtime outbox',
  ]],
  ['runtime/networking/ws-client.ts', [
    'sendEntityInputRaw(to: string, input: RoutedEntityInput, ingressTimestamp?: number): boolean',
  ]],
  ['runtime/networking/direct-runtime-bun.ts', [
    'sendEntityInputDelivery(targetRuntimeId: string, input: RoutedEntityInput, ingressTimestamp?: number): DeliveryResult',
    'ROUTE_DIRECT_MISS_FALLBACK',
    'ROUTE_DIRECT_SEND_FAILED',
  ]],
  ['runtime/relay-store.ts', [
    'export const isRelaySendResultFailure',
    'export const classifyRelayDeliveryEvent',
    'deliveryFailure({',
    'deliverPendingMessages',
  ]],
  ['runtime/relay-router.ts', [
    'const sendRelayDelivery = (',
    'isRelaySendResultFailure(result)',
    'delivery: relayDelivery',
    'local-delivery-failed',
  ]],
  ['runtime/orchestrator/hub-node.ts', [
    'directRuntimeWs.sendEntityInputDelivery(targetRuntimeId, input, ingressTimestamp)',
  ]],
  ['runtime/orchestrator/mm-node.ts', [
    'directRuntimeWs.sendEntityInputDelivery(targetRuntimeId, input, ingressTimestamp)',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const p2pSource = readText('runtime/networking/p2p.ts');
assertNotIncludes(p2pSource, 'pendingByRuntime', 'runtime/networking/p2p.ts');
assertNotIncludes(p2pSource, 'flushPending', 'runtime/networking/p2p.ts');

const runtimeTs = readText('runtime/runtime.ts');
assertIncludes(runtimeTs, '): RuntimeEntityInputRoutingResult => {', 'runtime/runtime.ts');
assertIncludes(runtimeTs, 'return sendEntityInputWithRouting(env, input, getRuntimeOutputRoutingDeps());', 'runtime/runtime.ts');
const sendEntityInputStart = runtimeTs.indexOf('export const sendEntityInput =');
const sendEntityInputEnd = runtimeTs.indexOf('export const startP2P', sendEntityInputStart);
const sendEntityInputSource = runtimeTs.slice(sendEntityInputStart, sendEntityInputEnd);
assertNotIncludes(sendEntityInputSource, 'return true', 'runtime/runtime.ts');
assertNotIncludes(sendEntityInputSource, 'return false', 'runtime/runtime.ts');

const relayDirectTs = readText('runtime/server/relay-direct.ts');
assertNotIncludes(relayDirectTs, '[RELAY] Direct dispatch', 'runtime/server/relay-direct.ts');
assertNotIncludes(relayDirectTs, 'console.', 'runtime/server/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.target_key_missing', 'runtime/server/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.source_key_missing', 'runtime/server/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.send_failed', 'runtime/server/relay-direct.ts');

for (const [path, markers] of [
  ['runtime/__tests__/delivery-result.test.ts', [
    'delivery result helpers validate the shared delivery contract',
    'undelivered disposition centralizes retry/drop event decisions',
  ]],
  ['runtime/__tests__/delivery-boundary.test.ts', [
    'raw entity input websocket send stays behind the P2P delivery adapter',
    'delivery retry and terminal decisions stay behind shared helpers',
    'delivery outcome decisions stay behind shared helpers',
  ]],
  ['runtime/__tests__/runtime-output-routing.test.ts', [
    'ROUTE_P2P_INVALID_DELIVERY_RESULT',
    'ROUTE_SEND_NOT_DELIVERED',
  ]],
  ['runtime/__tests__/p2p-prefetch.test.ts', [
    'enqueueEntityInputDelivery reports typed delivery result',
    'enqueueEntityInputDelivery returns typed success with transport',
  ]],
  ['runtime/__tests__/relay-store.test.ts', [
    'relay send result predicate matches websocket failure contract',
    'relay delivery events expose typed retry and fatal semantics',
    'relay pending delivery retains current and later messages when send fails',
  ]],
  ['runtime/__tests__/relay-direct.test.ts', [
    'direct relay diagnostics stay machine-readable',
    'relay.direct.target_key_missing',
    'relay.direct.source_key_missing',
    'relay.direct.send_failed',
  ]],
  ['runtime/__tests__/relay-router.test.ts', [
    'delivery:',
    'send-failed',
  ]],
  ['runtime/__tests__/direct-runtime-bun.test.ts', [
    'sendEntityInputDelivery',
    'ROUTE_DIRECT_DELIVERED',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const auditDocPath = 'docs/security/delivery-boundary-scan.md';
const auditDoc = readText(auditDocPath);
for (const marker of [
  '# Runtime Delivery Boundary Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:delivery-boundary',
  'Relay is the official baseline',
  'Direct delivery is an opportunistic fast path',
  'Raw `sendEntityInputRaw()` is limited to the P2P adapter',
  'Retry/drop/fatal decisions live behind shared delivery helpers',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('runtime delivery boundary scan check passed');
