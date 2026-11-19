import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NonceManager, Wallet } from 'ethers';
import { generateLazyEntityId } from '../../../entity/factory';
import { buildExternalTokenToReserveBatch } from '../../../jurisdiction/adapter/events/contract-codec';
import { prepareSignedBatch } from '../../../hanko/batch';
import { safeStringify } from '../../../protocol/serialization';
import { targetContracts } from '../target-evidence';
import { targetUser } from './context';
import type { PocUser } from '../user';

/** Fixture sponsor only. Confirm an actual Anvil before accessing its published key. */
export const fundLocalTarget = async (user: PocUser, hub: string, amount: bigint, apiBase: string) => {
  const contracts = await targetContracts(targetUser(user, apiBase));
  try {
    await contracts.provider.send('anvil_nodeInfo', []);
    const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk', contracts.provider);
    const signer = new NonceManager(wallet);
    const chainId = (await contracts.provider.getNetwork()).chainId;
    const operatorEntity = String(generateLazyEntityId([wallet.address], 1n));
    const before = await contracts.depository._reserves(hub, 1);
    const tokenBefore = await contracts.token.balanceOf(await contracts.depository.getAddress());
    const operatorTokenBefore = await contracts.token.balanceOf(wallet.address);
    const approval = await (
      await contracts.token.connect(signer).approve(await contracts.depository.getAddress(), amount)
    ).wait();
    if (!approval || approval.status !== 1) throw new Error('USDC_POC_OPERATOR_APPROVAL_FAILED');
    const batch = buildExternalTokenToReserveBatch({
      entityId: hub,
      tokenAddress: await contracts.token.getAddress(),
      amount,
      internalTokenId: 1,
    });
    const signed = prepareSignedBatch(
      batch,
      operatorEntity,
      wallet.privateKey,
      chainId,
      await contracts.depository.getAddress(),
      await contracts.depository.entityNonces(operatorEntity),
    );
    const receipt = await (
      await contracts.depository.connect(signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce)
    ).wait();
    if (!receipt || receipt.status !== 1) throw new Error('USDC_POC_OPERATOR_DEPOSIT_FAILED');
    const after = await contracts.depository._reserves(hub, 1);
    const tokenAfter = await contracts.token.balanceOf(await contracts.depository.getAddress());
    const operatorTokenAfter = await contracts.token.balanceOf(wallet.address);
    if (
      after - before !== amount ||
      tokenAfter - tokenBefore !== amount ||
      operatorTokenBefore - operatorTokenAfter !== amount
    )
      throw new Error('USDC_POC_OPERATOR_BACKING_MISMATCH');
    const funding = {
      amount,
      approvalHash: approval.hash,
      approvalBlock: approval.blockNumber,
      depositoryAddress: await contracts.depository.getAddress(),
      tokenAddress: await contracts.token.getAddress(),
      reserveBefore: before,
      reserveAfter: after,
      tokenBefore,
      tokenAfter,
      operatorTokenBefore,
      operatorTokenAfter,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      operator: wallet.address,
      operatorEntity,
    };
    writeFileSync(join(user.directory, 'target-operator-funding.json'), safeStringify(funding, 2));
    return funding;
  } finally {
    contracts.provider.destroy();
  }
};
