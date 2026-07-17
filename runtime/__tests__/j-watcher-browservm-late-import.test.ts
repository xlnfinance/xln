import { describe, expect, test } from 'bun:test';
import { computeAddress, hexlify } from 'ethers';

import { getSignerPrivateKey } from '../account/crypto';
import { getEntityConfigBoardHash } from '../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../jurisdiction/board-registry';
import { bootScenario, fundEntities, registerEntities } from '../scenarios/boot';
import { ensureSignerKeysFromSeed } from '../scenarios/helpers';
import { createEmptyEnv } from '../runtime';

const canonicalSigner = (env: ReturnType<typeof createEmptyEnv>, signerIndex: string): string =>
  computeAddress(hexlify(getSignerPrivateKey(env, signerIndex))).toLowerCase();

describe('BrowserVM J-watcher historical catch-up', () => {
  test('scenario signer initialization binds the witness runtime identity to its seed', () => {
    const seed = 'scenario witness runtime identity';
    const env = createEmptyEnv(null);
    env.runtimeSeed = seed;
    ensureSignerKeysFromSeed(env, ['2'], 'scenario witness');
    expect(env.runtimeId).toBe(canonicalSigner(env, '1'));

    const conflicting = createEmptyEnv(null);
    conflicting.runtimeSeed = seed;
    conflicting.runtimeId = `0x${'11'.repeat(20)}`;
    expect(() => ensureSignerKeysFromSeed(conflicting, ['2'], 'scenario witness'))
      .toThrow('scenario witness: runtimeId does not match runtimeSeed');
  });

  test('isolates the same signer slot as a canonical EOA in each Env key store', async () => {
    const firstEnv = createEmptyEnv('numeric signer isolation seed A');
    ensureSignerKeysFromSeed(firstEnv, ['1'], 'numeric signer isolation A');
    const firstAddress = canonicalSigner(firstEnv, '1');

    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'numeric-signer-isolation-browservm',
      seed: 'numeric signer isolation seed B',
      signerIds: ['1'],
      storageEnabled: false,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;
    try {
      const secondAddress = canonicalSigner(env, '1');
      const [registered] = await registerEntities(env, jadapter, [{
        name: 'Seed B Entity',
        signer: secondAddress,
        position: { x: 0, y: 0, z: 0 },
      }], jurisdiction);
      if (!registered) throw new Error('NUMERIC_SIGNER_ISOLATION_REGISTRATION_MISSING');
      const replica = env.eReplicas.get(`${registered.id}:${registered.signer}`);
      if (!replica) throw new Error('NUMERIC_SIGNER_ISOLATION_REPLICA_MISSING');

      const onchain = await jadapter.entityProvider.getEntityInfo(registered.id);
      expect(secondAddress).not.toBe(firstAddress);
      expect(registered.signer).toBe(secondAddress);
      expect(replica.state.config.validators).toEqual([secondAddress]);
      expect(onchain.currentBoardHash.toLowerCase()).toBe(
        await getEntityConfigBoardHash(env, replica.state.config),
      );
      expect(jadapter.getBrowserVM()?.getEntityWallet(registered.id).address.toLowerCase())
        .toBe(secondAddress);
    } finally {
      await jadapter.close();
    }
  }, 30_000);

  test('certifies a numbered entity board registered before its replica import', async () => {
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'j-watcher-browservm-late-import',
      seed: 'j-watcher-browservm-late-import',
      signerIds: ['1'],
      storageEnabled: false,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;

    try {
      const signer = canonicalSigner(env, '1');
      const [registered] = await registerEntities(env, jadapter, [{
        name: 'Late Numbered Entity',
        signer,
        position: { x: 0, y: 0, z: 0 },
      }], jurisdiction);
      if (!registered) throw new Error('BROWSERVM_LATE_IMPORT_REGISTRATION_MISSING');

      const onchain = await jadapter.entityProvider.getEntityInfo(registered.id);
      expect(onchain.exists).toBe(true);
      const replica = env.eReplicas.get(`${registered.id}:${registered.signer}`);
      if (!replica) throw new Error('BROWSERVM_LATE_IMPORT_REPLICA_MISSING');

      expect(replica.jHistory?.scannedThroughHeight).toBeGreaterThanOrEqual(Number(onchain.registrationBlock));
      expect(replica.state.lastFinalizedJHeight).toBeGreaterThanOrEqual(Number(onchain.registrationBlock));
      expect(resolveObserverCertifiedBoardHash(
        replica.state,
        getCertifiedBoardNodeStore(env),
        registered.id,
      )).toBe(onchain.currentBoardHash.toLowerCase());
    } finally {
      await jadapter.close();
    }
  }, 30_000);

  test('advances every local scan when a block event applies to only one entity', async () => {
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'j-watcher-browservm-multi-entity-scan',
      seed: 'j-watcher-browservm-multi-entity-scan',
      signerIds: ['1', '2'],
      storageEnabled: false,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;

    try {
      const senderSigner = canonicalSigner(env, '1');
      const observerSigner = canonicalSigner(env, '2');
      const [sender, observer] = await registerEntities(env, jadapter, [
        { name: 'Sender', signer: senderSigner, position: { x: -1, y: 0, z: 0 } },
        { name: 'Observer', signer: observerSigner, position: { x: 1, y: 0, z: 0 } },
      ], jurisdiction);
      if (!sender || !observer) throw new Error('BROWSERVM_MULTI_ENTITY_REGISTRATION_MISSING');

      await fundEntities(env, jadapter, [{ id: sender.id, tokenId: 1, amount: 100n }]);
      const targetBlock = Number(await jadapter.getCurrentBlockNumber?.());
      const senderReplica = env.eReplicas.get(`${sender.id}:${sender.signer}`);
      const observerReplica = env.eReplicas.get(`${observer.id}:${observer.signer}`);
      if (!senderReplica || !observerReplica) throw new Error('BROWSERVM_MULTI_ENTITY_REPLICA_MISSING');

      expect(senderReplica.state.reserves.get(1)).toBe(100n);
      expect(senderReplica.jHistory?.scannedThroughHeight).toBe(targetBlock);
      expect(observerReplica.jHistory?.scannedThroughHeight).toBe(targetBlock);
    } finally {
      await jadapter.close();
    }
  }, 30_000);
});
