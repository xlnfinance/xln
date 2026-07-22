import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyEntityTx } from '../entity/tx/apply';
import { handleMintReserves } from '../entity/tx/handlers/mint-reserves';
import { handleR2R } from '../entity/tx/handlers/r2r';
import { cloneJBatch, initJBatch } from '../jurisdiction/batch';
import { createEmptyEnv } from '../runtime';
import { hydrateEntityStateFromStorage } from '../storage/hydration';
import { projectEntityCoreDoc } from '../storage/projections';
import type { EntityState, EntityTx, Env } from '../types';

const entityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'bb'.repeat(32)}`;

const makeEntityState = (): EntityState => ({
  entityId,
  height: 0,
  timestamp: 123,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['signer'],
    shares: { signer: 1n },
    threshold: 1n,
  },
  reserves: new Map([[1, 100n]]),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `0x${'11'.repeat(32)}`,
  entityEncPrivKey: `0x${'22'.repeat(32)}`,
  profile: {
    name: 'JBatch Test Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
});

test('j-batch success-path logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/jurisdiction/batch.ts'), 'utf8');

  expect(source).toContain("const jBatchLog = createStructuredLogger('j.batch');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('jBatchLog.debug');
});

test('entity j-batch operation handler state transitions are unchanged', async () => {
  const r2rTx = {
    type: 'r2r',
    data: { toEntityId: counterpartyId, tokenId: 1, amount: 10n },
  } satisfies EntityTx;
  const r2rResult = await handleR2R(makeEntityState(), r2rTx);
  expect(r2rResult.newState.jBatchState?.batch.reserveToReserve).toEqual([{
    receivingEntity: counterpartyId,
    tokenId: 1,
    amount: 10n,
  }]);

  const mintTx = { type: 'mintReserves', data: { tokenId: 1, amount: 5n } } satisfies EntityTx;
  const mintResult = await handleMintReserves(makeEntityState(), mintTx, {} as Env);
  expect(mintResult.jOutputs).toEqual([]);
  expect(mintResult.newState.messages.at(-1)).toContain('Jurisdiction unavailable for mint');
});

test('removed legacy settlement commands cannot mutate the jurisdiction batch', async () => {
  const entityTxSource = readFileSync(join(process.cwd(), 'runtime/types/entity-tx.ts'), 'utf8');
  const dispatcherSource = readFileSync(join(process.cwd(), 'runtime/entity/tx/apply.ts'), 'utf8');
  expect(entityTxSource).not.toContain("type: 'createSettlement'");
  expect(entityTxSource).not.toContain("type: 'settleDiffs'");
  expect(dispatcherSource).not.toContain('createSettlement:');
  expect(dispatcherSource).not.toContain('settleDiffs:');

  for (const type of ['createSettlement', 'settleDiffs'] as const) {
    const state = makeEntityState();
    state.jBatchState = initJBatch();
    const before = cloneJBatch(state.jBatchState.batch);
    const rawLegacyTx = {
      type,
      data: {
        counterpartyEntityId: counterpartyId,
        diffs: [{ tokenId: 1, leftDiff: -1n, rightDiff: 1n, collateralDiff: 0n, ondeltaDiff: 0n }],
        sig: '0x1234',
      },
    } as unknown as EntityTx;

    const result = await applyEntityTx(createEmptyEnv(`legacy-${type}`), state, rawLegacyTx);

    expect(result.skippedError).toBe(`ENTITY_TX_UNHANDLED: type=${type}`);
    expect(result.newState.jBatchState?.batch).toEqual(before);
  }
});

test('storage restore rejects an oversized settlement forgiveness list', () => {
  const state = makeEntityState();
  state.jBatchState = initJBatch();
  state.jBatchState.batch.settlements.push({
    leftEntity: entityId,
    rightEntity: counterpartyId,
    diffs: [],
    forgiveDebtsInTokenIds: Array.from({ length: 33 }, (_, index) => index + 1),
    sig: '0x1234',
    entityProvider: `0x${'11'.repeat(20)}`,
    hankoData: '0x',
    nonce: 1,
  });

  expect(() => hydrateEntityStateFromStorage({
    core: projectEntityCoreDoc(state),
    accounts: new Map(),
    books: new Map(),
  })).toThrow(
    'J_BATCH_LIMIT_EXCEEDED: storage.entity.jBatchState.batch: '
    + 'settlements[0].forgiveDebtsInTokenIds 33/32',
  );
});

test('entity j-batch operation handlers stay behind structured logging', () => {
  for (const path of [
    'runtime/entity/tx/handlers/r2r.ts',
    'runtime/entity/tx/handlers/mint-reserves.ts',
    'runtime/entity/tx/handlers/j-broadcast.ts',
    'runtime/entity/tx/handlers/j-clear-batch.ts',
    'runtime/entity/tx/handlers/j-abort-sent-batch.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).toContain("createStructuredLogger('entity.jbatch')");
    expect(source).not.toContain('console.');
    expect(source).toContain('jBatchActionLog.');
  }
});

test('r2c handler traces stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/r2c.ts'), 'utf8');

  expect(source).toContain("const r2cLog = createStructuredLogger('entity.r2c');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('r2cLog.debug');
});

test('htlc payment handler traces stay behind structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/htlc-payment.ts'), 'utf8');

  expect(source).toContain("const htlcLog = createStructuredLogger('entity.htlc');");
  expect(source).not.toContain('console.');
  expect(source).toContain('htlcLog.debug');
  expect(source).toContain('htlcLog.error');
});

test('dispute handler traces stay behind structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/dispute.ts'), 'utf8');

  expect(source).toContain("const disputeLog = createStructuredLogger('entity.dispute');");
  expect(source).not.toContain('console.');
  expect(source).toContain('disputeLog.debug');
  expect(source).toContain('disputeLog.error');
  expect(source).toContain('disputeLog.warn');
});
