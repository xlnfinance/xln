import { describe, expect, test } from 'bun:test';

import { cutoverAccountEffects } from '../../../rscore/cutover/effects';

const OWNER = `0x${'11'.repeat(32)}`;
const COUNTERPARTY = `0x${'22'.repeat(32)}`;

describe('rscore cutover effects', () => {
  test('a finalized AccountSettled result recreates the exact Entity effects', () => {
    const result = cutoverAccountEffects(null, OWNER, COUNTERPARTY, [{
      kind: 'accountSettledFinalized',
      tokenId: 7,
      jHeight: 43,
      collateral: '1000000',
      ondelta: '-12',
    }]);

    const data = {
      entityId: OWNER,
      accountId: COUNTERPARTY,
      tokenId: 7,
      jHeight: 43,
      collateral: '1000000',
      ondelta: '-12',
    };
    expect(result.candidateEffects).toEqual([
      {
        kind: 'runtimeEvent',
        eventName: 'account_settled_finalized_bilateral',
        data,
      },
      {
        kind: 'debug',
        payload: {
          level: 'info',
          code: 'REB_STEP',
          step: 5,
          status: 'ok',
          event: 'account_settled_finalized_bilateral',
          ...data,
        },
      },
    ]);
  });
});
