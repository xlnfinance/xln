import { Transaction, ZeroHash, type JsonRpcProvider, type TransactionReceipt } from 'ethers';
import { Depository__factory } from '../../../../typechain-types';
import type { AccountSettledEvent } from '../../../../typechain-types/Depository.sol/Depository';
import { computeAccountKey } from '../../../../../core/jurisdiction/adapter/events/contract-codec';
import { broadcastPreparedRpcTransaction } from '../../../../../core/jurisdiction/adapter/rpc/write/prepared/prepared-broadcast';
import {
  assertCanonicalChainPoint,
  readCanonicalChainPoint,
  type CanonicalChainPoint,
} from '../../../../../core/jurisdiction/adapter/stack-manager/receipts';
import { decodeJBatch, encodeJBatch } from '../../../../../core/jurisdiction/machine/batch';
import { decodeInt512, decodeUint768 } from '../../../../../core/protocol/crypto/abi-money';
import { createSettlementHashWithNonce } from '../../../../../core/protocol/dispute/proof-builder';
import { isLeftEntity } from '../../../../../core/protocol/identity/entity-id';
import { compileOps } from '../../../../../core/protocol/settlement/operations';
import { readNonceReceipt } from '../nonce-receipt';
import type { ExecutionProviders } from '../providers';
import { depositoryAbi, readDepositoryEvent, verifyBatchReceipt } from '../receipt-event';
import { verifyBatchHanko, verifyEntityHanko, verifyExecutionChain } from '../submission';
import { requireSourceC2RAuthority, type SourceC2RAuthority } from './authority';

const validateTransaction = ({ payer, chain }: SourceC2RAuthority, raw: string) => {
  const tx = Transaction.from(raw);
  if (
    !tx.isSigned() ||
    tx.type !== 2 ||
    tx.chainId !== BigInt(chain.chainId) ||
    tx.from?.toLowerCase() !== payer.address ||
    tx.to?.toLowerCase() !== chain.depository ||
    tx.nonce !== payer.firstNonce ||
    tx.value !== 0n ||
    tx.authorizationList !== null ||
    tx.gasLimit <= 0n ||
    tx.gasLimit > payer.gasLimit ||
    tx.maxFeePerGas === null ||
    tx.maxFeePerGas <= 0n ||
    tx.maxFeePerGas > payer.maxFeePerGasWei ||
    tx.maxPriorityFeePerGas === null ||
    tx.maxPriorityFeePerGas > payer.maxPriorityFeePerGasWei ||
    tx.maxPriorityFeePerGas > tx.maxFeePerGas
  )
    throw new Error('USDC_SOURCE_C2R_TRANSACTION_NOT_AUTHORIZED');
  return { tx, hash: tx.hash!, maxFee: tx.maxFeePerGas, priorityFee: tx.maxPriorityFeePerGas };
};

const validateCalldata = ({ hubEntity, userEntity, settlement }: SourceC2RAuthority, data: string) => {
  const args = depositoryAbi.decodeFunctionData('processBatch', data);
  const [encoded, hanko, nonce] = [String(args[0]), String(args[1]), BigInt(args[2])];
  const decoded = decodeJBatch(encoded);
  if (
    data !== depositoryAbi.encodeFunctionData('processBatch', [encoded, hanko, nonce]) ||
    encodeJBatch(decoded) !== encoded ||
    nonce !== settlement.hubBatchNonce ||
    !Object.entries(decoded).every(([name, ops]) => ops.length === (name === 'collateralToReserve' ? 1 : 0))
  )
    throw new Error('USDC_SOURCE_C2R_BATCH_NOT_AUTHORIZED');
  const c2r = decoded.collateralToReserve[0]!;
  if (
    c2r.counterparty !== userEntity ||
    c2r.tokenId !== 1 ||
    c2r.amount !== settlement.amountAtoms ||
    c2r.nonce !== settlement.accountNonce
  )
    throw new Error('USDC_SOURCE_C2R_CALL_NOT_AUTHORIZED');
  return { batch: { encoded, hanko, nonce, entityId: hubEntity }, consent: c2r.sig };
};

const settlementScope = ({ chain, settlement, hubEntity, userEntity }: SourceC2RAuthority) => {
  const hubIsLeft = isLeftEntity(hubEntity, userEntity);
  const [leftEntity, rightEntity] = hubIsLeft ? [hubEntity, userEntity] : [userEntity, hubEntity];
  const { diffs, forgiveTokenIds } = compileOps(
    [{ type: 'c2r', tokenId: 1, amount: settlement.amountAtoms }],
    hubIsLeft,
  );
  const hash = createSettlementHashWithNonce(
    { leftEntity, rightEntity },
    diffs,
    forgiveTokenIds,
    { chainId: chain.chainId, depositoryAddress: chain.depository },
    settlement.accountNonce,
  );
  const hubAfter = settlement.hubReserveBeforeAtoms + settlement.amountAtoms;
  return {
    leftEntity,
    rightEntity,
    hash,
    ondeltaDiff: diffs[0]!.ondeltaDiff,
    leftAfter: hubIsLeft ? hubAfter : settlement.userReserveBeforeAtoms,
    rightAfter: hubIsLeft ? settlement.userReserveBeforeAtoms : hubAfter,
  };
};

const readOpeningOndelta = async (
  { chain, hubEntity, userEntity, settlement }: SourceC2RAuthority,
  provider: JsonRpcProvider,
  point: CanonicalChainPoint,
): Promise<bigint> => {
  const depository = Depository__factory.connect(chain.depository, provider);
  const at = { blockTag: point.number };
  const key = computeAccountKey(hubEntity, userEntity);
  const [account, collateral, hubReserve, userReserve, hubDebt, userDebt, batchNonce, token] = await Promise.all([
    depository._accounts(key, at),
    depository._collaterals(key, 1, at),
    depository._reserves(hubEntity, 1, at),
    depository._reserves(userEntity, 1, at),
    depository.debtOutstanding(hubEntity, 1, at),
    depository.debtOutstanding(userEntity, 1, at),
    depository.entityNonces(hubEntity, at),
    depository._tokens(1, at),
  ]);
  if (
    account.nonce !== BigInt(settlement.accountNonceBefore) ||
    account.disputeHash !== ZeroHash ||
    collateral.collateral !== settlement.amountAtoms ||
    hubReserve !== settlement.hubReserveBeforeAtoms ||
    userReserve !== settlement.userReserveBeforeAtoms ||
    decodeUint768(hubDebt) !== 0n ||
    decodeUint768(userDebt) !== 0n ||
    batchNonce + 1n !== settlement.hubBatchNonce ||
    token.contractAddress.toLowerCase() !== chain.token ||
    token.externalTokenId !== 0n ||
    token.tokenType !== 0n
  )
    throw new Error('USDC_SOURCE_C2R_OPENING_STATE_MISMATCH');
  await assertCanonicalChainPoint(provider, point);
  return decodeInt512(collateral.ondelta);
};

const verifySettlementReceipt = (
  authority: SourceC2RAuthority,
  receipt: TransactionReceipt,
  openingOndelta: bigint,
): void => {
  const { chain, settlement } = authority;
  const scope = settlementScope(authority);
  const [accounts] = readDepositoryEvent(
    chain,
    receipt,
    'AccountSettled',
  ) as unknown as AccountSettledEvent.OutputTuple;
  const account = accounts[0];
  const token = account?.tokens[0];
  if (
    accounts.length !== 1 ||
    !account ||
    account.tokens.length !== 1 ||
    !token ||
    account.left !== scope.leftEntity ||
    account.right !== scope.rightEntity ||
    account.nonce !== BigInt(settlement.accountNonce) ||
    token.tokenId !== 1n ||
    token.collateral !== 0n ||
    token.leftReserve !== scope.leftAfter ||
    token.rightReserve !== scope.rightAfter ||
    decodeInt512(token.ondelta) !== openingOndelta + scope.ondeltaDiff
  )
    throw new Error(`USDC_SOURCE_C2R_SETTLEMENT_RECEIPT_MISMATCH:${receipt.hash}`);
};

const verifyGas = async (
  authority: SourceC2RAuthority,
  provider: JsonRpcProvider,
  { tx, maxFee, priorityFee }: ReturnType<typeof validateTransaction>,
): Promise<void> => {
  const from = authority.payer.address;
  const [estimate, balance, block] = await Promise.all([
    provider.estimateGas({
      from,
      to: authority.chain.depository,
      data: tx.data,
      value: tx.value,
      accessList: tx.accessList,
    }),
    provider.getBalance(from),
    provider.getBlock('latest'),
  ]);
  if (
    estimate > tx.gasLimit ||
    balance < tx.gasLimit * maxFee ||
    block?.baseFeePerGas == null ||
    block.baseFeePerGas + priorityFee > maxFee
  )
    throw new Error('USDC_SOURCE_C2R_GAS_OUTSIDE_SCOPE');
};

export const submitSourceC2R = async (
  authority: SourceC2RAuthority,
  catalogPath: string,
  providers: ExecutionProviders,
  raw: string,
): Promise<string> => {
  requireSourceC2RAuthority(authority, catalogPath);
  const wire = validateTransaction(authority, raw);
  const { batch, consent } = validateCalldata(authority, wire.tx.data);
  const { chain, payer, userEntity } = authority;
  const { current, historical } = providers;
  await verifyExecutionChain(providers, { ...chain, payers: [payer] });
  const opening = await readOpeningOndelta(authority, historical, {
    number: chain.anchorNumber,
    hash: chain.anchorHash,
  });
  const receipt = await readNonceReceipt(providers, chain, payer, payer.firstNonce);
  if (receipt) {
    if (receipt.transaction.hash !== wire.hash || receipt.receipt.hash !== wire.hash)
      throw new Error('USDC_SOURCE_C2R_NONCE_ALREADY_CONSUMED');
    verifyBatchReceipt(chain, receipt.receipt, batch);
    verifySettlementReceipt(authority, receipt.receipt, opening);
    return wire.hash;
  }
  const point = await readCanonicalChainPoint(current);
  if ((await readOpeningOndelta(authority, current, point)) !== opening)
    throw new Error('USDC_SOURCE_C2R_ONDELTA_CHANGED');
  await Promise.all([
    verifyBatchHanko(current, chain, batch, point.number),
    verifyEntityHanko(
      current,
      chain,
      { hanko: consent, hash: settlementScope(authority).hash, entityId: userEntity },
      point.number,
    ),
  ]);
  const existing = await current.getTransaction(wire.hash);
  if (existing?.blockNumber === null) return wire.hash;
  return broadcastSourceC2R(authority, catalogPath, current, wire, point, raw);
};

const broadcastSourceC2R = async (
  authority: SourceC2RAuthority,
  catalogPath: string,
  provider: JsonRpcProvider,
  wire: ReturnType<typeof validateTransaction>,
  point: CanonicalChainPoint,
  raw: string,
): Promise<string> => {
  const { chain, payer } = authority;
  await verifyGas(authority, provider, wire);
  await assertCanonicalChainPoint(provider, point);
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(payer.address, 'latest'),
    provider.getTransactionCount(payer.address, 'pending'),
  ]);
  if (latest !== payer.firstNonce || pending !== payer.firstNonce) throw new Error('USDC_SOURCE_C2R_NONCE_UNAVAILABLE');
  requireSourceC2RAuthority(authority, catalogPath);
  const accepted = await broadcastPreparedRpcTransaction({ mode: 'rpc', chainId: chain.chainId }, provider, raw);
  if (accepted !== wire.hash) throw new Error('USDC_SOURCE_C2R_BROADCAST_HASH_MISMATCH');
  return accepted;
};
