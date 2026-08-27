import { describe, expect, test } from 'bun:test';

import { assertOutboundAdmissions, type OutboundAdmission } from '../../../rscore/cutover/provider';
import type { AccountTx } from '../../../types/account';
import type { Wave } from '../../../rscore/wave-decode';

const OWNER = `0x${'11'.repeat(32)}`;
const COUNTERPARTY_A = `0x${'22'.repeat(32)}`;
const COUNTERPARTY_B = `0x${'33'.repeat(32)}`;

const tx = (toEntityId: string): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 1n,
    route: [],
    fromEntityId: OWNER,
    toEntityId,
    deliveryMode: 'direct',
  },
});

const emptyWave = (admissions: Wave['admissions']): Wave => ({
  revision: 1,
  accountsRoot: `0x${'00'.repeat(32)}`,
  applied: [],
  admissions,
  proposals: [],
  touched: [],
  postAccounts: [],
  createdAccounts: [],
  checkpoint: null,
  parityDigest: `0x${'00'.repeat(32)}`,
  engineMicros: 0,
});

describe('rscore cutover outbound admission arity', () => {
  test('an engine wave that admits exactly what TS requested passes', () => {
    const admits: readonly OutboundAdmission[] = [
      { accountId: COUNTERPARTY_A, txs: [tx(COUNTERPARTY_A)] },
    ];
    const wave = emptyWave([
      { operationIndex: 0, accountId: COUNTERPARTY_A, verdict: { kind: 'admitted', count: 1 } },
    ]);
    expect(() => assertOutboundAdmissions(wave, admits, [])).not.toThrow();
  });

  // Regression for the resident-Entity round dropping every local admission:
  // TS's own oracle execution queued 2 local admits (e.g. from entity-originated
  // extendCredit/directPayment txs) but the engine's cached round returned zero,
  // because entityRound() never carries the Entity's local financial txs across
  // the wire. This must halt loudly, never silently accept a shorter wave.
  test('an engine wave that drops every local admission halts with exact counts', () => {
    const admits: readonly OutboundAdmission[] = [
      { accountId: COUNTERPARTY_A, txs: [tx(COUNTERPARTY_A)] },
      { accountId: COUNTERPARTY_B, txs: [tx(COUNTERPARTY_B)] },
    ];
    const wave = emptyWave([]);
    expect(() => assertOutboundAdmissions(wave, admits, []))
      .toThrow('RSCORE_CUTOVER_OUTBOUND_ADMISSION_ARITY:{"actual":0,"expected":2}');
  });

  test('a matching arity with a wrong admitted count still halts', () => {
    const admits: readonly OutboundAdmission[] = [
      { accountId: COUNTERPARTY_A, txs: [tx(COUNTERPARTY_A), tx(COUNTERPARTY_A)] },
    ];
    const wave = emptyWave([
      { operationIndex: 0, accountId: COUNTERPARTY_A, verdict: { kind: 'admitted', count: 1 } },
    ]);
    expect(() => assertOutboundAdmissions(wave, admits, []))
      .toThrow('RSCORE_CUTOVER_OUTBOUND_ADMISSION_MISMATCH');
  });
});
