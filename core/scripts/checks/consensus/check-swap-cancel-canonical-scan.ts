#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';

const readText = (path: string): string => {
  if (path !== 'core/__tests__/audit-failfast-regressions.test.ts') return readFileSync(path, 'utf8');
  return [
    'core/__tests__/testing/audit/audit-failfast-regressions-part-1.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-2.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-3.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-4.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-5.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-6.test.ts',
  ].map(file => readFileSync(file, 'utf8')).join('\n');
};

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) throw new Error(`${path} contains forbidden text: ${needle}`);
};

const entityTypesPath = 'core/types/entity-tx.ts';
const entityTypes = readText(entityTypesPath);
const retiredResolve = ['resolve', 'Swap'].join('');
assertIncludes(entityTypes, "type: 'placeSwapOffer';", entityTypesPath);
assertIncludes(entityTypes, "type: 'proposeCancelSwap';", entityTypesPath);
assertNotIncludes(entityTypes, `type: '${retiredResolve}';`, entityTypesPath);
assertNotIncludes(entityTypes, "type: 'cancelSwap';", entityTypesPath);
assertNotIncludes(entityTypes, "type: 'cancelSwapOffer';", entityTypesPath);

const applyPath = 'core/entity/tx/apply.ts';
const apply = readText(applyPath);
assertIncludes(apply, 'placeSwapOffer: (_env, state, tx, options) => handlePlaceSwapOfferRequest', applyPath);
assertIncludes(apply, 'proposeCancelSwap: (_env, state, tx, options) => handleCancelSwapRequest', applyPath);
assertNotIncludes(apply, `${retiredResolve}:`, applyPath);
assertNotIncludes(apply, 'cancelSwapOffer:', applyPath);
assertNotIncludes(apply, 'cancelSwap:', applyPath);

const handlerPath = 'core/entity/tx/handlers/payments/swap-requests.ts';
const handler = readText(handlerPath);
assertIncludes(handler, "Extract<EntityTx, { type: 'proposeCancelSwap' }>", handlerPath);
assertIncludes(handler, 'const requireSwapAccount =', handlerPath);
assertIncludes(handler, 'SWAP_REQUEST_ACCOUNT_MISSING:${action}', handlerPath);
assertNotIncludes(handler, `Extract<EntityTx, { type: '${retiredResolve}' }>`, handlerPath);
assertNotIncludes(handler, "'cancelSwapOffer' | 'cancelSwap' | 'proposeCancelSwap'", handlerPath);
assertNotIncludes(handler, 'console.error', handlerPath);
assertNotIncludes(handler, 'return { newState: entityState, outputs: [] };', handlerPath);
assertIncludes(handler, 'throw haltRuntimeFailure(', handlerPath);

const frontendPath = 'frontend/src/lib/components/Entity/swap/SwapPanel.svelte';
const frontend = readText(frontendPath);
assertIncludes(frontend, "type: 'proposeCancelSwap'", frontendPath);
assertIncludes(frontend, 'activeXlnFunctions.planSwapCommand({', frontendPath);
assertIncludes(frontend, 'await submitRuntimeInput(commandPlan.runtimeInput);', frontendPath);
assertIncludes(frontend, 'await submitActiveCrossJurisdictionIntent(commandPlan.crossJurisdictionIntent, {', frontendPath);
assertNotIncludes(frontend, 'waitForCrossTargetCapacity', frontendPath);
assertNotIncludes(frontend, 'SWAP_CROSS_TARGET_SETUP_COMMIT_TIMEOUT', frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwap'", frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwapOffer'", frontendPath);
assertNotIncludes(frontend, 'buildDeterministicSwapOfferId', frontendPath);
assertNotIncludes(frontend, 'satisfies CrossJurisdictionSwapRoute', frontendPath);

const commandPlanPath = 'core/runtime/swap-cmd/swap-command-plan.ts';
const commandPlan = readText(commandPlanPath);
assertIncludes(commandPlan, 'readSwapAccountCapacity({', commandPlanPath);
assertIncludes(commandPlan, 'planSwapInboundCapacity({', commandPlanPath);
const targetReadinessPath = 'core/runtime/swap-cmd/swap-target-readiness.ts';
assertIncludes(
  readText(targetReadinessPath),
  'assertCrossJurisdictionSwapTargetReadyInEnv',
  targetReadinessPath,
);
const commandRoutePath = 'core/account/swap/swap-command-route.ts';
assertIncludes(readText(commandRoutePath), 'withCanonicalCrossJurisdictionRouteHash({', commandRoutePath);

const activityPath = 'core/api/public/activity-history.ts';
const activity = readText(activityPath);
assertIncludes(activity, "case 'swap_resolve':", activityPath);
assertIncludes(activity, "case 'proposeCancelSwap':", activityPath);
assertNotIncludes(activity, `case '${retiredResolve}':`, activityPath);

const regressionPath = 'core/__tests__/audit-failfast-regressions.test.ts';
const regression = readText(regressionPath);
assertIncludes(regression, 'swap requests fail loud when the target account is missing', regressionPath);
assertIncludes(regression, "rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:placeSwapOffer')", regressionPath);
assertIncludes(regression, "rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:proposeCancelSwap')", regressionPath);

const sameOrderbookDirectory = 'core/entity/tx/handlers/account/orderbook/same';
const sameOrderbookFiles = readdirSync(sameOrderbookDirectory)
  .filter(file => file.endsWith('.ts'))
  .sort();
for (const file of sameOrderbookFiles) {
  const path = `${sameOrderbookDirectory}/${file}`;
  const source = readText(path);
  if (file === 'pass.ts') {
    assertIncludes(source, 'queueUniqueSwapResolveForEntityState', path);
    assertIncludes(source, 'suspendedSameOrderIds.add(', path);
    continue;
  }
  assertNotIncludes(source, 'queueUniqueSwapResolveForEntityState', path);
  assertNotIncludes(source, 'suspendedSameOrderIds.add(', path);
}

console.log('swap cancel canonical scan check passed');
