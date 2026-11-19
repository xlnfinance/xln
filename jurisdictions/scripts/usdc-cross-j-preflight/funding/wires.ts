import { Interface, Transaction, Wallet } from 'ethers';
import { Depository__factory } from '../../../typechain-types';
import { decodeJBatch } from '../../../../core/jurisdiction/machine/batch';
import { buildExternalTokenToReserveBatch } from '../../../../core/jurisdiction/adapter/events/contract-codec';
import { prepareSignedBatch } from '../../../../core/hanko/batch';
import { fundingSlots, type FundingChain, type FundingSlot } from './authority';

const erc20 = new Interface([
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
]);
const depository = Depository__factory.createInterface();
const requireCall = (condition: boolean): void => {
  if (!condition) throw new Error('USDC_FUNDING_CALL_NOT_AUTHORIZED');
};

export const fundingTransfer = (chain: FundingChain, stage: Exclude<FundingSlot['stage'], 'deposit'>) => {
  if (stage === 'approval') {
    return { to: chain.token, data: erc20.encodeFunctionData('approve', [chain.depository, chain.limits.amount]) };
  }
  if (stage === 'native-topup') return { to: chain.hubSigner, data: '0x' };
  const user = chain.limits.userFunding;
  if (!user) throw new Error('USDC_FUNDING_USER_SCOPE_INVALID');
  if (stage === 'user-native-topup') return { to: user.signer, data: '0x' };
  return { to: chain.token, data: erc20.encodeFunctionData('transfer', [user.signer, user.usdcAtoms]) };
};

const signDeposit = (chain: FundingChain, signer: Wallet) => {
  const batch = buildExternalTokenToReserveBatch({
    entityId: chain.hubEntity,
    tokenAddress: chain.token,
    amount: chain.limits.amount,
    internalTokenId: 1,
  });
  const signed = prepareSignedBatch(
    batch,
    chain.funderEntity,
    signer.privateKey,
    BigInt(chain.chainId),
    chain.depository,
    chain.entityNonce,
  );
  return {
    to: chain.depository,
    data: depository.encodeFunctionData('processBatch', [signed.encodedBatch, signed.hankoData, signed.nextNonce]),
  };
};

/** Exact fixed fee fields make the same approved slot reconstruct the same wire
 * after a lost response. A process restart never allocates another deposit. */
export const signFundingWires = async (chain: FundingChain, signer: Wallet): Promise<readonly string[]> => {
  return Promise.all(
    fundingSlots(chain.limits).map(({ stage, cap, valueWei }, index) =>
      signer.signTransaction({
        ...(stage === 'deposit' ? signDeposit(chain, signer) : fundingTransfer(chain, stage)),
        value: valueWei,
        type: 2,
        chainId: chain.chainId,
        nonce: chain.funder.firstNonce + index,
        gasLimit: cap.gasLimit,
        maxFeePerGas: cap.maxFeePerGasWei,
        maxPriorityFeePerGas: cap.maxPriorityFeePerGasWei,
      }),
    ),
  );
};

const validateDeposit = (chain: FundingChain, data: string) => {
  const args = depository.decodeFunctionData('processBatch', data);
  requireCall(
    data === depository.encodeFunctionData('processBatch', [args[0], args[1], args[2]]) &&
      BigInt(args[2]) === chain.entityNonce + 1n,
  );
  const batch = decodeJBatch(String(args[0]));
  requireCall(
    Object.entries(batch).every(
      ([key, value]) => Array.isArray(value) && value.length === (key === 'externalTokenToReserve' ? 1 : 0),
    ),
  );
  const deposit = batch.externalTokenToReserve[0]!;
  requireCall(
    deposit.entity.toLowerCase() === chain.hubEntity &&
      deposit.contractAddress.toLowerCase() === chain.token &&
      deposit.internalTokenId === 1 &&
      deposit.externalTokenId === 0n &&
      deposit.tokenType === 0 &&
      deposit.amount === chain.limits.amount,
  );
  return { encoded: String(args[0]), hanko: String(args[1]), nonce: BigInt(args[2]), entityId: chain.funderEntity };
};

/** The funding EOA spends its own allowance/gas; its Entity authorizes this
 * exact old->next Depository nonce and a different Hub receives the reserve.
 * A signed five-USDC deposit redirected to the funder must reject here. */
export const validateFundingWire = (chain: FundingChain, raw: string) => {
  const tx = Transaction.from(raw);
  const offset = tx.nonce - chain.funder.firstNonce;
  const slot = fundingSlots(chain.limits)[offset];
  if (!slot) throw new Error('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  requireCall(
    tx.isSigned() &&
      tx.from?.toLowerCase() === chain.funder.address &&
      tx.type === 2 &&
      tx.chainId === BigInt(chain.chainId) &&
      tx.to !== null &&
      tx.authorizationList === null &&
      tx.value === slot.valueWei,
  );
  const { stage, cap } = slot;
  requireCall(
    tx.gasLimit > 0n &&
      tx.gasLimit <= cap.gasLimit &&
      tx.maxFeePerGas !== null &&
      tx.maxPriorityFeePerGas !== null &&
      tx.maxFeePerGas <= cap.maxFeePerGasWei &&
      tx.maxPriorityFeePerGas <= cap.maxPriorityFeePerGasWei &&
      tx.maxPriorityFeePerGas <= tx.maxFeePerGas,
  );
  const to = tx.to!.toLowerCase();
  if (stage === 'deposit') {
    requireCall(to === chain.depository);
    return { transaction: tx, stage, batch: validateDeposit(chain, tx.data) };
  }
  const expected = fundingTransfer(chain, stage);
  requireCall(to === expected.to && tx.data.toLowerCase() === expected.data.toLowerCase());
  return { transaction: tx, stage, batch: null };
};
