#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import { deliveryFailure, isDeliveryResult } from '../../../protocol/payments/delivery-result';
import {
  buildRuntimeFailureSignal,
  classifyRuntimeFaucetFailure,
  classifyRuntimeJBatchFailure,
  classifyRuntimeMarketMakerFailure,
  classifyRuntimeTransportFailure,
  isRuntimeFailureSignal,
  type RuntimeFailureSignal,
} from '../../../protocol/errors/failure-taxonomy';
import { publicAggregatedHealth } from '../../../api/server/health/redaction';
import { resolveRuntimeImportReadiness } from '../../../orchestrator/replica-import/runtime-import-readiness';

const readText = (path: string): string => {
  const splitSources: Record<string, string[]> = {
    'core/runtime.ts': [
      'core/runtime.ts',
      'core/runtime/composition.ts',
      'core/api/public/runtime-public.ts',
      'core/runtime/frame/apply.ts',
      'core/runtime/frame/clone.ts',
      'core/runtime/frame/dispatch.ts',
      'core/runtime/frame/intake/execution-state.ts',
      'core/runtime/frame/lifecycle/finish.ts',
      'core/runtime/frame/intake/admission.ts',
      'core/runtime/frame/intake/finalize.ts',
      'core/runtime/frame/intake/reducer.ts',
      'core/runtime/frame/plan.ts',
      'core/runtime/frame/lifecycle/post-commit.ts',
      'core/runtime/frame/lifecycle/prepare.ts',
      'core/runtime/frame/process-profile.ts',
      'core/runtime/frame/intake/recovery.ts',
      'core/runtime/frame/snapshot.ts',
      'core/runtime/frame/lifecycle/start.ts',
      'core/runtime/frame/transaction.ts',
      'core/runtime/frame/lifecycle/writer-lock.ts',
    ],
    'core/runtime/loop/loop.ts': [
      'core/runtime/loop/loop.ts',
      'core/runtime/frame/intake/discard.ts',
      'core/runtime/loop/loop-lifecycle.ts',
      'core/runtime/loop/loop-failure.ts',
    ],
    'core/runtime/mempool/entity-inputs.ts': [
      'core/runtime/mempool/entity-inputs.ts',
      'core/runtime/admit/entity-input-admission.ts',
      'core/runtime/admit/entity-input-atomic.ts',
      'core/runtime/admit/entity-input-contract.ts',
      'core/runtime/admit/entity-input-output.ts',
      'core/runtime/admit/entity-input-replica.ts',
      'core/runtime/admit/entity-input-staging.ts',
    ],
    'core/entity/tx/handlers/account/index.ts': [
      'core/entity/tx/handlers/account/index.ts',
      'core/entity/tx/handlers/account/input-phases.ts',
    ],
    'core/entity/tx/handlers/dispute/index.ts': [
      'core/entity/tx/handlers/dispute/index.ts',
      'core/entity/tx/handlers/dispute/shared.ts',
      'core/entity/tx/handlers/dispute/start.ts',
      'core/entity/tx/handlers/dispute/start-admission.ts',
      'core/entity/tx/handlers/dispute/start-evidence.ts',
      'core/entity/tx/handlers/dispute/start-hanko.ts',
      'core/entity/tx/handlers/dispute/finalize.ts',
      'core/entity/tx/handlers/dispute/finalize-admission.ts',
      'core/entity/tx/handlers/dispute/finalize-proof.ts',
    ],
    'core/account/consensus/proposal/propose.ts': [
      'core/account/consensus/proposal/propose.ts',
      'core/account/consensus/proposal/admission.ts',
      'core/account/consensus/proposal/frame.ts',
      'core/account/consensus/proposal/proof.ts',
      'core/account/consensus/proposal/finalize.ts',
      'core/account/consensus/proposal/transactions.ts',
    ],
    'core/account/consensus/index.ts': [
      'core/account/consensus/index.ts',
      'core/account/consensus/incoming/preflight.ts',
    ],
    'core/account/tx/apply.ts': ['core/account/tx/apply.ts', 'core/account/tx/mutation.ts'],
    'core/orchestrator/mm-node.ts': [
      'core/orchestrator/mm-node.ts',
      'core/orchestrator/market-maker/node/mm-node-core.ts',
      'core/orchestrator/market-maker/node/mm-node-health.ts',
      'core/orchestrator/market-maker/node/mm-node-run.ts',
    ],
    'core/api/public/external-wallet-api.ts': [
      'core/api/public/external-wallet-api.ts',
      'core/api/public/external-wallet/http.ts',
      'core/api/public/external-wallet/faucet-wallet.ts',
      'core/api/public/external-wallet/faucet-handlers.ts',
      'core/api/public/external-wallet/snapshot-handler.ts',
      'core/api/public/external-wallet/tokens-handler.ts',
    ],
    'core/orchestrator/bootstrap/bootstrap-timeline.ts': [
      'core/orchestrator/bootstrap/bootstrap-timeline.ts',
      'core/orchestrator/bootstrap/bootstrap-timeline-stages.ts',
    ],
    'core/__tests__/audit-failfast-regressions.test.ts': [
      'core/__tests__/testing/audit/audit-failfast-regressions-part-1.test.ts',
      'core/__tests__/testing/audit/audit-failfast-regressions-part-2.test.ts',
      'core/__tests__/testing/audit/audit-failfast-regressions-part-3.test.ts',
      'core/__tests__/testing/audit/audit-failfast-regressions-part-4.test.ts',
      'core/__tests__/testing/audit/audit-failfast-regressions-part-5.test.ts',
      'core/__tests__/testing/audit/audit-failfast-regressions-part-6.test.ts',
    ],
    'core/__tests__/radapter.test.ts': [
      'core/__tests__/api/runtime-adapter/radapter-part-1.test.ts',
      'core/__tests__/api/runtime-adapter/radapter-part-2.test.ts',
      'core/__tests__/api/runtime-adapter/radapter-part-3.test.ts',
    ],
  };
  return (splitSources[path] ?? [path]).map(file => readFileSync(file, 'utf8')).join('\n');
};

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
  requireCondition(
    failure.category === expected.category,
    `category mismatch: ${failure.category} !== ${expected.category}`,
  );
  requireCondition(failure.code === expected.code, `code mismatch: ${failure.code} !== ${expected.code}`);
  requireCondition(failure.retryable === expected.retryable, `retryable mismatch for ${failure.code}`);
  requireCondition(failure.fatal === expected.fatal, `fatal mismatch for ${failure.code}`);
};

const fatalIncidentRoutes = [
  {
    name: 'browser',
    steps: [
      [
        'frontend/src/hooks.client.ts',
        ['installBrowserErrorTelemetry();', "captureBrowserError('svelte_error', error);"],
      ],
      [
        'frontend/src/lib/debug/browser-telemetry.ts',
        [
          "captureBrowserError('console_error'",
          "captureBrowserError('window_error'",
          "captureBrowserError('unhandled_rejection'",
          "fetch('/api/debug/events/ingest'",
        ],
      ],
      ['core/network/relay/debug-http.ts', ["event: 'browser_error'", "source: 'browser'"]],
      ['core/orchestrator/orchestrator.ts', ['incidentSink: incident => debugIncidentJournal.record(incident)']],
    ],
  },
  {
    name: 'managed-runtime',
    steps: [
      ['core/runtime/loop/loop.ts', ['await config.onFatal({', 'haltRuntimeRequiresOperator(env, error);']],
      ['core/orchestrator/hub-node.ts', ['onFatal: async payload => {', 'await reportManagedChildFatal({']],
      ['core/orchestrator/mm-node.ts', ['onFatal: async payload => {', 'await reportManagedChildFatal({']],
      [
        'core/orchestrator/process/managed-child-fatal-ipc.ts',
        ["type: 'xln:managed-child-fatal'", "type: 'xln:managed-child-fatal-ack'", 'persisted: true'],
      ],
      [
        'core/orchestrator/orchestrator.ts',
        [
          'attachManagedChildFatalIpc(',
          'persistManagedChildFatalReport(',
          'incidentSink: incident => debugIncidentJournal.record(incident)',
        ],
      ],
    ],
  },
  {
    name: 'standalone-runtime',
    steps: [
      [
        'core/api/server/index.ts',
        [
          "process.env['XLN_SERVER_DEBUG_INCIDENT_JOURNAL_PATH'] || `${dbRootPath}.debug-incidents.jsonl`",
          'incidentSink: incident => incidentJournal.record(incident)',
          'startRuntimeLoop(env, {',
          'onFatal: async payload => {',
          "serverLog.error('runtime.loop_fatal'",
        ],
      ],
    ],
  },
  {
    name: 'orchestrator',
    steps: [
      [
        'core/orchestrator/orchestrator.ts',
        [
          'pushManagedChildIncident(',
          'persistOrchestratorFailure(',
          'incidentSink: incident => debugIncidentJournal.record(incident)',
        ],
      ],
    ],
  },
  {
    name: 'jurisdiction-submit',
    steps: [
      [
        'core/runtime/j-submit/j-submit.ts',
        [
          'J_SUBMIT_FATAL:',
          "failure.category === 'transient' ? 'transientFailure' : 'terminalFailure'",
          'queueBatchResult(env, deps, jurisdictionName, jTx, outcome, extra)',
        ],
      ],
      ['core/runtime/loop/loop.ts', ['await deps.processRuntime(env);', 'await config.onFatal({']],
    ],
  },
] as const;

for (const route of fatalIncidentRoutes) {
  for (const [path, markers] of route.steps) {
    const source = readText(path);
    for (const marker of markers) {
      assertIncludes(source, marker, `${route.name}:${path}`);
    }
  }
}

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
    quiescence: null,
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
requireCondition(
  readiness.code === 'OPERATOR_CONFIG_INVALID',
  `readiness code mismatch: ${readiness.ok ? 'ok' : readiness.code}`,
);
requireCondition(readiness.fatal === true, 'runtime import readiness fatal flag was not propagated');
requireCondition(
  readiness.failure.code === 'OPERATOR_CONFIG_INVALID',
  'runtime import readiness failure payload missing code',
);

const publicHealth = publicAggregatedHealth({
  coreOk: false,
  systemOk: false,
  degraded: ['marketMaker'],
  failures: [contradiction],
  marketMaker: { enabled: true, ok: false, failure: contradiction },
  bootstrapTimeline: {
    stages: [
      {
        key: 'ready-hash',
        label: 'Ready hash',
        status: 'blocked',
        reason: 'secret timeline reason',
        failure: transient,
      },
    ],
  },
});
const publicHealthText = JSON.stringify(publicHealth);
assertNotIncludes(publicHealthText, 'secret-token-must-not-be-public', 'publicAggregatedHealth');
assertNotIncludes(publicHealthText, 'secret timeline reason', 'publicAggregatedHealth');
assertIncludes(publicHealthText, '"code":"OPERATOR_CONFIG_INVALID"', 'publicAggregatedHealth');
assertIncludes(publicHealthText, '"fatal":true', 'publicAggregatedHealth');

const taxonomyPath = 'core/protocol/errors/failure-taxonomy.ts';
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

const runtimeImportReadinessPath = 'core/orchestrator/replica-import/runtime-import-readiness.ts';
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

const runtimeImportHttpPath = 'core/orchestrator/replica-import/runtime-import-http.ts';
const runtimeImportHttp = readText(runtimeImportHttpPath);
for (const marker of [
  'const readiness = resolveRuntimeImportReadiness(',
  'category: readiness.category',
  'code: readiness.code',
  'retryable: readiness.retryable',
  'fatal: readiness.fatal',
  'failure: readiness.failure',
]) {
  assertIncludes(runtimeImportHttp, marker, runtimeImportHttpPath);
}

const orchestratorPath = 'core/orchestrator/orchestrator.ts';
const orchestrator = readText(orchestratorPath);
for (const marker of [
  'const readiness = resolveRuntimeImportReadiness(health);',
  "meshLog.warn('runtime_import_manifest.refresh_failed'",
  "meshLog.warn('market_snapshot.enrichment_unavailable'",
  "meshLog.warn('child.stop_timeout_sigkill'",
  "meshLog.error('child.unexpected_exit'",
  "meshLog.error('child.unexpected_exit.stop_failed'",
  "meshLog.error('custody.bootstrap_failed'",
  "meshLog.warn('reset.signal_during_reset'",
  "meshLog.error('reset.initial_failed'",
]) {
  assertIncludes(orchestrator, marker, orchestratorPath);
}
assertNotIncludes(orchestrator, '[MESH] runtime import manifest refresh failed', orchestratorPath);
assertNotIncludes(orchestrator, '[MESH] market snapshot enrichment unavailable', orchestratorPath);
assertNotIncludes(orchestrator, '[MESH] child pid=', orchestratorPath);
assertNotIncludes(orchestrator, 'failed while stopping children after fatal exit', orchestratorPath);
assertNotIncludes(orchestrator, 'shutting down instead of restarting', orchestratorPath);
assertNotIncludes(orchestrator, '[MESH] custody bootstrap failed:', orchestratorPath);
assertNotIncludes(orchestrator, '[MESH] received SIGTERM from parent during reset', orchestratorPath);
assertNotIncludes(orchestrator, '[MESH] initial reset failed:', orchestratorPath);

const bootstrapTimelinePath = 'core/orchestrator/bootstrap/bootstrap-timeline.ts';
const bootstrapTimeline = readText(bootstrapTimelinePath);
assertIncludes(
  bootstrapTimeline,
  'classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason)',
  bootstrapTimelinePath,
);

const hubNodePath = 'core/orchestrator/hub-node.ts';
const hubNode = readText(hubNodePath);
for (const marker of [
  "createStructuredLogger('mesh.hub'",
  "nodeLog.info('signer_keys.ready'",
  "nodeLog.info('faucet_provision.ready'",
  "nodeLog.info('runtime.ready'",
  "nodeLog.info('admin_url.ready'",
  "nodeLog.warn('admin_url.unavailable'",
]) {
  assertIncludes(hubNode, marker, hubNodePath);
}
assertNotIncludes(hubNode, "nodeLog.info('dev_bootstrap.storage_disabled'", hubNodePath);
assertNotIncludes(hubNode, "nodeLog.info('signer_keys.prewarmed'", hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] SIGNER_KEYS_PREWARMED', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] DEV_BOOTSTRAP_STORAGE_DISABLED', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] FAUCET_PROVISION_READY', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] READY', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] INSPECT_URL', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] INSPECT_URL_UNAVAILABLE', hubNodePath);

const marketMakerNodePath = 'core/orchestrator/mm-node.ts';
const marketMakerNode = readText(marketMakerNodePath);
for (const marker of [
  "createStructuredLogger('mesh.marketMaker'",
  "nodeLog.info('signer_keys.ready'",
  "nodeLog.info('runtime.ready'",
  "nodeLog.info('offers.ready'",
]) {
  assertIncludes(marketMakerNode, marker, marketMakerNodePath);
}
assertNotIncludes(marketMakerNode, "nodeLog.info('dev_bootstrap.storage_disabled'", marketMakerNodePath);
assertNotIncludes(marketMakerNode, "nodeLog.info('signer_keys.prewarmed'", marketMakerNodePath);
assertNotIncludes(marketMakerNode, '[MESH-MM] SIGNER_KEYS_PREWARMED', marketMakerNodePath);
assertNotIncludes(marketMakerNode, 'Runtime storage disabled for rebuildable market-maker state', marketMakerNodePath);
assertNotIncludes(marketMakerNode, '[MESH-MM] RUNTIME_READY', marketMakerNodePath);
assertNotIncludes(marketMakerNode, '[MESH-MM] OFFERS_READY', marketMakerNodePath);

const healthRedactionPath = 'core/api/server/health/redaction.ts';
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

const prodHealthPath = 'core/scripts/operations/production/prod-health-smoke.ts';
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
  ['core/api/server/faucet/failure.ts', ['classifyRuntimeFaucetFailure', 'failure,']],
  ['core/api/server/faucet/offchain.ts', ['faucetFailureBody']],
  ['core/api/server/faucet/reserve.ts', ['faucetFailureBody']],
  [
    'core/api/public/external-wallet-api.ts',
    ["createStructuredLogger('server.external_wallet')", 'faucet.erc20.failed', 'snapshot.failed', 'faucet.gas.failed'],
  ],
  [
    'core/entity/tx/processing/invariant-errors.ts',
    ['FailureDispositionError', 'entityInputFailureDisposition'],
  ],
  [
    'core/entity/tx/handlers/payments/direct-payment.ts',
    ["createStructuredLogger('entity.payment')", 'DIRECT_PAYMENT_${code}:${detail}', "'NEXT_HOP_ACCOUNT_MISSING'"],
  ],
  [
    'core/protocol/payments/route.ts',
    ['requireCommittedDirectPaymentRoute', "'ROUTE_START_INVALID'", "'ROUTE_END_INVALID'"],
  ],
  ['core/entity/tx/handlers/system/basic.ts', ["createStructuredLogger('entity.basic')"]],
  ['core/entity/tx/processing/proposals.ts', ["createStructuredLogger('entity.basic')"]],
  ['core/entity/factory.ts', ["createStructuredLogger('entity.factory')", 'lazy.create']],
  ['core/entity/consensus/entity-log.ts', ["createStructuredLogger('entity')"]],
  ['core/entity/consensus/frame/application.ts', ['frame.profile', 'frame.apply']],
  [
    'core/runtime/mempool/entity-inputs.ts',
    ["createStructuredLogger('runtime.entity_inputs')", 'inputs.profile', 'replay.merged_input'],
  ],
  ['core/runtime/mempool/input-queue.ts', ["createStructuredLogger('runtime.input_queue')", 'interesting_entity_inputs']],
  ['core/runtime/envelope/p2p-lifecycle.ts', ["createStructuredLogger('p2p.lifecycle')", 'detach.close_failed']],
  ['core/network/relay/standalone-server.ts', ["createStructuredLogger('relay.standalone')", 'service.listen']],
  ['core/entity/consensus/input/merge.ts', ["createStructuredLogger('entity.input.merge')", 'frame.conflict']],
  ['core/entity/tx/handlers/account/index.ts', ["createStructuredLogger('account.handler')", 'ACCOUNT_INPUT_EMPTY']],
  ['core/entity/tx/handlers/account/lifecycle/open-account.ts', ["createStructuredLogger('account.open')"]],
  [
    'core/entity/tx/handlers/account/committed-frame-followups.ts',
    ["createStructuredLogger('account.followup')", 'frame.commit', 'frame.tx'],
  ],
  [
    'core/entity/tx/handlers/account/committed-htlc-followups.ts',
    ["createStructuredLogger('account.followup')", 'htlc.secret_check'],
  ],
  [
    'core/account/consensus/index.ts',
    ["createStructuredLogger('account')", 'frame.prev_hash_mismatch', 'frame.state_root_mismatch'],
  ],
  [
    'core/account/consensus/proposal/propose.ts',
    ["createStructuredLogger('account')", 'frame.validation_failed', 'proposal.profile'],
  ],
  ['core/entity/tx/handlers/account/orderbook/index.ts', ["createStructuredLogger('orderbook.same')"]],
  ['core/runtime/tx/tx-handlers.ts', ["createStructuredLogger('runtime.tx')", 'replica.import_start']],
  [
    'core/runtime/j-submit/jurisdiction-import.ts',
    [
      "createStructuredLogger('runtime.jurisdiction_import')",
      'jurisdiction.import_failed',
      'jurisdiction.import_retry',
    ],
  ],
  ['core/entity/tx/handlers/j-batch/r2r.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['core/entity/tx/handlers/j-batch/mint-reserves.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['core/entity/tx/handlers/j-batch/j-broadcast.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['core/entity/tx/handlers/j-batch/j-clear-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['core/entity/tx/handlers/j-batch/j-abort-sent-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['core/entity/tx/handlers/j-batch/r2c.ts', ["createStructuredLogger('entity.r2c')"]],
  ['core/entity/tx/handlers/htlc/payment.ts', ["createStructuredLogger('entity.htlc')"]],
  ['core/entity/tx/handlers/dispute/index.ts', ["createStructuredLogger('entity.dispute')"]],
  ['core/entity/tx/handlers/payments/settle.ts', ["createStructuredLogger('entity.settle')"]],
  ['core/entity/tx/j-events-observations/debt.ts', ["createStructuredLogger('entity.debt')", 'ledger.divergence']],
  ['core/account/utils.ts', ["logDebug('ACCOUNT_STATE'", 'deriveDelta.return']],
  ['core/account/validation/delta-validation.ts', ['ACCOUNT_DELTAS_MISSING', 'ACCOUNT_DELTAS_INVALID_TOKEN_ID']],
  ['core/runtime.ts', ["createStructuredLogger('runtime')", 'apply.profile', 'process.profile', 'joutbox.incoming']],
  [
    'core/runtime/recovery/j-adapter-restore.ts',
    ["createStructuredLogger('runtime.restore')", 'jadapter.restore_retry', 'jadapter.restore_failed'],
  ],
  [
    'core/runtime/envelope/gossip-store.ts',
    ["createStructuredLogger('runtime.envelope_gossip')", 'profile.restore_failed'],
  ],
  [
    'core/storage/runtime-dbs.ts',
    ["createStructuredLogger('runtime.storage')", 'storage_db.blocked', 'storage_db.open_failed'],
  ],
  ['core/storage/index.ts', ["createStructuredLogger('runtime.storage')", 'persist.frame']],
  [
    'core/watchtower/standalone-server.ts',
    ["createStructuredLogger('watchtower.standalone')", 'service.listen', 'sweep.failed', 'push_sweep.failed'],
  ],
  ['core/watchtower/dispute-watch.ts', ["createStructuredLogger('watchtower.dispute_watch')", 'target.failed']],
  [
    'core/orchestrator/graceful-server.ts',
    ["createStructuredLogger('orchestrator.lifecycle')", 'http.shutdown_timeout'],
  ],
  [
    'core/orchestrator/process/managed-runtime-leases.ts',
    ["createStructuredLogger('orchestrator.managed_leases')", 'stale_processes.kill', 'MANAGED_RUNTIME_LEASE_INVALID'],
  ],
  [
    'core/support/process/parent-watch.ts',
    ["createStructuredLogger('orchestrator.parent_watch')", 'missing_parent_pid', 'parent_pid_missing'],
  ],
  [
    'core/jurisdiction/adapter/kernel/config.ts',
    [
      "createStructuredLogger('runtime.jurisdiction_config')",
      'JURISDICTIONS_BROWSER_FETCH_FAILED',
      'JURISDICTIONS_BROWSER_CONFIG_INVALID',
    ],
  ],
  [
    'core/jurisdiction/adapter/kernel/jurisdiction-loader.ts',
    ["createStructuredLogger('runtime.jurisdiction_loader')", 'JURISDICTIONS_CONFIG_MISSING', 'decodeJurisdictionsData'],
  ],
  ['core/api/runtime-adapter/server.ts', ["createStructuredLogger('runtime.radapter')", 'response_too_large']],
  ['core/orchestrator/proxy.ts', ['classifyRuntimeTransportFailure', 'failure,']],
  [
    'core/runtime/j-submit/j-submit.ts',
    ["createStructuredLogger('runtime.jsubmit')", 'J_SUBMIT_TRANSIENT', 'J_SUBMIT_FATAL', 'tx.submit_failed'],
  ],
  ['core/runtime/j-submit/j-submit-result.ts', ['classifyRuntimeJBatchFailure', 'J_SUBMIT_TRANSIENT', 'J_SUBMIT_FATAL']],
  ['core/orchestrator/market-maker/health/market-maker-aggregated-health.ts', ['classifyRuntimeMarketMakerFailure', 'failure,']],
  [
    'core/protocol/payments/delivery-result.ts',
    ['export type DeliveryResult', 'failure?: RuntimeFailureSignal', 'deliveryFailure'],
  ],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const directPaymentHandlerPath = 'core/entity/tx/handlers/payments/direct-payment.ts';
const directPaymentHandler = readText(directPaymentHandlerPath);
assertNotIncludes(directPaymentHandler, 'console.log', directPaymentHandlerPath);

const runtimeCorePath = 'core/runtime.ts';
const runtimeCore = readText(runtimeCorePath);
for (const legacyRuntimeLogMarker of [
  '[RUNTIME-PROCESS-PROFILE]',
  '[RUNTIME-PROFILE]',
  '[J-OUTBOX]',
  'SKIP-FRAME',
  'GOSSIP_PROFILE_FINGERPRINT_SKIP',
  'TICK:',
  'local outputs queued',
  '[SIDE-EFFECT]',
]) {
  assertNotIncludes(runtimeCore, legacyRuntimeLogMarker, runtimeCorePath);
}

const runtimeTxHandlersPath = 'core/runtime/tx/tx-handlers.ts';
const runtimeTxHandlers = readText(runtimeTxHandlersPath);
assertNotIncludes(runtimeTxHandlers, 'console.', runtimeTxHandlersPath);

const runtimeJSubmitPath = 'core/runtime/j-submit/j-submit.ts';
const runtimeJSubmit = readText(runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, 'console.', runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, '[J-SUBMIT]', runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, '[SIDE-EFFECT]', runtimeJSubmitPath);

const runtimeInfraPath = 'core/runtime/recovery/j-adapter-restore.ts';
const runtimeInfra = readText(runtimeInfraPath);
assertNotIncludes(runtimeInfra, 'console.', runtimeInfraPath);

const runtimeInfraGossipPath = 'core/runtime/envelope/gossip-store.ts';
const runtimeInfraGossip = readText(runtimeInfraGossipPath);
assertNotIncludes(runtimeInfraGossip, 'console.', runtimeInfraGossipPath);
assertNotIncludes(runtimeInfraGossip, '[infra-db]', runtimeInfraGossipPath);

const runtimeStorageDbsPath = 'core/storage/runtime-dbs.ts';
const runtimeStorageDbs = readText(runtimeStorageDbsPath);
assertNotIncludes(runtimeStorageDbs, 'console.', runtimeStorageDbsPath);
assertNotIncludes(runtimeStorageDbs, '[storage-epoch]', runtimeStorageDbsPath);

const runtimeStoragePath = 'core/storage/index.ts';
const runtimeStorage = readText(runtimeStoragePath);
assertNotIncludes(runtimeStorage, 'console.', runtimeStoragePath);
assertNotIncludes(runtimeStorage, '[PERSIST]', runtimeStoragePath);

const standaloneWatchtowerPath = 'core/watchtower/standalone-server.ts';
const standaloneWatchtower = readText(standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, 'console.', standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, '[WATCHTOWER] sweep', standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, '[PUSH-WATCH] sweep', standaloneWatchtowerPath);

const disputeWatchPath = 'core/watchtower/dispute-watch.ts';
const disputeWatch = readText(disputeWatchPath);
assertNotIncludes(disputeWatch, 'console.', disputeWatchPath);
assertNotIncludes(disputeWatch, '[PUSH-WATCH] target', disputeWatchPath);

for (const orchestratorLifecyclePath of [
  'core/orchestrator/graceful-server.ts',
  'core/orchestrator/process/managed-runtime-leases.ts',
  'core/support/process/parent-watch.ts',
]) {
  assertNotIncludes(readText(orchestratorLifecyclePath), 'console.', orchestratorLifecyclePath);
}

const jurisdictionConfigPath = 'core/jurisdiction/adapter/kernel/config.ts';
const jurisdictionConfig = readText(jurisdictionConfigPath);
assertNotIncludes(jurisdictionConfig, 'console.', jurisdictionConfigPath);

const jurisdictionLoaderPath = 'core/jurisdiction/adapter/kernel/jurisdiction-loader.ts';
const jurisdictionLoader = readText(jurisdictionLoaderPath);
assertNotIncludes(jurisdictionLoader, 'console.', jurisdictionLoaderPath);
assertNotIncludes(jurisdictionLoader, 'new Date()', jurisdictionLoaderPath);

const runtimeInputQueuePath = 'core/runtime/mempool/input-queue.ts';
const runtimeInputQueue = readText(runtimeInputQueuePath);
assertNotIncludes(runtimeInputQueue, 'console.', runtimeInputQueuePath);
assertNotIncludes(runtimeInputQueue, '[enqueueRuntimeInput]', runtimeInputQueuePath);

const runtimeP2PLifecyclePath = 'core/runtime/envelope/p2p-lifecycle.ts';
const runtimeP2PLifecycle = readText(runtimeP2PLifecyclePath);
assertNotIncludes(runtimeP2PLifecycle, 'console.', runtimeP2PLifecyclePath);

for (const relayLoggingPath of [
  'core/network/relay/router.ts',
  'core/network/relay/local-delivery.ts',
  'core/network/relay/standalone-server.ts',
]) {
  assertNotIncludes(readText(relayLoggingPath), 'console.', relayLoggingPath);
}
assertNotIncludes(
  readText('core/network/relay/standalone-server.ts'),
  '[WS] Runtime relay',
  'core/network/relay/standalone-server.ts',
);

const solvencyPath = 'core/runtime/swap-cmd/solvency.ts';
const solvency = readText(solvencyPath);
assertNotIncludes(solvency, 'console.', solvencyPath);

const r2cHandlerPath = 'core/entity/tx/handlers/j-batch/r2c.ts';
const r2cHandler = readText(r2cHandlerPath);
assertNotIncludes(r2cHandler, 'console.log', r2cHandlerPath);

const basicHandlerPath = 'core/entity/tx/handlers/system/basic.ts';
const basicHandler = readText(basicHandlerPath);
assertNotIncludes(basicHandler, 'console.', basicHandlerPath);

const proposalHandlerPath = 'core/entity/tx/processing/proposals.ts';
const proposalHandler = readText(proposalHandlerPath);
assertNotIncludes(proposalHandler, 'console.', proposalHandlerPath);

const entityFactoryPath = 'core/entity/factory.ts';
const entityFactory = readText(entityFactoryPath);
assertNotIncludes(entityFactory, 'console.', entityFactoryPath);

const entityInputMergePath = 'core/entity/consensus/input/merge.ts';
const entityInputMerge = readText(entityInputMergePath);
assertNotIncludes(entityInputMerge, 'console.', entityInputMergePath);

for (const entityConsensusPath of [
  'core/entity/consensus/leader/certificates.ts',
  'core/entity/consensus/j-prefix/prefix-round.ts',
  'core/entity/consensus/state-quota.ts',
  'core/entity/consensus/input/consensus.ts',
  'core/entity/consensus/frame/application.ts',
]) {
  assertNotIncludes(readText(entityConsensusPath), 'console.', entityConsensusPath);
}

const runtimeEntityInputsPath = 'core/runtime/mempool/entity-inputs.ts';
const runtimeEntityInputs = readText(runtimeEntityInputsPath);
assertNotIncludes(runtimeEntityInputs, 'console.', runtimeEntityInputsPath);

const accountHandlerPath = 'core/entity/tx/handlers/account/index.ts';
const accountHandler = readText(accountHandlerPath);
assertNotIncludes(accountHandler, 'console.', accountHandlerPath);

const openAccountHandlerPath = 'core/entity/tx/handlers/account/lifecycle/open-account.ts';
const openAccountHandler = readText(openAccountHandlerPath);
assertNotIncludes(openAccountHandler, 'console.', openAccountHandlerPath);

for (const accountFollowupPath of [
  'core/entity/tx/handlers/account/committed-frame-followups.ts',
  'core/entity/tx/handlers/account/committed-htlc-followups.ts',
]) {
  assertNotIncludes(readText(accountFollowupPath), 'console.', accountFollowupPath);
}

const accountTxApplyPath = 'core/account/tx/apply.ts';
const accountTxApply = readText(accountTxApplyPath);
assertNotIncludes(accountTxApply, 'console.', accountTxApplyPath);

const accountConsensusPath = 'core/account/consensus/index.ts';
const accountConsensus = readText(accountConsensusPath);
assertNotIncludes(accountConsensus, 'console.', accountConsensusPath);

const accountProposePath = 'core/account/consensus/proposal/propose.ts';
const accountPropose = readText(accountProposePath);
assertNotIncludes(accountPropose, 'console.', accountProposePath);

const sameOrderbookMatchingPath = 'core/entity/tx/handlers/account/orderbook/index.ts';
const sameOrderbookMatching = readText(sameOrderbookMatchingPath);
assertNotIncludes(sameOrderbookMatching, 'console.', sameOrderbookMatchingPath);

const settlementOpsPath = 'core/protocol/settlement/operations.ts';
const settlementOps = readText(settlementOpsPath);
assertIncludes(settlementOps, 'SETTLEMENT_UNKNOWN_OP_TYPE', settlementOpsPath);
assertNotIncludes(settlementOps, 'console.', settlementOpsPath);

const externalWalletApiPath = 'core/api/public/external-wallet-api.ts';
const externalWalletApi = readText(externalWalletApiPath);
assertNotIncludes(externalWalletApi, 'console.', externalWalletApiPath);
assertNotIncludes(externalWalletApi, '[EXT-FAUCET/', externalWalletApiPath);
assertNotIncludes(externalWalletApi, '[EXT-WALLET/', externalWalletApiPath);

const runtimeAdapterServerPath = 'core/api/runtime-adapter/server.ts';
const runtimeAdapterServer = readText(runtimeAdapterServerPath);
assertNotIncludes(runtimeAdapterServer, 'console.', runtimeAdapterServerPath);
assertNotIncludes(runtimeAdapterServer, '[RADAPTER] RESPONSE_TOO_LARGE', runtimeAdapterServerPath);

for (const jBatchHandlerPath of [
  'core/entity/tx/handlers/j-batch/r2r.ts',
  'core/entity/tx/handlers/j-batch/mint-reserves.ts',
  'core/entity/tx/handlers/j-batch/j-broadcast.ts',
  'core/entity/tx/handlers/j-batch/j-clear-batch.ts',
  'core/entity/tx/handlers/j-batch/j-abort-sent-batch.ts',
]) {
  assertNotIncludes(readText(jBatchHandlerPath), 'console.', jBatchHandlerPath);
}

const htlcPaymentHandlerPath = 'core/entity/tx/handlers/htlc/payment.ts';
const htlcPaymentHandler = readText(htlcPaymentHandlerPath);
assertNotIncludes(htlcPaymentHandler, 'console.', htlcPaymentHandlerPath);

const disputeHandlerPath = 'core/entity/tx/handlers/dispute/index.ts';
const disputeHandler = readText(disputeHandlerPath);
assertNotIncludes(disputeHandler, 'console.', disputeHandlerPath);

const settleHandlerPath = 'core/entity/tx/handlers/payments/settle.ts';
const settleHandler = readText(settleHandlerPath);
assertNotIncludes(settleHandler, 'console.', settleHandlerPath);

const debtEventsPath = 'core/entity/tx/j-events-observations/debt.ts';
const debtEvents = readText(debtEventsPath);
assertNotIncludes(debtEvents, 'console.', debtEventsPath);

for (const validationPath of [
  'core/account/validation/state-validation.ts',
  'core/entity/state/state-validation.ts',
  'core/entity/replica/replica-validation.ts',
  'core/runtime/delivery/topology/routing-validation.ts',
]) {
  assertNotIncludes(readText(validationPath), 'console.', validationPath);
}

for (const marker of [
  'failureKind: EntityInputApplyFailureKind',
  'classifyEntityInputApplyFailure(cause)',
  "this.failureKind === 'malformed-ingress'",
]) {
  assertIncludes(runtimeEntityInputs, marker, runtimeEntityInputsPath);
}

const runtimeSourcePath = 'core/runtime/frame/intake/discard.ts';
const runtimeSource = readText(runtimeSourcePath);
assertIncludes(runtimeSource, 'error.isDiscardableIngress', runtimeSourcePath);
assertNotIncludes(
  runtimeSource,
  'error instanceof RuntimeEntityInputApplyError && error.isRemoteIngress',
  runtimeSourcePath,
);

for (const [path, markers] of [
  ['core/__tests__/security/policy/failure-taxonomy.test.ts', ['runtime failure taxonomy', 'J_BATCH_LIMIT_EXCEEDED']],
  [
    'core/__tests__/audit-failfast-regressions.test.ts',
    [
      'direct payment rejects invalid route topology without an invariant halt',
      'DIRECT_PAYMENT_ROUTE_START_INVALID',
      'DIRECT_PAYMENT_ROUTE_END_INVALID',
      'DIRECT_PAYMENT_NEXT_HOP_ACCOUNT_MISSING',
      'remote-business-rejection-discard',
      'remote-storage-failure-fatal',
      'remote-local-bug-fatal',
      "expect(storage.failureKind).toBe('storage')",
      "expect(localBug.failureKind).toBe('local-bug')",
    ],
  ],
  ['core/__tests__/runtime/lifecycle/runtime-import-readiness.test.ts', ['runtime import readiness gate', 'fatal: true']],
  [
    'core/__tests__/operations/health/health-redaction.test.ts',
    ['public aggregated health strips child process ids', 'Latest /api/health child refresh window'],
  ],
  ['core/__tests__/operations/health/prod-health-smoke.test.ts', ['getFatalHealthFailures']],
  [
    'core/__tests__/registration/invariants/entity-factory-logging.test.ts',
    ['lazy entity creation uses structured logging without direct console output', 'entity.factory'],
  ],
  [
    'core/__tests__/entity/consensus/invariants/entity-consensus-logging.test.ts',
    ['entity consensus core uses structured logging only', 'frame.profile'],
  ],
  [
    'core/__tests__/runtime/ingress/runtime-entity-input-logging.test.ts',
    ['runtime entity input j-output collection logs stay behind structured debug logging', 'inputs.profile'],
  ],
  [
    'core/__tests__/entity/boundaries/entity-input-merge.test.ts',
    ['uses structured logging without direct console output', 'entity.input.merge'],
  ],
  ['core/__tests__/payments/settlement/settlement-ops.test.ts', ['SETTLEMENT_UNKNOWN_OP_TYPE', 'without console substitution']],
  [
    'core/__tests__/account/transactions/account-followup-logging.test.ts',
    ['account committed followups use structured logging only', 'account.followup'],
  ],
  [
    'core/__tests__/account/consensus/logging/account-consensus-logging.test.ts',
    ['account consensus core uses structured logging only', 'frame.state_root_mismatch'],
  ],
  [
    'core/__tests__/account/consensus/logging/account-propose-logging.test.ts',
    ['account frame proposal path uses structured logging only', 'proposal.profile'],
  ],
  [
    'core/__tests__/finance/state/debt-ledger.test.ts',
    ['debt ledger divergence without direct console warning', 'DEBT_LEDGER_DIVERGENCE'],
  ],
  ['core/__tests__/architecture/state/validation-utils.test.ts', ['validateAccountDeltas fails loud', 'ACCOUNT_DELTAS_MISSING']],
  [
    'core/__tests__/network/relay/relay-router.test.ts',
    ['relay router and local delivery verbose diagnostics use structured logging', 'relay.local_delivery'],
  ],
  [
    'core/__tests__/runtime/transport/runtime-ws-recovery.test.ts',
    ['standalone relay uses structured startup logging', 'relay.standalone'],
  ],
  [
    'core/__tests__/runtime/observability/solvency-logging.test.ts',
    ['solvency diagnostics use structured logging only', 'runtime.solvency'],
  ],
  [
    'core/__tests__/storage/runtime/runtime-storage-logging.test.ts',
    ['runtime storage DB boundary uses structured logging without direct console output', 'runtime.storage'],
  ],
  [
    'core/__tests__/security/watchtower/watchtower-standalone.test.ts',
    ['uses structured logging without direct console output', 'watchtower.standalone'],
  ],
  [
    'core/__tests__/security/dispute/push-dispute-wake.test.ts',
    ['uses structured logging without direct console output', 'watchtower.dispute_watch'],
  ],
  [
    'core/__tests__/orchestrator/process/orchestrator-lifecycle-logging.test.ts',
    ['orchestrator lifecycle helpers use structured logging without direct console output', 'orchestrator.lifecycle'],
  ],
  [
    'core/__tests__/network/jurisdiction/jurisdiction-config-logging.test.ts',
    ['jurisdiction config loader uses structured logging without direct console output', 'runtime.jurisdiction_config'],
  ],
  [
    'core/__tests__/network/jurisdiction/jurisdiction-loader-logging.test.ts',
    ['jurisdiction loader diagnostics', 'runtime.jurisdiction_loader'],
  ],
  [
    'core/__tests__/api/server/external-wallet-api.test.ts',
    ['external wallet API uses structured logging instead of raw console output', 'server.external_wallet'],
  ],
  [
    'core/__tests__/radapter.test.ts',
    ['runtime adapter server diagnostics use structured logging only', 'runtime.radapter'],
  ],
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
  'External wallet/faucet diagnostics use the structured',
  'Runtime adapter oversized-response diagnostics use the structured',
  'Runtime-import manifest refresh failures use structured',
  'Market snapshot enrichment failures use structured',
  'Orchestrator child stop timeout and unexpected child exit diagnostics use',
  'Orchestrator custody bootstrap, SIGTERM-during-reset, and initial reset',
  'Hub admin URL diagnostics use structured',
  'Hub/MM normal startup diagnostics use structured',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('runtime failure taxonomy scan check passed');
