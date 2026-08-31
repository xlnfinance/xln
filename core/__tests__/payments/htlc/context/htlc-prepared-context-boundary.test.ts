import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateHtlcPreparedInfraContext } from '../../../../entity/paybook/prepared-context-validation';
import { getEffectiveHtlcFrameTxs } from '../../../../entity/paybook/materialize-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { EntityState } from '../../../../entity/types';

const id = (byte: string): string => `0x${byte.repeat(64)}`;
const envelope = { version: 'xln:htlc-opaque:aes-gcm' as const, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

describe('HTLC prepared Entity context boundary', () => {
  test('discovers a payment inside its signed Entity command wrapper', () => {
    const signerId = `0x${'33'.repeat(20)}`;
    const state = {
      config: { threshold: 1n, validators: [signerId], shares: { [signerId]: 1n } },
      proposals: new Map(),
    } as unknown as EntityState;
    const payment = {
      type: 'htlcPayment',
      data: {
        targetEntityId: id('2'), tokenId: 1, amount: 10n, maxSenderDebit: 11n,
        route: [id('1'), id('2')], deliveryMode: 'instant',
      },
    } as EntityTx;
    const wrapped = {
      type: 'entityCommand',
      data: { txs: [{
        type: 'propose',
        data: {
          proposer: signerId,
          action: { type: 'entity_transaction', data: { version: 1, actionHash: id('9'), txs: [payment] } },
        },
      }] },
    } as EntityTx;

    expect(getEffectiveHtlcFrameTxs(state, [wrapped])).toEqual([payment]);
  });

  test('accepts the exact empty canonical context', () => {
    expect(validateHtlcPreparedInfraContext({ version: 1, entries: [], originated: [] }))
      .toEqual({ version: 1, entries: [], originated: [] });
  });

  test('rejects duplicate inbound bindings and noncanonical origin economics', () => {
    const binding = {
      fromEntityId: id('1'), toEntityId: id('2'),
      domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
      accountFrameHash: id('3'), accountHeight: 1, envelopeHash: id('5'),
      hashlock: id('6'), tokenId: 1, amount: 10n, timelock: 100n, revealBeforeHeight: 9,
    };
    const entry = { binding, outcome: { kind: 'reject', reason: 'insufficient_capacity' } };
    expect(() => validateHtlcPreparedInfraContext({ version: 1, entries: [entry, entry], originated: [] }))
      .toThrow('HTLC_PREPARED_BINDING_DUPLICATE');
    expect(() => validateHtlcPreparedInfraContext({
      version: 1,
      entries: [],
      originated: [{
        txHash: id('7'), targetEntityId: id('2'), tokenId: 1, recipientAmount: 10n,
        route: [id('1'), id('2')], description: '', deliveryMode: 'instant', startedAtMs: 1,
        hashlock: id('6'), senderLockAmount: 9n, maxSenderDebit: 10n, totalFee: -1n,
        timelock: 100n, revealBeforeHeight: 9, nextHopEntityId: id('2'), envelope,
      }],
    })).toThrow('HTLC_PREPARED_ORIGIN_ECONOMICS_INVALID');
  });

  test('forward innerEnvelope extra keys name their shape', () => {
    const binding = {
      fromEntityId: id('1'), toEntityId: id('2'),
      domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
      accountFrameHash: id('3'), accountHeight: 1, envelopeHash: id('5'),
      hashlock: id('6'), tokenId: 1, amount: 10n, timelock: 100n, revealBeforeHeight: 9,
    };
    expect(() => validateHtlcPreparedInfraContext({
      version: 1, originated: [],
      entries: [{
        binding,
        outcome: {
          kind: 'forward',
          nextHopEntityId: id('3'),
          forwardAmount: 9n,
          innerEnvelope: { ...envelope, extra: true },
        },
      }],
    })).toThrow('HTLC_OPAQUE_CIPHERTEXT_INVALID:keys=ciphertext,extra,version');
  });

  test('final outcome contains only the canonical raw preimage', () => {
    const binding = {
      fromEntityId: id('1'), toEntityId: id('2'),
      domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
      accountFrameHash: id('3'), accountHeight: 1, envelopeHash: id('5'),
      hashlock: id('6'), tokenId: 1, amount: 10n, timelock: 100n, revealBeforeHeight: 9,
    };
    const context = {
      version: 1, originated: [],
      entries: [{ binding, outcome: { kind: 'final', secret: id('7') } }],
    };
    expect(validateHtlcPreparedInfraContext(context)).toEqual(context);
    expect(() => validateHtlcPreparedInfraContext({
      ...context,
      entries: [{ binding, outcome: { kind: 'final', secret: id('7'), retiredField: id('8') } }],
    })).toThrow('HTLC_PREPARED_FINAL_FIELDS_INVALID');
  });

  test('does not spanning-structuredClone the HTLC graph', () => {
    const source = readFileSync(join(import.meta.dir, '../../../../entity/paybook/prepared-context-validation.ts'), 'utf8');
    expect(source).toContain('cloneIsolatedProtocolValue(context');
    expect(source).not.toContain('structuredClone(context)');
  });

  test('inbound canonicalize decorate-sorts binding keys once', () => {
    const source = readFileSync(join(import.meta.dir, '../../../../entity/paybook/materialize-context.ts'), 'utf8');
    expect(source).toContain('const decorated = entries.map(entry => ({ key: preparedHtlcBindingKey(entry.binding), entry }))');
    expect(source).toContain('decorated.sort((left, right) => left.key.localeCompare(right.key))');
    expect(source).not.toContain('preparedHtlcBindingKey(left.binding).localeCompare(preparedHtlcBindingKey(right.binding))');
  });
});
