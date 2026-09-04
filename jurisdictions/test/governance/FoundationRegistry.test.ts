import { expect } from 'chai';
import hre from 'hardhat';

import {
  boardHashOf,
  buildFoundationAction,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  encodeSingleSignerBoard,
  entityTransferFromTreasury,
} from '../helpers/hanko.ts';

const { ethers } = await hre.network.getOrCreate('hardhat');

const articles = {
  controlDelay: 3,
  dividendDelay: 5,
  foundationDelay: 7,
};

const actionArgumentsHash = (types: string[], values: unknown[]): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(types, values));

describe('Foundation authority', function () {
  async function fixture() {
    const signers = await ethers.getSigners();
    const provider = await deployEntityProvider(signers[0]!.address);
    const registerEntity = async (signerIndex: number): Promise<bigint> => {
      const encodedBoard = encodeSingleSignerBoard(signers[signerIndex]!.address);
      const authorization = await buildFoundationAction(
        provider,
        await provider.FOUNDATION_REGISTER_ENTITY(),
        actionArgumentsHash(
          ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'],
          [boardHashOf(encodedBoard), articles],
        ),
      );
      await provider.foundationRegisterEntity(
        encodedBoard,
        articles,
        authorization.hankoData,
        authorization.actionNonce,
      );
      return (await provider.nextNumber()) - 1n;
    };
    return { provider, signers, registerEntity };
  }

  it('does not turn minority Foundation control ownership into admin authority', async function () {
    const { provider, signers } = await fixture();
    const [controlTokenId] = await provider.getTokenIds(1);
    // Redesign: Foundation shares sit in entityTreasury(1), so the recipient EOA
    // moves them with a Foundation Hanko instead of a direct ERC1155 transfer.
    await entityTransferFromTreasury(provider, signers[4]!.address, controlTokenId, 1n);
    expect(await provider.balanceOf(signers[4]!.address, controlTokenId)).to.equal(1n);

    // foundationRegisterEntity is the Foundation action whose replay reaches the
    // nonce fence: a repeated board hash is a valid new numbered entity, so the
    // only thing that can reject the second call is the consumed action nonce.
    const encodedBoard = encodeSingleSignerBoard(signers[6]!.address);
    const argumentsHash = actionArgumentsHash(
      ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'],
      [boardHashOf(encodedBoard), articles],
    );
    const nextNumberBefore = await provider.nextNumber();
    const attackerAuthorization = await buildFoundationAction(
      provider,
      await provider.FOUNDATION_REGISTER_ENTITY(),
      argumentsHash,
      deriveHardhatPrivateKey(4),
    );
    await expect(provider.connect(signers[4]).foundationRegisterEntity(
      encodedBoard,
      articles,
      attackerAuthorization.hankoData,
      attackerAuthorization.actionNonce,
    )).to.be.revertedWithCustomError(provider, 'InvalidFoundationAuthorization');
    expect(await provider.nextNumber()).to.equal(nextNumberBefore);

    const validAuthorization = await buildFoundationAction(
      provider,
      await provider.FOUNDATION_REGISTER_ENTITY(),
      argumentsHash,
    );
    await provider.connect(signers[4]).foundationRegisterEntity(
      encodedBoard,
      articles,
      validAuthorization.hankoData,
      validAuthorization.actionNonce,
    );
    expect(await provider.nextNumber()).to.equal(nextNumberBefore + 1n);

    await expect(provider.connect(signers[4]).foundationRegisterEntity(
      encodedBoard,
      articles,
      validAuthorization.hankoData,
      validAuthorization.actionNonce,
    )).to.be.revertedWithCustomError(provider, 'InvalidFoundationActionNonce');
  });
});
