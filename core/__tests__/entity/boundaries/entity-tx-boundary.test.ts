import { expect, test } from 'bun:test';

import { applyEntityTx } from '../../../entity/tx/apply';
import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';

test('Entity reducer rejects a missing transaction as a programming fault', async () => {
  await expect(applyEntityTx(
    {} as RuntimeReplica,
    {} as EntityState,
    undefined as unknown as EntityTx,
  )).rejects.toThrow('ENTITY_TX_UNDEFINED');
});
