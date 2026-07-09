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

const applyPath = 'runtime/entity-tx/apply.ts';
const apply = readText(applyPath);
assertIncludes(apply, 'proposeCancelSwap: (_env, state, tx, options) => handleCancelSwapRequest', applyPath);
assertNotIncludes(apply, 'cancelSwapOffer:', applyPath);
assertNotIncludes(apply, 'cancelSwap:', applyPath);

const handlerPath = 'runtime/entity-tx/handlers/swap-requests.ts';
const handler = readText(handlerPath);
assertIncludes(handler, "Extract<EntityTx, { type: 'proposeCancelSwap' }>", handlerPath);
assertNotIncludes(handler, "'cancelSwapOffer' | 'cancelSwap' | 'proposeCancelSwap'", handlerPath);

const frontendPath = 'frontend/src/lib/components/Entity/SwapPanel.svelte';
const frontend = readText(frontendPath);
assertIncludes(frontend, "type: 'proposeCancelSwap'", frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwap'", frontendPath);
assertNotIncludes(frontend, "type: 'cancelSwapOffer'", frontendPath);

const activityPath = 'runtime/activity-history.ts';
const activity = readText(activityPath);
assertIncludes(activity, "case 'cancelSwap':", activityPath);
assertIncludes(activity, "case 'cancelSwapOffer':", activityPath);
assertIncludes(activity, "case 'proposeCancelSwap':", activityPath);

console.log('swap cancel canonical scan check passed');
