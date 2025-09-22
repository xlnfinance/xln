#!/usr/bin/env bun

import { Env } from './src/types';
import { applyServerInput, processUntilEmpty } from './src/server';

const env: Env = {
  replicas: new Map(),
  height: 0,
  timestamp: Date.now(),
  serverInput: { serverTxs: [], entityInputs: [] },
  history: [],
  gossip: { profiles: new Map(), messageLog: [] } as any,
};

// Create two entities
const e1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
const e2 = '0x0000000000000000000000000000000000000000000000000000000000000002';

const result = await applyServerInput(env, {
  serverTxs: [
    {
      type: 'importReplica',
      entityId: e1,
      signerId: 's1',
      data: {
        isProposer: true,
        config: {
          validators: ['s1'],
          threshold: BigInt(1)
        }
      }
    },
    {
      type: 'importReplica',
      entityId: e2,
      signerId: 's2',
      data: {
        isProposer: true,
        config: {
          validators: ['s2'],
          threshold: BigInt(1)
        }
      }
    }
  ],
  entityInputs: []
});

console.log('Created entities:', Array.from(env.replicas.keys()));

// Entity1 opens account with Entity2
const openResult = await applyServerInput(env, {
  serverTxs: [],
  entityInputs: [{
    entityId: e1,
    signerId: 's1',
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: e2 }
    }]
  }]
});

console.log('Outputs from opening account:', openResult.entityOutbox.length);
if (openResult.entityOutbox.length > 0) {
  console.log('Output target:', openResult.entityOutbox[0].entityId.slice(-4), 'signer:', openResult.entityOutbox[0].signerId);
}

// Process the outputs
await processUntilEmpty(env, openResult.entityOutbox);

// Check if Entity2 received it
const e1_state = env.replicas.get(`${e1}:s1`)?.state;
const e2_state = env.replicas.get(`${e2}:s2`)?.state;

console.log('E1 has account with E2:', e1_state?.accounts.has(e2));
console.log('E2 has account with E1:', e2_state?.accounts.has(e1));

if (e2_state?.accounts.has(e1)) {
  console.log('✅ ROUTING WORKS!');
} else {
  console.log('❌ ROUTING BROKEN');
}