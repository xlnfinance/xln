import { expect, test } from 'bun:test';

import {
  collectCommittedAccountFrames,
  registerCommittedAccountRoutes,
} from '../../../runtime/admit/entity-input-staging';
import type { RuntimeEntityInputApplyOptions } from '../../../runtime/admit/entity-input-contract';
import type { EntityReplica } from '../../../entity/types';
import type { RoutedEntityInput, RuntimeReplica } from '../../../runtime/types';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

const localEntityId = entityId('11');
const remoteEntityId = entityId('22');
const victimEntityId = entityId('66');
const committedHash = `0x${'55'.repeat(32)}`;

const ackInput = (fromEntityId: string, frameHash: string): RoutedEntityInput => ({
  entityId: localEntityId,
  signerId: signerId('33'),
  from: signerId('44'),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'ack',
      fromEntityId,
      toEntityId: localEntityId,
      ack: { height: 1, frameHash, frameHanko: '0x01' },
    },
  }],
} as RoutedEntityInput);

test('only a committed Account frame binds its counterparty to the sending Runtime', () => {
  // A raw accountInput's fromEntityId used to become a route hint at admission,
  // so any peer could bind a victim Entity to its own Runtime.
  const replica = {
    state: {
      accounts: new Map([
        [remoteEntityId, { currentFrame: { height: 1, stateHash: committedHash } }],
        [victimEntityId, { currentFrame: { height: 1, stateHash: `0x${'77'.repeat(32)}` } }],
      ]),
    },
  } as unknown as EntityReplica;
  const env = { state: { timestamp: 5 }, infrastructure: { entityRuntimeHints: new Map() } } as unknown as RuntimeReplica;
  const options = {
    routingDeps: { ensureRuntimeInfrastructure: (target: RuntimeReplica) => target.infrastructure! },
  } as unknown as RuntimeEntityInputApplyOptions;

  for (const input of [ackInput(remoteEntityId, committedHash), ackInput(victimEntityId, committedHash)]) {
    registerCommittedAccountRoutes(env, input, collectCommittedAccountFrames(input, replica), options);
  }

  expect([...env.infrastructure!.entityRuntimeHints!.keys()]).toEqual([remoteEntityId]);
  expect(env.infrastructure!.entityRuntimeHints!.get(remoteEntityId)?.runtimeId).toBe(signerId('44'));
});
