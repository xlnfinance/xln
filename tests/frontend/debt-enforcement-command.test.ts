import { describe, expect, test } from 'bun:test';

import { buildDebtEnforcementRuntimeInputFromProjection } from '../../runtime/protocol/payments/debt-enforcement';

describe('debt enforcement RuntimeInput builder', () => {
  test('builds debt enforcement j-input from projection data', () => {
    const input = buildDebtEnforcementRuntimeInputFromProjection({
      entityId: ' 0xABC ',
      jurisdictionName: 'Testnet',
      tokenId: 7,
      maxIterations: 3,
      signerId: ' 0xDEF ',
      timestamp: 12345,
    });

    expect(input).toEqual({
      runtimeTxs: [],
      entityInputs: [],
      jInputs: [{
        jurisdictionName: 'Testnet',
        jTxs: [{
          type: 'debtEnforcement',
          entityId: '0xabc',
          data: {
            tokenId: 7,
            maxIterations: 3n,
            signerId: '0xdef',
          },
          timestamp: 12345,
        }],
      }],
      timestamp: 12345,
    });
  });

  test('fails fast without required projection command fields', () => {
    expect(() => buildDebtEnforcementRuntimeInputFromProjection({
      entityId: '',
      jurisdictionName: 'J',
      tokenId: 1,
      timestamp: 1,
    })).toThrow('DEBT_ENFORCEMENT_ENTITY_REQUIRED');
    expect(() => buildDebtEnforcementRuntimeInputFromProjection({
      entityId: 'entity-1',
      jurisdictionName: '',
      tokenId: 1,
      timestamp: 1,
    })).toThrow('ENTITY_JURISDICTION_MISSING');
    expect(() => buildDebtEnforcementRuntimeInputFromProjection({
      entityId: 'entity-1',
      jurisdictionName: 'J',
      tokenId: -1,
      timestamp: 1,
    })).toThrow('DEBT_ENFORCEMENT_TOKEN_INVALID');
    expect(() => buildDebtEnforcementRuntimeInputFromProjection({
      entityId: 'entity-1',
      jurisdictionName: 'J',
      tokenId: 1,
      maxIterations: 0,
      timestamp: 1,
    })).toThrow('DEBT_ENFORCEMENT_ITERATIONS_INVALID');
    expect(() => buildDebtEnforcementRuntimeInputFromProjection({
      entityId: 'entity-1',
      jurisdictionName: 'J',
      tokenId: 1,
    } as any)).toThrow('DEBT_ENFORCEMENT_TIMESTAMP_INVALID');
  });
});
