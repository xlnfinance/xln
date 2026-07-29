import { expect, test } from 'bun:test';

import { applyEntityTx } from '../entity/tx/apply';
import type { EntityState, EntityTx, RuntimeState } from '../types';

test('Entity reducer rejects a missing transaction as a programming fault', async () => {
  await expect(applyEntityTx(
    {} as RuntimeState,
    {} as EntityState,
    undefined as unknown as EntityTx,
  )).rejects.toThrow('ENTITY_TX_UNDEFINED');
});
