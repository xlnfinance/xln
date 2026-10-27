/**
 * Entity command / proposal-action inputs are captured once and the owned
 * structuredClone is structure-checked again. Adversarial counterexamples:
 * an accessor that returns a different batch per read, and a Date carrying an
 * own `type` (passes the original shape check; cloning drops `type`).
 * Human-audit importance: 85/100 — authorization input boundary.
 */
import { describe, expect, test } from 'bun:test';
import { assertEntityProposalAction } from '../../../entity/auth/authorization';
import { normalizeSignedEntityCommand } from '../../../entity/command/command-codec';

const commandFields = (txs: unknown): Record<string, unknown> => ({
  version: 1,
  entityId: `0x${'11'.repeat(32)}`,
  stackKey: `0x${'22'.repeat(32)}`,
  boardHash: `0x${'33'.repeat(32)}`,
  boardEpoch: 0,
  authorSignerId: '1',
  authorSigner: `0x${'44'.repeat(20)}`,
  nonce: 1n,
  txsHash: `0x${'55'.repeat(32)}`,
  txs,
  signature: `0x${'66'.repeat(64)}00`,
});

describe('entity command input capture', () => {
  test('rejects an accessor envelope field instead of reading it twice', () => {
    const value = commandFields(undefined);
    let reads = 0;
    Object.defineProperty(value, 'txs', {
      enumerable: true,
      get: () => {
        reads += 1;
        return [{ type: 'chat', data: { from: '1', message: String(reads) } }];
      },
    });
    expect(() => normalizeSignedEntityCommand(value)).toThrow('ENTITY_COMMAND_FIELDS_INVALID:accessor:txs');
    expect(reads).toBe(0);
  });

  test('re-checks proposal-action structure on the owned clone', () => {
    const exotic = Object.assign(new Date(0), { type: 'openAccount' });
    expect(() => assertEntityProposalAction({
      type: 'entity_transaction',
      data: { version: 1, actionHash: `0x${'77'.repeat(32)}`, txs: [exotic] },
    })).toThrow('ENTITY_COLLECTIVE_ACTION_TX_INVALID');
  });

  test('an own __proto__ key is captured as a field, not dropped by the prototype setter', () => {
    const raw = JSON.parse('{"type":"collective_message","data":{"message":"ok"},"__proto__":{"marker":true}}');
    expect(() => assertEntityProposalAction(raw)).toThrow();
  });
});
