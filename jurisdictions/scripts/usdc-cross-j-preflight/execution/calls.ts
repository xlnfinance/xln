import { Interface, Transaction, zeroPadValue } from 'ethers';
import { Depository__factory } from '../../../typechain-types';
import { decodeJBatch } from '../../../../core/jurisdiction/machine/batch';
import { isLeftEntity } from '../../../../core/protocol/identity/entity-id';
import { compileOps } from '../../../../core/protocol/settlement/operations';
import { payerSlots, type ChainAuthority, type ExecutionAuthority, type PayerGrant } from './authority';

const tokenAbi = new Interface(['function approve(address,uint256) returns(bool)']);
const batchAbi = Depository__factory.createInterface();
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const requireCall = (condition: boolean): void => {
  if (!condition) throw new Error('USDC_EXECUTION_CALL_NOT_AUTHORIZED');
};

const validateBatch = (chain: ChainAuthority, payer: PayerGrant, stage: number, encoded: string): void => {
  const batch = decodeJBatch(encoded);
  const operation =
    payer.role === 'source-user'
      ? stage === 1
        ? 'externalTokenToReserve'
        : 'reserveToCollateral'
      : payer.role === 'target-hub'
        ? 'reserveToCollateral'
        : 'reserveToExternalToken';
  const allowed = operation === 'reserveToExternalToken' ? [operation, 'settlements'] : [operation];
  requireCall(
    Object.entries(batch).every(
      ([key, value]) => Array.isArray(value) && (allowed.includes(key) ? value.length === 1 : value.length === 0),
    ),
  );
  if (operation === 'externalTokenToReserve') {
    const deposit = batch.externalTokenToReserve[0]!;
    requireCall(
      same(deposit.entity, chain.userEntity) &&
        same(deposit.contractAddress, chain.token) &&
        deposit.internalTokenId === 1 &&
        deposit.tokenType === 0 &&
        deposit.externalTokenId === 0n &&
        deposit.amount === 1_000_000n,
    );
  } else if (operation === 'reserveToCollateral') validateCollateral(chain, payer, batch.reserveToCollateral[0]!);
  else validateExit(chain, batch);
};

const validateCollateral = (
  chain: ChainAuthority,
  payer: PayerGrant,
  collateral: ReturnType<typeof decodeJBatch>['reserveToCollateral'][number],
): void => {
  const source = payer.role === 'source-user';
  requireCall(
    collateral.tokenId === 1 &&
      same(collateral.receivingEntity, source ? chain.userEntity : chain.hubEntity) &&
      collateral.pairs.length === 1,
  );
  const pair = collateral.pairs[0]!;
  requireCall(
    same(pair.entity, source ? chain.hubEntity : chain.userEntity) &&
      (source ? pair.amount === 1_000_000n : pair.amount >= 850_000n && pair.amount <= 1_000_000n),
  );
};

/** Approval scope only. Runtime and the contracts still own settlement admission
 * and both Entity signatures; a gas grant cannot authorize a new counterparty. */
const validateExit = (chain: ChainAuthority, batch: ReturnType<typeof decodeJBatch>): void => {
  const exit = batch.reserveToExternalToken[0]!;
  const settlement = batch.settlements[0]!;
  const left = isLeftEntity(chain.userEntity, chain.hubEntity);
  requireCall(
    exit.tokenId === 1 &&
      same(exit.receivingEntity, zeroPadValue(chain.userSigner, 32)) &&
      exit.amount >= 850_000n &&
      exit.amount <= 1_000_000n &&
      settlement.diffs.length === 1 &&
      settlement.forgiveDebtsInTokenIds.length === 0 &&
      same(settlement.leftEntity, left ? chain.userEntity : chain.hubEntity) &&
      same(settlement.rightEntity, left ? chain.hubEntity : chain.userEntity),
  );
  const diff = settlement.diffs[0]!;
  const expected = compileOps([{ type: 'c2r', tokenId: 1, amount: exit.amount }], left).diffs[0]!;
  requireCall(
    diff.tokenId === expected.tokenId &&
      diff.collateralDiff === expected.collateralDiff &&
      diff.leftDiff === expected.leftDiff &&
      diff.rightDiff === expected.rightDiff &&
      diff.ondeltaDiff === expected.ondeltaDiff,
  );
};

export const validateAuthorizedWire = (authority: ExecutionAuthority, chain: ChainAuthority, raw: string) => {
  const transaction = Transaction.from(raw);
  requireCall(
    transaction.isSigned() &&
      transaction.type === 2 &&
      transaction.chainId === BigInt(chain.chainId) &&
      transaction.value === 0n &&
      transaction.to !== null &&
      transaction.from !== null,
  );
  const payer = chain.payers.find(value => value.address === transaction.from!.toLowerCase());
  if (!payer) throw new Error('USDC_EXECUTION_PAYER_NOT_AUTHORIZED');
  const offset = transaction.nonce - payer.firstNonce;
  requireCall(
    offset >= 0 &&
      offset < payerSlots(authority, payer) &&
      transaction.gasLimit <= payer.gasLimit &&
      transaction.maxFeePerGas !== null &&
      transaction.maxPriorityFeePerGas !== null &&
      transaction.maxFeePerGas <= payer.maxFeePerGasWei &&
      transaction.maxPriorityFeePerGas <= payer.maxPriorityFeePerGasWei &&
      transaction.authorizationList === null,
  );
  const stage = payer.role === 'source-user' ? offset % 3 : 0;
  if (payer.role === 'source-user' && stage === 0) {
    requireCall(same(transaction.to!, chain.token));
    const args = tokenAbi.decodeFunctionData('approve', transaction.data);
    requireCall(
      same(String(args[0]), chain.depository) &&
        args[1] === 1_000_000n &&
        transaction.data === tokenAbi.encodeFunctionData('approve', [args[0], args[1]]),
    );
    return { transaction, payer, runIndex: Math.floor(offset / 3), batch: null };
  }
  requireCall(same(transaction.to!, chain.depository));
  const args = batchAbi.decodeFunctionData('processBatch', transaction.data);
  requireCall(transaction.data === batchAbi.encodeFunctionData('processBatch', [args[0], args[1], args[2]]));
  validateBatch(chain, payer, stage, String(args[0]));
  return {
    transaction,
    payer,
    runIndex: payer.role === 'source-user' ? Math.floor(offset / 3) : offset,
    batch: {
      encoded: String(args[0]),
      hanko: String(args[1]),
      nonce: BigInt(args[2]),
      entityId: payer.role === 'target-hub' ? chain.hubEntity : chain.userEntity,
    },
  };
};
