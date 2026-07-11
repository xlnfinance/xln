import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { handleLendingStateRequest } from '../server/lending';
import type { Env } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB = entity('11');
const USER = entity('22');
const SIGNER = `0x${'33'.repeat(20)}`;

describe('lending API boundary', () => {
  test('GET exposes committed hub lending state', async () => {
    const env = {
      eReplicas: new Map([[`${HUB}:${SIGNER}`, {
        entityId: HUB,
        signerId: SIGNER,
        state: {
          entityId: HUB,
          lending: { pools: new Map(), loans: new Map() },
        },
      }]]),
    } as unknown as Env;
    const request = new Request(`http://xln.local/api/lending/state?hubEntityId=${HUB}&userEntityId=${USER}&tokenId=1`);
    const response = await handleLendingStateRequest({ req: request, env, headers: {}, activeHubEntityIds: [HUB] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, hubEntityId: HUB, pools: [], loans: [] });
  });

  test('unauthenticated POST mutation routes are absent', () => {
    for (const path of ['runtime/server.ts', 'runtime/orchestrator/hub-node.ts', 'runtime/orchestrator/orchestrator.ts']) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toContain("pathname === '/api/lending/offer'");
      expect(source).not.toContain("pathname === '/api/lending/borrow'");
      expect(source).not.toContain("pathname === '/api/lending/repay'");
    }
  });
});
