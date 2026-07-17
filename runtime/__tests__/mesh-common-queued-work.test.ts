import { describe, expect, test } from 'bun:test';
import {
  collectQueuedSwapOfferIds,
  hasPendingRuntimeWork,
  hasQueuedExtendCredit,
  hasQueuedOpenAccount,
  hasQueuedSwapOffer,
} from '../orchestrator/mesh-common';
import { buildCollectiveEntityProposalTx } from '../entity/authorization';
import { hashEntityCommandTxs } from '../entity/command-codec';
import type { EntityTx, Env } from '../types';

const entityId = '0x1111111111111111111111111111111111111111111111111111111111111111';
const counterpartyId = '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('mesh queued work detection', () => {
  test('keeps bootstrap settled behind an in-flight runtime frame after its mempool drains', () => {
    const env = {
      runtimeState: { processingPromise: new Promise<void>(() => {}) },
      runtimeMempool: { runtimeTxs: [], entityInputs: [] },
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      eReplicas: new Map(),
      jReplicas: new Map(),
    } as unknown as Env;

    expect(hasPendingRuntimeWork(env)).toBe(true);
  });

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

  test('finds bootstrap work nested in a signed collective proposal already in replica mempool', () => {
    const author = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const collectiveTxs: EntityTx[] = [{
      type: 'openAccount',
      data: { targetEntityId: counterpartyId, tokenId: 2, creditAmount: 1000n },
    }, {
      type: 'extendCredit',
      data: { counterpartyEntityId: counterpartyId, tokenId: 2, amount: 1000n },
    }, {
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: counterpartyId,
        offerId: 'nested-mm-offer',
        giveTokenId: 1,
        giveAmount: 100n,
        wantTokenId: 2,
        wantAmount: 200n,
      },
    }];
    const proposal = buildCollectiveEntityProposalTx(author, collectiveTxs);
    const commandTxs = [proposal];
    const signedCommand: EntityTx = {
      type: 'entityCommand',
      data: {
        version: 2,
        entityId,
        stackKey: `0x${'01'.repeat(32)}`,
        boardHash: `0x${'02'.repeat(32)}`,
        boardEpoch: 0,
        authorSignerId: author,
        authorSigner: author,
        nonce: 1n,
        txsHash: hashEntityCommandTxs(commandTxs),
        txs: commandTxs,
        signature: `0x${'03'.repeat(65)}`,
      },
    };
    const env = {
      eReplicas: new Map([[`${entityId}:${author}`, { entityId, mempool: [signedCommand] }]]),
    } as unknown as Env;

    expect(hasQueuedOpenAccount(env, entityId, counterpartyId)).toBe(true);
    expect(hasQueuedExtendCredit(env, entityId, counterpartyId, 2, 1000n)).toBe(true);
    expect(hasQueuedSwapOffer(env, entityId, counterpartyId, 'nested-mm-offer')).toBe(true);
  });

  test('collects placeSwapOffer queued in runtime mempool before account consensus sees it', () => {
    const env = {
      runtimeMempool: {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entityTxs: [{
            type: 'placeSwapOffer',
            data: {
              counterpartyEntityId: counterpartyId,
              offerId: 'mm-queued-ask-1',
              giveTokenId: 1,
              giveAmount: 100n,
              wantTokenId: 2,
              wantAmount: 200n,
            },
          }],
        }],
      },
      eReplicas: new Map(),
    } as unknown as Env;

    expect([...collectQueuedSwapOfferIds(env, entityId, counterpartyId)]).toEqual(['mm-queued-ask-1']);
    expect(hasQueuedSwapOffer(env, entityId, counterpartyId, 'mm-queued-ask-1')).toBe(true);
    expect(hasQueuedSwapOffer(env, entityId, counterpartyId, 'mm-queued-bid-1')).toBe(false);
  });
});
