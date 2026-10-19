import { expect } from 'chai';
import hre from 'hardhat';
import { createWatchedErc20TokenReader } from '../../../core/jurisdiction/adapter/rpc-watcher-inputs.ts';

import {
  boardHashOf,
  buildFoundationAction,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  encodeSingleSignerBoard,
  entityTransferFromTreasury,
  foundationListExternalToken,
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

  it('assigns stable token IDs only through a Foundation listing', async function () {
    const { provider, signers } = await fixture();
    const { depository } = await deployDepositoryStack(await provider.getAddress());
    const token = await (await ethers.getContractFactory('ERC20Mock')).deploy('ERC20Mock', 'ERC20', 18, 1_000_000);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const watcherDebugEvents: Record<string, unknown>[] = [];
    const readWatchedTokens = createWatchedErc20TokenReader(
      depository,
      calls => Promise.all(calls.map(call => ethers.provider.send(call.method, call.params))),
      payload => watcherDebugEvents.push(payload),
    );
    // Only Foundation authority through EntityProvider may list: neither an
    // unrelated EOA nor the deployment admin has direct Depository authority.
    await expect(
      depository.connect(signers[1]).registerExternalToken(0, tokenAddress, 0),
    ).to.be.revertedWithCustomError(depository, 'E2');
    await expect(
      depository.connect(signers[0]).registerExternalToken(0, tokenAddress, 0),
    ).to.be.revertedWithCustomError(depository, 'E2');
    expect(await readWatchedTokens()).to.deep.equal([]);
    const argumentsHash = actionArgumentsHash(
      ['address', 'uint8', 'address', 'uint256'],
      [await depository.getAddress(), 0, tokenAddress, 0],
    );
    const listing = await buildFoundationAction(provider, await provider.FOUNDATION_REGISTER_TOKEN(), argumentsHash);
    await expect(
      provider.foundationRegisterExternalToken(
        await depository.getAddress(),
        0,
        tokenAddress,
        0,
        listing.hankoData,
        listing.actionNonce,
      ),
    )
      .to.emit(depository, 'TokenRegistered')
      .withArgs(1n, 0, tokenAddress, 0n);
    expect(await readWatchedTokens()).to.deep.equal([{ tokenId: 1, address: tokenAddress.toLowerCase() }]);
    await foundationListExternalToken(provider, await depository.getAddress(), 0, tokenAddress, 0);
    expect(await depository.getTokensLength()).to.equal(2n);
    expect(await readWatchedTokens()).to.deep.equal([{ tokenId: 1, address: tokenAddress.toLowerCase() }]);
    expect(watcherDebugEvents).to.deep.equal([]);
  });

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
