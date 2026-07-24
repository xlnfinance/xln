import { expect } from 'chai';
import hre from 'hardhat';

import {
  buildFoundationAction,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const { ethers } = hre;

const articles = {
  controlDelay: 3,
  dividendDelay: 5,
  foundationDelay: 7,
};

const actionArgumentsHash = (types: string[], values: unknown[]): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(types, values));

describe('Foundation authority and name registry', function () {
  async function fixture() {
    const signers = await ethers.getSigners();
    const provider = await deployEntityProvider(signers[0]!.address);
    const registerEntity = async (signerIndex: number): Promise<bigint> => {
      const boardHash = singleSignerLazyEntityId(signers[signerIndex]!.address);
      const authorization = await buildFoundationAction(
        provider,
        await provider.FOUNDATION_REGISTER_ENTITY(),
        actionArgumentsHash(
          ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'],
          [boardHash, articles],
        ),
      );
      await provider.foundationRegisterEntity(
        boardHash,
        articles,
        authorization.hankoData,
        authorization.actionNonce,
      );
      return (await provider.nextNumber()) - 1n;
    };
    return { provider, signers, registerEntity };
  }

  async function authorizeName(
    provider: Awaited<ReturnType<typeof deployEntityProvider>>,
    kind: 'assign' | 'transfer',
    name: string,
    entityNumber: bigint,
  ) {
    const actionType = kind === 'assign'
      ? await provider.FOUNDATION_ASSIGN_NAME()
      : await provider.FOUNDATION_TRANSFER_NAME();
    return buildFoundationAction(
      provider,
      actionType,
      actionArgumentsHash(['string', 'uint256'], [name, entityNumber]),
    );
  }

  async function assertBijection(
    provider: Awaited<ReturnType<typeof deployEntityProvider>>,
    names: readonly string[],
    entityNumbers: readonly bigint[],
  ): Promise<void> {
    for (const name of names) {
      const owner = await provider.nameToNumber(name);
      if (owner === 0n) continue;
      expect(await provider.numberToName(owner)).to.equal(name);
    }
    for (const entityNumber of entityNumbers) {
      const name = await provider.numberToName(entityNumber);
      if (name.length === 0) continue;
      expect(await provider.nameToNumber(name)).to.equal(entityNumber);
    }
  }

  it('preserves a bijective name mapping through replacement transfers', async function () {
    const { provider, registerEntity } = await fixture();
    const entities = [
      await registerEntity(1),
      await registerEntity(2),
      await registerEntity(3),
    ];
    const names = ['alpha', 'beta', 'gamma'] as const;

    for (let index = 0; index < names.length; index += 1) {
      const authorization = await authorizeName(provider, 'assign', names[index]!, entities[index]!);
      await provider.assignName(
        names[index]!,
        entities[index]!,
        authorization.hankoData,
        authorization.actionNonce,
      );
      await assertBijection(provider, names, entities);
    }

    for (const [name, target] of [
      ['alpha', entities[1]!],
      ['gamma', entities[0]!],
      ['alpha', entities[2]!],
    ] as const) {
      const authorization = await authorizeName(provider, 'transfer', name, target);
      await provider.transferName(name, target, authorization.hankoData, authorization.actionNonce);
      await assertBijection(provider, names, entities);
    }

    expect(await provider.nameToNumber('beta')).to.equal(0n);
    expect(await provider.nameToNumber('gamma')).to.equal(entities[0]);
    expect(await provider.nameToNumber('alpha')).to.equal(entities[2]);
  });

  it('does not turn minority Foundation control ownership into admin authority', async function () {
    const { provider, signers } = await fixture();
    const [controlTokenId] = await provider.getTokenIds(1);
    await provider.safeTransferFrom(
      signers[0]!.address,
      signers[4]!.address,
      controlTokenId,
      1n,
      '0x',
    );

    const user = signers[6]!.address;
    const argumentsHash = actionArgumentsHash(['address', 'uint8'], [user, 7]);
    const attackerAuthorization = await buildFoundationAction(
      provider,
      await provider.FOUNDATION_SET_NAME_QUOTA(),
      argumentsHash,
      deriveHardhatPrivateKey(4),
    );
    await expect(provider.connect(signers[4]).setNameQuota(
      user,
      7,
      attackerAuthorization.hankoData,
      attackerAuthorization.actionNonce,
    )).to.be.revertedWithCustomError(provider, 'InvalidFoundationAuthorization');
    expect(await provider.nameQuota(user)).to.equal(0);

    const validAuthorization = await buildFoundationAction(
      provider,
      await provider.FOUNDATION_SET_NAME_QUOTA(),
      argumentsHash,
    );
    await provider.connect(signers[4]).setNameQuota(
      user,
      7,
      validAuthorization.hankoData,
      validAuthorization.actionNonce,
    );
    expect(await provider.nameQuota(user)).to.equal(7);

    await expect(provider.connect(signers[4]).setNameQuota(
      user,
      7,
      validAuthorization.hankoData,
      validAuthorization.actionNonce,
    )).to.be.revertedWithCustomError(provider, 'InvalidFoundationActionNonce');
  });
});
