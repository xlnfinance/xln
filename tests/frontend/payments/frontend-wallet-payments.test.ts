import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { formatTokenAmount, parseTokenAmount } from '../../../core/account/financial-utils';
import { deriveDelta, getTokenInfo, isLeftEntity } from '../../../core/account/utils';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import {
  executeWalletPaymentCommand,
  prepareWalletPaymentCommand,
} from '../../../frontend/apps/wallet/src/wallet-payment-command';
import {
  buildWalletPaymentInput,
  decodeWalletPaymentProjection,
  decodeWalletPaymentRoutes,
  type WalletPaymentMath,
} from '../../../frontend/apps/wallet/src/wallet-payment-model';
import { buildWalletOperationTx } from '../../../frontend/apps/wallet/src/wallet-payment-operations-model';

const alice = `0x${'11'.repeat(32)}`;
const bob = `0x${'22'.repeat(32)}`;
const hub = `0x${'33'.repeat(32)}`;
const signer = `0x${'aa'.repeat(20)}`;

const math: WalletPaymentMath = {
  deriveDelta,
  formatTokenAmount,
  getTokenInfo,
  isLeftEntity,
  parseTokenAmount,
};

const delta = {
  tokenId: 1,
  collateral: 100_000_000n,
  ondelta: 20_000_000n,
  offdelta: 0n,
  leftCreditLimit: 30_000_000n,
  rightCreditLimit: 40_000_000n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
};

const account = (rightEntity: string, status: 'active' | 'disputed') => ({
  status,
  state: {
    leftEntity: alice,
    rightEntity,
    deltas: new Map([[1, delta]]),
  },
});

const frame = () => ({
  height: 22,
  entities: [
    { entityId: alice, label: 'Alice', height: 22 },
    { entityId: bob, label: 'Bob', height: 22 },
    { entityId: hub, label: 'Hub', height: 22, isHub: true },
  ],
  activeEntityId: alice,
  activeEntity: {
    core: {
      entityId: alice,
      signerId: signer,
      reserves: new Map([[1, 500_000_000n]]),
    },
    accounts: {
      items: [account(bob, 'active'), account(hub, 'disputed')],
      pageIndex: 0,
      pageCount: 1,
      totalItems: 2,
    },
  },
});

const directRoute = () => ({
  routes: [{
    path: [alice, bob],
    hops: [{ from: alice, to: bob, fee: '0', feePPM: 0 }],
    totalFee: '0',
    senderAmount: '25000000',
    recipientAmount: '25000000',
    probability: 1,
  }],
});

describe('React wallet payments', () => {
  test('projects command authority, capacity, recipients, and dispute gates', () => {
    const projection = decodeWalletPaymentProjection(frame(), math);
    expect(projection).toMatchObject({
      height: 22,
      activeEntityId: alice,
      activeEntityLabel: 'Alice',
      signerId: signer,
    });
    expect(projection.tokens[0]).toMatchObject({
      tokenId: 1,
      symbol: 'USDC',
      reserve: 500_000_000n,
      spendable: 600_000_000n,
    });
    expect(projection.recipients).toEqual([
      { entityId: bob, label: 'Bob', blocked: false },
      { entityId: hub, label: 'Hub', blocked: true },
    ]);
  });

  test('validates and orders Runtime-owned route quotes without re-quoting them', () => {
    const request = {
      sourceEntityId: alice,
      targetEntityId: bob,
      tokenId: 1,
      recipientAmount: 25_000_000n,
      deliveryMode: 'direct' as const,
    };
    expect(decodeWalletPaymentRoutes(directRoute(), request)[0]).toMatchObject({
      path: [alice, bob],
      totalFee: 0n,
      senderAmount: 25_000_000n,
      recipientAmount: 25_000_000n,
    });

    const wrongFee = directRoute();
    wrongFee.routes[0]!.totalFee = '1';
    wrongFee.routes[0]!.senderAmount = '25000001';
    expect(() => decodeWalletPaymentRoutes(wrongFee, request))
      .toThrow('WALLET_PAYMENT_ROUTE_FEE_MISMATCH');

    const cycle = directRoute();
    cycle.routes[0]!.path = [alice, bob, alice, bob];
    cycle.routes[0]!.hops = [
      { from: alice, to: bob, fee: '0', feePPM: 0 },
      { from: bob, to: alice, fee: '0', feePPM: 0 },
      { from: alice, to: bob, fee: '0', feePPM: 0 },
    ];
    expect(() => decodeWalletPaymentRoutes(cycle, { ...request, deliveryMode: 'instant' }))
      .toThrow('WALLET_PAYMENT_ROUTE_CYCLE');
  });

  test('builds the canonical direct and conditional payment Runtime inputs', () => {
    const projection = decodeWalletPaymentProjection(frame(), math);
    const route = decodeWalletPaymentRoutes(directRoute(), {
      sourceEntityId: alice,
      targetEntityId: bob,
      tokenId: 1,
      recipientAmount: 25_000_000n,
      deliveryMode: 'direct',
    })[0]!;
    expect(buildWalletPaymentInput({
      projection,
      targetEntityId: bob,
      tokenId: 1,
      deliveryMode: 'direct',
      description: 'Lunch',
      route,
    }).entityInputs[0]?.entityTxs[0]).toEqual({
      type: 'directPayment',
      data: {
        targetEntityId: bob,
        tokenId: 1,
        amount: 25_000_000n,
        route: [alice, bob],
        deliveryMode: 'direct',
        description: 'Lunch',
      },
    });

    expect(buildWalletPaymentInput({
      projection,
      targetEntityId: bob,
      tokenId: 1,
      deliveryMode: 'instant',
      description: '',
      route,
    }).entityInputs[0]?.entityTxs[0]).toMatchObject({
      type: 'htlcPayment',
      data: { maxSenderDebit: 25_000_000n, deliveryMode: 'instant' },
    });
  });

  test('retries the same memory-only Runtime command identity after an unresolved response', async () => {
    const projection = decodeWalletPaymentProjection(frame(), math);
    const route = decodeWalletPaymentRoutes(directRoute(), {
      sourceEntityId: alice,
      targetEntityId: bob,
      tokenId: 1,
      recipientAmount: 25_000_000n,
      deliveryMode: 'direct',
    })[0]!;
    const input = buildWalletPaymentInput({
      projection,
      targetEntityId: bob,
      tokenId: 1,
      deliveryMode: 'direct',
      description: '',
      route,
    });
    const sends: Array<Readonly<{ commandId?: string; commandSequence?: number }>> = [];
    const adapter = {
      runtimeId: 'runtime-payment-test',
      serverFingerprint: `0x${'ab'.repeat(32)}`,
      nextCommandSequence: 7,
      commandLaneKind: 'capability',
      ensureOwnerCommandLane: async () => undefined,
      send: async (_input: unknown, options: Readonly<{ commandId?: string; commandSequence?: number }>) => {
        sends.push(options);
        return { status: 'pending' as const, height: 22, commandSequence: 7 };
      },
    } as unknown as RuntimeAdapter;
    const command = await prepareWalletPaymentCommand(adapter, input);

    expect(command).toMatchObject({ commandSequence: 7, durable: false });
    await executeWalletPaymentCommand(adapter, command);
    await executeWalletPaymentCommand(adapter, command);
    expect(sends).toEqual([
      { commandId: command.commandId, commandSequence: 7 },
      { commandId: command.commandId, commandSequence: 7 },
    ]);
  });

  test('bounds reserve, collateral, and lending operations before command submission', () => {
    const projection = decodeWalletPaymentProjection(frame(), math);
    const base = {
      targetEntityId: bob,
      tokenId: 1,
      amount: '25',
      termId: '1d' as const,
      interestBps: 125,
      intentId: '',
    };
    expect(buildWalletOperationTx({ ...base, kind: 'r2r' }, projection, math)).toMatchObject({
      type: 'r2r', data: { toEntityId: bob, amount: 25_000_000n },
    });
    expect(buildWalletOperationTx({ ...base, kind: 'r2c' }, projection, math)).toMatchObject({
      type: 'r2c', data: { counterpartyId: bob, amount: 25_000_000n },
    });
    expect(buildWalletOperationTx({ ...base, kind: 'c2r' }, projection, math)).toMatchObject({
      type: 'settle_propose',
      data: { counterpartyEntityId: bob, ops: [{ type: 'c2r', amount: 25_000_000n }] },
    });
    expect(buildWalletOperationTx({
      ...base, kind: 'lend', intentId: 'lend-12345678',
    }, projection, math)).toMatchObject({
      type: 'lendingOffer', data: { hubEntityId: bob, termId: '1d', interestBps: 125 },
    });
    expect(() => buildWalletOperationTx({
      ...base, kind: 'r2r', amount: '501',
    }, projection, math)).toThrow('WALLET_OPERATION_RESERVE_EXCEEDED');
    expect(() => buildWalletOperationTx({
      ...base, kind: 'c2r', amount: '101',
    }, projection, math)).toThrow('WALLET_OPERATION_COLLATERAL_EXCEEDED');
  });

  test('keeps write identity, reconnect retry, and cleanup at the explicit adapter boundary', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-payment-source.ts', 'utf8');
    const command = readFileSync('frontend/apps/wallet/src/wallet-payment-command.ts', 'utf8');
    const boundary = readFileSync('frontend/apps/wallet/src/wallet-runtime-read-boundary.ts', 'utf8');
    const view = readFileSync('frontend/apps/wallet/src/wallet-payments.tsx', 'utf8');
    expect(source).toContain("adapter.read('payment-routes'");
    expect(source).toContain('prepareWalletPaymentCommand');
    expect(source).toContain('executeWalletPaymentCommand');
    expect(source).toContain('Do not submit a second command');
    expect(source).toContain('this.adapter?.disconnect()');
    expect(command).toContain('resolveRemoteRuntimeCommandIntent');
    expect(command).toContain('commandId: command.commandId');
    expect(command).toContain('commandSequence: command.commandSequence');
    expect(boundary).toContain('signRuntimeAdapterOwnerBinding');
    expect(view).toContain('useSyncExternalStore');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('Math.random');
  });
});
