import { NonceManager, Wallet } from 'ethers';
import { ERC20Mock__factory } from '../../../../../jurisdictions/typechain-types';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../../jurisdiction/adapter';
import { foundationRegisterExternalToken } from '../../../../jurisdiction/adapter/operations/foundation-token-listing';
import { buildExternalTokenToReserveBatch } from '../../../../jurisdiction/adapter/events/contract-codec';
import { prepareSignedBatch } from '../../../../hanko/batch';
import { generateLazyEntityId } from '../../../../entity/factory';

export const deployFixtureChain = async (
  index: number,
  rpc: string,
  hub: string,
  adapters: JAdapter[],
  reserveAmount = index === 0 ? 1_000_000n : 5_000_000n,
) => {
  const chainId = index === 0 ? 11155111 : 421614;
  const provider = createXlnJsonRpcProvider(rpc);
  const genesis = Wallet.fromPhrase('test test test test test test test test test test test junk');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch (error) {
        if (attempt === 100) throw error;
        await Bun.sleep(50);
      }
    }
    const adapter = await createJAdapter({ mode: 'rpc', chainId, rpcUrl: rpc, privateKey: genesis.privateKey });
    adapters.push(adapter);
    await adapter.deployStack();
    const signer = new NonceManager(genesis.connect(provider));
    const token = await new ERC20Mock__factory(signer).deploy('USD Coin', 'USDC', 6, 10_000_000n);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const depository = adapter.depository.connect(signer);
    await foundationRegisterExternalToken(
      adapter.entityProvider.connect(signer),
      {
        depository: adapter.addresses.depository,
        tokenType: 0,
        contractAddress: tokenAddress,
        externalTokenId: 0n,
      },
      genesis.privateKey,
    );
    if (reserveAmount < 0n) throw new Error('USDC_FIXTURE_NEGATIVE_RESERVE');
    if (reserveAmount > 0n) {
      await (await token.approve(adapter.addresses.depository, reserveAmount)).wait();
      const operator = generateLazyEntityId([genesis.address], 1n);
      const batch = buildExternalTokenToReserveBatch({
        entityId: hub,
        tokenAddress,
        amount: reserveAmount,
        internalTokenId: 1,
      });
      const signed = prepareSignedBatch(
        batch,
        operator,
        genesis.privateKey,
        BigInt(chainId),
        adapter.addresses.depository,
        await depository.entityNonces(operator),
      );
      await (await depository.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce)).wait();
    }
    return {
      name: index === 0 ? 'Ethereum Sepolia' : 'Arbitrum Sepolia',
      chainId,
      primary: index === 0,
      blockTimeMs: 1_000,
      contracts: { ...adapter.addresses },
      entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
      explorer: '',
      currency: 'ETH',
      status: 'active',
      tokens: { USDC: { tokenId: 1, address: tokenAddress, decimals: 6 } },
    };
  } finally {
    provider.destroy();
  }
};
