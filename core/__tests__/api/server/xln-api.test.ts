import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as runtime from '../../../runtime';
import { isXLNModuleLoaded } from '../../../api/public/runtime-module-guard';

describe('browser runtime API boundary', () => {
  test('accepts the actual runtime module', () => {
    expect(isXLNModuleLoaded(runtime)).toBe(true);
  });

  test('rejects a runtime module with a missing bootstrap function', () => {
    expect(isXLNModuleLoaded({
      ...runtime,
      enqueueRuntimeInput: undefined,
    })).toBe(false);
  });

  test('retired convenience exports and handwritten public types stay absent', () => {
    const retiredRuntimeExports = [
      'CHAIN_IDS',
      'XLN_COORDINATOR',
      'createLazyJId',
      'createLocalUri',
      'createProfileUpdateTx',
      'deriveSignerKey',
      'entityIdsEqual',
      'extractProvider',
      'formatEntityIdDisplay',
      'formatOrderbook',
      'formatSummary',
      'isDelta',
      'jIdFromChainId',
      'queueEntityInput',
    ] as const;
    for (const exportName of retiredRuntimeExports) {
      expect(exportName in runtime).toBe(false);
    }

    const runtimeModuleSource = readFileSync('core/api/public/runtime-module.ts', 'utf8');
    for (const retiredType of [
      'AccountSnapshot',
      'CompletedBatch',
      'DebtStatus',
      'LoadEnvFromDbOptions',
      'QueueEntityInputPayload',
      'SignerDisplayInfo',
      'VerifyRuntimeChainResult',
    ]) {
      expect(runtimeModuleSource).not.toContain(retiredType);
    }
  });
});
