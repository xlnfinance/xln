import { expect, test } from 'bun:test';

import { prewarmCounterpartyProfiles } from '../../frontend/src/lib/utils/p2pPrefetch';

test('prewarmCounterpartyProfiles forwards unique normalized entity ids to runtime p2p', async () => {
  let seen: string[] = [];
  const env = {
    runtimeState: {
      p2p: {
        ensureProfiles: async (entityIds: string[]) => {
          seen = [...entityIds];
          return true;
        },
      },
    },
  };

  const ready = await prewarmCounterpartyProfiles(env as never, [
    ' 0xAbc ',
    '0xabc',
    '',
    '0xDEF',
  ]);

  expect(ready).toBe(true);
  expect(seen).toEqual(['0xabc', '0xdef']);
});

test('prewarmCounterpartyProfiles degrades cleanly when runtime p2p is unavailable', async () => {
  await expect(prewarmCounterpartyProfiles(null, ['0xabc'])).resolves.toBe(false);
  await expect(prewarmCounterpartyProfiles({ runtimeState: {} } as never, ['0xabc'])).resolves.toBe(false);
});
