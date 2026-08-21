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
} from '../../../protocol/payments/delivery-result';
import {
  classifyRelayDeliveryEvent,
} from '../../../network/relay/store';
import { classifyWebSocketSendResult } from '../../../network/websocket-send-result';

const repoRoot = process.cwd();

const readRuntimeOutputRoutingBoundary = (): string => {
  const deliveryDir = join(repoRoot, 'core/runtime/delivery');
  const paths = [
    join(repoRoot, 'core/runtime/delivery/topology/output-routing.ts'),
    ...readdirSync(deliveryDir)
      .filter(file => file.endsWith('.ts'))
      .sort()
      .map(file => join(deliveryDir, file)),
  ];
  return paths.map(path => readFileSync(path, 'utf8')).join('\n');
};

const readText = (path: string): string => {
  if (path === 'core/runtime/delivery/topology/output-routing.ts') return readRuntimeOutputRoutingBoundary();
  if (path === 'core/orchestrator/mm-node.ts') {
    return [
      'mm-node.ts',
      'market-maker/node/mm-node-core.ts',
      'market-maker/node/mm-node-health.ts',
      'market-maker/node/mm-node-run.ts',
    ]
      .map(file => readFileSync(join(repoRoot, 'core/orchestrator', file), 'utf8'))
      .join('\n');
  }
  return readFileSync(path, 'utf8');
};

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

const deferred = deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' });
assertDelivery(deferred, {
  outcome: 'deferred',
  code: 'ROUTE_DIRECT_MISS_FAILOVER',
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

requireCondition(classifyWebSocketSendResult(false) === 'dropped', 'relay send false must drop');
requireCondition(classifyWebSocketSendResult(0) === 'dropped', 'relay send zero must drop');
requireCondition(classifyWebSocketSendResult(-1) === 'backpressured', 'relay send -1 must be accepted with backpressure');
requireCondition(classifyWebSocketSendResult(true) === 'accepted', 'relay send true must pass');
requireCondition(classifyWebSocketSendResult(1) === 'accepted', 'relay positive send must pass');
requireCondition(classifyWebSocketSendResult(undefined) === 'accepted', 'relay send void must pass');

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

const runtimeSources = collectRuntimeSourceFiles(join(repoRoot, 'core'));

const rawEntityInputSendAllowedFiles = new Set([
  'core/network/p2p/p2p.ts',
  'core/network/p2p/ws-client.ts',
]);
const deliveryDecisionAllowedFiles = new Set([
  'core/protocol/payments/delivery-result.ts',
]);

for (const file of runtimeSources) {
  const relPath = relative(repoRoot, file);
  const source = readText(file);
  if (!rawEntityInputSendAllowedFiles.has(relPath)) {
    assertNotMatches(source, /\bsendEntityInputsRaw\s*\(|['"]sendEntityInputsRaw['"]/, relPath, 'raw entity inputs websocket send');
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
  ['core/protocol/payments/delivery-result.ts', [
    "export type DeliveryOutcome = 'delivered' | 'queued' | 'deferred' | 'failed';",
    'export type DeliveryResult = {',
    'export const requireDeliveryResult',
    'export const isDeliveryDelivered',
    'export const shouldRetryDelivery',
    'export const requireDeliveryDelivered',
    'export const classifyUndeliveredDelivery',
    'export const deliveryFailure',
  ]],
  ['core/runtime/delivery/topology/output-routing.ts', [
    'enqueueEntityInputsDelivery(\n    targetRuntimeId: string,\n    envelope: RuntimeEntityInputsEnvelope,\n    ingressTimestamp?: number,\n  ): DeliveryResult;',
    'export type RuntimeEntityInputRoutingResult = {',
    'delivery: DeliveryResult;',
    'export const buildPendingNetworkOutputs',
    'NETWORK_OUTBOX_CAPACITY_EXCEEDED',
    'ROUTE_DEFERRED_OUTPUTS_FORBIDDEN',
    'ROUTE_P2P_UNAVAILABLE',
    'requireDeliveryResult(',
    'requireDeliveryDelivered(',
    'const tryDirectOutputEnvelope = (',
    'if (!isDeliveryDelivered(delivery)) return false;',
    'const dispatchP2POutputEnvelope = (',
  ]],
  ['core/network/p2p/p2p.ts', [
    'enqueueEntityInputsDelivery(\n    targetRuntimeId: string,\n    envelope: RuntimeEntityInputsEnvelope,\n    ingressTimestamp?: number,\n  ): EntityInputDeliveryResult',
    'sendEntityInputsRaw',
    "delivery.code === 'P2P_NO_PUBKEY'",
    'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
    'Durable retry ownership belongs to the runtime outbox',
  ]],
  ['core/network/p2p/ws-client.ts', [
    'sendEntityInputsRaw(to: string, envelope: RuntimeEntityInputsEnvelope, ingressTimestamp?: number): boolean',
  ]],
  ['core/network/p2p/direct-runtime-bun.ts', [
    'sendEntityInputsDelivery: (\n      targetRuntimeId: string,\n      envelope: RuntimeEntityInputsEnvelope,\n      ingressTimestamp?: number,\n    ): DeliveryResult',
    'ROUTE_DIRECT_MISS_FAILOVER',
    'ROUTE_DIRECT_SEND_FAILED',
  ]],
  ['core/network/websocket-send-result.ts', [
    'export const classifyWebSocketSendResult',
    "return 'backpressured'",
    "return 'dropped'",
  ]],
  ['core/network/relay/store.ts', [
    'export const classifyRelayDeliveryEvent',
    'deliveryFailure({',
  ]],
  ['core/network/relay/router.ts', [
    'const sendRelayDelivery = (',
    "classifyWebSocketSendResult(result) === 'dropped'",
    'delivery: relayDelivery',
    'local-delivery-failed',
  ]],
  ['core/orchestrator/hub/hub-runtime-transport.ts', [
    'route.sendEntityInputsDelivery(',
    'targetRuntimeId,\n    envelope,\n    ingressTimestamp,',
  ]],
  ['core/orchestrator/mm-node.ts', [
    'directRuntimeWs.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp)',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const p2pSource = readText('core/network/p2p/p2p.ts');
assertNotIncludes(p2pSource, 'pendingByRuntime', 'core/network/p2p/p2p.ts');
assertNotIncludes(p2pSource, 'flushPending', 'core/network/p2p/p2p.ts');

const runtimeRoutingPath = 'core/runtime/loop/loop-routing.ts';
const runtimeRouting = readText(runtimeRoutingPath);
assertIncludes(runtimeRouting, 'sendEntityInputWithRouting(env, input, outputRoutingDeps())', runtimeRoutingPath);
const sendEntityInputStart = runtimeRouting.indexOf('sendEntityInput: (env: RuntimeReplica');
const sendEntityInputEnd = runtimeRouting.indexOf('startP2P:', sendEntityInputStart);
const sendEntityInputSource = runtimeRouting.slice(sendEntityInputStart, sendEntityInputEnd);
assertNotIncludes(sendEntityInputSource, 'return true', runtimeRoutingPath);
assertNotIncludes(sendEntityInputSource, 'return false', runtimeRoutingPath);

const relayDirectTs = readText('core/api/server/network/relay-direct.ts');
assertNotIncludes(relayDirectTs, '[RELAY] Direct dispatch', 'core/api/server/network/relay-direct.ts');
assertNotIncludes(relayDirectTs, 'console.', 'core/api/server/network/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.target_key_missing', 'core/api/server/network/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.source_key_missing', 'core/api/server/network/relay-direct.ts');
assertIncludes(relayDirectTs, 'relay.direct.send_failed', 'core/api/server/network/relay-direct.ts');

for (const [path, markers] of [
  ['core/__tests__/payments/invariants/delivery-result.test.ts', [
    'delivery result helpers validate the shared delivery contract',
    'undelivered disposition centralizes retry/drop event decisions',
  ]],
  ['core/__tests__/payments/invariants/delivery-boundary.test.ts', [
    'raw entity inputs websocket send stays behind the P2P delivery adapter',
    'delivery retry and terminal decisions stay behind shared helpers',
    'delivery outcome decisions stay behind shared helpers',
  ]],
  ['core/__tests__/runtime/transport/runtime-output-routing.test.ts', [
    'ROUTE_P2P_INVALID_DELIVERY_RESULT',
    'ROUTE_SEND_NOT_DELIVERED',
  ]],
  ['core/__tests__/network/p2p/p2p-prefetch.test.ts', [
    'enqueueEntityInputsDelivery reports typed delivery result',
    'enqueueEntityInputsDelivery returns typed success with transport',
  ]],
  ['core/__tests__/network/relay/relay-store.test.ts', [
    'websocket send result classifier covers the complete server/client matrix',
    'relay delivery events expose typed retry and fatal semantics',
  ]],
  ['core/__tests__/network/relay/relay-direct.test.ts', [
    'direct relay diagnostics stay machine-readable',
    'relay.direct.target_key_missing',
    'relay.direct.source_key_missing',
    'relay.direct.send_failed',
  ]],
  ['core/__tests__/network/relay/relay-router.test.ts', [
    'delivery:',
    'send-failed',
    'deliver-invalid',
  ]],
  ['core/__tests__/network/pathfinding/direct-runtime-bun.test.ts', [
    'sendEntityInputsDelivery',
    'WEBSOCKET_SEND_RESULT_INVALID',
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
  'Raw `sendEntityInputsRaw()` is limited to the P2P adapter',
  'Retry/drop/fatal decisions live behind shared delivery helpers',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('runtime delivery boundary scan check passed');
