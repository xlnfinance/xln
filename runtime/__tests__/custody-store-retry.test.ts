import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CustodyStore } from '../../custody/store';
import { bindCustodyWithdrawalInitiation } from '../../custody/withdrawal-journal';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('custody withdrawal retry journal', () => {
  test('binds initiation before a same-page terminal event and accepts the exact submit replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xln-custody-initiation-race-'));
    roots.push(root);
    const store = new CustodyStore(join(root, 'custody.sqlite'));
    const custodyEntityId = `0x${'10'.repeat(32)}`;
    const targetEntityId = `0x${'20'.repeat(32)}`;
    const hashlock = `0x${'30'.repeat(32)}`;
    const withdrawalId = 'wd_initiation_race_0001';
    const description = `custody-withdrawal:${withdrawalId} requested:65 fee:5`;
    const route = [custodyEntityId, targetEntityId];
    const routeJson = JSON.stringify(route);
    store.createSession('race-session', 'race-user');
    store.creditDeposit({
      eventKey: 'race-deposit',
      userId: 'race-user',
      tokenId: 1,
      amountMinor: 100n,
      description: 'seed balance',
      fromEntityId: targetEntityId,
      hashlock: `0x${'40'.repeat(32)}`,
      frameHeight: 1,
      createdAt: 1,
    });
    store.reserveWithdrawal({
      id: withdrawalId,
      userId: 'race-user',
      tokenId: 1,
      amountMinor: 70n,
      requestedAmountMinor: 65n,
      feeMinor: 5n,
      targetEntityId,
      description,
      routeJson,
      commandId: `custody:${withdrawalId}`,
      createdAt: 2,
    });

    expect(bindCustodyWithdrawalInitiation(store, custodyEntityId, {
      id: 1,
      timestamp: 3,
      level: 'info',
      category: 'system',
      message: 'HtlcInitiated',
      data: {
        entityId: custodyEntityId,
        toEntity: targetEntityId,
        tokenId: 1,
        amount: '65',
        description,
        route,
        hashlock,
      },
    })).toBe(true);
    store.finalizeWithdrawalByHashlock({ hashlock, frameHeight: 4, updatedAt: 4 });
    expect(store.markWithdrawalSent({ id: withdrawalId, hashlock, routeJson, updatedAt: 5 })?.status).toBe('finalized');
    expect(store.getWithdrawalById(withdrawalId)?.status).toBe('finalized');
    expect(() => store.markWithdrawalSent({
      id: withdrawalId,
      hashlock: `0x${'31'.repeat(32)}`,
      routeJson,
      updatedAt: 6,
    })).toThrow('CUSTODY_WITHDRAWAL_SENT_REPLAY_CONFLICT');
    store.close();
  });

  test('reopens an exact submitting intent without refunding or changing its command lane sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xln-custody-retry-'));
    roots.push(root);
    const path = join(root, 'custody.sqlite');
    const sessionToken = 'session-token';
    const userId = 'user-1';
    const route = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`];

    let store = new CustodyStore(path);
    store.createSession(sessionToken, userId);
    store.creditDeposit({
      eventKey: 'deposit-1',
      userId,
      tokenId: 1,
      amountMinor: 100n,
      description: 'seed balance',
      fromEntityId: route[1]!,
      hashlock: `0x${'33'.repeat(32)}`,
      frameHeight: 1,
      createdAt: 1,
    });
    store.reserveWithdrawal({
      id: 'wd_retry_0000000001',
      userId,
      tokenId: 1,
      amountMinor: 70n,
      requestedAmountMinor: 65n,
      feeMinor: 5n,
      targetEntityId: route[1]!,
      description: 'custody-withdrawal:wd_retry_0000000001',
      routeJson: JSON.stringify(route),
      commandId: 'custody:wd_retry_0000000001',
      createdAt: 2,
    });
    store.setWithdrawalCommandSequence(
      'wd_retry_0000000001',
      'custody:wd_retry_0000000001',
      7,
    );
    expect(store.getBalanceAmount(userId, 1)).toBe(30n);
    store.close();

    store = new CustodyStore(path);
    expect(store.getBalanceAmount(userId, 1)).toBe(30n);
    expect(store.listSubmittingWithdrawals()).toEqual([
      expect.objectContaining({
        id: 'wd_retry_0000000001',
        status: 'submitting',
        routeJson: JSON.stringify(route),
        commandId: 'custody:wd_retry_0000000001',
        commandSequence: 7,
      }),
    ]);
    expect(() => store.setWithdrawalCommandSequence(
      'wd_retry_0000000001',
      'custody:wd_retry_0000000001',
      8,
    )).toThrow('CUSTODY_WITHDRAWAL_COMMAND_SEQUENCE_CONFLICT');
    store.close();
  });

  test('never refunds a withdrawal after its owner-lane command sequence is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xln-custody-prepared-'));
    roots.push(root);
    const store = new CustodyStore(join(root, 'custody.sqlite'));
    const userId = 'prepared-user';
    const targetEntityId = `0x${'44'.repeat(32)}`;
    store.createSession('prepared-session', userId);
    store.creditDeposit({
      eventKey: 'prepared-deposit',
      userId,
      tokenId: 1,
      amountMinor: 100n,
      description: 'seed balance',
      fromEntityId: targetEntityId,
      hashlock: `0x${'55'.repeat(32)}`,
      frameHeight: 1,
      createdAt: 1,
    });
    store.reserveWithdrawal({
      id: 'wd_prepared_00000001',
      userId,
      tokenId: 1,
      amountMinor: 70n,
      requestedAmountMinor: 65n,
      feeMinor: 5n,
      targetEntityId,
      description: 'custody-withdrawal:wd_prepared_00000001',
      routeJson: JSON.stringify([targetEntityId]),
      commandId: 'custody:wd_prepared_00000001',
      createdAt: 2,
    });
    store.setWithdrawalCommandSequence(
      'wd_prepared_00000001',
      'custody:wd_prepared_00000001',
      3,
    );

    expect(() => store.failWithdrawalById({
      id: 'wd_prepared_00000001',
      error: 'ambiguous remote rejection',
      updatedAt: 3,
      restoreBalance: true,
    })).toThrow('CUSTODY_WITHDRAWAL_PREPARED_REFUND_FORBIDDEN');
    expect(store.getBalanceAmount(userId, 1)).toBe(30n);
    expect(store.getWithdrawalById('wd_prepared_00000001')?.status).toBe('submitting');
    store.failWithdrawalById({
      id: 'wd_prepared_00000001',
      error: 'ambiguous remote rejection',
      updatedAt: 4,
      restoreBalance: false,
    });
    store.failWithdrawalById({
      id: 'wd_prepared_00000001',
      error: 'duplicate terminal response',
      updatedAt: 5,
      restoreBalance: true,
    });
    expect(store.getBalanceAmount(userId, 1)).toBe(30n);
    expect(store.getWithdrawalById('wd_prepared_00000001')?.status).toBe('failed');
    store.close();
  });

  test('rejects a failed event that conflicts with a finalized withdrawal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xln-custody-terminal-'));
    roots.push(root);
    const store = new CustodyStore(join(root, 'custody.sqlite'));
    const userId = 'terminal-user';
    const targetEntityId = `0x${'66'.repeat(32)}`;
    const hashlock = `0x${'77'.repeat(32)}`;
    store.createSession('terminal-session', userId);
    store.creditDeposit({
      eventKey: 'terminal-deposit',
      userId,
      tokenId: 1,
      amountMinor: 100n,
      description: 'seed balance',
      fromEntityId: targetEntityId,
      hashlock: `0x${'88'.repeat(32)}`,
      frameHeight: 1,
      createdAt: 1,
    });
    store.reserveWithdrawal({
      id: 'wd_terminal_00000001',
      userId,
      tokenId: 1,
      amountMinor: 70n,
      requestedAmountMinor: 65n,
      feeMinor: 5n,
      targetEntityId,
      description: 'custody-withdrawal:wd_terminal_00000001',
      routeJson: JSON.stringify([targetEntityId]),
      commandId: 'custody:wd_terminal_00000001',
      createdAt: 2,
    });
    store.markWithdrawalSent({
      id: 'wd_terminal_00000001',
      hashlock,
      routeJson: JSON.stringify([targetEntityId]),
      updatedAt: 3,
    });
    store.finalizeWithdrawalByHashlock({ hashlock, frameHeight: 4, updatedAt: 4 });

    expect(() => store.failWithdrawalByHashlock({
      hashlock,
      error: 'conflicting terminal event',
      frameHeight: 5,
      updatedAt: 5,
    })).toThrow('CUSTODY_WITHDRAWAL_TERMINAL_CONFLICT');
    expect(store.getBalanceAmount(userId, 1)).toBe(30n);
    expect(store.getWithdrawalById('wd_terminal_00000001')?.status).toBe('finalized');
    store.close();
  });
});
