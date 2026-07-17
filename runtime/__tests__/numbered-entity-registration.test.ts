import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { getSignerPrivateKey } from '../account/crypto';
import {
  createNumberedEntitiesBatch,
  createNumberedEntity,
  hashBoard,
  encodeBoard,
  parseNumberedEntityRegistrationReceipt,
} from '../entity/factory';
import { createJAdapter } from '../jadapter';
import { createEmptyEnv } from '../runtime';
import type { JReplica, JurisdictionConfig } from '../types';

const makeReplica = (
  name: string,
  adapter: Awaited<ReturnType<typeof createJAdapter>>,
): JReplica => ({
  name,
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  chainId: adapter.chainId,
  position: { x: 0, y: 0, z: 0 },
  depositoryAddress: adapter.addresses.depository,
  entityProviderAddress: adapter.addresses.entityProvider,
  contracts: { ...adapter.addresses },
  jadapter: adapter,
});

describe('numbered Entity registration authority', () => {
  test('batch receipt parser rejects missing, extra, reordered, and mismatched registrations', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const env = createEmptyEnv('numbered-registration:receipt-order');
      const privateKey = getSignerPrivateKey(env, '4');
      const wallet = new ethers.Wallet(ethers.hexlify(privateKey), adapter.provider);
      if (!adapter.fundSignerWallet) throw new Error('NUMBERED_REGISTRATION_TEST_WALLET_BOUNDARY_MISSING');
      await adapter.fundSignerWallet(wallet.address);
      const boardHashes = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] as const;
      const tx = await adapter.entityProvider.connect(wallet).registerNumberedEntitiesBatch(boardHashes);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('NUMBERED_REGISTRATION_TEST_RECEIPT_MISSING');

      expect(parseNumberedEntityRegistrationReceipt(adapter, receipt, boardHashes)).toEqual([
        { entityNumber: 2, entityId: `0x${'2'.padStart(64, '0')}`, logIndex: 2 },
        { entityNumber: 3, entityId: `0x${'3'.padStart(64, '0')}`, logIndex: 6 },
      ]);
      expect(() => parseNumberedEntityRegistrationReceipt(
        adapter,
        receipt,
        [...boardHashes, `0x${'33'.repeat(32)}`],
      )).toThrow('NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=3:actual=2');
      expect(() => parseNumberedEntityRegistrationReceipt(adapter, receipt, [boardHashes[0]]))
        .toThrow('NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=1:actual=2');
      expect(() => parseNumberedEntityRegistrationReceipt(adapter, receipt, [...boardHashes].reverse()))
        .toThrow('NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=0');
      expect(() => parseNumberedEntityRegistrationReceipt(
        adapter,
        receipt,
        [boardHashes[0], `0x${'44'.repeat(32)}`],
      )).toThrow('NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=1');
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('batch uses the exact trusted Env adapter and explicitly selected vault payer', async () => {
    const chainId = 31_338;
    const adapter = await createJAdapter({ mode: 'browservm', chainId });
    try {
      const env = createEmptyEnv('numbered-registration:batch-selected-wallet');
      const payerPrivateKey = getSignerPrivateKey(env, '3');
      const payerAddress = new ethers.Wallet(ethers.hexlify(payerPrivateKey)).address.toLowerCase();
      if (!adapter.fundSignerWallet || !adapter.getEthBalance) {
        throw new Error('NUMBERED_REGISTRATION_TEST_WALLET_BOUNDARY_MISSING');
      }
      await adapter.fundSignerWallet(payerAddress);
      const jurisdiction: JurisdictionConfig = {
        name: 'BatchRegistrationStack',
        address: 'browservm://batch-registration-stack',
        chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      env.jAdapter = adapter;
      env.jReplicas.set(jurisdiction.name, makeReplica(jurisdiction.name, adapter));
      const payerBefore = await adapter.getEthBalance(payerAddress);

      const results = await createNumberedEntitiesBatch(
        [
          { name: 'first', validators: [payerAddress], threshold: 1n },
          {
            name: 'second',
            validators: [payerAddress, '0x1111111111111111111111111111111111111111'],
            threshold: 2n,
          },
          { name: 'third', validators: [payerAddress], threshold: 1n },
        ],
        jurisdiction,
        env,
        payerAddress,
      );

      expect(results.map((result) => result.entityNumber)).toEqual([2, 3, 4]);
      expect(results.map((result) => result.entityId)).toEqual([2, 3, 4].map((number) =>
        `0x${number.toString(16).padStart(64, '0')}`));
      expect(await adapter.entityProvider.nextNumber()).toBe(5n);
      expect(await adapter.getEthBalance(payerAddress)).toBeLessThan(payerBefore);
      for (const result of results) {
        expect((await adapter.entityProvider.entities(result.entityId)).currentBoardHash).toBe(
          hashBoard(encodeBoard(result.config, env)),
        );
      }
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('uses the exact trusted Env adapter and explicitly selected vault signer', async () => {
    const chainId = 31_338;
    const adapter = await createJAdapter({ mode: 'browservm', chainId });
    try {
      const env = createEmptyEnv('numbered-registration:selected-wallet');
      const signerPrivateKey = getSignerPrivateKey(env, '2');
      const signerAddress = new ethers.Wallet(ethers.hexlify(signerPrivateKey)).address.toLowerCase();
      const adapterSignerAddress = (await adapter.signer.getAddress()).toLowerCase();
      expect(signerAddress).not.toBe(adapterSignerAddress);

      if (!adapter.fundSignerWallet || !adapter.getEthBalance) {
        throw new Error('NUMBERED_REGISTRATION_TEST_WALLET_BOUNDARY_MISSING');
      }
      await adapter.fundSignerWallet(signerAddress);

      const name = 'RegistrationStack';
      const jurisdiction: JurisdictionConfig = {
        name,
        address: 'browservm://registration-stack',
        chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      env.jReplicas.set(name, makeReplica(name, adapter));
      env.jAdapter = adapter;

      const selectedBefore = await adapter.getEthBalance(signerAddress);
      const adapterSignerBefore = await adapter.getEthBalance(adapterSignerAddress);
      expect(await adapter.entityProvider.nextNumber()).toBe(2n);

      const result = await createNumberedEntity(
        'weighted-multisig',
        [
          { name: signerAddress, weight: 2 },
          { name: '0x1111111111111111111111111111111111111111', weight: 1 },
        ],
        2n,
        jurisdiction,
        env,
        signerAddress,
      );

      expect(result.entityNumber).toBe(2);
      expect(result.entityId).toBe(`0x${'2'.padStart(64, '0')}`);
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);
      expect((await adapter.entityProvider.entities(result.entityId)).currentBoardHash).toBe(
        hashBoard(encodeBoard(result.config, env)),
      );
      expect(await adapter.getEthBalance(signerAddress)).toBeLessThan(selectedBefore);
      expect(await adapter.getEthBalance(adapterSignerAddress)).toBe(adapterSignerBefore);
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('fails closed without one exact live adapter or an explicit vault signer', async () => {
    const chainId = 31_338;
    const adapter = await createJAdapter({ mode: 'browservm', chainId });
    try {
      const jurisdiction: JurisdictionConfig = {
        name: 'RegistrationStack',
        address: 'browservm://registration-stack',
        chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      const missingAdapter = createEmptyEnv('numbered-registration:missing-adapter');
      await expect(createNumberedEntity(
        'must-not-connect-fresh',
        ['0x1111111111111111111111111111111111111111'],
        1n,
        jurisdiction,
        missingAdapter,
        '1',
      )).rejects.toThrow('NUMBERED_REGISTRATION_TRUSTED_ADAPTER_MISSING');

      const missingSigner = createEmptyEnv('numbered-registration:missing-signer');
      missingSigner.jAdapter = adapter;
      await expect(createNumberedEntity(
        'entity-id-must-not-propose',
        [`0x${'33'.repeat(32)}`, '0x1111111111111111111111111111111111111111'],
        1n,
        jurisdiction,
        missingSigner,
        '1',
      )).rejects.toThrow('BOARD_PROPOSER_EOA_REQUIRED');
      expect(await adapter.entityProvider.nextNumber()).toBe(2n);

      await expect(createNumberedEntity(
        'must-not-use-adapter-default',
        ['0x1111111111111111111111111111111111111111'],
        1n,
        jurisdiction,
        missingSigner,
        undefined as never,
      )).rejects.toThrow('NUMBERED_REGISTRATION_SIGNER_REQUIRED');
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('fails closed when two disconnected adapters claim the same stack', async () => {
    const chainId = 31_338;
    const [first, second] = await Promise.all([
      createJAdapter({ mode: 'browservm', chainId }),
      createJAdapter({ mode: 'browservm', chainId }),
    ]);
    try {
      expect(second.addresses).toEqual(first.addresses);
      const jurisdiction: JurisdictionConfig = {
        name: 'RegistrationStack',
        address: 'browservm://registration-stack',
        chainId,
        depositoryAddress: first.addresses.depository,
        entityProviderAddress: first.addresses.entityProvider,
      };
      const env = createEmptyEnv('numbered-registration:ambiguous');
      env.jAdapter = first;
      env.jReplicas.set('duplicate-stack', makeReplica('duplicate-stack', second));
      await expect(createNumberedEntity(
        'must-not-guess-vm',
        ['0x1111111111111111111111111111111111111111'],
        1n,
        jurisdiction,
        env,
        '1',
      )).rejects.toThrow('NUMBERED_REGISTRATION_TRUSTED_ADAPTER_AMBIGUOUS');
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 30_000);
});
