import { expect, test } from 'bun:test';

import { getEntityInfoFromChain } from '../jadapter/runtime-api';

test('entity lookup distinguishes transport/config failure from confirmed absence', async () => {
  await expect(getEntityInfoFromChain(
    `0x${'11'.repeat(32)}`,
    {
      address: 'not-a-valid-rpc-url',
      name: 'invalid test jurisdiction',
      entityProviderAddress: 'not-an-address',
      depositoryAddress: 'not-an-address',
      chainId: 31337,
    },
  )).rejects.toThrow('GET_ENTITY_INFO_FROM_CHAIN_FAILED');
});
