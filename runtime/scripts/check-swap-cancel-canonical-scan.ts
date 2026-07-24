#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

const readText = (path: string): string => readFileSync(path, 'utf8');

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotIncludes = (text: string, needle: string, path: string): void => {
  if (text.includes(needle)) throw new Error(`${path} contains forbidden text: ${needle}`);
};

const entityTypesPath = 'runtime/types/entity-tx.ts';
const entityTypes = readText(entityTypesPath);
assertIncludes(entityTypes, "type: 'proposeCancelSwap';", entityTypesPath);
assertNotIncludes(entityTypes, "type: 'cancelSwap';", entityTypesPath);
assertNotIncludes(entityTypes, "type: 'cancelSwapOffer';", entityTypesPath);

const applyPath = 'runtime/entity/tx/apply.ts';
const apply = readText(applyPath);
assertIncludes(apply, 'proposeCancelSwap: (_env, state, tx, options) => handleCancelSwapRequest', applyPath);
assertNotIncludes(apply, 'cancelSwapOffer:', applyPath);
assertNotIncludes(apply, 'cancelSwap:', applyPath);

const handlerPath = 'runtime/entity/tx/handlers/swap-requests.ts';
const handler = readText(handlerPath);
assertIncludes(handler, "Extract<EntityTx, { type: 'proposeCancelSwap' }>", handlerPath);
assertIncludes(handler, 'const requireSwapAccount =', handlerPath);
assertIncludes(handler, 'SWAP_REQUEST_ACCOUNT_MISSING:${action}', handlerPath);
assertNotIncludes(handler, "'cancelSwapOffer' | 'cancelSwap' | 'proposeCancelSwap'", handlerPath);
assertNotIncludes(handler, 'console.error', handlerPath);
assertNotIncludes(handler, 'return { newState: entityState, outputs: [] };', handlerPath);

const invariantPath = 'runtime/entity/tx/invariant-errors.ts';
const invariant = readText(invariantPath);
assertIncludes(invariant, "'SWAP_REQUEST_',", invariantPath);

const frontendPath = 'frontend/src/lib/components/Entity/SwapPanel.svelte';
const frontend = readText(frontendPath);
assertIncludes(frontend, "type: 'proposeCancelSwap'", frontendPath);
assertIncludes(frontend, 'activeXlnFunctions.planSwapCommand({', frontendPath);
assertIncludes(frontend, 'await submitRuntimeInput(commandPlan.runtimeInput);', frontendPath);
assertIncludes(frontend, 'await waitForCrossTargetCapacity(', frontendPath);
assertIncludes(frontend, 'await submitActiveCrossJurisdictionIntent(commandPlan.crossJurisdictionIntent);', frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwap'", frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwapOffer'", frontendPath);
assertNotIncludes(frontend, 'buildDeterministicSwapOfferId', frontendPath);
assertNotIncludes(frontend, 'satisfies CrossJurisdictionSwapRoute', frontendPath);

const commandPlanPath = 'runtime/account/swap-command-plan.ts';
const commandPlan = readText(commandPlanPath);
assertIncludes(commandPlan, 'readSwapAccountCapacity({', commandPlanPath);
assertIncludes(commandPlan, 'planSwapInboundCapacity({', commandPlanPath);
assertIncludes(commandPlan, 'assertCrossJurisdictionSwapTargetReadyInEnv', commandPlanPath);
const commandRoutePath = 'runtime/account/swap-command-route.ts';
assertIncludes(readText(commandRoutePath), 'withCanonicalCrossJurisdictionRouteHash({', commandRoutePath);

const activityPath = 'runtime/api/activity-history.ts';
const activity = readText(activityPath);
assertIncludes(activity, "case 'cancelSwap':", activityPath);
assertIncludes(activity, "case 'cancelSwapOffer':", activityPath);
assertIncludes(activity, "case 'proposeCancelSwap':", activityPath);

const regressionPath = 'runtime/__tests__/audit-failfast-regressions.test.ts';
const regression = readText(regressionPath);
assertIncludes(regression, 'swap requests fail loud when the target account is missing', regressionPath);
assertIncludes(regression, "rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:placeSwapOffer')", regressionPath);
assertIncludes(regression, "rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:resolveSwap')", regressionPath);
assertIncludes(regression, "rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:proposeCancelSwap')", regressionPath);

console.log('swap cancel canonical scan check passed');
