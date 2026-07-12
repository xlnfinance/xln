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
  "meshLog.warn('runtime_import_manifest.refresh_failed'",
  "meshLog.warn('market_snapshot.enrichment_unavailable'",
  "meshLog.warn('child.stop_timeout_sigkill'",
  "meshLog.error('child.unexpected_exit'",
  "meshLog.error('child.unexpected_exit.stop_failed'",
  "meshLog.error('custody.bootstrap_failed'",
  "meshLog.warn('reset.sigterm_during_reset'",
  "meshLog.error('reset.initial_failed'",
  'classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason)',
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

const hubNodePath = 'runtime/orchestrator/hub-node.ts';
const hubNode = readText(hubNodePath);
for (const marker of [
  "createStructuredLogger('mesh.hub'",
  "nodeLog.info('signer_keys.prewarmed'",
  "nodeLog.info('dev_bootstrap.storage_disabled'",
  "nodeLog.info('faucet_provision.ready'",
  "nodeLog.info('runtime.ready'",
  "nodeLog.info('inspect_url.ready'",
  "nodeLog.warn('inspect_url.unavailable'",
]) {
  assertIncludes(hubNode, marker, hubNodePath);
}
assertNotIncludes(hubNode, '[MESH-HUB] SIGNER_KEYS_PREWARMED', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] DEV_BOOTSTRAP_STORAGE_DISABLED', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] FAUCET_PROVISION_READY', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] READY', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] INSPECT_URL', hubNodePath);
assertNotIncludes(hubNode, '[MESH-HUB] INSPECT_URL_UNAVAILABLE', hubNodePath);

const marketMakerNodePath = 'runtime/orchestrator/mm-node.ts';
const marketMakerNode = readText(marketMakerNodePath);
for (const marker of [
  "createStructuredLogger('mesh.marketMaker'",
  "nodeLog.info('signer_keys.prewarmed'",
  "nodeLog.info('dev_bootstrap.storage_disabled'",
  "nodeLog.info('runtime.ready'",
  "nodeLog.info('offers.ready'",
]) {
  assertIncludes(marketMakerNode, marker, marketMakerNodePath);
}
assertNotIncludes(marketMakerNode, '[MESH-MM] SIGNER_KEYS_PREWARMED', marketMakerNodePath);
assertNotIncludes(marketMakerNode, 'Runtime storage disabled for rebuildable market-maker state', marketMakerNodePath);
assertNotIncludes(marketMakerNode, '[MESH-MM] RUNTIME_READY', marketMakerNodePath);
assertNotIncludes(marketMakerNode, '[MESH-MM] OFFERS_READY', marketMakerNodePath);

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
  ['runtime/api/external-wallet-api.ts', [
    "createStructuredLogger('server.external_wallet')",
    "faucet.erc20.failed",
    "snapshot.failed",
    "faucet.gas.failed",
  ]],
  ['runtime/entity/tx/invariant-errors.ts', ["'DIRECT_PAYMENT_',", "'SWAP_REQUEST_',"]],
  ['runtime/entity/tx/handlers/direct-payment.ts', [
    "createStructuredLogger('entity.payment')",
    'DIRECT_PAYMENT_${code}:${detail}',
    "'ROUTE_START_INVALID'",
    "'ROUTE_END_INVALID'",
    "'NEXT_HOP_ACCOUNT_MISSING'",
  ]],
  ['runtime/entity/tx/handlers/basic.ts', ["createStructuredLogger('entity.basic')"]],
  ['runtime/entity/tx/proposals.ts', ["createStructuredLogger('entity.basic')"]],
  ['runtime/entity-factory.ts', ["createStructuredLogger('entity.factory')", 'lazy.create', 'numbered.register_failed']],
  ['runtime/entity-consensus.ts', ["createStructuredLogger('entity')", 'frame.profile', 'frame.apply']],
  ['runtime/runtime-entity-inputs.ts', ["createStructuredLogger('runtime.entity_inputs')", 'inputs.profile', 'replay.merged_input']],
  ['runtime/runtime-input-queue.ts', ["createStructuredLogger('runtime.input_queue')", 'interesting_entity_inputs']],
  ['runtime/runtime-p2p-lifecycle.ts', ["createStructuredLogger('p2p.lifecycle')", 'detach.close_failed']],
  ['runtime/relay/standalone-server.ts', ["createStructuredLogger('relay.standalone')", 'service.listen']],
  ['runtime/entity/consensus/input-merge.ts', ["createStructuredLogger('entity.input.merge')", 'frame.conflict', 'duplicates.deduped']],
  ['runtime/entity/tx/handlers/account.ts', ["createStructuredLogger('account.handler')", 'ACCOUNT_INPUT_EMPTY']],
  ['runtime/entity/tx/handlers/open-account.ts', ["createStructuredLogger('account.open')"]],
  ['runtime/entity/tx/handlers/account/committed-frame-followups.ts', ["createStructuredLogger('account.followup')", 'frame.commit', 'frame.tx']],
  ['runtime/entity/tx/handlers/account/committed-htlc-followups.ts', ["createStructuredLogger('account.followup')", 'htlc.secret_check']],
  ['runtime/account-consensus.ts', ["createStructuredLogger('account')", 'frame.prev_hash_mismatch', 'frame.state_root_mismatch']],
  ['runtime/account/consensus/propose.ts', ["createStructuredLogger('account')", 'frame.validation_failed', 'proposal.profile']],
  ['runtime/account/tx/apply.ts', ["createStructuredLogger('account.tx')", 'account_frame.rejected']],
  ['runtime/entity/tx/handlers/account/orderbook-matching-same.ts', ["createStructuredLogger('orderbook.same')"]],
  ['runtime/runtime-tx-handlers.ts', ["createStructuredLogger('runtime.tx')", 'jurisdiction.import_failed', 'replica.wallet_registration_skipped']],
  ['runtime/entity/tx/handlers/r2r.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/create-settlement.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/mint-reserves.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/j-broadcast.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/j-clear-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/j-abort-sent-batch.ts', ["createStructuredLogger('entity.jbatch')"]],
  ['runtime/entity/tx/handlers/r2c.ts', ["createStructuredLogger('entity.r2c')"]],
  ['runtime/entity/tx/handlers/htlc-payment.ts', ["createStructuredLogger('entity.htlc')"]],
  ['runtime/entity/tx/handlers/dispute.ts', ["createStructuredLogger('entity.dispute')"]],
  ['runtime/entity/tx/handlers/settle.ts', ["createStructuredLogger('entity.settle')"]],
  ['runtime/entity/tx/j-events-debt.ts', ["createStructuredLogger('entity.debt')", 'ledger.divergence']],
  ['runtime/account-utils.ts', ["logDebug('ACCOUNT_STATE'", 'deriveDelta.return']],
  ['runtime/validation-utils.ts', ['ACCOUNT_DELTAS_MISSING', 'ACCOUNT_DELTAS_INVALID_TOKEN_ID']],
  ['runtime/runtime.ts', ["createStructuredLogger('runtime')", 'apply.profile', 'process.profile', 'joutbox.incoming']],
  ['runtime/runtime-infra.ts', ["createStructuredLogger('runtime.infra')", 'jadapter.restore_retry', 'browservm.restore_failed']],
  ['runtime/runtime-infra-gossip-store.ts', ["createStructuredLogger('runtime.infra_gossip')", 'profile.restore_failed']],
  ['runtime/runtime-storage-dbs.ts', ["createStructuredLogger('runtime.storage')", 'storage_db.blocked', 'runtime_db.open_failed']],
  ['runtime/storage/index.ts', ["createStructuredLogger('runtime.storage')", 'persist.frame']],
  ['runtime/watchtower/standalone-server.ts', ["createStructuredLogger('watchtower.standalone')", 'service.listen', 'sweep.failed', 'push_sweep.failed']],
  ['runtime/watchtower/dispute-watch.ts', ["createStructuredLogger('watchtower.dispute_watch')", 'target.failed']],
  ['runtime/orchestrator/graceful-server.ts', ["createStructuredLogger('orchestrator.lifecycle')", 'http.shutdown_timeout']],
  ['runtime/orchestrator/managed-runtime-leases.ts', ["createStructuredLogger('orchestrator.managed_leases')", 'stale_processes.kill', 'lease.unreadable_ignored']],
  ['runtime/orchestrator/parent-watch.ts', ["createStructuredLogger('orchestrator.parent_watch')", 'missing_parent_pid', 'parent_pid_missing']],
  ['runtime/jurisdiction-config.ts', ["createStructuredLogger('runtime.jurisdiction_config')", 'browser_api_unavailable', 'JURISDICTIONS_BROWSER_CONFIG_INVALID']],
  ['runtime/jurisdiction/jurisdiction-loader.ts', ["createStructuredLogger('runtime.jurisdiction_loader')", 'config_missing_using_defaults', 'DEFAULT_LAST_UPDATED']],
  ['runtime/radapter/server.ts', ["createStructuredLogger('runtime.radapter')", 'response_too_large']],
  ['runtime/orchestrator/proxy.ts', ['classifyRuntimeTransportFailure', 'failure,']],
  ['runtime/runtime-j-submit.ts', ["createStructuredLogger('runtime.jsubmit')", 'classifyRuntimeJBatchFailure', 'J_SUBMIT_TRANSIENT', 'J_SUBMIT_FATAL', 'tx.submit_failed']],
  ['runtime/orchestrator/market-maker-aggregated-health.ts', ['classifyRuntimeMarketMakerFailure', 'failure,']],
  ['runtime/delivery-result.ts', ['export type DeliveryResult', 'failure?: RuntimeFailureSignal', 'deliveryFailure']],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

const directPaymentHandlerPath = 'runtime/entity/tx/handlers/direct-payment.ts';
const directPaymentHandler = readText(directPaymentHandlerPath);
assertNotIncludes(directPaymentHandler, 'console.log', directPaymentHandlerPath);

const runtimeCorePath = 'runtime/runtime.ts';
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

const runtimeTxHandlersPath = 'runtime/runtime-tx-handlers.ts';
const runtimeTxHandlers = readText(runtimeTxHandlersPath);
assertNotIncludes(runtimeTxHandlers, 'console.', runtimeTxHandlersPath);

const runtimeJSubmitPath = 'runtime/runtime-j-submit.ts';
const runtimeJSubmit = readText(runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, 'console.', runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, '[J-SUBMIT]', runtimeJSubmitPath);
assertNotIncludes(runtimeJSubmit, '[SIDE-EFFECT]', runtimeJSubmitPath);

const runtimeInfraPath = 'runtime/runtime-infra.ts';
const runtimeInfra = readText(runtimeInfraPath);
assertNotIncludes(runtimeInfra, 'console.', runtimeInfraPath);

const runtimeInfraGossipPath = 'runtime/runtime-infra-gossip-store.ts';
const runtimeInfraGossip = readText(runtimeInfraGossipPath);
assertNotIncludes(runtimeInfraGossip, 'console.', runtimeInfraGossipPath);
assertNotIncludes(runtimeInfraGossip, '[infra-db]', runtimeInfraGossipPath);

const runtimeStorageDbsPath = 'runtime/runtime-storage-dbs.ts';
const runtimeStorageDbs = readText(runtimeStorageDbsPath);
assertNotIncludes(runtimeStorageDbs, 'console.', runtimeStorageDbsPath);
assertNotIncludes(runtimeStorageDbs, '[storage-epoch]', runtimeStorageDbsPath);

const runtimeStoragePath = 'runtime/storage/index.ts';
const runtimeStorage = readText(runtimeStoragePath);
assertNotIncludes(runtimeStorage, 'console.', runtimeStoragePath);
assertNotIncludes(runtimeStorage, '[PERSIST]', runtimeStoragePath);

const standaloneWatchtowerPath = 'runtime/watchtower/standalone-server.ts';
const standaloneWatchtower = readText(standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, 'console.', standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, '[WATCHTOWER] sweep', standaloneWatchtowerPath);
assertNotIncludes(standaloneWatchtower, '[PUSH-WATCH] sweep', standaloneWatchtowerPath);

const disputeWatchPath = 'runtime/watchtower/dispute-watch.ts';
const disputeWatch = readText(disputeWatchPath);
assertNotIncludes(disputeWatch, 'console.', disputeWatchPath);
assertNotIncludes(disputeWatch, '[PUSH-WATCH] target', disputeWatchPath);

for (const orchestratorLifecyclePath of [
  'runtime/orchestrator/graceful-server.ts',
  'runtime/orchestrator/managed-runtime-leases.ts',
  'runtime/orchestrator/parent-watch.ts',
]) {
  assertNotIncludes(readText(orchestratorLifecyclePath), 'console.', orchestratorLifecyclePath);
}

const jurisdictionConfigPath = 'runtime/jurisdiction-config.ts';
const jurisdictionConfig = readText(jurisdictionConfigPath);
assertNotIncludes(jurisdictionConfig, 'console.', jurisdictionConfigPath);

const jurisdictionLoaderPath = 'runtime/jurisdiction/jurisdiction-loader.ts';
const jurisdictionLoader = readText(jurisdictionLoaderPath);
assertNotIncludes(jurisdictionLoader, 'console.', jurisdictionLoaderPath);
assertNotIncludes(jurisdictionLoader, 'new Date()', jurisdictionLoaderPath);

const runtimeInputQueuePath = 'runtime/runtime-input-queue.ts';
const runtimeInputQueue = readText(runtimeInputQueuePath);
assertNotIncludes(runtimeInputQueue, 'console.', runtimeInputQueuePath);
assertNotIncludes(runtimeInputQueue, '[enqueueRuntimeInput]', runtimeInputQueuePath);

const runtimeP2PLifecyclePath = 'runtime/runtime-p2p-lifecycle.ts';
const runtimeP2PLifecycle = readText(runtimeP2PLifecyclePath);
assertNotIncludes(runtimeP2PLifecycle, 'console.', runtimeP2PLifecyclePath);

for (const relayLoggingPath of [
  'runtime/relay/router.ts',
  'runtime/relay/local-delivery.ts',
  'runtime/relay/standalone-server.ts',
]) {
  assertNotIncludes(readText(relayLoggingPath), 'console.', relayLoggingPath);
}
assertNotIncludes(readText('runtime/relay/standalone-server.ts'), '[WS] Runtime relay', 'runtime/relay/standalone-server.ts');

const solvencyPath = 'runtime/solvency.ts';
const solvency = readText(solvencyPath);
assertNotIncludes(solvency, 'console.', solvencyPath);

const r2cHandlerPath = 'runtime/entity/tx/handlers/r2c.ts';
const r2cHandler = readText(r2cHandlerPath);
assertNotIncludes(r2cHandler, 'console.log', r2cHandlerPath);

const basicHandlerPath = 'runtime/entity/tx/handlers/basic.ts';
const basicHandler = readText(basicHandlerPath);
assertNotIncludes(basicHandler, 'console.', basicHandlerPath);

const proposalHandlerPath = 'runtime/entity/tx/proposals.ts';
const proposalHandler = readText(proposalHandlerPath);
assertNotIncludes(proposalHandler, 'console.', proposalHandlerPath);

const entityFactoryPath = 'runtime/entity-factory.ts';
const entityFactory = readText(entityFactoryPath);
assertNotIncludes(entityFactory, 'console.', entityFactoryPath);

const entityInputMergePath = 'runtime/entity/consensus/input-merge.ts';
const entityInputMerge = readText(entityInputMergePath);
assertNotIncludes(entityInputMerge, 'console.', entityInputMergePath);

const entityConsensusPath = 'runtime/entity-consensus.ts';
const entityConsensus = readText(entityConsensusPath);
assertNotIncludes(entityConsensus, 'console.', entityConsensusPath);

const runtimeEntityInputsPath = 'runtime/runtime-entity-inputs.ts';
const runtimeEntityInputs = readText(runtimeEntityInputsPath);
assertNotIncludes(runtimeEntityInputs, 'console.', runtimeEntityInputsPath);

const accountHandlerPath = 'runtime/entity/tx/handlers/account.ts';
const accountHandler = readText(accountHandlerPath);
assertNotIncludes(accountHandler, 'console.', accountHandlerPath);

const openAccountHandlerPath = 'runtime/entity/tx/handlers/open-account.ts';
const openAccountHandler = readText(openAccountHandlerPath);
assertNotIncludes(openAccountHandler, 'console.', openAccountHandlerPath);

for (const accountFollowupPath of [
  'runtime/entity/tx/handlers/account/committed-frame-followups.ts',
  'runtime/entity/tx/handlers/account/committed-htlc-followups.ts',
]) {
  assertNotIncludes(readText(accountFollowupPath), 'console.', accountFollowupPath);
}

const accountTxApplyPath = 'runtime/account/tx/apply.ts';
const accountTxApply = readText(accountTxApplyPath);
assertNotIncludes(accountTxApply, 'console.', accountTxApplyPath);

const accountConsensusPath = 'runtime/account-consensus.ts';
const accountConsensus = readText(accountConsensusPath);
assertNotIncludes(accountConsensus, 'console.', accountConsensusPath);

const accountProposePath = 'runtime/account/consensus/propose.ts';
const accountPropose = readText(accountProposePath);
assertNotIncludes(accountPropose, 'console.', accountProposePath);

const sameOrderbookMatchingPath = 'runtime/entity/tx/handlers/account/orderbook-matching-same.ts';
const sameOrderbookMatching = readText(sameOrderbookMatchingPath);
assertNotIncludes(sameOrderbookMatching, 'console.', sameOrderbookMatchingPath);

const settlementOpsPath = 'runtime/settlement-ops.ts';
const settlementOps = readText(settlementOpsPath);
assertIncludes(settlementOps, 'SETTLEMENT_UNKNOWN_OP_TYPE', settlementOpsPath);
assertNotIncludes(settlementOps, 'console.', settlementOpsPath);

const externalWalletApiPath = 'runtime/api/external-wallet-api.ts';
const externalWalletApi = readText(externalWalletApiPath);
assertNotIncludes(externalWalletApi, 'console.', externalWalletApiPath);
assertNotIncludes(externalWalletApi, '[EXT-FAUCET/', externalWalletApiPath);
assertNotIncludes(externalWalletApi, '[EXT-WALLET/', externalWalletApiPath);

const runtimeAdapterServerPath = 'runtime/radapter/server.ts';
const runtimeAdapterServer = readText(runtimeAdapterServerPath);
assertNotIncludes(runtimeAdapterServer, 'console.', runtimeAdapterServerPath);
assertNotIncludes(runtimeAdapterServer, '[RADAPTER] RESPONSE_TOO_LARGE', runtimeAdapterServerPath);

for (const jBatchHandlerPath of [
  'runtime/entity/tx/handlers/r2r.ts',
  'runtime/entity/tx/handlers/create-settlement.ts',
  'runtime/entity/tx/handlers/mint-reserves.ts',
  'runtime/entity/tx/handlers/j-broadcast.ts',
  'runtime/entity/tx/handlers/j-clear-batch.ts',
  'runtime/entity/tx/handlers/j-abort-sent-batch.ts',
]) {
  assertNotIncludes(readText(jBatchHandlerPath), 'console.', jBatchHandlerPath);
}

const htlcPaymentHandlerPath = 'runtime/entity/tx/handlers/htlc-payment.ts';
const htlcPaymentHandler = readText(htlcPaymentHandlerPath);
assertNotIncludes(htlcPaymentHandler, 'console.', htlcPaymentHandlerPath);

const disputeHandlerPath = 'runtime/entity/tx/handlers/dispute.ts';
const disputeHandler = readText(disputeHandlerPath);
assertNotIncludes(disputeHandler, 'console.', disputeHandlerPath);

const settleHandlerPath = 'runtime/entity/tx/handlers/settle.ts';
const settleHandler = readText(settleHandlerPath);
assertNotIncludes(settleHandler, 'console.', settleHandlerPath);

const debtEventsPath = 'runtime/entity/tx/j-events-debt.ts';
const debtEvents = readText(debtEventsPath);
assertNotIncludes(debtEvents, 'console.', debtEventsPath);

const validationUtilsPath = 'runtime/validation-utils.ts';
const validationUtils = readText(validationUtilsPath);
assertNotIncludes(validationUtils, 'console.', validationUtilsPath);

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
  ['runtime/__tests__/account-consensus-logging.test.ts', ['account consensus core uses structured logging only', 'frame.state_root_mismatch']],
  ['runtime/__tests__/account-propose-logging.test.ts', ['account frame proposal path uses structured logging only', 'proposal.profile']],
  ['runtime/__tests__/debt-ledger.test.ts', ['debt ledger divergence without direct console warning', 'DEBT_LEDGER_DIVERGENCE']],
  ['runtime/__tests__/validation-utils.test.ts', ['validateAccountDeltas fails loud', 'ACCOUNT_DELTAS_MISSING']],
  ['runtime/__tests__/relay-router.test.ts', ['relay router and local delivery verbose diagnostics use structured logging', 'relay.local_delivery']],
  ['runtime/__tests__/runtime-ws-recovery.test.ts', ['standalone relay uses structured startup logging', 'relay.standalone']],
  ['runtime/__tests__/solvency-logging.test.ts', ['solvency diagnostics use structured logging only', 'runtime.solvency']],
  ['runtime/__tests__/runtime-storage-logging.test.ts', ['runtime storage DB boundary uses structured logging without direct console output', 'runtime.storage']],
  ['runtime/__tests__/watchtower-standalone.test.ts', ['uses structured logging without direct console output', 'watchtower.standalone']],
  ['runtime/__tests__/push-dispute-wake.test.ts', ['uses structured logging without direct console output', 'watchtower.dispute_watch']],
  ['runtime/__tests__/orchestrator-lifecycle-logging.test.ts', ['orchestrator lifecycle helpers use structured logging without direct console output', 'orchestrator.lifecycle']],
  ['runtime/__tests__/jurisdiction-config-logging.test.ts', ['jurisdiction config loader uses structured logging without direct console output', 'runtime.jurisdiction_config']],
  ['runtime/__tests__/jurisdiction-loader-logging.test.ts', ['jurisdiction loader diagnostics', 'runtime.jurisdiction_loader']],
  ['runtime/__tests__/external-wallet-api.test.ts', ['external wallet API uses structured logging instead of raw console output', 'server.external_wallet']],
  ['runtime/__tests__/radapter.test.ts', ['runtime adapter server diagnostics use structured logging only', 'runtime.radapter']],
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
  'Hub inspect URL diagnostics use structured',
  'Hub/MM normal startup diagnostics use structured',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('runtime failure taxonomy scan check passed');
