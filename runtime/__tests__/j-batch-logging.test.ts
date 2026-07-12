import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { handleCreateSettlement } from '../entity/tx/handlers/create-settlement';
import { handleMintReserves } from '../entity/tx/handlers/mint-reserves';
import { handleR2R } from '../entity/tx/handlers/r2r';
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
  jBlockObservations: [],
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
  pendingSwapFillRatios: new Map(),
});

test('j-batch success-path logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/j-batch.ts'), 'utf8');

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

  const settlementTx = {
    type: 'createSettlement',
    data: {
      counterpartyEntityId: counterpartyId,
      diffs: [{ tokenId: 1, leftDiff: -1n, rightDiff: 1n, collateralDiff: 0n, ondeltaDiff: 0n }],
      sig: '0x1234',
    },
  } satisfies EntityTx;
  const settlementResult = await handleCreateSettlement(makeEntityState(), settlementTx);
  const settlement = settlementResult.newState.jBatchState?.batch.settlements[0];
  expect(settlement?.leftEntity).toBe(entityId);
  expect(settlement?.rightEntity).toBe(counterpartyId);
  expect(settlement?.diffs).toHaveLength(1);
  expect(settlement?.sig).toBe('0x1234');

  const mintTx = { type: 'mintReserves', data: { tokenId: 1, amount: 5n } } satisfies EntityTx;
  const mintResult = await handleMintReserves(makeEntityState(), mintTx, {} as Env);
  expect(mintResult.jOutputs).toEqual([]);
  expect(mintResult.newState.messages.at(-1)).toContain('Jurisdiction unavailable for mint');
});

test('entity j-batch operation handlers stay behind structured logging', () => {
  for (const path of [
    'runtime/entity/tx/handlers/r2r.ts',
    'runtime/entity/tx/handlers/create-settlement.ts',
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
