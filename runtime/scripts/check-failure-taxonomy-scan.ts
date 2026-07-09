#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import { deliveryFailure, isDeliveryResult } from '../delivery-result';
import {
  buildRuntimeFailureSignal,
  classifyRuntimeFaucetFailure,
  classifyRuntimeJBatchFailure,
  classifyRuntimeMarketMakerFailure,
  classifyRuntimeTransportFailure,
  isRuntimeFailureSignal,
  type RuntimeFailureSignal,
} from '../failure-taxonomy';
import { publicAggregatedHealth } from '../health-redaction';
import { resolveRuntimeImportReadiness } from '../orchestrator/runtime-import-readiness';

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

const assertFailure = (
  failure: RuntimeFailureSignal,
  expected: Pick<RuntimeFailureSignal, 'category' | 'code' | 'retryable' | 'fatal'>,
): void => {
  requireCondition(isRuntimeFailureSignal(failure), `invalid failure signal: ${JSON.stringify(failure)}`);
  requireCondition(failure.category === expected.category, `category mismatch: ${failure.category} !== ${expected.category}`);
  requireCondition(failure.code === expected.code, `code mismatch: ${failure.code} !== ${expected.code}`);
  requireCondition(failure.retryable === expected.retryable, `retryable mismatch for ${failure.code}`);
  requireCondition(failure.fatal === expected.fatal, `fatal mismatch for ${failure.code}`);
};

const expectedEmpty = classifyRuntimeFaucetFailure('FAUCET_ACCOUNT_NOT_OPEN', 'account has no open faucet line');
assertFailure(expectedEmpty, {
  category: 'ExpectedEmpty',
  code: 'FAUCET_ACCOUNT_NOT_OPEN',
  retryable: false,
  fatal: false,
});

const transient = classifyRuntimeJBatchFailure('J_SUBMIT_TRANSIENT', 'rpc ECONNRESET');
assertFailure(transient, {
  category: 'TransientRace',
  code: 'J_SUBMIT_TRANSIENT',
  retryable: true,
  fatal: false,
});

const contradiction = buildRuntimeFailureSignal({
  category: 'Contradiction',
  code: 'OPERATOR_CONFIG_INVALID',
  message: 'secret-token-must-not-be-public',
});
assertFailure(contradiction, {
  category: 'Contradiction',
  code: 'OPERATOR_CONFIG_INVALID',
  retryable: false,
  fatal: true,
});

const transportContradiction = classifyRuntimeTransportFailure('RPC_UPSTREAM_NOT_CONFIGURED');
assertFailure(transportContradiction, {
  category: 'Contradiction',
  code: 'RPC_UPSTREAM_NOT_CONFIGURED',
  retryable: false,
  fatal: true,
});

const marketMakerExpectedEmpty = classifyRuntimeMarketMakerFailure('MARKET_MAKER_DISABLED');
assertFailure(marketMakerExpectedEmpty, {
  category: 'ExpectedEmpty',
  code: 'MARKET_MAKER_DISABLED',
  retryable: false,
  fatal: false,
});

const delivery = deliveryFailure({
  category: 'Contradiction',
  code: 'RPC_UPSTREAM_NOT_CONFIGURED',
  message: 'secret delivery detail',
});
requireCondition(isDeliveryResult(delivery), `invalid typed delivery result: ${JSON.stringify(delivery)}`);
requireCondition(delivery.failure?.code === 'RPC_UPSTREAM_NOT_CONFIGURED', 'delivery failure code was not propagated');
requireCondition(delivery.terminal === true, 'contradiction delivery must be terminal');

const readinessHealth: Parameters<typeof resolveRuntimeImportReadiness>[0] = {
  systemOk: true,
  coreOk: true,
  degraded: [],
  failures: [contradiction],
  reset: {
    inProgress: false,
    lastError: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    resolvedAt: null,
  },
  hubMesh: {
    ok: true,
    hubIds: [],
    pairs: [],
    direct: { openLinkCount: 0, links: [] },
  },
  marketMaker: {
    enabled: false,
    ok: true,
    failure: null,
    entityId: null,
    startupPhase: null,
    expectedOffersPerHub: 0,
    expectedOffersPerPair: 0,
    cross: {
      applicable: false,
      ok: true,
      expectedRoutes: 0,
      expectedOffersPerRoute: 0,
      expectedOffersPerPair: 0,
      routeCount: 0,
      routes: [],
    },
    hubs: [],
  },
  custody: {
    enabled: false,
    ok: true,
    entityId: null,
    daemonPort: null,
    servicePort: null,
  },
  bootstrapReserves: {
    ok: true,
    targetMet: true,
    requiredTokenCount: 0,
    entityCount: 0,
    entities: [],
  },
};
const readiness = resolveRuntimeImportReadiness(readinessHealth);
requireCondition(readiness.ok === false, 'runtime import readiness must fail on fatal typed failure');
requireCondition(readiness.code === 'OPERATOR_CONFIG_INVALID', `readiness code mismatch: ${readiness.ok ? 'ok' : readiness.code}`);
requireCondition(readiness.fatal === true, 'runtime import readiness fatal flag was not propagated');
requireCondition(readiness.failure.code === 'OPERATOR_CONFIG_INVALID', 'runtime import readiness failure payload missing code');

const publicHealth = publicAggregatedHealth({
  coreOk: false,
  systemOk: false,
  degraded: ['marketMaker'],
  failures: [contradiction],
  marketMaker: { enabled: true, ok: false, failure: contradiction },
  bootstrapTimeline: {
    stages: [{
      key: 'ready-hash',
      label: 'Ready hash',
      status: 'blocked',
      reason: 'secret timeline reason',
      failure: transient,
    }],
  },
});
const publicHealthText = JSON.stringify(publicHealth);
assertNotIncludes(publicHealthText, 'secret-token-must-not-be-public', 'publicAggregatedHealth');
assertNotIncludes(publicHealthText, 'secret timeline reason', 'publicAggregatedHealth');
assertIncludes(publicHealthText, '"code":"OPERATOR_CONFIG_INVALID"', 'publicAggregatedHealth');
assertIncludes(publicHealthText, '"fatal":true', 'publicAggregatedHealth');

const taxonomyPath = 'runtime/failure-taxonomy.ts';
const taxonomy = readText(taxonomyPath);
for (const marker of [
  "export type RuntimeFailureCategory = 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';",
  "(value as RuntimeFailureSignal).retryable === ((value as RuntimeFailureSignal).category === 'TransientRace')",
  "(value as RuntimeFailureSignal).fatal === ((value as RuntimeFailureSignal).category === 'Contradiction')",
  'classifyRuntimeImportReadinessReason',
  'classifyRuntimeTransportFailure',
  'classifyRuntimeFaucetFailure',
  'classifyRuntimeBootstrapStageFailure',
  'classifyRuntimeMarketMakerFailure',
  'classifyRuntimeJBatchFailure',
]) {
  assertIncludes(taxonomy, marker, taxonomyPath);
}

const runtimeImportReadinessPath = 'runtime/orchestrator/runtime-import-readiness.ts';
const runtimeImportReadiness = readText(runtimeImportReadinessPath);
for (const marker of [
  "error: 'RUNTIME_IMPORT_NETWORK_NOT_READY'",
  'category: RuntimeFailureCategory;',
  'failure: RuntimeFailureSignal;',
  'const fatalFailure = typedFailures.find(failure => failure.fatal === true);',
  'return fail(`fatal:${fatalFailure.code}`, fatalFailure);',
]) {
  assertIncludes(runtimeImportReadiness, marker, runtimeImportReadinessPath);
}

const orchestratorPath = 'runtime/orchestrator/orchestrator.ts';
const orchestrator = readText(orchestratorPath);
for (const marker of [
  'const readiness = resolveRuntimeImportReadiness(health);',
  'category: readiness.category',
  'code: readiness.code',
  'retryable: readiness.retryable',
  'fatal: readiness.fatal',
  'failure: readiness.failure',
  'classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason)',
]) {
  assertIncludes(orchestrator, marker, orchestratorPath);
}

const healthRedactionPath = 'runtime/health-redaction.ts';
const healthRedaction = readText(healthRedactionPath);
for (const marker of [
  'const publicFailureSignal = (value: unknown): Record<string, unknown> | null => {',
  "category: valueOf(value, 'category')",
  "code: valueOf(value, 'code')",
  "retryable: valueOf(value, 'retryable') === true",
  "fatal: valueOf(value, 'fatal') === true",
  "failure: publicFailureSignal(valueOf(marketMaker, 'failure'))",
  "failure: publicFailureSignal(valueOf(stage, 'failure'))",
]) {
  assertIncludes(healthRedaction, marker, healthRedactionPath);
}

const publicFailureSignalSource = healthRedaction.slice(
  healthRedaction.indexOf('const publicFailureSignal ='),
  healthRedaction.indexOf('const publicFailureSignals ='),
);
assertNotIncludes(publicFailureSignalSource, 'message', healthRedactionPath);

const prodHealthPath = 'runtime/scripts/prod-health-smoke.ts';
const prodHealth = readText(prodHealthPath);
for (const marker of [
  'export const getFatalHealthFailures',
  'publicHealthFailureSignals(failures).filter(failure => failure.fatal === true)',
  'fatalFailures.length === 0',
  'health.failures has fatal entries',
]) {
  assertIncludes(prodHealth, marker, prodHealthPath);
}

for (const [path, markers] of [
  ['runtime/server/faucet-failure.ts', ['classifyRuntimeFaucetFailure', 'failure,']],
  ['runtime/server/offchain-faucet.ts', ['faucetFailureBody']],
  ['runtime/server/reserve-faucet.ts', ['faucetFailureBody']],
  ['runtime/entity-tx/invariant-errors.ts', ["'DIRECT_PAYMENT_',", "'SWAP_REQUEST_',"]],
  ['runtime/entity-tx/handlers/direct-payment.ts', [
    "createStructuredLogger('entity.payment')",
    'DIRECT_PAYMENT_${code}:${detail}',
    "'ROUTE_START_INVALID'",
    "'ROUTE_END_INVALID'",
    "'NEXT_HOP_ACCOUNT_MISSING'",
  ]],
  ['runtime/entity-tx/handlers/basic.ts', ["createStructuredLogger('entity.basic')"]],
  ['runtime/entity-tx/proposals.ts', ["createStructuredLogger('entity.basic')"]],
  ['runtime/entity-factory.ts', ["createStructuredLogger('entity.factory')", 'lazy.create', 'numbered.register_failed']],
  ['runtime/entity-consensus.ts', ["createStructuredLogger('entity')", 'frame.profile', 'frame.apply']],
  ['runtime/runtime-entity-inputs.ts', ["createStructuredLogger('runtime.entity_inputs')", 'inputs.profile', 'replay.merged_input']],
  ['runtime/entity-input-merge.ts', ["createStructuredLogger('entity.input.merge')", 'frame.conflict', 'duplicates.deduped']],
  ['runtime/entity-tx/handlers/account.ts', ["createStructuredLogger('account.handler')", 'ACCOUNT_INPUT_EMPTY']],
  ['runtime/entity-tx/handlers/open-account.ts', ["createStructuredLogger('account.open')"]],
  ['runtime/entity-tx/handlers/account/committed-frame-followups.ts', ["createStructuredLogger('account.followup')", 'frame.commit', 'frame.tx']],
  ['runtime/entity-tx/handlers/account/committed-htlc-followups.ts', ["createStructuredLogger('account.followup')", 'htlc.secret_check']],
  ['runtime/account-consensus.ts', ["createStructuredLogger('account')", 'frame.prev_hash_mismatch', 'frame.bilateral_delta_mismatch']],
  ['runtime/account-consensus/propose.ts', ["createStructuredLogger('account')", 'frame.validation_failed', 'proposal.profile']],
  ['runtime/account-tx/apply.ts', ["createStructuredLogger('account.tx')", 'account_frame.rejected']],
  ['runtime/entity-tx/handlers/account/orderbook-matching-same.ts', ["createStructuredLogger('orderbook.same')"]],
  ['runtime/entity-tx/handlers/r2r.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/create-settlement.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/mint-reserves.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/j-broadcast.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/j-clear-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/j-abort-sent-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity-tx/handlers/r2c.ts', ["createStructuredLogger('entity.r2c')"]],
  ['runtime/entity-tx/handlers/htlc-payment.ts', ["createStructuredLogger('entity.htlc')"]],
  ['runtime/entity-tx/handlers/dispute.ts', ["createStructuredLogger('entity.dispute')"]],
  ['runtime/entity-tx/handlers/settle.ts', ["createStructuredLogger('entity.settle')"]],
  ['runtime/entity-tx/j-events-debt.ts', ["createStructuredLogger('entity.debt')", 'ledger.divergence']],
  ['runtime/orchestrator/proxy.ts', ['classifyRuntimeTransportFailure', 'failure,']],
  ['runtime/runtime-j-submit.ts', ['classifyRuntimeJBatchFailure', 'J_SUBMIT_TRANSIENT', 'J_SUBMIT_FATAL']],
  ['runtime/orchestrator/market-maker-aggregated-health.ts', ['classifyRuntimeMarketMakerFailure', 'failure,']],
  ['runtime/delivery-result.ts', ['export type DeliveryResult', 'failure?: RuntimeFailureSignal', 'deliveryFailure']],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const directPaymentHandlerPath = 'runtime/entity-tx/handlers/direct-payment.ts';
const directPaymentHandler = readText(directPaymentHandlerPath);
assertNotIncludes(directPaymentHandler, 'console.log', directPaymentHandlerPath);

const r2cHandlerPath = 'runtime/entity-tx/handlers/r2c.ts';
const r2cHandler = readText(r2cHandlerPath);
assertNotIncludes(r2cHandler, 'console.log', r2cHandlerPath);

const basicHandlerPath = 'runtime/entity-tx/handlers/basic.ts';
const basicHandler = readText(basicHandlerPath);
assertNotIncludes(basicHandler, 'console.', basicHandlerPath);

const proposalHandlerPath = 'runtime/entity-tx/proposals.ts';
const proposalHandler = readText(proposalHandlerPath);
assertNotIncludes(proposalHandler, 'console.', proposalHandlerPath);

const entityFactoryPath = 'runtime/entity-factory.ts';
const entityFactory = readText(entityFactoryPath);
assertNotIncludes(entityFactory, 'console.', entityFactoryPath);

const entityInputMergePath = 'runtime/entity-input-merge.ts';
const entityInputMerge = readText(entityInputMergePath);
assertNotIncludes(entityInputMerge, 'console.', entityInputMergePath);

const entityConsensusPath = 'runtime/entity-consensus.ts';
const entityConsensus = readText(entityConsensusPath);
assertNotIncludes(entityConsensus, 'console.', entityConsensusPath);

const runtimeEntityInputsPath = 'runtime/runtime-entity-inputs.ts';
const runtimeEntityInputs = readText(runtimeEntityInputsPath);
assertNotIncludes(runtimeEntityInputs, 'console.', runtimeEntityInputsPath);

const accountHandlerPath = 'runtime/entity-tx/handlers/account.ts';
const accountHandler = readText(accountHandlerPath);
assertNotIncludes(accountHandler, 'console.', accountHandlerPath);

const openAccountHandlerPath = 'runtime/entity-tx/handlers/open-account.ts';
const openAccountHandler = readText(openAccountHandlerPath);
assertNotIncludes(openAccountHandler, 'console.', openAccountHandlerPath);

for (const accountFollowupPath of [
  'runtime/entity-tx/handlers/account/committed-frame-followups.ts',
  'runtime/entity-tx/handlers/account/committed-htlc-followups.ts',
]) {
  assertNotIncludes(readText(accountFollowupPath), 'console.', accountFollowupPath);
}

const accountTxApplyPath = 'runtime/account-tx/apply.ts';
const accountTxApply = readText(accountTxApplyPath);
assertNotIncludes(accountTxApply, 'console.', accountTxApplyPath);

const accountConsensusPath = 'runtime/account-consensus.ts';
const accountConsensus = readText(accountConsensusPath);
assertNotIncludes(accountConsensus, 'console.', accountConsensusPath);

const accountProposePath = 'runtime/account-consensus/propose.ts';
const accountPropose = readText(accountProposePath);
assertNotIncludes(accountPropose, 'console.', accountProposePath);

const sameOrderbookMatchingPath = 'runtime/entity-tx/handlers/account/orderbook-matching-same.ts';
const sameOrderbookMatching = readText(sameOrderbookMatchingPath);
assertNotIncludes(sameOrderbookMatching, 'console.', sameOrderbookMatchingPath);

const settlementOpsPath = 'runtime/settlement-ops.ts';
const settlementOps = readText(settlementOpsPath);
assertIncludes(settlementOps, 'SETTLEMENT_UNKNOWN_OP_TYPE', settlementOpsPath);
assertNotIncludes(settlementOps, 'console.', settlementOpsPath);

for (const jBatchHandlerPath of [
  'runtime/entity-tx/handlers/r2r.ts',
  'runtime/entity-tx/handlers/create-settlement.ts',
  'runtime/entity-tx/handlers/mint-reserves.ts',
  'runtime/entity-tx/handlers/j-broadcast.ts',
  'runtime/entity-tx/handlers/j-clear-batch.ts',
  'runtime/entity-tx/handlers/j-abort-sent-batch.ts',
]) {
  assertNotIncludes(readText(jBatchHandlerPath), 'console.', jBatchHandlerPath);
}

const htlcPaymentHandlerPath = 'runtime/entity-tx/handlers/htlc-payment.ts';
const htlcPaymentHandler = readText(htlcPaymentHandlerPath);
assertNotIncludes(htlcPaymentHandler, 'console.', htlcPaymentHandlerPath);

const disputeHandlerPath = 'runtime/entity-tx/handlers/dispute.ts';
const disputeHandler = readText(disputeHandlerPath);
assertNotIncludes(disputeHandler, 'console.', disputeHandlerPath);

const settleHandlerPath = 'runtime/entity-tx/handlers/settle.ts';
const settleHandler = readText(settleHandlerPath);
assertNotIncludes(settleHandler, 'console.', settleHandlerPath);

const debtEventsPath = 'runtime/entity-tx/j-events-debt.ts';
const debtEvents = readText(debtEventsPath);
assertNotIncludes(debtEvents, 'console.', debtEventsPath);

for (const [path, markers] of [
  ['runtime/__tests__/failure-taxonomy.test.ts', ['runtime failure taxonomy', 'J_BATCH_LIMIT_EXCEEDED']],
  ['runtime/__tests__/audit-failfast-regressions.test.ts', [
    'direct payment fails loud for invalid route topology',
    'DIRECT_PAYMENT_ROUTE_START_INVALID',
    'DIRECT_PAYMENT_ROUTE_END_INVALID',
    'DIRECT_PAYMENT_NEXT_HOP_ACCOUNT_MISSING',
  ]],
  ['runtime/__tests__/runtime-import-readiness.test.ts', ['runtime import readiness gate', 'fatal: true']],
  ['runtime/__tests__/health-redaction.test.ts', ['public aggregated health strips child process ids', 'Latest /api/health child refresh window']],
  ['runtime/__tests__/prod-health-smoke.test.ts', ['getFatalHealthFailures']],
  ['runtime/__tests__/entity-factory-logging.test.ts', ['entity factory uses structured logging without direct console output', 'entity.factory']],
  ['runtime/__tests__/entity-consensus-logging.test.ts', ['entity consensus core uses structured logging only', 'frame.profile']],
  ['runtime/__tests__/runtime-entity-input-logging.test.ts', ['runtime entity input j-output collection logs stay behind structured debug logging', 'inputs.profile']],
  ['runtime/__tests__/entity-input-merge.test.ts', ['uses structured logging without direct console output', 'entity.input.merge']],
  ['runtime/__tests__/settlement-ops.test.ts', ['SETTLEMENT_UNKNOWN_OP_TYPE', 'without console fallback']],
  ['runtime/__tests__/account-tx-apply-logging.test.ts', ['account_frame without direct console output', 'account_frame.rejected']],
  ['runtime/__tests__/account-followup-logging.test.ts', ['account committed followups use structured logging only', 'account.followup']],
  ['runtime/__tests__/account-consensus-logging.test.ts', ['account consensus core uses structured logging only', 'frame.bilateral_delta_mismatch']],
  ['runtime/__tests__/account-propose-logging.test.ts', ['account frame proposal path uses structured logging only', 'proposal.profile']],
  ['runtime/__tests__/debt-ledger.test.ts', ['debt ledger divergence without direct console warning', 'DEBT_LEDGER_DIVERGENCE']],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const auditDocPath = 'docs/security/failure-taxonomy-scan.md';
const auditDoc = readText(auditDocPath);
for (const marker of [
  '# Runtime Failure Taxonomy Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:failure-taxonomy',
  '`Contradiction` is fatal',
  '`TransientRace` is retryable',
  '`ExpectedEmpty` is non-fatal',
  'Public health redaction exposes code/category/retryability/fatality',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('runtime failure taxonomy scan check passed');
