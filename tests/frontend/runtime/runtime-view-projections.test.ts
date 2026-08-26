import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeViewProjectionReader,
  type RuntimeViewProjectionQuery,
} from '../../../frontend/packages/runtime-client/src/runtime-view-projections';
import type {
  RuntimeViewFrameModel,
} from '../../../frontend/packages/runtime-client/src/runtime-view-model';

type TestFrame = RuntimeViewFrameModel & { tag: string };
type TestAccount = { accountId: string };
type TestHistory = { items: string[] };

const projectedFrame = (
  activeEntityId: string | null = '0xentity-a',
): TestFrame => ({
  tag: 'frame',
  activeEntityId,
  activeEntity: null,
});

const createHarness = () => {
  let atHeight: number | null = null;
  let frame = projectedFrame();
  const viewQueries: RuntimeViewProjectionQuery[] = [];
  const accountReads: Array<[string, string, RuntimeViewProjectionQuery]> = [];
  const historyReads: Array<[string, string, RuntimeViewProjectionQuery]> = [];
  const reader = new RuntimeViewProjectionReader<TestFrame, TestAccount, TestHistory>({
    readAtHeight: () => atHeight,
    readViewFrame: async (query) => {
      viewQueries.push(query);
      return frame;
    },
    readAccount: async (entityId, counterpartyId, query) => {
      accountReads.push([entityId, counterpartyId, query]);
      return { accountId: counterpartyId };
    },
    readSwapHistory: async (entityId, counterpartyId, query) => {
      historyReads.push([entityId, counterpartyId, query]);
      return { items: [counterpartyId] };
    },
  });
  return {
    reader,
    viewQueries,
    accountReads,
    historyReads,
    setAtHeight: (next: number | null) => { atHeight = next; },
    setFrame: (next: TestFrame) => { frame = next; },
  };
};

const entityFrame = (
  summaryId?: string,
  coreId?: string,
): TestFrame => ({
  tag: 'frame',
  activeEntityId: null,
  activeEntity: {
    ...(summaryId === undefined ? {} : { summary: { entityId: summaryId } }),
    ...(coreId === undefined ? {} : { core: { entityId: coreId } }),
    accounts: { items: [] },
    books: { items: [] },
  },
});

describe('runtime-client RuntimeView projection reader', () => {
  test('rejects a missing Entity id before issuing a projection read', async () => {
    const harness = createHarness();

    await expect(harness.reader.readEntityFrame('  '))
      .rejects.toThrow('RUNTIME_ENTITY_PROJECTION_ID_MISSING');
    expect(harness.viewQueries).toEqual([]);
  });

  test('normalizes a live Entity read and applies bounded page limits', async () => {
    const harness = createHarness();

    expect(await harness.reader.readEntityFrame(' 0xENTITY-A ')).toEqual(projectedFrame());
    expect(harness.viewQueries).toEqual([{
      entityId: '0xentity-a',
      accountsLimit: 10,
      booksLimit: 10,
    }]);
  });

  test('pins Entity reads to the selected historical height', async () => {
    const harness = createHarness();
    harness.setAtHeight(7);
    harness.setFrame(entityFrame(' 0xENTITY-A '));

    await harness.reader.readEntityFrame('0xentity-a');
    expect(harness.viewQueries[0]).toEqual({
      entityId: '0xentity-a',
      accountsLimit: 10,
      booksLimit: 10,
      atHeight: 7,
    });
  });

  test('accepts the projected Entity from the frame core fallback', async () => {
    const harness = createHarness();
    harness.setFrame(entityFrame(undefined, ' 0xENTITY-A '));

    expect((await harness.reader.readEntityFrame('0xentity-a')).tag).toBe('frame');
  });

  test('rejects a frame for a different projected Entity', async () => {
    const harness = createHarness();
    harness.setFrame(projectedFrame('0xentity-b'));

    await expect(harness.reader.readEntityFrame('0xentity-a')).rejects.toThrow(
      'RUNTIME_ENTITY_PROJECTION_MISMATCH:0xentity-a:0xentity-b',
    );
  });

  test('reports missing projected Entity evidence explicitly', async () => {
    const harness = createHarness();
    harness.setFrame(projectedFrame(null));

    await expect(harness.reader.readEntityFrame('0xentity-a')).rejects.toThrow(
      'RUNTIME_ENTITY_PROJECTION_MISMATCH:0xentity-a:missing',
    );
  });

  test('rejects incomplete Account identity before issuing a read', async () => {
    const harness = createHarness();

    await expect(harness.reader.readAccount('', '0xpeer'))
      .rejects.toThrow('RUNTIME_ACCOUNT_PROJECTION_ID_MISSING');
    await expect(harness.reader.readAccount('0xentity-a', ''))
      .rejects.toThrow('RUNTIME_ACCOUNT_PROJECTION_ID_MISSING');
    expect(harness.accountReads).toEqual([]);
  });

  test('normalizes and height-scopes an Account projection read', async () => {
    const harness = createHarness();
    harness.setAtHeight(9);

    expect(await harness.reader.readAccount(' 0xENTITY-A ', ' 0xPEER '))
      .toEqual({ accountId: '0xpeer' });
    expect(harness.accountReads).toEqual([[
      '0xentity-a',
      '0xpeer',
      { atHeight: 9 },
    ]]);
  });

  test('bounds swap history and carries only an explicit cursor', async () => {
    const harness = createHarness();
    await expect(harness.reader.readSwapHistory('', '0xpeer', null))
      .rejects.toThrow('RUNTIME_SWAP_HISTORY_ID_MISSING');

    expect(await harness.reader.readSwapHistory('0xENTITY-A', '0xPEER', null))
      .toEqual({ items: ['0xpeer'] });
    harness.setAtHeight(11);
    await harness.reader.readSwapHistory('0xentity-a', '0xpeer', 'next-page');
    expect(harness.historyReads).toEqual([
      ['0xentity-a', '0xpeer', { limit: 100 }],
      ['0xentity-a', '0xpeer', { cursor: 'next-page', limit: 100, atHeight: 11 }],
    ]);
  });

  test('keeps the concrete query client and active view in the Svelte adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-projections.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeQueryClient');
    expect(boundary).not.toContain('writable');
    expect(store).toContain('new RuntimeViewProjectionReader<');
    expect(store).toContain('readAtHeight: () => get(runtimeView).atHeight');
    expect(store).toContain('runtimeViewProjectionReader.readEntityFrame(entityId)');
    expect(store).toContain('runtimeViewProjectionReader.readAccount(');
    expect(store).toContain('runtimeViewProjectionReader.readSwapHistory(');
    expect(store).not.toContain('RUNTIME_ENTITY_PROJECTION_MISMATCH:');
    expect(store).not.toContain('RUNTIME_SWAP_HISTORY_ID_MISSING');
  });
});
