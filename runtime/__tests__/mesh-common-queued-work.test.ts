import { describe, expect, test } from 'bun:test';
import { hasQueuedExtendCredit, hasQueuedOpenAccount } from '../orchestrator/mesh-common';
import type { Env } from '../types';

const entityId = '0x1111111111111111111111111111111111111111111111111111111111111111';
const counterpartyId = '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('mesh queued work detection', () => {
  test('treats openAccount queued in runtime mempool as pending work', () => {
    const env = {
      runtimeMempool: {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entityTxs: [{
            type: 'openAccount',
            data: {
              targetEntityId: counterpartyId,
              tokenId: 1,
              creditAmount: 100n,
            },
          }],
        }],
      },
      eReplicas: new Map(),
    } as unknown as Env;

    expect(hasQueuedOpenAccount(env, entityId, counterpartyId)).toBe(true);
    expect(hasQueuedOpenAccount(env, entityId, `${counterpartyId.slice(0, -1)}3`)).toBe(false);
  });

  test('treats extendCredit queued in runtime mempool as pending work', () => {
    const env = {
      runtimeMempool: {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entityTxs: [{
            type: 'extendCredit',
            data: {
              counterpartyEntityId: counterpartyId,
              tokenId: 2,
              amount: '1000',
            },
          }],
        }],
      },
      eReplicas: new Map(),
    } as unknown as Env;

    expect(hasQueuedExtendCredit(env, entityId, counterpartyId, 2, 1000n)).toBe(true);
    expect(hasQueuedExtendCredit(env, entityId, counterpartyId, 2, 1001n)).toBe(false);
    expect(hasQueuedExtendCredit(env, entityId, counterpartyId, 3, 1000n)).toBe(false);
  });
});
