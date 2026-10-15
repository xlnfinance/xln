import { ZeroHash } from 'ethers';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types';
import { COMPANY_QUOTE_FUNDING } from '../../core/scenarios/company-ipo/model';
import type { JAdapter } from '../../core/jurisdiction/adapter/types';

/** A distinct ERC20 in the private demo EVM, never an alias for a dollar asset. */
export async function deploySpice(adapter: JAdapter): Promise<number> {
  if (adapter.mode !== 'browservm') throw new Error('ARRAKIS_REQUIRES_PRIVATE_EVM');
  const token = await new ERC20Mock__factory(adapter.signer).deploy('Spice', 'SPICE', 6, 1_000_000_000n * 1_000_000n, {
    gasLimit: 5_000_000n,
  });
  await token.waitForDeployment();
  const address = await token.getAddress();
  await (await token.approve(adapter.addresses.depository, 1n)).wait();
  await (
    await adapter.depository.adminRegisterExternalToken({
      entity: ZeroHash,
      contractAddress: address,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: 1n,
    })
  ).wait();
  // Match the two 7M reserve grants with actual ERC20 held by Depository.
  await (await token.transfer(adapter.addresses.depository, 2n * COMPANY_QUOTE_FUNDING)).wait();
  if ((await token.balanceOf(adapter.addresses.depository)) !== 2n * COMPANY_QUOTE_FUNDING + 1n) {
    throw new Error('ARRAKIS_SPICE_CUSTODY_MISMATCH');
  }
  const registered = (await adapter.getTokenRegistry()).find(
    item => item.address.toLowerCase() === address.toLowerCase(),
  );
  if (!registered || registered.symbol !== 'SPICE' || registered.decimals !== 6)
    throw new Error('ARRAKIS_SPICE_REGISTRATION_MISSING');
  return registered.tokenId;
}
