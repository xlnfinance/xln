import { expect, test } from 'bun:test';
import { HDNodeWallet } from 'ethers';
import * as xln from '@xln/core/runtime';
import { clearSignerKeys, getCachedSignerPrivateKey, prewarmNumericSigners } from '@xln/core/account/crypto';
import { generateLazyEntityId } from '@xln/core/entity/factory';
import { deriveJurisdictionSignerIndex } from '@xln/core/jurisdiction/machine/config/signer-derivation';
import { createTestEntityImportRuntimeTx } from '@xln/core/qa/entity-creation-fixture';
import { createTestJReplica } from '@xln/core/__tests__/helpers/j-replica';
import { computeCanonicalStateHashFromEnv } from '@xln/core/storage/canonical-hash';
import { readRuntimeMetadata } from '@xln/core/runtime/loop/loop-environment';
import type { RuntimeInput, RuntimeReplica } from '@xln/core/runtime/types';
import { prepareWalletSignerKeys } from './wallet-signers';
import { deriveAddress } from './keys';

for (const materializePeriodFrames of [1, 100]) {
  test(`offline wallet restores a secondary signer before signing: materialize every ${materializePeriodFrames}`, async () => {
    const seed = HDNodeWallet.createRandom().mnemonic!.phrase;
    const secondaryLabel = String(deriveJurisdictionSignerIndex('Secondary') + 1);
    const [primary, secondary] = prewarmNumericSigners(seed, ['1', secondaryLabel]);
    if (!primary || !secondary) throw new Error('SIGNER_FIXTURE_MISSING');
    const env = xln.createEmptyEnv(seed, 1);
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: {
        ...env.runtimeConfig?.storage,
        materializePeriodFrames,
        snapshotPeriodFrames: 100,
      },
    };
    const jurisdiction = {
      name: 'Secondary',
      address: 'browservm://Secondary',
      chainId: 31337,
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
    };
    env.state.jReplicas.set(
      jurisdiction.name,
      createTestJReplica({
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        contracts: {
          depository: jurisdiction.depositoryAddress,
          entityProvider: jurisdiction.entityProviderAddress,
          account: '0x000000000000000000000000000000000000ac01',
          deltaTransformer: '0x000000000000000000000000000000000000de17',
        },
      }),
    );
    const imported = (signerId: string) =>
      createTestEntityImportRuntimeTx(env, {
        entityId: generateLazyEntityId([signerId], 1n),
        signerId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction,
          },
        },
      });
    let restored: RuntimeReplica | null = null;
    try {
      xln.enqueueRuntimeInput(env, { runtimeTxs: [imported(primary)], entityInputs: [] });
      await xln.processRuntime(env, []);
      xln.enqueueRuntimeInput(env, { runtimeTxs: [imported(secondary)], entityInputs: [] });
      await xln.processRuntime(env, []);
      await xln.processRuntime(env, [
        {
          entityId: generateLazyEntityId([secondary], 1n),
          signerId: secondary,
          entityTxs: [
            {
              type: 'profile-update',
              data: {
                profile: {
                  entityId: generateLazyEntityId([secondary], 1n),
                  name: 'Signed secondary after checkpoint',
                },
              },
            },
          ],
        },
      ]);
      for (let step = 0; step < 4; step++) await xln.processRuntime(env, []);
      const owner = [...env.state.eReplicas.values()].find(replica => replica.signerId === secondary);
      expect(owner!.state.height).toBeGreaterThan(0);
      const expected = computeCanonicalStateHashFromEnv(env);
      await xln.closeRuntimeDb(env);
      await xln.closeInfraDb(env);
      clearSignerKeys(seed);
      const prepared: number[] = [];
      restored = await xln.loadEnvFromDB(primary, seed, {
        prepareLocalSigners: (target: RuntimeReplica, input?: RuntimeInput) => {
          prepared.push(target.state.height);
          prepareWalletSignerKeys({ prewarmNumericSigners, getCachedSignerPrivateKey }, seed, target, input);
        },
      });
      expect(restored).not.toBeNull();
      expect(getCachedSignerPrivateKey(seed, secondary)).not.toBeNull();
      expect(prepared.length).toBeGreaterThan(0);
      expect(computeCanonicalStateHashFromEnv(restored!)).toBe(expected);
      const meta = readRuntimeMetadata(restored!, '__replayMeta') as { replayedFrameCount: number };
      if (materializePeriodFrames === 1) expect(meta.replayedFrameCount).toBe(0);
      else expect(meta.replayedFrameCount).toBeGreaterThan(0);
    } finally {
      await xln.closeRuntimeDb(env);
      await xln.closeInfraDb(env);
      if (restored) {
        await xln.closeRuntimeDb(restored);
        await xln.closeInfraDb(restored);
      }
      clearSignerKeys(seed);
    }
  }, 60_000);
}

test('wallet signer preparation proves exact EOA, jurisdiction path and seed scope without changing state', () => {
  const seed = HDNodeWallet.createRandom().mnemonic!.phrase;
  const otherSeed = HDNodeWallet.createRandom().mnemonic!.phrase;
  const secondary = deriveAddress(seed, deriveJurisdictionSignerIndex('Secondary'));
  const foreign = deriveAddress(otherSeed, deriveJurisdictionSignerIndex('Secondary'));
  const env = xln.createEmptyEnv(seed, 1);
  const imported = (address: string, name: string) =>
    createTestEntityImportRuntimeTx(env, {
      entityId: generateLazyEntityId([address], 1n),
      signerId: address,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [address],
          shares: { [address]: 1n },
          jurisdiction: {
            name,
            address: 'browservm://Secondary',
            chainId: 31337,
            depositoryAddress: '0x000000000000000000000000000000000000dEaD',
            entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
          },
        },
      },
    });
  const prepare = (address: string, name: string) =>
    prepareWalletSignerKeys({ prewarmNumericSigners, getCachedSignerPrivateKey }, seed, env, {
      runtimeTxs: [imported(address, name)],
      entityInputs: [],
    });
  const root = computeCanonicalStateHashFromEnv(env);
  try {
    clearSignerKeys(seed);
    prepare(secondary, 'Wrong jurisdiction');
    expect(getCachedSignerPrivateKey(seed, secondary)).toBeNull();
    prepare(foreign, 'Secondary');
    expect(getCachedSignerPrivateKey(seed, foreign)).toBeNull();
    prepare(secondary, 'Secondary');
    expect(getCachedSignerPrivateKey(seed, secondary)).not.toBeNull();
    expect(getCachedSignerPrivateKey(otherSeed, secondary)).toBeNull();
    expect(computeCanonicalStateHashFromEnv(env)).toBe(root);
  } finally {
    clearSignerKeys(seed);
    clearSignerKeys(otherSeed);
  }
});
