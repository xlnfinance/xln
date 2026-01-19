#!/usr/bin/env node

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {};
}

if (typeof globalThis.crypto === 'undefined') {
  const nodeCrypto = await import('crypto');
  globalThis.crypto = {
    getRandomValues: (arr) => {
      const buf = nodeCrypto.randomBytes(arr.length);
      arr.set(buf);
      return arr;
    },
  };
}

const server = await import('../src/server.ts');
const entityFactory = await import('../src/entity-factory.ts');

const { createEmptyEnv, applyServerInput, processUntilEmpty } = server;
const { generateNumberedEntityId } = entityFactory;

const makeReserveEvent = (entityId, signerId, tokenId, amount, decimals, blockNumber, label) => ({
  entityId,
  signerId,
  entityTxs: [{
    type: 'j_event',
    data: {
      from: signerId,
      event: {
        type: 'ReserveUpdated',
        data: {
          entity: entityId,
          tokenId,
          newBalance: amount.toString(),
          name: label,
          symbol: label,
          decimals,
        },
      },
      observedAt: Date.now(),
      blockNumber,
      transactionHash: `0xSIM_${label}_${blockNumber}`,
    },
  }],
});

const main = async () => {
  const env = createEmptyEnv();

  const applyAndCascade = async (serverInput) => {
    const result = await applyServerInput(env, serverInput);
    if (result.entityOutbox.length > 0) {
      await processUntilEmpty(env, result.entityOutbox);
    }
    return result;
  };

  const signer1 = '1';
  const signer2 = '2';
  const e1 = generateNumberedEntityId(1);
  const e2 = generateNumberedEntityId(2);

  const e1Config = { mode: 'proposer-based', threshold: 1n, validators: [signer1], shares: { [signer1]: 1n } };
  const e2Config = { mode: 'proposer-based', threshold: 1n, validators: [signer2], shares: { [signer2]: 1n } };

  await applyAndCascade({
    serverTxs: [
      { type: 'importReplica', entityId: e1, signerId: signer1, data: { config: e1Config, isProposer: true } },
      { type: 'importReplica', entityId: e2, signerId: signer2, data: { config: e2Config, isProposer: true } },
    ],
    entityInputs: [],
  });

  let block = 1;
  await applyAndCascade({
    serverTxs: [],
    entityInputs: [makeReserveEvent(e1, signer1, 1, 100000000000000000000n, 18, block++, 'ETH')],
  });

  const e1Before = env.replicas.get(`${e1}:${signer1}`);
  if (!e1Before?.state.reserves.get('1')) {
    throw new Error('Funding failed');
  }

  await applyAndCascade({
    serverTxs: [],
    entityInputs: [
      makeReserveEvent(e1, signer1, 1, 99000000000000000000n, 18, block++, 'ETH_OUT'),
      makeReserveEvent(e2, signer2, 1, 1000000000000000000n, 18, block++, 'ETH_IN'),
    ],
  });

  const e1AfterTransfer = env.replicas.get(`${e1}:${signer1}`);
  const e2AfterTransfer = env.replicas.get(`${e2}:${signer2}`);
  if (e1AfterTransfer?.state.reserves.get('1') !== 99000000000000000000n) {
    throw new Error('Reserve mismatch on sender after transfer');
  }
  if (e2AfterTransfer?.state.reserves.get('1') !== 1000000000000000000n) {
    throw new Error('Reserve mismatch on receiver after transfer');
  }

  await applyAndCascade({
    serverTxs: [],
    entityInputs: [{ entityId: e1, signerId: signer1, entityTxs: [{ type: 'openAccount', data: { targetEntityId: e2 } }] }],
  });

  await applyAndCascade({
    serverTxs: [],
    entityInputs: [{
      entityId: e1,
      signerId: signer1,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: e2,
          tokenId: 2,
          amount: 50000n,
          route: [e1, e2],
          description: 'Test payment',
        },
      }],
    }],
  });

  // Process any remaining cascades (auto-propose may queue additional outputs)
  await processUntilEmpty(env, []);

  const e1Final = env.replicas.get(`${e1}:${signer1}`);
  const e2Final = env.replicas.get(`${e2}:${signer2}`);
  const e1Account = e1Final?.state.accounts.get(e2);
  const e2Account = e2Final?.state.accounts.get(e1);

  if (!e1Account || !e2Account) {
    throw new Error('Account state missing after payment');
  }

  const delta1 = e1Account.deltas.get(2);
  const delta2 = e2Account.deltas.get(2);
  if (!delta1 || !delta2) {
    console.log('Delta contents', {
      e1Keys: Array.from(e1Account.deltas.keys()),
      e2Keys: Array.from(e2Account.deltas.keys()),
      e1: Array.from(e1Account.deltas.entries()),
      e2: Array.from(e2Account.deltas.entries()),
    });
    throw new Error('Payment token delta missing');
  }

  const e1Total = delta1.ondelta + delta1.offdelta;
  const e2Total = delta2.ondelta + delta2.offdelta;
  if (e1Total !== 50000n || e2Total !== -50000n) {
    throw new Error(`Payment mismatch: e1=${e1Total} e2=${e2Total}`);
  }
  if (e1Total + e2Total !== 0n) {
    throw new Error('Conservation failed');
  }

  console.log('✅ Payment flow ok', { e1, e2, e1Total: e1Total.toString(), e2Total: e2Total.toString() });
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
