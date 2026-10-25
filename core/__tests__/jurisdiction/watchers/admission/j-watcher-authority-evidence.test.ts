import { describe, expect, test } from 'bun:test';

import { getCertifiedBoardStackKey } from '../../../../jurisdiction/machine/board-registry';
import { auditWatcherCanonicalState } from '../../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-canonical';
import type { RpcWatcherServices, RpcWatcherSession } from '../../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-types';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { CertifiedRegistrationEvidence } from '../../../../types/jurisdiction-runtime';

const STACK = {
  chainId: 31_337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
};
const hashAt = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;

const audit = (session: RpcWatcherSession, env: RuntimeReplica, head: number, services: RpcWatcherServices) =>
  auditWatcherCanonicalState(session, env, head, services, () => {});

const setup = (evidenceCount: number) => {
  const calls: number[][] = [];
  const served = new Map<number, string>();
  const services = {
    ...STACK,
    readBlockHeaders: async (heights: number[]) => {
      calls.push([...heights]);
      return [...new Set(heights)].sort((a, b) => a - b).map(jHeight => ({ jHeight, jBlockHash: served.get(jHeight) ?? hashAt(jHeight) }));
    },
  } as unknown as RpcWatcherServices;
  const evidence = new Map<string, CertifiedRegistrationEvidence>();
  for (let index = 0; index < evidenceCount; index += 1) {
    const activationHeight = 3 + index;
    const observedThroughHeight = 20 + index;
    evidence.set(`e${index}`, {
      stackKey: getCertifiedBoardStackKey(STACK),
      entityId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      activationHeight,
      blockHash: hashAt(activationHeight),
      observedThroughHeight,
      observedTipBlockHash: hashAt(observedThroughHeight),
    } as unknown as CertifiedRegistrationEvidence);
  }
  const env = {
    infrastructure: { certifiedRegistrationEvidence: evidence },
    state: { eReplicas: new Map(), jReplicas: new Map() },
  } as unknown as RuntimeReplica;
  const session = {
    lastAuthorityAuditKey: '',
    lastSyncedBlock: 0,
    pendingRewindReplicaKeys: [] as string[],
  } as unknown as RpcWatcherSession;
  return { calls, served, services, env, session };
};

describe('watcher authority evidence audit', () => {
  test('an applied rewind is cleared before the one header batch, after which no tip audit runs', async () => {
    const { calls, services, env, session } = setup(1);
    session.lastSyncedBlock = 64;
    session.pendingRewindReplicaKeys = ['gone'];
    expect(await audit(session, env, 100, services)).toBe(false);
    expect(session.pendingRewindReplicaKeys).toEqual([]);
    expect(calls).toEqual([[100, 3, 20]]);
  });

  test('reads the head and every evidence header in one batch per poll', async () => {
    const { calls, services, env, session } = setup(2);
    await audit(session, env, 100, services);
    expect(calls).toEqual([[100, 3, 20, 4, 21]]);
    expect(session.lastAuthorityAuditKey).toBe(`100:${hashAt(100)}:2`);
    // The same head is not re-audited, and still costs one round trip.
    await audit(session, env, 100, services);
    expect(calls).toHaveLength(2);
  });

  test('an empty evidence set reads only the head', async () => {
    const { calls, services, env, session } = setup(0);
    await audit(session, env, 50, services);
    expect(calls).toEqual([[50]]);
    expect(session.lastAuthorityAuditKey).toBe(`50:${hashAt(50)}:0`);
  });

  test('a reorged activation or finality tip halts the audit', async () => {
    const activation = setup(1);
    activation.served.set(3, hashAt(999));
    await expect(audit(activation.session, activation.env, 100, activation.services))
      .rejects.toThrow(`J_AUTHORITY_FINALIZED_REORG:entity=${hashAt(1)}:height=3:expected=${hashAt(3)}:canonical=${hashAt(999)}`);
    expect(activation.session.lastAuthorityAuditKey).toBe('');
    const tip = setup(1);
    tip.served.set(20, hashAt(998));
    await expect(audit(tip.session, tip.env, 100, tip.services))
      .rejects.toThrow(`J_AUTHORITY_FINALITY_TIP_REORG:entity=${hashAt(1)}:height=20:expected=${hashAt(20)}:canonical=${hashAt(998)}`);
    expect(tip.session.lastAuthorityAuditKey).toBe('');
  });
});
